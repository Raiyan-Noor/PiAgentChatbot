import { describe, expect, test } from "vitest";
import type { RunnerEventInput } from "../../shared/protocol";
import { createBridge, toToolResult, type PiEvent } from "./bridge";

/** A recorded (trimmed) Pi event stream: one text delta, one bash tool call, final answer. */
const recorded: PiEvent[] = [
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: { role: "user" } },
  { type: "message_end", message: { role: "user", content: "list files" } },
  { type: "message_start", message: { role: "assistant" } },
  { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Checking" } },
  { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{\"com" } },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Checking" }],
      stopReason: "toolUse",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
    },
  },
  { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } },
  { type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "a.txt\n" }] } },
  {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    isError: false,
    result: { content: [{ type: "text", text: "a.txt\nb.txt\n" }], details: { truncation: { truncated: false, content: "x".repeat(10), outputLines: 2, totalLines: 2 } } },
  },
  { type: "message_start", message: { role: "toolResult" } },
  { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "a.txt\nb.txt\n" }] } },
  { type: "turn_end" },
  { type: "turn_start" },
  { type: "message_start", message: { role: "assistant" } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Two files." } },
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Two files." }], stopReason: "stop" } },
  { type: "agent_end" },
];

describe("bridge", () => {
  test("maps a recorded Pi stream to protocol events", () => {
    const out: RunnerEventInput[] = [];
    let clock = 100;
    const bridge = createBridge((e) => out.push(e), () => (clock += 10));
    for (const e of recorded) bridge.handle(e);

    expect(out.map((e) => e.type)).toEqual([
      "llm_request",
      "message_end", // user
      "assistant_delta", // thinking
      "assistant_delta", // text
      "message_end", // assistant a1
      "tool_start",
      "tool_output",
      "tool_end",
      "message_end", // toolResult
      "llm_request",
      "assistant_delta",
      "message_end", // assistant a2
    ]);
    expect(out[2]).toMatchObject({ messageKey: "a1", thinking: "hmm" });
    expect(out[4]).toMatchObject({ role: "assistant", messageKey: "a1", stopReason: "toolUse", usage: { totalTokens: 15, costUsd: 0.001 } });
    expect(out[1]).toMatchObject({ role: "user", messageKey: undefined });
    const end = out[7] as Extract<RunnerEventInput, { type: "tool_end" }>;
    expect(end).toMatchObject({ toolCallId: "call_1", isError: false, durationMs: 20 });
    expect(end.result).toEqual({ text: "a.txt\nb.txt\n", truncated: false, details: { exitCode: 0, truncation: { truncated: false, outputLines: 2, totalLines: 2 }, fullOutputPath: undefined } });
    expect(out[11]).toMatchObject({ messageKey: "a2" });
    expect(bridge.turns).toBe(2);
    expect(bridge.lastAssistant?.stopReason).toBe("stop");
  });

  test("tool result normalization", () => {
    expect(toToolResult("bash", { content: [{ type: "text", text: "boom\n\nCommand exited with code 2" }] }, true).details).toMatchObject({ exitCode: 2 });
    expect(toToolResult("grep", { content: [{ type: "text", text: "a.py:1: def f\nb.py:3: def g" }], details: {} }, false).details).toMatchObject({ matchCount: 2 });
    const big = toToolResult("read", { content: [{ type: "text", text: "x".repeat(100_000) }] }, false);
    expect(big.truncated).toBe(true);
    expect(big.text.length).toBeLessThan(70_000);
  });
});
