/**
 * The VM's inbox. The daemon subscribes to `watch` over its WebSocket, so a new
 * message reaches the VM as a query push — no Daytona API call, no exec, no
 * process spawn on the per-message path.
 */
import { ConvexError, v } from "convex/values";
import {
  ACTIVE_RUN_STATUSES,
  PROTOCOL_VERSION,
  RUN_LEASE_MS,
  type ClaimRunResult,
  type RegisterResult,
  type TranscriptResult,
  type WatchResult,
} from "../../shared/protocol";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../_generated/server";
import { finishRun } from "../lifecycle/pool";
import { transition } from "../lifecycle/stateMachine";
import { logEvent } from "../lib/log";
import { requireSandbox, sandboxForToken } from "./auth";

/** Oldest non-terminal run of a thread (strict FIFO). */
export async function headRun(ctx: QueryCtx, threadId: Id<"threads">): Promise<Doc<"runs"> | null> {
  let head: Doc<"runs"> | null = null;
  for (const status of ACTIVE_RUN_STATUSES) {
    const run = await ctx.db
      .query("runs")
      .withIndex("by_thread_status", (q) => q.eq("threadId", threadId).eq("status", status))
      .order("asc")
      .first();
    if (run && (!head || run.queuedAt < head.queuedAt)) head = run;
  }
  return head;
}

export const register = mutation({
  args: {
    token: v.string(),
    bootId: v.string(),
    protocolVersion: v.number(),
    runnerVersion: v.string(),
    bootMs: v.number(),
  },
  handler: async (ctx, args): Promise<RegisterResult> => {
    let sandbox = await requireSandbox(ctx, args.token);
    const now = Date.now();
    if (args.protocolVersion !== PROTOCOL_VERSION) {
      await logEvent(ctx, {
        type: "sandbox.protocol_mismatch",
        sandboxId: sandbox._id,
        threadId: sandbox.threadId,
        data: { vm: args.protocolVersion, cp: PROTOCOL_VERSION, runnerVersion: args.runnerVersion },
      });
      throw new ConvexError({ code: "protocol_mismatch", expected: PROTOCOL_VERSION, got: args.protocolVersion });
    }

    // A new boot means any run claimed by a previous boot is dead. Fail it now instead of waiting for the lease.
    if (sandbox.threadId && sandbox.bootId !== args.bootId) {
      for (const status of ["claimed", "running"] as const) {
        for (const run of await ctx.db
          .query("runs")
          .withIndex("by_thread_status", (q) => q.eq("threadId", sandbox.threadId!).eq("status", status))
          .collect()) {
          if (run.bootId !== args.bootId) await finishRun(ctx, run, run.cancelRequestedAt ? "aborted" : "failed", "runner restarted mid-run");
        }
      }
    }

    const readyMs = sandbox.spans.requestedAt ? now - sandbox.spans.requestedAt : undefined;
    const patch = {
      bootId: args.bootId,
      protocolVersion: args.protocolVersion,
      runnerVersion: args.runnerVersion,
      lastActivityAt: now,
      lastRefreshAt: now,
      error: undefined,
      spans: { ...sandbox.spans, daemonBootMs: args.bootMs, readyMs },
    };
    const target = sandbox.threadId ? "ready" : "pooled";
    if (sandbox.state === target) {
      // Daemon restart inside a running VM (crash loop in entrypoint) or reconnect.
      await ctx.db.patch(sandbox._id, patch);
    } else if (sandbox.state === "stopping") {
      // Let the stop finish; the daemon will be killed with the VM.
      await ctx.db.patch(sandbox._id, { bootId: args.bootId });
    } else {
      sandbox = await transition(ctx, sandbox, target, "daemon_registered", { ...patch, pendingOp: undefined });
    }
    await logEvent(ctx, {
      type: "sandbox.registered",
      sandboxId: sandbox._id,
      threadId: sandbox.threadId,
      durationMs: readyMs,
      data: { bootId: args.bootId, bootMs: args.bootMs, runnerVersion: args.runnerVersion },
    });
    return { sandboxId: sandbox._id, state: sandbox.state };
  },
});

export const watch = query({
  args: { token: v.string(), bootId: v.string() },
  handler: async (ctx, { token, bootId }): Promise<WatchResult | null> => {
    const sandbox = await sandboxForToken(ctx, token);
    if (!sandbox) return null; // revoked: the daemon exits
    const base = { sandboxId: sandbox._id, state: sandbox.state, nextRun: null, cancelRunId: null };
    if (!sandbox.threadId || sandbox.state !== "ready") return { ...base, threadId: null, model: null };
    const thread = await ctx.db.get(sandbox.threadId);
    if (!thread || thread.sandboxId !== sandbox._id) return { ...base, threadId: null, model: null };
    const head = await headRun(ctx, thread._id);
    return {
      ...base,
      threadId: thread._id,
      model: thread.model,
      nextRun: head && head.status === "queued" ? { runId: head._id } : null,
      cancelRunId: head && head.status !== "queued" && head.bootId === bootId && head.cancelRequestedAt ? head._id : null,
    };
  },
});

export const transcript = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<TranscriptResult> => {
    const sandbox = await requireSandbox(ctx, token);
    if (!sandbox.threadId) return { threadId: null, transcriptSeq: 0, messages: [] };
    const thread = await ctx.db.get(sandbox.threadId);
    const entries = await ctx.db
      .query("transcript")
      .withIndex("by_thread_seq", (q) => q.eq("threadId", sandbox.threadId!))
      .collect();
    return { threadId: sandbox.threadId, transcriptSeq: thread?.transcriptSeq ?? 0, messages: entries.map((e) => e.raw) };
  },
});

export const claimRun = mutation({
  args: { token: v.string(), bootId: v.string(), runId: v.id("runs") },
  handler: async (ctx, { token, bootId, runId }): Promise<ClaimRunResult> => {
    const sandbox = await requireSandbox(ctx, token);
    const run = await ctx.db.get(runId);
    if (!run || run.threadId !== sandbox.threadId) return { ok: false, reason: "not_your_run" };
    if (sandbox.state !== "ready" || sandbox.bootId !== bootId) return { ok: false, reason: "stale_boot" };
    if (run.status !== "queued") return { ok: false, reason: `status_${run.status}` };
    const head = await headRun(ctx, run.threadId);
    if (head?._id !== run._id) return { ok: false, reason: "not_head" };
    const thread = (await ctx.db.get(run.threadId))!;
    const now = Date.now();
    await ctx.db.patch(run._id, {
      status: "claimed",
      sandboxId: sandbox._id,
      bootId,
      claimedAt: now,
      leaseExpiresAt: now + RUN_LEASE_MS,
    });
    await ctx.db.patch(sandbox._id, { lastActivityAt: now });
    await logEvent(ctx, {
      type: "run.claimed",
      threadId: run.threadId,
      runId,
      sandboxId: sandbox._id,
      durationMs: now - run.queuedAt,
      data: { bootId },
    });
    return { ok: true, prompt: run.prompt, model: thread.model, threadId: thread._id, transcriptSeq: thread.transcriptSeq };
  },
});
