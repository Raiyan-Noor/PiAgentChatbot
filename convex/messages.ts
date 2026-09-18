import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { ensureSandboxRunning } from "./lifecycle/pool";
import { logEvent } from "./lib/log";

/** Chat items for a thread: messages and tool calls, merged in creation order. */
export const list = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const [messages, toolCalls] = await Promise.all([
      ctx.db
        .query("messages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .collect(),
      ctx.db
        .query("toolCalls")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .collect(),
    ]);
    return [
      ...messages.map((m) => ({ kind: "message" as const, ...m })),
      ...toolCalls.map((t) => ({ kind: "tool" as const, ...t })),
    ].sort((a, b) => a._creationTime - b._creationTime);
  },
});

/**
 * Enqueue a user turn. This is the whole per-message write path: one mutation.
 * The daemon's `watch` subscription picks the run up; no Daytona call is made
 * unless the sandbox is stopped or gone.
 */
export const send = mutation({
  args: { threadId: v.id("threads"), text: v.string() },
  handler: async (ctx, { threadId, text }) => {
    const prompt = text.trim();
    if (!prompt) throw new ConvexError("empty message");
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new ConvexError("thread not found");
    const now = Date.now();
    const userMessageId = await ctx.db.insert("messages", { threadId, role: "user", text: prompt, status: "complete" });
    const runId = await ctx.db.insert("runs", {
      threadId,
      userMessageId,
      prompt,
      status: "queued",
      lastSeq: 0,
      queuedAt: now,
      turns: 0,
    });
    await ctx.db.patch(userMessageId, { runId });
    const patch: { lastActivityAt: number; title?: string } = { lastActivityAt: now };
    if (thread.title === "New thread") patch.title = prompt.length > 48 ? `${prompt.slice(0, 47)}…` : prompt;
    await ctx.db.patch(threadId, patch);
    await logEvent(ctx, { type: "run.queued", threadId, runId, sandboxId: thread.sandboxId });
    await ensureSandboxRunning(ctx, thread);
    return { runId };
  },
});
