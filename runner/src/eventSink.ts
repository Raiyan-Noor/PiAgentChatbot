/**
 * Ordered, coalescing, single-flight event sink.
 *
 * - `push` stamps a per-run monotonic seq and queues the event.
 * - At most one `append` mutation is in flight. Events that arrive meanwhile
 *   accumulate; consecutive deltas for the same message/tool merge into one.
 *   Write volume therefore tracks network latency, not token rate: a fast link
 *   streams near token-by-token, a slow link sends bigger batches.
 * - A failed write is retried with the same seqs (ingest is idempotent).
 */
import type { AppendResult, RunnerEvent, RunnerEventInput } from "../../shared/protocol";
import { LIVE_OUTPUT_TAIL_CHARS, tailText } from "../../shared/protocol";

export interface EventSinkOptions {
  /** Max events per mutation. */
  maxBatch?: number;
  /** Delay before retrying a failed write. */
  retryDelayMs?: number;
  /** The user asked to stop: abort the agent. Events keep flowing until run_finished. Called once. */
  onCancel?: () => void;
  /** The control plane no longer accepts events for this run (or writes keep failing). Called once. */
  onRejected?: () => void;
  onError?: (e: unknown, attempt: number) => void;
  /** Give up after this many consecutive failures (the lease will expire server-side). */
  maxAttempts?: number;
}

export class EventSink {
  private seq = 0;
  private pending: RunnerEvent[] = [];
  private inFlight: Promise<void> | null = null;
  private idleWaiters: (() => void)[] = [];
  private failures = 0;
  private stopped = false;
  private cancelled = false;
  lastSentAt = 0;
  writes = 0;

  constructor(
    private readonly send: (events: RunnerEvent[]) => Promise<AppendResult>,
    private readonly opts: EventSinkOptions = {},
  ) {}

  push(input: RunnerEventInput): void {
    if (this.stopped) return;
    const last = this.pending[this.pending.length - 1];
    // Coalesce only into events that are not yet in flight (pending is never in flight).
    if (last && input.type === "assistant_delta" && last.type === "assistant_delta" && last.messageKey === input.messageKey) {
      if (input.text) last.text = (last.text ?? "") + input.text;
      if (input.thinking) last.thinking = (last.thinking ?? "") + input.thinking;
      return;
    }
    if (last && input.type === "tool_output" && last.type === "tool_output" && last.toolCallId === input.toolCallId) {
      last.tail = tailText(input.tail, LIVE_OUTPUT_TAIL_CHARS);
      return;
    }
    if (input.type === "keepalive" && this.pending.length > 0) return; // any write extends the lease
    this.pending.push({ ...input, seq: ++this.seq } as RunnerEvent);
    this.kick();
  }

  /** Resolves when everything pushed so far has been acknowledged (or the sink gave up). */
  drain(): Promise<void> {
    if (!this.inFlight && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  get lastSeq() {
    return this.seq;
  }

  private kick() {
    if (this.inFlight || this.pending.length === 0) return;
    const max = this.opts.maxBatch ?? 200;
    const batch = this.pending.slice(0, max);
    this.pending = this.pending.slice(batch.length);
    this.inFlight = this.write(batch).finally(() => {
      this.inFlight = null;
      if (this.pending.length > 0 && !this.stopped) this.kick();
      else this.notifyIdle();
    });
  }

  private async write(batch: RunnerEvent[]): Promise<void> {
    try {
      const res = await this.send(batch);
      this.failures = 0;
      this.writes++;
      this.lastSentAt = Date.now();
      if (!res.accepted) this.stop();
      else if (res.cancelRequested && !this.cancelled) {
        this.cancelled = true;
        this.opts.onCancel?.();
      }
    } catch (e) {
      this.failures++;
      this.opts.onError?.(e, this.failures);
      if (this.failures >= (this.opts.maxAttempts ?? 5)) {
        this.stop();
        return;
      }
      // Put the batch back in front (same seqs; replay-safe) and retry after a pause.
      this.pending = [...batch, ...this.pending];
      await new Promise((r) => setTimeout(r, this.opts.retryDelayMs ?? 500));
    }
  }

  private stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.pending = [];
    this.opts.onRejected?.();
  }

  private notifyIdle() {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}
