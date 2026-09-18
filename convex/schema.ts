import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vRunStatus, vSandboxState, vUsage } from "./validators";

export default defineSchema({
  /** A conversation. Owns its sandbox pointer and transcript cursor. */
  threads: defineTable({
    title: v.string(),
    model: v.string(),
    sandboxId: v.optional(v.id("sandboxes")),
    /** Number of transcript entries; the VM compares it to detect stale memory. */
    transcriptSeq: v.number(),
    lastActivityAt: v.number(),
  }).index("by_lastActivity", ["lastActivityAt"]),

  /** Thread <-> VM mapping and lifecycle. One row per Daytona sandbox ever created. */
  sandboxes: defineTable({
    state: vSandboxState,
    stateChangedAt: v.number(),
    threadId: v.optional(v.id("threads")),
    daytonaId: v.optional(v.string()),
    /** SHA-256 of the sandbox token. The plaintext only ever lives in the VM env. */
    tokenHash: v.string(),
    snapshot: v.string(),
    /** True when this row was created cold for a thread (not taken from the pool). */
    cold: v.boolean(),
    protocolVersion: v.optional(v.number()),
    runnerVersion: v.optional(v.string()),
    bootId: v.optional(v.string()),
    lastActivityAt: v.number(),
    lastRefreshAt: v.optional(v.number()),
    error: v.optional(v.string()),
    /** In-flight Daytona operation; dedupes scheduling across reconcile ticks. */
    pendingOp: v.optional(v.object({ op: v.string(), at: v.number() })),
    spans: v.object({
      /** Daytona create() wall time (control-plane clock). */
      createMs: v.optional(v.number()),
      /** Daytona start() wall time (control-plane clock). */
      startMs: v.optional(v.number()),
      /** Process start -> register (VM clock). */
      daemonBootMs: v.optional(v.number()),
      /** When the current lifecycle operation (create/start) was requested. */
      requestedAt: v.optional(v.number()),
      /** requestedAt -> register (control-plane clock). */
      readyMs: v.optional(v.number()),
    }),
  })
    .index("by_state", ["state"])
    .index("by_tokenHash", ["tokenHash"])
    .index("by_thread", ["threadId"])
    .index("by_daytonaId", ["daytonaId"]),

  /** One user turn. Strict FIFO per thread; at most one active (claimed/running). */
  runs: defineTable({
    threadId: v.id("threads"),
    userMessageId: v.id("messages"),
    prompt: v.string(),
    status: vRunStatus,
    sandboxId: v.optional(v.id("sandboxes")),
    bootId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    cancelRequestedAt: v.optional(v.number()),
    /** Highest applied event seq (idempotent replay). */
    lastSeq: v.number(),
    // Control-plane clock
    queuedAt: v.number(),
    claimedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    // VM clock (within-run spans are measured on one clock)
    vmStartedAt: v.optional(v.number()),
    vmLlmRequestAt: v.optional(v.number()),
    vmFirstTokenAt: v.optional(v.number()),
    vmEndedAt: v.optional(v.number()),
    turns: v.number(),
    usage: v.optional(vUsage),
    error: v.optional(v.string()),
  })
    .index("by_thread_status", ["threadId", "status"])
    .index("by_status", ["status"]),

  /** UI chat bubbles (projection of the event log). */
  messages: defineTable({
    threadId: v.id("threads"),
    runId: v.optional(v.id("runs")),
    messageKey: v.optional(v.string()),
    role: v.union(v.literal("user"), v.literal("assistant")),
    text: v.string(),
    thinking: v.optional(v.string()),
    status: v.union(v.literal("streaming"), v.literal("complete"), v.literal("error")),
    stopReason: v.optional(v.string()),
    usage: v.optional(vUsage),
  })
    .index("by_thread", ["threadId"])
    .index("by_run_key", ["runId", "messageKey"]),

  /** Tool usage history (projection of the event log). */
  toolCalls: defineTable({
    threadId: v.id("threads"),
    runId: v.id("runs"),
    /** Order within the run. */
    seq: v.number(),
    toolCallId: v.string(),
    name: v.string(),
    args: v.any(),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("error")),
    liveOutputTail: v.optional(v.string()),
    result: v.optional(v.object({ text: v.string(), details: v.optional(v.any()), truncated: v.boolean() })),
    isError: v.optional(v.boolean()),
    vmStartedAt: v.number(),
    durationMs: v.optional(v.number()),
  })
    .index("by_thread", ["threadId"])
    .index("by_run_toolCallId", ["runId", "toolCallId"]),

  /** Exact LLM context (raw Pi AgentMessages) used to rehydrate a fresh VM. */
  transcript: defineTable({
    threadId: v.id("threads"),
    seq: v.number(),
    runId: v.id("runs"),
    raw: v.any(),
  }).index("by_thread_seq", ["threadId", "seq"]),

  /** Append-only timeline and audit log for both planes. */
  events: defineTable({
    type: v.string(),
    source: v.union(v.literal("vm"), v.literal("cp")),
    /** Control-plane clock. */
    at: v.number(),
    /** VM clock, for events that originated in the VM. */
    vmAt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    threadId: v.optional(v.id("threads")),
    runId: v.optional(v.id("runs")),
    sandboxId: v.optional(v.id("sandboxes")),
    data: v.optional(v.any()),
  })
    .index("by_thread", ["threadId"])
    .index("by_run", ["runId"])
    .index("by_sandbox", ["sandboxId"]),
});
