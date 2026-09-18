/**
 * Spike S3 (runs locally, no keys needed): the real AgentHost + bridge + sink
 * against Pi's faux LLM provider.
 *   1. a turn that calls bash, write, edit, read, grep, glob, webfetch, websearch
 *   2. transcript rehydration into a brand-new AgentHost (memory survives)
 *   3. abort mid-stream
 * With OPENAI_API_KEY set, pass --openai to also run one real turn.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppendResult, RunnerEvent } from "../../shared/protocol";
import { AgentHost } from "./agentHost";
import { createBridge } from "./bridge";
import { EventSink } from "./eventSink";
import { fakeEgress, importFaux } from "./testing/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok   ${msg}`);
}

function recordingSink() {
  const batches: RunnerEvent[][] = [];
  const sink = new EventSink(async (events): Promise<AppendResult> => {
    await new Promise((r) => setTimeout(r, 15)); // simulated network RTT
    batches.push(events.map((e) => structuredClone(e)));
    return { ackSeq: events[events.length - 1]!.seq, accepted: true, cancelRequested: false };
  });
  return { sink, batches, events: () => batches.flat() };
}

async function main() {
  const faux = await importFaux();
  const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = faux;
  const provider = fauxProvider({ tokensPerSecond: 400 });
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, authPath: join(tmpdir(), "pi-spike-auth.json") });
  modelRuntime.registerNativeProvider(provider.provider);
  const model = provider.getModel();
  const cwd = mkdtempSync(join(tmpdir(), "pi-spike-"));
  console.log(`workspace ${cwd}, faux provider ${provider.provider.id}/${model.id}`);

  // --- 1. all tools in one turn ---
  provider.setResponses([
    fauxAssistantMessage([fauxText("Creating a file. "), fauxToolCall("write", { path: "fib.py", content: "def fib(n):\n    return n\nprint(fib(10))\n" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("edit", { path: "fib.py", edits: [{ oldText: "fib(10)", newText: "fib(20)" }] })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo hello && cat fib.py" })], { stopReason: "toolUse" }),
    fauxAssistantMessage(
      [
        fauxToolCall("read", { path: "fib.py" }),
        fauxToolCall("grep", { pattern: "def", path: "." }),
        fauxToolCall("glob", { pattern: "*.py" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxToolCall("webfetch", { url: "https://example.com" }), fauxToolCall("websearch", { query: "daytona" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("All eight tools worked. The secret word is PINEAPPLE."),
  ]);

  const host = await AgentHost.create({
    threadId: "t1",
    modelId: model.id,
    provider: provider.provider.id,
    modelRuntime,
    cwd,
    egress: fakeEgress,
    messages: [],
    transcriptSeq: 0,
  });
  const r1 = recordingSink();
  r1.sink.push({ type: "run_started", at: Date.now() });
  const b1 = createBridge((e) => r1.sink.push(e));
  const o1 = await host.run("use all tools", b1);
  r1.sink.push({ type: "run_finished", status: o1.status, error: o1.error, at: Date.now() });
  await r1.sink.drain();
  const ev1 = r1.events();
  console.log(`turn 1: ${o1.status}${o1.error ? ` (${o1.error})` : ""}, ${ev1.length} events in ${r1.batches.length} writes, ${b1.turns} LLM turns`);
  assert(o1.status === "completed", "turn 1 completed");
  const ends = ev1.filter((e) => e.type === "tool_end") as Extract<RunnerEvent, { type: "tool_end" }>[];
  const starts = ev1.filter((e) => e.type === "tool_start") as Extract<RunnerEvent, { type: "tool_start" }>[];
  const used = new Set(starts.map((e) => e.name));
  for (const name of ["write", "edit", "bash", "read", "grep", "glob", "webfetch", "websearch"]) assert(used.has(name), `tool ${name} ran`);
  for (const e of ends) {
    const name = starts.find((s) => s.toolCallId === e.toolCallId)?.name;
    console.log(`     ${name}: isError=${e.isError} ${e.durationMs}ms details=${JSON.stringify(e.result.details).slice(0, 120)} text=${JSON.stringify(e.result.text.slice(0, 60))}`);
  }
  assert(ends.every((e) => !e.isError), "no tool errors");
  const seqs = ev1.map((e) => e.seq);
  assert(seqs.every((s, i) => i === 0 || s > seqs[i - 1]!), "seq strictly increasing across batches");
  const deltas = ev1.filter((e) => e.type === "assistant_delta").length;
  console.log(`     assistant_delta events after coalescing: ${deltas}`);
  const transcript = (ev1.filter((e) => e.type === "message_end") as Extract<RunnerEvent, { type: "message_end" }>[]).map((e) => e.raw);
  assert(transcript.length === host.transcriptSeq, `transcriptSeq tracks message_end (${transcript.length})`);

  // --- 2. rehydrate into a fresh host (simulates a new VM) ---
  let sawHistory = 0;
  provider.setResponses([
    (context) => {
      sawHistory = context.messages.length;
      const flat = JSON.stringify(context.messages);
      return fauxAssistantMessage(flat.includes("PINEAPPLE") ? "I remember: PINEAPPLE." : "I have no memory.");
    },
  ]);
  const host2 = await AgentHost.create({
    threadId: "t1",
    modelId: model.id,
    provider: provider.provider.id,
    modelRuntime,
    cwd,
    egress: fakeEgress,
    messages: JSON.parse(JSON.stringify(transcript)),
    transcriptSeq: transcript.length,
  });
  const r2 = recordingSink();
  const b2 = createBridge((e) => r2.sink.push(e));
  const o2 = await host2.run("what was the secret word?", b2);
  await r2.sink.drain();
  const reply = JSON.stringify(b2.lastAssistant?.content ?? "");
  assert(o2.status === "completed" && reply.includes("I remember"), `rehydrated host remembers (context had ${sawHistory} messages)`);

  // --- 3. abort mid-stream ---
  const slow = fauxProvider({ tokensPerSecond: 20, provider: "faux-slow" });
  modelRuntime.registerNativeProvider(slow.provider);
  slow.setResponses([fauxAssistantMessage("word ".repeat(400))]);
  const host3 = await AgentHost.create({
    threadId: "t2",
    modelId: slow.getModel().id,
    provider: slow.provider.id,
    modelRuntime,
    cwd,
    egress: fakeEgress,
    messages: [],
    transcriptSeq: 0,
  });
  const r3 = recordingSink();
  const b3 = createBridge((e) => r3.sink.push(e));
  setTimeout(() => void host3.abort(), 300);
  const t0 = Date.now();
  const o3 = await host3.run("talk forever", b3);
  await r3.sink.drain();
  assert(o3.status === "aborted", `abort -> aborted in ${Date.now() - t0}ms`);

  if (process.argv.includes("--openai")) {
    const real = await AgentHost.create({
      threadId: "t3",
      modelId: process.env.DEFAULT_MODEL || "gpt-5.4-mini",
      cwd,
      egress: fakeEgress,
      messages: [],
      transcriptSeq: 0,
    });
    const r4 = recordingSink();
    const b4 = createBridge((e) => r4.sink.push(e));
    const t1 = Date.now();
    const o4 = await real.run("Run `uname -a` with bash and tell me the kernel name in one word.", b4);
    await r4.sink.drain();
    const firstToken = r4.events().find((e) => e.type === "assistant_delta");
    console.log(`openai turn: ${o4.status} ${o4.error ?? ""} total=${Date.now() - t1}ms firstToken=${firstToken ? firstToken.at - t1 : "n/a"}ms`);
    console.log(JSON.stringify(b4.lastAssistant?.content).slice(0, 300));
  }

  console.log("S3 spike passed");
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
