/**
 * Event ingestion from the VM. One mutation applies a batch of RunnerEvents:
 * the append-only `events` log and the UI projections (`runs`, `messages`,
 * `toolCalls`, `transcript`) change in the same transaction, and the run's
 * lease is extended as a side effect (no separate heartbeat).
 *
 * Replays are idempotent: events with seq <= run.lastSeq are skipped.
 */
import { v } from "convex/values";
import { capText, RUN_LEASE_MS, type AppendResult, type RunnerEvent, type UsagePayload } from "../../shared/protocol";
import type { Doc } from "../_generated/dataModel";
import { mutation, type MutationCtx } from "../_generated/server";
import { timing } from "../config";
import { vRunnerEvent } from "../validators";
import { requireSandbox } from "./auth";

/** High-frequency event types that only update projections (not the timeline). */
const PROJECTION_ONLY: ReadonlySet<RunnerEvent["type"]> = new Set(["assistant_delta", "tool_output", "keepalive"]);

export const append = mutation({
  args: { token: v.string(), bootId: v.string(), runId: v.id("runs"), events: v.array(vRunnerEvent) },
  handler: async (ctx, { token, bootId, runId, events }): Promise<AppendResult> => {
    const sandbox = await requireSandbox(ctx, token);
    let run = await ctx.db.get(runId);
    if (!run || run.sandboxId !== sandbox._id || run.bootId !== bootId) {
      return { ackSeq: run?.lastSeq ?? 0, accepted: false, cancelRequested: true };
    }
    if (run.status !== "claimed" && run.status !== "running") {
      // Terminal already (lease expired, failed by recovery): tell the VM to stop.
      return { ackSeq: run.lastSeq, accepted: false, cancelRequested: true };
    }

    const now = Date.now();
    for (const event of events as RunnerEvent[]) {
      if (event.seq <= run.lastSeq) continue; // replay
      run = await applyEvent(ctx, run, event, now);
      run = { ...run, lastSeq: event.seq };
    }

    const terminal = run.status === "completed" || run.status === "failed" || run.status === "aborted";
    await ctx.db.patch(run._id, {
      ...pickRunFields(run),
      leaseExpiresAt: terminal ? undefined : now + RUN_LEASE_MS,
    });

    if (terminal || now - sandbox.lastActivityAt > timing.activityWriteEveryMs) {
      await ctx.db.patch(sandbox._id, { lastActivityAt: now });
      const thread = await ctx.db.get(run.threadId);
      if (thread) await ctx.db.patch(thread._id, { lastActivityAt: now });
    }
    return { ackSeq: run.lastSeq, accepted: true, cancelRequested: !terminal && run.cancelRequestedAt !== undefined };
  },
});

function pickRunFields(run: Doc<"runs">) {
  const { _id, _creationTime, ...rest } = run;
  void _id;
  void _creationTime;
  return rest;
}

function addUsage(a: UsagePayload | undefined, b: UsagePayload | undefined): UsagePayload | undefined {
  if (!b) return a;
  if (!a) return b;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

async function findMessage(ctx: MutationCtx, run: Doc<"runs">, messageKey: string) {
  return await ctx.db
    .query("messages")
    .withIndex("by_run_key", (q) => q.eq("runId", run._id).eq("messageKey", messageKey))
    .unique();
}

async function findToolCall(ctx: MutationCtx, run: Doc<"runs">, toolCallId: string) {
  return await ctx.db
    .query("toolCalls")
    .withIndex("by_run_toolCallId", (q) => q.eq("runId", run._id).eq("toolCallId", toolCallId))
    .unique();
}

/** Applies one event; returns the (in-memory) updated run. Callers persist run fields once per batch. */
async function applyEvent(ctx: MutationCtx, run: Doc<"runs">, e: RunnerEvent, now: number): Promise<Doc<"runs">> {
  const ids = { threadId: run.threadId, runId: run._id, sandboxId: run.sandboxId };
  if (!PROJECTION_ONLY.has(e.type)) {
    await ctx.db.insert("events", { ...ids, type: `vm.${e.type}`, source: "vm", at: now, vmAt: e.at, data: slimForLog(e) });
  }

  switch (e.type) {
    case "run_started":
      return { ...run, status: "running", vmStartedAt: e.at };

    case "llm_request":
      return { ...run, turns: e.turn, vmLlmRequestAt: run.vmLlmRequestAt ?? e.at };

    case "assistant_delta": {
      const existing = await findMessage(ctx, run, e.messageKey);
      if (existing) {
        await ctx.db.patch(existing._id, {
          text: existing.text + (e.text ?? ""),
          ...(e.thinking ? { thinking: (existing.thinking ?? "") + e.thinking } : {}),
        });
      } else {
        await ctx.db.insert("messages", {
          threadId: run.threadId,
          runId: run._id,
          messageKey: e.messageKey,
          role: "assistant",
          text: e.text ?? "",
          thinking: e.thinking,
          status: "streaming",
        });
      }
      return { ...run, vmFirstTokenAt: run.vmFirstTokenAt ?? e.at };
    }

    case "message_end": {
      const thread = (await ctx.db.get(run.threadId))!;
      const seq = thread.transcriptSeq + 1;
      await ctx.db.insert("transcript", { threadId: run.threadId, runId: run._id, seq, raw: e.raw });
      await ctx.db.patch(thread._id, { transcriptSeq: seq });
      if (e.role === "assistant" && e.messageKey) {
        // Final text from the raw message is authoritative (deltas may have been coalesced/dropped).
        const { text, thinking } = assistantText(e.raw);
        const existing = await findMessage(ctx, run, e.messageKey);
        const fields = {
          text,
          thinking: thinking || undefined,
          status: e.stopReason === "error" || e.stopReason === "aborted" ? ("error" as const) : ("complete" as const),
          stopReason: e.stopReason,
          usage: e.usage,
        };
        if (existing) await ctx.db.patch(existing._id, fields);
        else if (text || thinking) {
          await ctx.db.insert("messages", { threadId: run.threadId, runId: run._id, messageKey: e.messageKey, role: "assistant", ...fields });
        }
      }
      return { ...run, usage: e.role === "assistant" ? addUsage(run.usage, e.usage) : run.usage };
    }

    case "tool_start": {
      if (!(await findToolCall(ctx, run, e.toolCallId))) {
        const prior = await ctx.db
          .query("toolCalls")
          .withIndex("by_thread", (q) => q.eq("threadId", run.threadId))
          .filter((q) => q.eq(q.field("runId"), run._id))
          .collect();
        await ctx.db.insert("toolCalls", {
          threadId: run.threadId,
          runId: run._id,
          seq: prior.length + 1,
          toolCallId: e.toolCallId,
          name: e.name,
          args: e.args,
          status: "running",
          vmStartedAt: e.at,
        });
      }
      return run;
    }

    case "tool_output": {
      const call = await findToolCall(ctx, run, e.toolCallId);
      if (call && call.status === "running") await ctx.db.patch(call._id, { liveOutputTail: e.tail });
      return run;
    }

    case "tool_end": {
      const call = await findToolCall(ctx, run, e.toolCallId);
      if (call) {
        await ctx.db.patch(call._id, {
          status: e.isError ? "error" : "done",
          isError: e.isError,
          result: e.result,
          durationMs: e.durationMs,
          liveOutputTail: undefined,
        });
      }
      return run;
    }

    case "run_finished": {
      // Close anything the VM left open.
      for (const m of await ctx.db
        .query("messages")
        .withIndex("by_run_key", (q) => q.eq("runId", run._id))
        .collect()) {
        if (m.status === "streaming") await ctx.db.patch(m._id, { status: e.status === "completed" ? "complete" : "error" });
      }
      if (e.status !== "completed" && e.error) {
        await ctx.db.insert("messages", {
          threadId: run.threadId,
          runId: run._id,
          messageKey: "run_error",
          role: "assistant",
          text: e.status === "aborted" ? "_Stopped._" : `**Run failed:** ${e.error}`,
          status: "error",
        });
      }
      await ctx.db.insert("events", {
        ...ids,
        type: `run.${e.status}`,
        source: "cp",
        at: now,
        durationMs: now - run.queuedAt,
        data: e.error ? { error: e.error } : undefined,
      });
      return { ...run, status: e.status, error: e.error, endedAt: now, vmEndedAt: e.at, usage: e.usage ?? run.usage };
    }

    case "keepalive":
    case "log":
      return run;
  }
}

/** The timeline keeps summaries; full payloads live in their projection tables. */
function slimForLog(e: RunnerEvent): unknown {
  const { at: _at, type: _type, ...data } = e;
  void _at;
  void _type;
  switch (e.type) {
    case "message_end":
      return { seq: e.seq, role: e.role, messageKey: e.messageKey, stopReason: e.stopReason, usage: e.usage };
    case "tool_start":
      return { seq: e.seq, toolCallId: e.toolCallId, name: e.name, args: capText(JSON.stringify(e.args ?? null), 1_000).text };
    case "tool_end":
      return {
        seq: e.seq,
        toolCallId: e.toolCallId,
        isError: e.isError,
        durationMs: e.durationMs,
        truncated: e.result.truncated,
        chars: e.result.text.length,
      };
    default:
      return data;
  }
}

function assistantText(raw: unknown): { text: string; thinking: string } {
  const content = (raw as { content?: unknown })?.content;
  if (!Array.isArray(content)) return { text: typeof content === "string" ? content : "", thinking: "" };
  let text = "";
  let thinking = "";
  for (const block of content as { type?: string; text?: string; thinking?: string }[]) {
    if (block.type === "text" && block.text) text += block.text;
    if (block.type === "thinking" && block.thinking) thinking += block.thinking;
  }
  return { text, thinking };
}
