/**
 * Maps Pi session events to protocol RunnerEvents. Pure and synchronous: it
 * only calls `push`, so it can be unit-tested with recorded Pi events.
 * Create one bridge per run (message keys are per run).
 */
import {
  capText,
  LIVE_OUTPUT_TAIL_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  tailText,
  type RunnerEventInput,
  type ToolResultPayload,
  type Truncation,
  type UsagePayload,
} from "../../shared/protocol";

/** The subset of Pi's AgentSessionEvent the bridge understands (structural, so tests need no Pi import). */
export type PiEvent =
  | { type: "turn_start" }
  | { type: "message_start"; message: { role: string } }
  | { type: "message_update"; assistantMessageEvent: { type: string; delta?: string } }
  | { type: "message_end"; message: PiMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: string };

interface PiMessage {
  role: string;
  content?: unknown;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; totalTokens: number; cost?: { total: number } };
  stopReason?: string;
  errorMessage?: string;
}

export interface Bridge {
  handle(event: PiEvent): void;
  /** Last assistant message of the run (to decide completed/failed/aborted). */
  readonly lastAssistant: PiMessage | undefined;
  readonly turns: number;
}

export function createBridge(push: (e: RunnerEventInput) => void, now: () => number = Date.now): Bridge {
  let assistantCount = 0;
  let currentKey: string | undefined;
  let turns = 0;
  let lastAssistant: PiMessage | undefined;
  const toolStarts = new Map<string, number>();

  return {
    get lastAssistant() {
      return lastAssistant;
    },
    get turns() {
      return turns;
    },
    handle(event: PiEvent) {
      const at = now();
      switch (event.type) {
        case "turn_start":
          push({ type: "llm_request", turn: ++turns, at });
          return;

        case "message_start": {
          const e = event as Extract<PiEvent, { type: "message_start" }>;
          if (e.message.role === "assistant") currentKey = `a${++assistantCount}`;
          return;
        }

        case "message_update": {
          const e = (event as Extract<PiEvent, { type: "message_update" }>).assistantMessageEvent;
          if (!currentKey || !e.delta) return;
          if (e.type === "text_delta") push({ type: "assistant_delta", messageKey: currentKey, text: e.delta, at });
          else if (e.type === "thinking_delta") push({ type: "assistant_delta", messageKey: currentKey, thinking: e.delta, at });
          return;
        }

        case "message_end": {
          const m = (event as Extract<PiEvent, { type: "message_end" }>).message;
          if (m.role === "assistant") lastAssistant = m;
          push({
            type: "message_end",
            role: m.role,
            messageKey: m.role === "assistant" ? currentKey : undefined,
            raw: m,
            usage: toUsage(m.usage),
            stopReason: m.stopReason,
            at,
          });
          return;
        }

        case "tool_execution_start": {
          const e = event as Extract<PiEvent, { type: "tool_execution_start" }>;
          toolStarts.set(e.toolCallId, at);
          push({ type: "tool_start", toolCallId: e.toolCallId, name: e.toolName, args: e.args, at });
          return;
        }

        case "tool_execution_update": {
          const e = event as Extract<PiEvent, { type: "tool_execution_update" }>;
          const text = contentText(e.partialResult);
          if (text) push({ type: "tool_output", toolCallId: e.toolCallId, tail: tailText(text, LIVE_OUTPUT_TAIL_CHARS), at });
          return;
        }

        case "tool_execution_end": {
          const e = event as Extract<PiEvent, { type: "tool_execution_end" }>;
          const started = toolStarts.get(e.toolCallId) ?? at;
          toolStarts.delete(e.toolCallId);
          push({
            type: "tool_end",
            toolCallId: e.toolCallId,
            result: toToolResult(e.toolName, e.result, e.isError),
            isError: e.isError,
            durationMs: at - started,
            at,
          });
          return;
        }
      }
    },
  };
}

export function toUsage(u: PiMessage["usage"]): UsagePayload | undefined {
  if (!u) return undefined;
  return {
    input: u.input,
    output: u.output,
    cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite,
    reasoning: u.reasoning,
    totalTokens: u.totalTokens,
    costUsd: u.cost?.total ?? 0,
  };
}

export function contentText(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : c.type === "image" ? "[image]" : ""))
    .join("");
}

function slimTruncation(t: unknown): Truncation | undefined {
  if (!t || typeof t !== "object") return undefined;
  const x = t as { truncated?: boolean; outputLines?: number; totalLines?: number };
  return { truncated: !!x.truncated, outputLines: x.outputLines, totalLines: x.totalLines };
}

/**
 * Normalizes Pi's per-tool `details` into the structured shapes in
 * shared/protocol.ts (ToolDetailsByName). Our own tools (glob, webfetch,
 * websearch) already emit protocol details and pass through.
 */
export function toToolResult(name: string, result: unknown, isError: boolean): ToolResultPayload {
  const raw = result as { details?: Record<string, unknown> } | undefined;
  const d = raw?.details ?? {};
  const fullText = contentText(result);
  const { text, truncated } = capText(fullText, MAX_TOOL_OUTPUT_CHARS);
  let details: unknown = d;
  switch (name) {
    case "bash": {
      const code = /exited with code (\d+)/.exec(fullText);
      details = {
        exitCode: code ? Number(code[1]) : isError ? null : 0,
        truncation: slimTruncation(d.truncation),
        fullOutputPath: d.fullOutputPath,
      };
      break;
    }
    case "read":
      details = { truncation: slimTruncation(d.truncation) };
      break;
    case "edit":
      details = { patch: d.patch, firstChangedLine: d.firstChangedLine };
      break;
    case "grep":
      details = {
        matchCount: fullText ? fullText.split("\n").filter((l) => /:\d+[:-]/.test(l)).length : 0,
        matchLimitReached: d.matchLimitReached,
        truncation: slimTruncation(d.truncation),
      };
      break;
  }
  return { text, truncated, details };
}
