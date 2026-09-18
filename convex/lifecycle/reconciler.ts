/**
 * The single reconciler. `tick` is a pure database pass (no network) that
 * compares desired and actual state and schedules Daytona operations through
 * pool.scheduleOp. `applyObservation` folds in what Daytona itself reports.
 */
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { config, timing } from "../config";
import { logEvent } from "../lib/log";
import {
  ensureSandboxRunning,
  finishRun,
  handleMissing,
  provisionSandbox,
  recreateForThread,
  scheduleOp,
} from "./pool";
import { canTransition, transition } from "./stateMachine";

async function byState(ctx: MutationCtx, state: Doc<"sandboxes">["state"]) {
  return await ctx.db
    .query("sandboxes")
    .withIndex("by_state", (q) => q.eq("state", state))
    .collect();
}

async function activeRun(ctx: MutationCtx, threadId: Id<"threads">) {
  for (const status of ["claimed", "running", "queued"] as const) {
    const run = await ctx.db
      .query("runs")
      .withIndex("by_thread_status", (q) => q.eq("threadId", threadId).eq("status", status))
      .first();
    if (run) return run;
  }
  return null;
}

export const tick = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const actions: Record<string, number> = {};
    const count = (k: string) => (actions[k] = (actions[k] ?? 0) + 1);

    // 1. Expired leases: the VM stopped extending its claim.
    for (const status of ["claimed", "running"] as const) {
      for (const run of await ctx.db
        .query("runs")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect()) {
        if ((run.leaseExpiresAt ?? 0) > now) continue;
        await finishRun(ctx, run, run.cancelRequestedAt ? "aborted" : "failed", "lease expired (runner unresponsive)");
        count("lease_expired");
        const sandbox = run.sandboxId ? await ctx.db.get(run.sandboxId) : null;
        if (sandbox && sandbox.state === "ready") await scheduleOp(ctx, sandbox, "probe");
      }
    }

    // 2. Queued work: make sure its sandbox is heading to ready.
    for (const run of await ctx.db
      .query("runs")
      .withIndex("by_status", (q) => q.eq("status", "queued"))
      .collect()) {
      const thread = await ctx.db.get(run.threadId);
      if (!thread) continue;
      const sandbox = thread.sandboxId ? await ctx.db.get(thread.sandboxId) : null;
      if (sandbox?.state === "ready") {
        const head = await activeRun(ctx, thread._id);
        if (head?._id === run._id && now - run.queuedAt > timing.claimTimeoutMs) {
          // Ready but nobody claims: is the VM still there?
          if (await scheduleOp(ctx, sandbox, "probe")) count("probe_unclaimed");
        }
      } else if (!sandbox || ["stopped", "error", "deleted"].includes(sandbox.state)) {
        await ensureSandboxRunning(ctx, thread);
        count("wake_for_queued");
      }
    }

    // 3. Idle stop.
    for (const sandbox of await byState(ctx, "ready")) {
      if (!sandbox.threadId || now - sandbox.lastActivityAt < config.idleStopMs) continue;
      if (await activeRun(ctx, sandbox.threadId)) continue;
      await scheduleOp(ctx, await transition(ctx, sandbox, "stopping", "idle"), "stop");
      count("idle_stop");
    }

    // 4. Stuck operations.
    for (const state of ["provisioning", "starting"] as const) {
      for (const sandbox of await byState(ctx, state)) {
        if (now - sandbox.stateChangedAt < timing.bootTimeoutMs) continue;
        if (sandbox.pendingOp && now - sandbox.pendingOp.at < timing.opTimeoutMs) continue;
        await transition(ctx, sandbox, "error", `${state}_timeout`, { error: `no register within ${timing.bootTimeoutMs}ms` });
        count("boot_timeout");
      }
    }
    for (const [state, op] of [
      ["stopping", "stop"],
      ["deleting", "delete"],
    ] as const) {
      for (const sandbox of await byState(ctx, state)) {
        if (now - sandbox.stateChangedAt > timing.opTimeoutMs && (await scheduleOp(ctx, sandbox, op))) count(`retry_${op}`);
      }
    }

    // 5. Errors: bound sandboxes get probed (start / recover / recreate); pool members get replaced.
    for (const sandbox of await byState(ctx, "error")) {
      const thread = sandbox.threadId ? await ctx.db.get(sandbox.threadId) : null;
      if (thread && thread.sandboxId === sandbox._id) {
        if (!sandbox.daytonaId && now - sandbox.stateChangedAt > timing.claimTimeoutMs) {
          await recreateForThread(ctx, thread, "create_failed");
          count("recreate");
        } else if (await activeRun(ctx, thread._id)) {
          if (await scheduleOp(ctx, sandbox, "probe")) count("probe_error");
        }
      } else if (sandbox.daytonaId) {
        await scheduleOp(ctx, await transition(ctx, sandbox, "deleting", "error_unbound"), "delete");
        count("delete_error");
      } else {
        await transition(ctx, sandbox, "deleted", "error_never_created");
      }
    }

    // 6. Warm pool: roll old snapshots out, top up to target.
    if (config.snapshot) {
      const pooled = await byState(ctx, "pooled");
      for (const sandbox of pooled.filter((s) => s.snapshot !== config.snapshot)) {
        await scheduleOp(ctx, await transition(ctx, sandbox, "deleting", "snapshot_rollover"), "delete");
        count("pool_rollover");
      }
      const warming = (await byState(ctx, "provisioning")).filter((s) => !s.threadId && s.snapshot === config.snapshot);
      const have = pooled.filter((s) => s.snapshot === config.snapshot).length + warming.length;
      const deficit = Math.min(config.poolSize - have, timing.maxCreatesPerTick);
      for (let i = 0; i < deficit; i++) {
        await provisionSandbox(ctx, undefined, "pool_topup");
        count("pool_topup");
      }
    }

    // 7. Dead-man's switch upkeep: keep Daytona auto-stop from firing on sandboxes we want alive.
    const stale = [...(await byState(ctx, "pooled")), ...(await byState(ctx, "ready"))].filter(
      (s) => s.daytonaId && now - (s.lastRefreshAt ?? s.stateChangedAt) > timing.refreshEveryMs,
    );
    if (stale.length) {
      for (const s of stale) await ctx.db.patch(s._id, { lastRefreshAt: now });
      await ctx.scheduler.runAfter(0, internal.lifecycle.daytona.refreshActivity, { sandboxIds: stale.map((s) => s._id) });
      count("refresh_activity");
    }

    if (Object.keys(actions).length) await logEvent(ctx, { type: "reconciler.tick", data: actions });
    return actions;
  },
});

/** Daytona's view of our labelled sandboxes, from lifecycle/daytona:observe. */
export const applyObservation = internalMutation({
  args: {
    observed: v.array(v.object({ daytonaId: v.string(), state: v.string(), sandboxRow: v.optional(v.string()) })),
  },
  handler: async (ctx, { observed }) => {
    const now = Date.now();
    const seen = new Map(observed.map((o) => [o.daytonaId, o]));
    const orphans: string[] = [];
    const drift: Record<string, number> = {};
    const count = (k: string) => (drift[k] = (drift[k] ?? 0) + 1);

    // VMs with no live row: leaked (e.g. thread deleted while the control plane was down).
    for (const o of observed) {
      const row = await ctx.db
        .query("sandboxes")
        .withIndex("by_daytonaId", (q) => q.eq("daytonaId", o.daytonaId))
        .first();
      if (!row || row.state === "deleted") {
        // Rows are written after create returns; give in-flight creates a grace period.
        const rowId = o.sandboxRow ? ctx.db.normalizeId("sandboxes", o.sandboxRow) : null;
        const pendingCreate = rowId ? await ctx.db.get(rowId) : null;
        if (pendingCreate && pendingCreate.state === "provisioning" && now - pendingCreate.stateChangedAt < timing.bootTimeoutMs) continue;
        orphans.push(o.daytonaId);
        count("orphan");
      }
    }

    // Rows whose VM vanished or was stopped behind our back.
    for (const state of ["pooled", "ready", "stopped", "starting", "error"] as const) {
      for (const row of await byState(ctx, state)) {
        if (!row.daytonaId) continue;
        const o = seen.get(row.daytonaId);
        if (!o) {
          await handleMissing(ctx, row._id, "observe");
          count("missing");
          continue;
        }
        if ((state === "ready" || state === "pooled") && ["stopped", "archived"].includes(o.state)) {
          // Daytona auto-stopped it (dead-man's switch fired, or someone stopped it in the dashboard).
          if (state === "pooled") {
            await scheduleOp(ctx, await transition(ctx, row, "deleting", "observed_stopped_pool"), "delete");
          } else if (canTransition(row.state, "stopping")) {
            const stopping = await transition(ctx, row, "stopping", `observed_${o.state}`);
            await transition(ctx, stopping, "stopped", `observed_${o.state}`, { bootId: undefined });
          }
          count("stopped_externally");
        }
      }
    }

    if (orphans.length || Object.keys(drift).length) {
      await logEvent(ctx, { type: "daytona.observe", data: { observed: observed.length, ...drift } });
    }
    return { orphans };
  },
});
