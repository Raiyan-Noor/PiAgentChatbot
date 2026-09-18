/**
 * The versioned contract between the control plane (Convex) and the execution
 * plane (the runner daemon inside each Daytona sandbox).
 *
 * Rules:
 * - Anything that crosses the plane boundary is typed here, nowhere else.
 * - This file has no runtime dependencies besides `convex/server` function
 *   references, so both planes can import it.
 * - Breaking changes bump PROTOCOL_VERSION; `register` rejects mismatches, and
 *   the reconciler rolls pooled sandboxes on old snapshots forward.
 */
import { makeFunctionReference } from "convex/server";

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Tunables shared by both planes
// ---------------------------------------------------------------------------

/** A claimed run whose lease is not extended within this window is failed. */
export const RUN_LEASE_MS = 60_000;
/** The runner sends a keepalive when a run has been silent this long. */
export const KEEPALIVE_MS = 20_000;
/** Cap for any single tool output stored in Convex (docs max out at 1 MiB). */
export const MAX_TOOL_OUTPUT_CHARS = 64_000;
/** Cap for the live (streaming) tool output tail shown in the UI. */
export const LIVE_OUTPUT_TAIL_CHARS = 4_000;
/** Default workspace path inside the sandbox. */
export const DEFAULT_WORKSPACE_DIR = "/workspace";

// ---------------------------------------------------------------------------
// Domain enums
// ---------------------------------------------------------------------------

export const SANDBOX_STATES = [
  "provisioning", // Daytona create in flight (or daemon not registered yet)
  "pooled", // booted, daemon connected, no thread assigned
  "ready", // bound to a thread, daemon connected
  "stopping",
  "stopped",
  "starting", // Daytona start in flight (or daemon not registered yet)
  "error",
  "deleting",
  "deleted",
] as const;
export type SandboxState = (typeof SANDBOX_STATES)[number];

export const RUN_STATUSES = ["queued", "claimed", "running", "completed", "failed", "aborted"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "claimed", "running"];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "aborted"];

export const TOOL_NAMES = ["bash", "read", "write", "edit", "grep", "glob", "webfetch", "websearch"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Structured tool details (rendered by the UI, one renderer per tool)
// ---------------------------------------------------------------------------

export interface Truncation {
  truncated: boolean;
  outputLines?: number;
  totalLines?: number;
}

// Inputs (command, path, pattern, ...) are in the tool call args; details carry outcomes only.
export interface BashDetails {
  exitCode?: number | null;
  truncation?: Truncation;
  fullOutputPath?: string;
}
export interface ReadDetails {
  truncation?: Truncation;
}
export type WriteDetails = Record<string, never>;
export interface EditDetails {
  patch?: string;
  firstChangedLine?: number;
}
export interface GrepDetails {
  matchCount: number;
  matchLimitReached?: number;
  truncation?: Truncation;
}
export interface GlobDetails {
  paths: string[];
  resultLimitReached?: number;
}
export interface WebfetchDetails {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: number;
  truncated: boolean;
}
export interface WebsearchDetails {
  query: string;
  results: WebsearchResult[];
}
export interface WebsearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface ToolDetailsByName {
  bash: BashDetails;
  read: ReadDetails;
  write: WriteDetails;
  edit: EditDetails;
  grep: GrepDetails;
  glob: GlobDetails;
  webfetch: WebfetchDetails;
  websearch: WebsearchDetails;
}

export interface ToolResultPayload {
  /** Text content the model saw (capped at MAX_TOOL_OUTPUT_CHARS). */
  text: string;
  /** Structured, tool-specific details (see ToolDetailsByName). */
  details?: unknown;
  /** True when `text` was cut to fit the cap. */
  truncated: boolean;
}

export interface UsagePayload {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Runner -> control plane events (execution/ingest:append)
// ---------------------------------------------------------------------------

/** Every event carries a per-run monotonic `seq` and the VM clock `at` (ms). */
interface EventBase {
  seq: number;
  at: number;
}

export type RunnerEvent = EventBase &
  (
    | { type: "run_started" }
    /** One LLM request starts (Pi `turn_start`). */
    | { type: "llm_request"; turn: number }
    /** Coalesced text/thinking delta for one assistant message. */
    | { type: "assistant_delta"; messageKey: string; text?: string; thinking?: string }
    /** A complete Pi AgentMessage (user, assistant, or toolResult). Goes to the transcript. */
    | { type: "message_end"; messageKey?: string; role: string; raw: unknown; usage?: UsagePayload; stopReason?: string }
    | { type: "tool_start"; toolCallId: string; name: string; args: unknown }
    /** Coalesced live output: `tail` replaces the previous tail. */
    | { type: "tool_output"; toolCallId: string; tail: string }
    | { type: "tool_end"; toolCallId: string; result: ToolResultPayload; isError: boolean; durationMs: number }
    | { type: "run_finished"; status: "completed" | "failed" | "aborted"; error?: string; usage?: UsagePayload }
    | { type: "keepalive" }
    | { type: "log"; level: "debug" | "info" | "warn" | "error"; msg: string; data?: unknown }
  );

export type RunnerEventType = RunnerEvent["type"];

/** An event before the sink stamps `seq`. */
export type RunnerEventInput = RunnerEvent extends infer E ? (E extends RunnerEvent ? Omit<E, "seq"> : never) : never;

// ---------------------------------------------------------------------------
// Function references the VM may call (and nothing else)
// ---------------------------------------------------------------------------

export interface RegisterArgs {
  token: string;
  bootId: string;
  protocolVersion: number;
  runnerVersion: string;
  /** Process start -> register call, VM clock. */
  bootMs: number;
}
export interface RegisterResult {
  sandboxId: string;
  state: SandboxState;
}

export interface WatchArgs {
  token: string;
  bootId: string;
}
export interface WatchResult {
  sandboxId: string;
  state: SandboxState;
  threadId: string | null;
  model: string | null;
  /** Oldest queued run for the thread, if no other run is active. */
  nextRun: { runId: string } | null;
  /** Run owned by this boot whose cancellation was requested. */
  cancelRunId: string | null;
}

export interface ClaimRunArgs {
  token: string;
  bootId: string;
  runId: string;
}
export type ClaimRunResult =
  | { ok: true; prompt: string; model: string; threadId: string; transcriptSeq: number }
  | { ok: false; reason: string };

export interface TranscriptArgs {
  token: string;
}
export interface TranscriptResult {
  threadId: string | null;
  transcriptSeq: number;
  messages: unknown[];
}

export interface AppendArgs {
  token: string;
  bootId: string;
  runId: string;
  events: RunnerEvent[];
}
export interface AppendResult {
  /** Highest seq the control plane has applied for this run. */
  ackSeq: number;
  /** False when the run is no longer this boot's (terminal, lease lost): drop further events. */
  accepted: boolean;
  /** The user asked to stop: abort the agent, but keep sending events until run_finished. */
  cancelRequested: boolean;
}

export interface WebfetchArgs {
  token: string;
  url: string;
  maxChars?: number;
}
export interface WebfetchResult extends WebfetchDetails {
  text: string;
}

export interface WebsearchArgs {
  token: string;
  query: string;
  maxResults?: number;
}
export interface WebsearchResultPayload {
  query: string;
  answer?: string;
  results: WebsearchResult[];
}

/** Convex function args must be string-indexable; interfaces aren't, so widen them here. */
type Fn<T> = T & Record<string, unknown>;

export const executionApi = {
  register: makeFunctionReference<"mutation", Fn<RegisterArgs>, RegisterResult>("execution/inbox:register"),
  watch: makeFunctionReference<"query", Fn<WatchArgs>, WatchResult | null>("execution/inbox:watch"),
  transcript: makeFunctionReference<"query", Fn<TranscriptArgs>, TranscriptResult>("execution/inbox:transcript"),
  claimRun: makeFunctionReference<"mutation", Fn<ClaimRunArgs>, ClaimRunResult>("execution/inbox:claimRun"),
  append: makeFunctionReference<"mutation", Fn<AppendArgs>, AppendResult>("execution/ingest:append"),
  webfetch: makeFunctionReference<"action", Fn<WebfetchArgs>, WebfetchResult>("execution/egress:webfetch"),
  websearch: makeFunctionReference<"action", Fn<WebsearchArgs>, WebsearchResultPayload>("execution/egress:websearch"),
};

// ---------------------------------------------------------------------------
// Small pure helpers used by both planes
// ---------------------------------------------------------------------------

/** Keep the head of `text` within `max` chars. */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`, truncated: true };
}

/** Keep the tail of `text` within `max` chars. */
export function tailText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}
