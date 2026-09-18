import { v } from "convex/values";
import { RUN_STATUSES, SANDBOX_STATES } from "../shared/protocol";

function literals<T extends string>(values: readonly T[]) {
  const [a, b, ...rest] = values.map((x) => v.literal(x));
  return v.union(a!, b!, ...rest);
}

export const vSandboxState = literals(SANDBOX_STATES);
export const vRunStatus = literals(RUN_STATUSES);

export const vUsage = v.object({
  input: v.number(),
  output: v.number(),
  cacheRead: v.number(),
  cacheWrite: v.number(),
  reasoning: v.optional(v.number()),
  totalTokens: v.number(),
  costUsd: v.number(),
});

const base = { seq: v.number(), at: v.number() };

/** Boundary validation for RunnerEvent (shared/protocol.ts). Payload bodies stay `any`. */
export const vRunnerEvent = v.union(
  v.object({ ...base, type: v.literal("run_started") }),
  v.object({ ...base, type: v.literal("llm_request"), turn: v.number() }),
  v.object({
    ...base,
    type: v.literal("assistant_delta"),
    messageKey: v.string(),
    text: v.optional(v.string()),
    thinking: v.optional(v.string()),
  }),
  v.object({
    ...base,
    type: v.literal("message_end"),
    messageKey: v.optional(v.string()),
    role: v.string(),
    raw: v.any(),
    usage: v.optional(vUsage),
    stopReason: v.optional(v.string()),
  }),
  v.object({ ...base, type: v.literal("tool_start"), toolCallId: v.string(), name: v.string(), args: v.any() }),
  v.object({ ...base, type: v.literal("tool_output"), toolCallId: v.string(), tail: v.string() }),
  v.object({
    ...base,
    type: v.literal("tool_end"),
    toolCallId: v.string(),
    result: v.object({ text: v.string(), details: v.optional(v.any()), truncated: v.boolean() }),
    isError: v.boolean(),
    durationMs: v.number(),
  }),
  v.object({
    ...base,
    type: v.literal("run_finished"),
    status: v.union(v.literal("completed"), v.literal("failed"), v.literal("aborted")),
    error: v.optional(v.string()),
    usage: v.optional(vUsage),
  }),
  v.object({ ...base, type: v.literal("keepalive") }),
  v.object({
    ...base,
    type: v.literal("log"),
    level: v.union(v.literal("debug"), v.literal("info"), v.literal("warn"), v.literal("error")),
    msg: v.string(),
    data: v.optional(v.any()),
  }),
);
