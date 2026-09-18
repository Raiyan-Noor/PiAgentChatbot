/**
 * Runner daemon: one per sandbox, started by the snapshot entrypoint (main.ts).
 *
 *   boot -> register -> subscribe(watch)
 *     on assignment : build AgentHost, rehydrate transcript
 *     on nextRun    : claim -> run -> stream events -> drain
 *     on cancelRunId: session.abort()
 *
 * Fatal exit codes: 1 = restart immediately (entrypoint loop), 3 = refused by the control plane (back off).
 */
import { performance } from "node:perf_hooks";
import { KEEPALIVE_MS, PROTOCOL_VERSION, type WatchResult } from "../../shared/protocol";
import { AgentHost, type AgentHostOptions } from "./agentHost";
import { createBridge } from "./bridge";
import type { ControlPlane } from "./controlPlane";
import { EventSink } from "./eventSink";
import { errorMessage, log } from "./log";

declare const __RUNNER_VERSION__: string;
export const RUNNER_VERSION = typeof __RUNNER_VERSION__ === "string" ? __RUNNER_VERSION__ : "dev";

export interface DaemonOptions {
  workspace: string;
  /** Swappable for tests (e.g. a faux LLM provider). */
  createHost?: (opts: AgentHostOptions) => Promise<AgentHost>;
  /** Called on unrecoverable errors. Default: process.exit(code). */
  fatal?: (code: 1 | 3, reason: string) => void;
}

export class Daemon {
  private host: AgentHost | null = null;
  private hostKey: string | null = null;
  private latest: WatchResult | null = null;
  private processed: WatchResult | null = null;
  private busy = false;
  private currentRunId: string | null = null;
  private unwatch: (() => void) | null = null;
  private readonly createHost: (opts: AgentHostOptions) => Promise<AgentHost>;
  private readonly fatal: (code: 1 | 3, reason: string) => void;

  constructor(
    private readonly cp: ControlPlane,
    private readonly opts: DaemonOptions,
  ) {
    this.createHost = opts.createHost ?? AgentHost.create;
    this.fatal =
      opts.fatal ??
      ((code, reason) => {
        log("error", "fatal", { code, reason });
        process.exit(code);
      });
  }

  async start() {
    const bootMs = Math.round(performance.now());
    try {
      const reg = await this.cp.register({ protocolVersion: PROTOCOL_VERSION, runnerVersion: RUNNER_VERSION, bootMs });
      log("info", "registered", { ...reg, bootId: this.cp.bootId, bootMs });
    } catch (e) {
      return this.fatal(3, `register refused: ${errorMessage(e)}`);
    }
    this.unwatch = this.cp.watch(
      (w) => this.onWatch(w),
      (e) => this.fatal(1, `watch failed: ${errorMessage(e)}`),
    );
  }

  stop() {
    this.unwatch?.();
    this.host?.dispose();
  }

  private onWatch(w: WatchResult | null) {
    if (w === null) return this.fatal(3, "token revoked");
    this.latest = w;
    // Cancellation is handled immediately, not queued behind the running turn.
    if (w.cancelRunId && w.cancelRunId === this.currentRunId && this.host) {
      log("info", "cancel requested", { runId: w.cancelRunId });
      void this.host.abort();
    }
    void this.pump();
  }

  /**
   * Processes watch snapshots serially; each pushed snapshot is handled at most
   * once, so a stale snapshot can cause at most one rejected claim.
   */
  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.latest && this.latest !== this.processed) {
        const w = this.latest;
        this.processed = w;
        if (!w.threadId || !w.model) continue;
        // Build the agent as soon as a thread is assigned (pool claim), before the first message.
        let hostError: string | null = null;
        try {
          await this.ensureHost(w.threadId, w.model);
        } catch (e) {
          hostError = errorMessage(e);
          log("error", "agent host failed", { threadId: w.threadId, error: hostError });
        }
        if (!w.nextRun) continue;
        const runId = w.nextRun.runId;
        const claim = await this.cp.claimRun(runId);
        if (!claim.ok) {
          log("info", "claim rejected", { runId, reason: claim.reason });
          continue;
        }
        if (hostError !== null || !this.host) {
          // Fail the run visibly instead of crash-looping on a config error (e.g. unknown model).
          const sink = new EventSink((events) => this.cp.append(runId, events));
          sink.push({ type: "run_started", at: Date.now() });
          sink.push({ type: "run_finished", status: "failed", error: `agent init failed: ${hostError}`, at: Date.now() });
          await sink.drain();
          continue;
        }
        if (claim.transcriptSeq !== this.host.transcriptSeq) {
          const t = await this.cp.transcript();
          this.host.rehydrate(t.messages, t.transcriptSeq);
          log("info", "rehydrated (transcript drift)", { runId, messages: t.messages.length });
        }
        await this.runTurn(this.host, runId, claim.prompt);
      }
    } catch (e) {
      this.fatal(1, `pump failed: ${errorMessage(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private async ensureHost(threadId: string, model: string) {
    const key = `${threadId}:${model}`;
    if (this.host && this.hostKey === key) return;
    this.host?.dispose();
    this.host = null;
    this.hostKey = key;
    const t0 = performance.now();
    const t = await this.cp.transcript();
    this.host = await this.createHost({
      threadId,
      modelId: model,
      cwd: this.opts.workspace,
      egress: this.cp,
      messages: t.messages,
      transcriptSeq: t.transcriptSeq,
    });
    log("info", "agent host ready", { threadId, model, messages: t.messages.length, ms: Math.round(performance.now() - t0) });
  }

  private async runTurn(host: AgentHost, runId: string, prompt: string) {
    this.currentRunId = runId;
    let stopRequested = false;
    const abort = () => {
      stopRequested = true;
      void host.abort();
    };
    const sink = new EventSink((events) => this.cp.append(runId, events), {
      onCancel: abort,
      onRejected: abort,
      onError: (e, attempt) => log("warn", "append failed", { runId, attempt, error: errorMessage(e) }),
    });
    const keepalive = setInterval(() => {
      if (Date.now() - sink.lastSentAt >= KEEPALIVE_MS) sink.push({ type: "keepalive", at: Date.now() });
    }, KEEPALIVE_MS / 2);

    const t0 = performance.now();
    sink.push({ type: "run_started", at: Date.now() });
    const bridge = createBridge((e) => sink.push(e));
    const outcome = await host.run(prompt, bridge);
    const status = stopRequested && outcome.status !== "completed" ? "aborted" : outcome.status;
    sink.push({ type: "run_finished", status, error: outcome.error, at: Date.now() });
    clearInterval(keepalive);
    await sink.drain();
    this.currentRunId = null;
    log("info", "run finished", {
      runId,
      status,
      turns: bridge.turns,
      ms: Math.round(performance.now() - t0),
      writes: sink.writes,
      events: sink.lastSeq,
    });
  }
}
