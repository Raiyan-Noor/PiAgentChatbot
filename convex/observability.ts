/** Read models for the Inspector: timeline, raw events, sandbox history, transcript. */
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";

export const events = query({
  args: { threadId: v.id("threads"), limit: v.optional(v.number()) },
  handler: async (ctx, { threadId, limit }) => {
    return await ctx.db
      .query("events")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .order("desc")
      .take(Math.min(limit ?? 300, 1000));
  },
});

/** Per-run waterfall data. Within-run offsets use the VM clock; queue/claim use the control-plane clock. */
export const timeline = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const runs: Doc<"runs">[] = [];
    for (const status of ["queued", "claimed", "running", "completed", "failed", "aborted"] as const) {
      runs.push(
        ...(await ctx.db
          .query("runs")
          .withIndex("by_thread_status", (q) => q.eq("threadId", threadId).eq("status", status))
          .collect()),
      );
    }
    runs.sort((a, b) => b.queuedAt - a.queuedAt);
    const toolCalls = await ctx.db
      .query("toolCalls")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    return runs.slice(0, 20).map((run) => {
      const tools = toolCalls
        .filter((t) => t.runId === run._id)
        .sort((a, b) => a.seq - b.seq)
        .map((t) => ({
          name: t.name,
          toolCallId: t.toolCallId,
          status: t.status,
          startOffsetMs: run.vmStartedAt !== undefined ? t.vmStartedAt - run.vmStartedAt : undefined,
          durationMs: t.durationMs,
        }));
      const vmStart = run.vmStartedAt;
      return {
        runId: run._id,
        prompt: run.prompt.slice(0, 80),
        status: run.status,
        turns: run.turns,
        usage: run.usage,
        error: run.error,
        // Control-plane clock
        queueWaitMs: run.claimedAt !== undefined ? run.claimedAt - run.queuedAt : undefined,
        totalMs: run.endedAt !== undefined ? run.endedAt - run.queuedAt : undefined,
        // VM clock, relative to run_started
        llmRequestOffsetMs: vmStart !== undefined && run.vmLlmRequestAt !== undefined ? run.vmLlmRequestAt - vmStart : undefined,
        firstTokenOffsetMs: vmStart !== undefined && run.vmFirstTokenAt !== undefined ? run.vmFirstTokenAt - vmStart : undefined,
        vmDurationMs: vmStart !== undefined && run.vmEndedAt !== undefined ? run.vmEndedAt - vmStart : undefined,
        tools,
      };
    });
  },
});

export const sandboxHistory = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const rows = await ctx.db
      .query("sandboxes")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    return await Promise.all(
      rows
        .sort((a, b) => b._creationTime - a._creationTime)
        .map(async (s) => {
          // Lifecycle only (transitions, Daytona ops, registration); run events live in the Events tab.
          const transitions = (
            await ctx.db
              .query("events")
              .withIndex("by_sandbox", (q) => q.eq("sandboxId", s._id))
              .order("desc")
              .take(500)
          )
            .filter((e) => /^(sandbox|daytona|thread)\./.test(e.type))
            .slice(0, 100);
          const { tokenHash: _tokenHash, ...safe } = s;
          void _tokenHash;
          return { ...safe, events: transitions };
        }),
    );
  },
});

export const transcript = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    return await ctx.db
      .query("transcript")
      .withIndex("by_thread_seq", (q) => q.eq("threadId", threadId))
      .collect();
  },
});

/** Global view for the sidebar footer / bench: counts by sandbox state. */
export const fleet = query({
  args: {},
  handler: async (ctx) => {
    const counts: Record<string, number> = {};
    for (const state of ["provisioning", "pooled", "ready", "stopping", "stopped", "starting", "error", "deleting"] as const) {
      counts[state] = (
        await ctx.db
          .query("sandboxes")
          .withIndex("by_state", (q) => q.eq("state", state))
          .collect()
      ).length;
    }
    return counts;
  },
});
