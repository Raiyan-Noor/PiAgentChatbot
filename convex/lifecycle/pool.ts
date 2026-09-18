/**
 * Sandbox allocation (warm pool claim / cold provision / recreate) and the
 * internal mutations that Daytona actions report back to. Every Daytona call
 * is scheduled from here or from the reconciler, never on the message path.
 */
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { config, timing } from "../config";
import { logEvent } from "../lib/log";
import { canTransition, transition } from "./stateMachine";

export type DaytonaOp = "create" | "start" | "stop" | "delete" | "probe";

const opFunctions = {
  create: internal.lifecycle.daytona.createSandbox,
  start: internal.lifecycle.daytona.startSandbox,
  stop: internal.lifecycle.daytona.stopSandbox,
  delete: internal.lifecycle.daytona.deleteSandbox,
  probe: internal.lifecycle.daytona.probeSandbox,
} as const;

/** Schedule a Daytona operation unless the same op is already in flight. */
export async function scheduleOp(ctx: MutationCtx, sandbox: Doc<"sandboxes">, op: DaytonaOp) {
  const now = Date.now();
  if (sandbox.pendingOp && sandbox.pendingOp.op === op && now - sandbox.pendingOp.at < timing.opTimeoutMs) return false;
  await ctx.db.patch(sandbox._id, { pendingOp: { op, at: now } });
  await ctx.scheduler.runAfter(0, opFunctions[op], { sandboxId: sandbox._id });
  return true;
}

async function clearOp(ctx: MutationCtx, sandboxId: Id<"sandboxes">) {
  await ctx.db.patch(sandboxId, { pendingOp: undefined });
}

/** Insert a `provisioning` row and schedule the Daytona create. */
export async function provisionSandbox(ctx: MutationCtx, threadId: Id<"threads"> | undefined, reason: string) {
  const now = Date.now();
  const sandboxId = await ctx.db.insert("sandboxes", {
    state: "provisioning",
    stateChangedAt: now,
    threadId,
    tokenHash: "",
    snapshot: config.snapshot,
    cold: threadId !== undefined,
    lastActivityAt: now,
    spans: { requestedAt: now },
  });
  await logEvent(ctx, { type: "sandbox.provision", sandboxId, threadId, data: { reason, snapshot: config.snapshot } });
  const row = (await ctx.db.get(sandboxId))!;
  await scheduleOp(ctx, row, "create");
  return sandboxId;
}

/** Give a new thread a sandbox: warm pool first (one serializable read+patch), else cold. */
export async function assignSandbox(ctx: MutationCtx, threadId: Id<"threads">, opts: { allowPool: boolean }) {
  if (opts.allowPool) {
    const pooled = await ctx.db
      .query("sandboxes")
      .withIndex("by_state", (q) => q.eq("state", "pooled"))
      .filter((q) => q.eq(q.field("snapshot"), config.snapshot))
      .first();
    if (pooled) {
      const now = Date.now();
      await transition(ctx, pooled, "ready", "pool_claim", { threadId, lastActivityAt: now });
      await logEvent(ctx, {
        type: "sandbox.pool_claim",
        sandboxId: pooled._id,
        threadId,
        data: { pooledForMs: now - pooled.stateChangedAt },
      });
      return { sandboxId: pooled._id, fromPool: true };
    }
  }
  const sandboxId = await provisionSandbox(ctx, threadId, opts.allowPool ? "pool_empty" : "cold_requested");
  return { sandboxId, fromPool: false };
}

/** Fail the thread's claimed/running run (queued runs are kept for the next sandbox). */
export async function failActiveRuns(ctx: MutationCtx, threadId: Id<"threads">, error: string) {
  for (const status of ["claimed", "running"] as const) {
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_thread_status", (q) => q.eq("threadId", threadId).eq("status", status))
      .collect();
    for (const run of runs) await finishRun(ctx, run, run.cancelRequestedAt ? "aborted" : "failed", error);
  }
}

/** Terminal bookkeeping for a run that the VM will not finish. */
export async function finishRun(
  ctx: MutationCtx,
  run: Doc<"runs">,
  status: "completed" | "failed" | "aborted",
  error?: string,
) {
  const now = Date.now();
  await ctx.db.patch(run._id, { status, endedAt: now, leaseExpiresAt: undefined, error });
  for (const m of await ctx.db
    .query("messages")
    .withIndex("by_run_key", (q) => q.eq("runId", run._id))
    .collect()) {
    if (m.status === "streaming") await ctx.db.patch(m._id, { status: status === "completed" ? "complete" : "error" });
  }
  for (const t of await ctx.db
    .query("toolCalls")
    .withIndex("by_thread", (q) => q.eq("threadId", run.threadId))
    .filter((q) => q.and(q.eq(q.field("runId"), run._id), q.eq(q.field("status"), "running")))
    .collect()) {
    await ctx.db.patch(t._id, { status: "error", isError: true });
  }
  await logEvent(ctx, {
    type: `run.${status}`,
    threadId: run.threadId,
    runId: run._id,
    sandboxId: run.sandboxId,
    durationMs: now - run.queuedAt,
    data: error ? { error } : undefined,
  });
}

/** Circuit breaker: this many failed sandboxes for one thread within the window stops recreation. */
const BREAKER_FAILURES = 3;
const BREAKER_WINDOW_MS = 10 * 60_000;

async function breakerOpen(ctx: MutationCtx, threadId: Id<"threads">) {
  const since = Date.now() - BREAKER_WINDOW_MS;
  const rows = await ctx.db
    .query("sandboxes")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .filter((q) => q.gt(q.field("_creationTime"), since))
    .collect();
  return rows.filter((r) => r.error !== undefined).length >= BREAKER_FAILURES;
}

/**
 * The thread's VM (and workspace) is gone. Point the thread at a fresh sandbox;
 * the conversation survives because the transcript lives in Convex.
 */
export async function recreateForThread(ctx: MutationCtx, thread: Doc<"threads">, reason: string) {
  if (await breakerOpen(ctx, thread._id)) {
    // Don't burn Daytona quota in a loop (bad snapshot, missing key, quota exhausted, ...).
    for (const run of await ctx.db
      .query("runs")
      .withIndex("by_thread_status", (q) => q.eq("threadId", thread._id).eq("status", "queued"))
      .collect()) {
      await finishRun(ctx, run, "failed", "sandbox provisioning keeps failing; see the Sandbox tab (circuit breaker open)");
    }
    await logEvent(ctx, { type: "thread.breaker_open", threadId: thread._id, data: { reason } });
    return null;
  }
  const old = thread.sandboxId ? await ctx.db.get(thread.sandboxId) : null;
  if (old && old.state !== "deleted") {
    if (old.daytonaId && canTransition(old.state, "deleting") && reason !== "vm_missing") {
      const row = await transition(ctx, old, "deleting", `replaced:${reason}`);
      await scheduleOp(ctx, row, "delete");
    } else {
      await transition(ctx, old, "deleted", `replaced:${reason}`, { pendingOp: undefined });
    }
  }
  await failActiveRuns(ctx, thread._id, `sandbox lost (${reason})`);
  const sandboxId = await provisionSandbox(ctx, thread._id, `recreate:${reason}`);
  await ctx.db.patch(thread._id, { sandboxId });
  await logEvent(ctx, {
    type: "thread.workspace_reset",
    threadId: thread._id,
    sandboxId,
    data: { reason, previousSandboxId: old?._id, note: "conversation kept (transcript), workspace files lost" },
  });
  return sandboxId;
}

/** Make sure a thread with queued work has a VM that is on its way to `ready`. */
export async function ensureSandboxRunning(ctx: MutationCtx, thread: Doc<"threads">) {
  const sandbox = thread.sandboxId ? await ctx.db.get(thread.sandboxId) : null;
  if (!sandbox || sandbox.state === "deleted" || sandbox.state === "deleting") {
    await recreateForThread(ctx, thread, sandbox ? "sandbox_deleted" : "no_sandbox");
    return;
  }
  switch (sandbox.state) {
    case "stopped": {
      const row = await transition(ctx, sandbox, "starting", "message_wake", {
        spans: { ...sandbox.spans, requestedAt: Date.now(), startMs: undefined, readyMs: undefined },
      });
      await scheduleOp(ctx, row, "start");
      return;
    }
    case "error":
      await scheduleOp(ctx, sandbox, "probe");
      return;
    default:
      // provisioning/starting: will register; ready: daemon is watching; stopping: restarted on stop completion.
      return;
  }
}

export async function hasQueuedRuns(ctx: MutationCtx, threadId: Id<"threads">) {
  const run = await ctx.db
    .query("runs")
    .withIndex("by_thread_status", (q) => q.eq("threadId", threadId).eq("status", "queued"))
    .first();
  return run !== null;
}

// ---------------------------------------------------------------------------
// Callbacks from Daytona actions (convex/lifecycle/daytona.ts)
// ---------------------------------------------------------------------------

export const getSandbox = internalQuery({
  args: { sandboxId: v.id("sandboxes") },
  handler: (ctx, { sandboxId }) => ctx.db.get(sandboxId),
});

/** Store the token hash before the VM exists. Returns false if the row moved on. */
export const beginCreate = internalMutation({
  args: { sandboxId: v.id("sandboxes"), tokenHash: v.string() },
  handler: async (ctx, { sandboxId, tokenHash }) => {
    const s = await ctx.db.get(sandboxId);
    if (!s || s.state !== "provisioning") return { proceed: false as const };
    await ctx.db.patch(sandboxId, { tokenHash, spans: { ...s.spans, requestedAt: Date.now() } });
    return { proceed: true as const, snapshot: s.snapshot, threadId: s.threadId ?? null };
  },
});

export const recordCreated = internalMutation({
  args: { sandboxId: v.id("sandboxes"), daytonaId: v.string(), createMs: v.number() },
  handler: async (ctx, { sandboxId, daytonaId, createMs }) => {
    const s = await ctx.db.get(sandboxId);
    if (!s) return { deleteNow: true };
    await ctx.db.patch(sandboxId, { daytonaId, spans: { ...s.spans, createMs }, pendingOp: undefined });
    await logEvent(ctx, { type: "daytona.create", sandboxId, threadId: s.threadId, durationMs: createMs, data: { daytonaId } });
    // The thread was deleted while we were creating: tear down.
    return { deleteNow: s.state === "deleting" || s.state === "deleted" };
  },
});

export const recordStarted = internalMutation({
  args: { sandboxId: v.id("sandboxes"), startMs: v.number() },
  handler: async (ctx, { sandboxId, startMs }) => {
    const s = await ctx.db.get(sandboxId);
    if (!s) return;
    await ctx.db.patch(sandboxId, { spans: { ...s.spans, startMs }, pendingOp: undefined });
    await logEvent(ctx, { type: "daytona.start", sandboxId, threadId: s.threadId, durationMs: startMs });
  },
});

export const recordStopped = internalMutation({
  args: { sandboxId: v.id("sandboxes"), stopMs: v.number() },
  handler: async (ctx, { sandboxId, stopMs }) => {
    const s = await ctx.db.get(sandboxId);
    if (!s) return;
    await logEvent(ctx, { type: "daytona.stop", sandboxId, threadId: s.threadId, durationMs: stopMs });
    if (s.state !== "stopping") return clearOp(ctx, sandboxId);
    let row = await transition(ctx, s, "stopped", "stop_complete", { pendingOp: undefined, bootId: undefined });
    // A message arrived while stopping: wake straight back up.
    if (row.threadId && (await hasQueuedRuns(ctx, row.threadId))) {
      row = await transition(ctx, row, "starting", "queued_while_stopping", {
        spans: { ...row.spans, requestedAt: Date.now(), startMs: undefined, readyMs: undefined },
      });
      await scheduleOp(ctx, row, "start");
    }
  },
});

export const recordDeleted = internalMutation({
  args: { sandboxId: v.id("sandboxes"), deleteMs: v.number() },
  handler: async (ctx, { sandboxId, deleteMs }) => {
    const s = await ctx.db.get(sandboxId);
    if (!s) return;
    await logEvent(ctx, { type: "daytona.delete", sandboxId, threadId: s.threadId, durationMs: deleteMs });
    if (s.state === "deleted") return clearOp(ctx, sandboxId);
    await transition(ctx, s, "deleted", "delete_complete", { pendingOp: undefined });
  },
});

export const recordFailure = internalMutation({
  args: { sandboxId: v.id("sandboxes"), op: v.string(), error: v.string() },
  handler: async (ctx, { sandboxId, op, error }) => {
    const s = await ctx.db.get(sandboxId);
    if (!s) return;
    await logEvent(ctx, { type: `daytona.${op}.failed`, sandboxId, threadId: s.threadId, data: { error } });
    if (canTransition(s.state, "error")) {
      await transition(ctx, s, "error", `${op}_failed`, { error, pendingOp: undefined });
    } else {
      await clearOp(ctx, sandboxId);
    }
  },
});

/** Daytona says the VM does not exist. */
export async function handleMissing(ctx: MutationCtx, sandboxId: Id<"sandboxes">, source: string) {
  const s = await ctx.db.get(sandboxId);
  if (!s || s.state === "deleted") return;
  await logEvent(ctx, { type: "daytona.missing", sandboxId, threadId: s.threadId, data: { source } });
  const thread = s.threadId ? await ctx.db.get(s.threadId) : null;
  if (thread && thread.sandboxId === s._id && s.state !== "deleting") {
    await recreateForThread(ctx, thread, "vm_missing");
  } else {
    await transition(ctx, s, "deleted", "vm_missing", { pendingOp: undefined });
  }
}

export const recordMissing = internalMutation({
  args: { sandboxId: v.id("sandboxes"), source: v.string() },
  handler: (ctx, { sandboxId, source }) => handleMissing(ctx, sandboxId, source),
});

/** Result of a probe: reconcile our row with what Daytona reports. */
export const recordProbe = internalMutation({
  args: { sandboxId: v.id("sandboxes"), daytonaState: v.string() },
  handler: async (ctx, { sandboxId, daytonaState }) => {
    const s = await ctx.db.get(sandboxId);
    if (!s) return { action: "none" as const };
    await ctx.db.patch(sandboxId, { pendingOp: undefined });
    await logEvent(ctx, { type: "daytona.probe", sandboxId, threadId: s.threadId, data: { daytonaState, rowState: s.state } });
    const thread = s.threadId ? await ctx.db.get(s.threadId) : null;
    const bound = thread !== null && thread.sandboxId === s._id;
    if (!bound) {
      // Pool member or stale row: cheaper to replace than to repair.
      if (canTransition(s.state, "deleting")) await scheduleOp(ctx, await transition(ctx, s, "deleting", "probe_unbound"), "delete");
      return { action: "delete" as const };
    }
    if (daytonaState === "started") {
      // VM is up. If the daemon has not registered for too long, the image is broken for this VM: replace it.
      if ((s.state === "error" || s.state === "starting") && Date.now() - s.stateChangedAt > timing.bootTimeoutMs && thread) {
        await recreateForThread(ctx, thread, "daemon_unresponsive");
        return { action: "recreate" as const };
      }
      return { action: "none" as const };
    }
    if (["stopped", "error", "archived"].includes(daytonaState) && thread) {
      if (canTransition(s.state, "starting")) {
        const row = await transition(ctx, s, "starting", `probe_${daytonaState}`, {
          spans: { ...s.spans, requestedAt: Date.now(), startMs: undefined, readyMs: undefined },
        });
        await scheduleOp(ctx, row, "start");
        return { action: "start" as const };
      }
    }
    return { action: "none" as const };
  },
});

export const recordRefreshed = internalMutation({
  args: { sandboxIds: v.array(v.id("sandboxes")), failed: v.array(v.id("sandboxes")) },
  handler: async (ctx, { sandboxIds, failed }) => {
    const now = Date.now();
    for (const id of sandboxIds) await ctx.db.patch(id, { lastRefreshAt: now });
    if (sandboxIds.length || failed.length) {
      await logEvent(ctx, { type: "daytona.refresh_activity", data: { refreshed: sandboxIds.length, failed: failed.length } });
    }
  },
});
