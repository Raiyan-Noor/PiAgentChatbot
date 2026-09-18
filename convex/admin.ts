/**
 * Operator controls for demos and benchmarks (auth is a non-goal of this project).
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation } from "./_generated/server";
import { scheduleOp } from "./lifecycle/pool";
import { canTransition, transition } from "./lifecycle/stateMachine";

/** Stop a thread's sandbox now (as if idle). The next message resumes it. */
export const stopThreadSandbox = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.db.get(threadId);
    const sandbox = thread?.sandboxId ? await ctx.db.get(thread.sandboxId) : null;
    if (!sandbox || !canTransition(sandbox.state, "stopping")) return { ok: false, state: sandbox?.state ?? null };
    await scheduleOp(ctx, await transition(ctx, sandbox, "stopping", "operator"), "stop");
    return { ok: true, state: "stopping" as const };
  },
});

/**
 * Local development / integration testing: bind a thread to a runner daemon
 * you start yourself (no Daytona VM). `tokenHash` is SHA-256(hex) of the token
 * you pass to that daemon as SANDBOX_TOKEN.
 */
export const attachLocalRunner = mutation({
  args: { threadId: v.id("threads"), tokenHash: v.string() },
  handler: async (ctx, { threadId, tokenHash }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("thread not found");
    const previous = thread.sandboxId ? await ctx.db.get(thread.sandboxId) : null;
    if (previous && canTransition(previous.state, "deleted")) {
      await transition(ctx, previous, "deleted", "replaced_by_local_runner", { pendingOp: undefined });
    }
    const now = Date.now();
    const sandboxId = await ctx.db.insert("sandboxes", {
      state: "provisioning",
      stateChangedAt: now,
      threadId,
      tokenHash,
      snapshot: "local",
      cold: true,
      lastActivityAt: now,
      spans: { requestedAt: now },
    });
    await ctx.db.patch(threadId, { sandboxId });
    return { sandboxId };
  },
});

/** Run a reconcile pass immediately instead of waiting for the cron. */
export const reconcileNow = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.lifecycle.reconciler.tick, {});
  },
});

/** Run Daytona drift detection immediately. */
export const observeNow = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.lifecycle.daytona.observe, {});
  },
});
