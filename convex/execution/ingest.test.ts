import { describe, expect, test } from "vitest";
import { RUN_LEASE_MS, type RunnerEvent } from "../../shared/protocol";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeTest, sha256Hex } from "../test.setup";

const TOKEN = "test-token";
const BOOT = "boot-1";

async function setup() {
  const t = makeTest();
  const tokenHash = await sha256Hex(TOKEN);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const threadId = await ctx.db.insert("threads", { title: "t", model: "m", transcriptSeq: 0, lastActivityAt: now });
    const sandboxId = await ctx.db.insert("sandboxes", {
      state: "provisioning",
      stateChangedAt: now,
      threadId,
      tokenHash,
      snapshot: "s",
      cold: true,
      lastActivityAt: now,
      spans: {},
    });
    await ctx.db.patch(threadId, { sandboxId });
    return { threadId, sandboxId };
  });
  await t.mutation(api.execution.inbox.register, { token: TOKEN, bootId: BOOT, protocolVersion: 1, runnerVersion: "test", bootMs: 5 });
  const { runId } = await t.mutation(api.messages.send, { threadId: ids.threadId, text: "hello" });
  return { t, ...ids, runId };
}

let seq = 0;
const ev = (e: Omit<RunnerEvent, "seq" | "at">): RunnerEvent => ({ ...e, seq: ++seq, at: 1_000 + seq }) as RunnerEvent;

describe("execution API", () => {
  test("register moves provisioning -> ready and watch pushes the queued run", async () => {
    const { t, threadId, runId } = await setup();
    const w = await t.query(api.execution.inbox.watch, { token: TOKEN, bootId: BOOT });
    expect(w).toMatchObject({ state: "ready", threadId, nextRun: { runId }, cancelRunId: null });
    expect(await t.query(api.execution.inbox.watch, { token: "wrong", bootId: BOOT })).toBeNull();
  });

  test("register rejects a protocol mismatch", async () => {
    const { t } = await setup();
    await expect(
      t.mutation(api.execution.inbox.register, { token: TOKEN, bootId: "b2", protocolVersion: 999, runnerVersion: "x", bootMs: 1 }),
    ).rejects.toThrow();
  });

  test("claim is exclusive and FIFO", async () => {
    const { t, threadId, runId } = await setup();
    const second = await t.mutation(api.messages.send, { threadId, text: "second" });
    expect((await t.mutation(api.execution.inbox.claimRun, { token: TOKEN, bootId: BOOT, runId: second.runId })).ok).toBe(false);
    const claim = await t.mutation(api.execution.inbox.claimRun, { token: TOKEN, bootId: BOOT, runId });
    expect(claim).toMatchObject({ ok: true, prompt: "hello" });
    const again = await t.mutation(api.execution.inbox.claimRun, { token: TOKEN, bootId: BOOT, runId });
    expect(again).toEqual({ ok: false, reason: "status_claimed" });
    // Head is active: watch offers nothing new.
    expect((await t.query(api.execution.inbox.watch, { token: TOKEN, bootId: BOOT }))?.nextRun).toBeNull();
  });

  test("append: projections, transcript, lease, and idempotent replay", async () => {
    const { t, threadId, runId } = await setup();
    await t.mutation(api.execution.inbox.claimRun, { token: TOKEN, bootId: BOOT, runId });
    seq = 0;
    const batch1 = [
      ev({ type: "run_started" }),
      ev({ type: "llm_request", turn: 1 }),
      ev({ type: "assistant_delta", messageKey: "a1", text: "Hel" }),
      ev({ type: "assistant_delta", messageKey: "a1", text: "lo" }),
      ev({ type: "tool_start", toolCallId: "c1", name: "bash", args: { command: "ls" } }),
      ev({ type: "tool_output", toolCallId: "c1", tail: "a.txt" }),
    ];
    const before = Date.now();
    const r1 = await t.mutation(api.execution.ingest.append, { token: TOKEN, bootId: BOOT, runId, events: batch1 });
    expect(r1).toEqual({ ackSeq: 6, accepted: true, cancelRequested: false });

    // Replaying the same batch changes nothing.
    await t.mutation(api.execution.ingest.append, { token: TOKEN, bootId: BOOT, runId, events: batch1 });
    let items = await t.query(api.messages.list, { threadId });
    const assistant = items.find((i) => i.kind === "message" && i.role === "assistant");
    expect(assistant).toMatchObject({ text: "Hello", status: "streaming" });
    expect(items.filter((i) => i.kind === "tool")).toHaveLength(1);

    let run = await t.run((ctx) => ctx.db.get(runId));
    expect(run).toMatchObject({ status: "running", lastSeq: 6, vmStartedAt: 1001, vmLlmRequestAt: 1002, vmFirstTokenAt: 1003 });
    expect(run!.leaseExpiresAt).toBeGreaterThanOrEqual(before + RUN_LEASE_MS);

    const raw = { role: "assistant", content: [{ type: "text", text: "Hello!" }], stopReason: "stop" };
    await t.mutation(api.execution.ingest.append, {
      token: TOKEN,
      bootId: BOOT,
      runId,
      events: [
        ev({ type: "tool_end", toolCallId: "c1", result: { text: "a.txt", details: { exitCode: 0 }, truncated: false }, isError: false, durationMs: 12 }),
        ev({ type: "message_end", role: "assistant", messageKey: "a1", raw, stopReason: "stop" }),
        ev({ type: "run_finished", status: "completed" }),
      ],
    });
    items = await t.query(api.messages.list, { threadId });
    expect(items.find((i) => i.kind === "message" && i.role === "assistant")).toMatchObject({ text: "Hello!", status: "complete" });
    expect(items.find((i) => i.kind === "tool")).toMatchObject({ status: "done", durationMs: 12, result: { details: { exitCode: 0 } } });
    run = await t.run((ctx) => ctx.db.get(runId));
    expect(run).toMatchObject({ status: "completed", lastSeq: 9 });
    expect(run!.leaseExpiresAt).toBeUndefined();
    const transcript = await t.query(api.observability.transcript, { threadId });
    expect(transcript.map((e) => e.raw)).toEqual([raw]);
    expect((await t.run((ctx) => ctx.db.get(threadId)))!.transcriptSeq).toBe(1);

    // Terminal runs reject further events.
    const late = await t.mutation(api.execution.ingest.append, { token: TOKEN, bootId: BOOT, runId, events: [ev({ type: "keepalive" })] });
    expect(late.accepted).toBe(false);
  });

  test("cancel is delivered via watch and ingest ack, and run_finished still lands", async () => {
    const { t, runId } = await setup();
    await t.mutation(api.execution.inbox.claimRun, { token: TOKEN, bootId: BOOT, runId });
    seq = 0;
    await t.mutation(api.execution.ingest.append, { token: TOKEN, bootId: BOOT, runId, events: [ev({ type: "run_started" })] });
    await t.mutation(api.runs.cancel, { runId });
    expect((await t.query(api.execution.inbox.watch, { token: TOKEN, bootId: BOOT }))?.cancelRunId).toBe(runId);
    const ack = await t.mutation(api.execution.ingest.append, { token: TOKEN, bootId: BOOT, runId, events: [ev({ type: "keepalive" })] });
    expect(ack).toMatchObject({ accepted: true, cancelRequested: true });
    await t.mutation(api.execution.ingest.append, { token: TOKEN, bootId: BOOT, runId, events: [ev({ type: "run_finished", status: "aborted" })] });
    expect((await t.run((ctx) => ctx.db.get(runId)))!.status).toBe("aborted");
  });

  test("a new boot fails runs claimed by the previous boot", async () => {
    const { t, runId } = await setup();
    await t.mutation(api.execution.inbox.claimRun, { token: TOKEN, bootId: BOOT, runId });
    await t.mutation(api.execution.inbox.register, { token: TOKEN, bootId: "boot-2", protocolVersion: 1, runnerVersion: "test", bootMs: 5 });
    const run = await t.run((ctx) => ctx.db.get(runId));
    expect(run).toMatchObject({ status: "failed", error: "runner restarted mid-run" });
    // And the old boot can no longer write.
    const ack = await t.mutation(api.execution.ingest.append, { token: TOKEN, bootId: BOOT, runId, events: [ev({ type: "keepalive" })] });
    expect(ack.accepted).toBe(false);
  });

  test("reconciler expires stale leases", async () => {
    const { t, runId } = await setup();
    await t.mutation(api.execution.inbox.claimRun, { token: TOKEN, bootId: BOOT, runId });
    await t.run((ctx) => ctx.db.patch(runId as Id<"runs">, { leaseExpiresAt: Date.now() - 1 }));
    const actions = await t.mutation(internal.lifecycle.reconciler.tick, {});
    expect(actions).toMatchObject({ lease_expired: 1 });
    expect((await t.run((ctx) => ctx.db.get(runId)))).toMatchObject({ status: "failed", error: "lease expired (runner unresponsive)" });
  });
});
