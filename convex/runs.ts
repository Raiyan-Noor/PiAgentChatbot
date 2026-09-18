import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { finishRun } from "./lifecycle/pool";
import { logEvent } from "./lib/log";

export const listByThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const runs = [];
    for (const status of ["queued", "claimed", "running", "completed", "failed", "aborted"] as const) {
      runs.push(
        ...(await ctx.db
          .query("runs")
          .withIndex("by_thread_status", (q) => q.eq("threadId", threadId).eq("status", status))
          .collect()),
      );
    }
    return runs.sort((a, b) => a.queuedAt - b.queuedAt);
  },
});

export const cancel = mutation({
  args: { runId: v.id("runs") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) return;
    if (run.status === "queued") {
      await finishRun(ctx, run, "aborted", "cancelled before start");
      return;
    }
    if ((run.status === "claimed" || run.status === "running") && !run.cancelRequestedAt) {
      // The VM sees this via its watch subscription (and the next ingest ack) and aborts Pi.
      await ctx.db.patch(runId, { cancelRequestedAt: Date.now() });
      await logEvent(ctx, { type: "run.cancel_requested", threadId: run.threadId, runId, sandboxId: run.sandboxId });
    }
  },
});
