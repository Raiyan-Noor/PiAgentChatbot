import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { config } from "./config";
import { assignSandbox, failActiveRuns, scheduleOp } from "./lifecycle/pool";
import { canTransition, transition } from "./lifecycle/stateMachine";
import { logEvent } from "./lib/log";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const threads = await ctx.db.query("threads").withIndex("by_lastActivity").order("desc").take(100);
    return await Promise.all(
      threads.map(async (t) => {
        const sandbox = t.sandboxId ? await ctx.db.get(t.sandboxId) : null;
        return { ...t, sandboxState: sandbox?.state ?? null };
      }),
    );
  },
});

export const get = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread) return null;
    const sandbox = thread.sandboxId ? await ctx.db.get(thread.sandboxId) : null;
    return { ...thread, sandbox: sandbox ? { ...sandbox, tokenHash: undefined } : null };
  },
});

export const create = mutation({
  args: {
    title: v.optional(v.string()),
    model: v.optional(v.string()),
    /** Skip the warm pool (benchmarks: cold start). */
    cold: v.optional(v.boolean()),
  },
  handler: async (ctx, { title, model, cold }) => {
    const now = Date.now();
    const threadId = await ctx.db.insert("threads", {
      title: title?.trim() || "New thread",
      model: model || config.defaultModel,
      transcriptSeq: 0,
      lastActivityAt: now,
    });
    const { sandboxId, fromPool } = await assignSandbox(ctx, threadId, { allowPool: !cold && config.poolSize > 0 });
    await ctx.db.patch(threadId, { sandboxId });
    await logEvent(ctx, { type: "thread.created", threadId, sandboxId, data: { fromPool } });
    return { threadId, sandboxId, fromPool };
  },
});

export const rename = mutation({
  args: { threadId: v.id("threads"), title: v.string() },
  handler: async (ctx, { threadId, title }) => {
    await ctx.db.patch(threadId, { title: title.trim() || "Untitled" });
  },
});

export const remove = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread) return;
    await failActiveRuns(ctx, threadId, "thread deleted");
    const sandbox = thread.sandboxId ? await ctx.db.get(thread.sandboxId) : null;
    if (sandbox && canTransition(sandbox.state, "deleting")) {
      const row = await transition(ctx, sandbox, "deleting", "thread_deleted");
      // A create still in flight will see `deleting` in recordCreated and delete the VM itself.
      if (row.daytonaId) await scheduleOp(ctx, row, "delete");
    }
    await ctx.db.delete(threadId);
    await ctx.scheduler.runAfter(0, internal.threads.purge, { threadId });
  },
});

/** Delete a thread's rows in bounded batches. */
export const purge = internalMutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const batches = await Promise.all([
      ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", threadId)).take(200),
      ctx.db.query("toolCalls").withIndex("by_thread", (q) => q.eq("threadId", threadId)).take(200),
      ctx.db.query("transcript").withIndex("by_thread_seq", (q) => q.eq("threadId", threadId)).take(200),
      ctx.db.query("events").withIndex("by_thread", (q) => q.eq("threadId", threadId)).take(200),
    ]);
    let more = false;
    for (const rows of batches) {
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length === 200) more = true;
    }
    for (const status of ["queued", "claimed", "running", "completed", "failed", "aborted"] as const) {
      const runs = await ctx.db
        .query("runs")
        .withIndex("by_thread_status", (q) => q.eq("threadId", threadId).eq("status", status))
        .take(200);
      for (const run of runs) await ctx.db.delete(run._id);
      if (runs.length === 200) more = true;
    }
    if (more) await ctx.scheduler.runAfter(0, internal.threads.purge, { threadId });
  },
});
