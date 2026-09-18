import { describe, expect, test } from "vitest";
import type { AppendResult, RunnerEvent } from "../../shared/protocol";
import { EventSink } from "./eventSink";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const ok = (events: RunnerEvent[]): AppendResult => ({ ackSeq: events.at(-1)!.seq, accepted: true, cancelRequested: false });

describe("EventSink", () => {
  test("single flight: deltas that arrive during a write coalesce into the next batch", async () => {
    const batches: RunnerEvent[][] = [];
    const gates: ReturnType<typeof deferred<void>>[] = [];
    const sink = new EventSink(async (events) => {
      batches.push(structuredClone(events));
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
      return ok(events);
    });

    sink.push({ type: "run_started", at: 1 }); // goes out immediately
    for (const t of ["a", "b", "c", "d"]) sink.push({ type: "assistant_delta", messageKey: "m1", text: t, at: 2 });
    sink.push({ type: "tool_output", toolCallId: "c1", tail: "x", at: 3 });
    sink.push({ type: "tool_output", toolCallId: "c1", tail: "xy", at: 3 });
    expect(batches).toHaveLength(1);

    gates[0]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([
      { type: "assistant_delta", messageKey: "m1", text: "abcd", at: 2, seq: 2 },
      { type: "tool_output", toolCallId: "c1", tail: "xy", at: 3, seq: 3 },
    ]);
    gates[1]!.resolve();
    await sink.drain();
    expect(sink.writes).toBe(2);
  });

  test("does not coalesce across different messages; seqs strictly increase", async () => {
    const all: RunnerEvent[] = [];
    let block = deferred<void>();
    const sink = new EventSink(async (events) => {
      await block.promise;
      all.push(...events);
      return ok(events);
    });
    sink.push({ type: "run_started", at: 0 });
    sink.push({ type: "assistant_delta", messageKey: "m1", text: "a", at: 0 });
    sink.push({ type: "assistant_delta", messageKey: "m2", text: "b", at: 0 });
    sink.push({ type: "assistant_delta", messageKey: "m2", thinking: "t", at: 0 });
    block.resolve();
    block = { promise: Promise.resolve(), resolve: () => {} };
    await sink.drain();
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(all[2]).toMatchObject({ messageKey: "m2", text: "b", thinking: "t" });
  });

  test("failed writes are retried with the same seqs", async () => {
    let attempts = 0;
    const delivered: number[][] = [];
    const sink = new EventSink(
      async (events) => {
        if (attempts++ === 0) throw new Error("network");
        delivered.push(events.map((e) => e.seq));
        return ok(events);
      },
      { retryDelayMs: 1 },
    );
    sink.push({ type: "run_started", at: 0 });
    sink.push({ type: "llm_request", turn: 1, at: 0 });
    await sink.drain();
    expect(delivered.flat()).toEqual([1, 2]);
  });

  test("cancelRequested calls onCancel once but keeps delivering; rejection drops pending events", async () => {
    let cancels = 0;
    let rejected = 0;
    let reply: Partial<AppendResult> = { cancelRequested: true };
    const delivered: string[] = [];
    const sink = new EventSink(
      async (events) => {
        delivered.push(...events.map((e) => e.type));
        return { ...ok(events), ...reply };
      },
      { onCancel: () => cancels++, onRejected: () => rejected++ },
    );
    sink.push({ type: "run_started", at: 0 });
    await sink.drain();
    sink.push({ type: "run_finished", status: "aborted", at: 1 });
    await sink.drain();
    expect(delivered).toEqual(["run_started", "run_finished"]);
    expect(cancels).toBe(1);

    reply = { accepted: false };
    sink.push({ type: "keepalive", at: 2 });
    await sink.drain();
    sink.push({ type: "log", level: "info", msg: "dropped", at: 3 });
    await sink.drain();
    expect(rejected).toBe(1);
    expect(delivered).not.toContain("log");
  });
});
