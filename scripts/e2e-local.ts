/**
 * Local end-to-end test of both planes without Daytona or API keys:
 *   real Convex functions (local or cloud dev deployment) <-> real runner Daemon
 *   (in this process, over its own ConvexClient WebSocket) with a faux LLM.
 *
 *   npx convex dev          (in another terminal, or `--once` beforehand)
 *   npm run e2e:local
 *
 * Covers: dispatch via subscription, claim, streaming ingest, tool projections,
 * egress broker (webfetch), transcript, cancel, daemon restart + rehydration,
 * and FIFO queueing of two messages.
 */
import { ConvexClient } from "convex/browser";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { AgentHost } from "../runner/src/agentHost";
import { ControlPlane } from "../runner/src/controlPlane";
import { Daemon } from "../runner/src/daemon";
import { fauxRuntime } from "../runner/src/testing/faux";
import { loadEnvLocal } from "./util";

const env = loadEnvLocal();
const url = process.env.CONVEX_URL ?? env.VITE_CONVEX_URL;
if (!url) throw new Error("No Convex URL (run `npx convex dev` first)");

let failures = 0;
function check(cond: unknown, msg: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 20_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function main() {
  const client = new ConvexClient(url!);
  const { faux, handle, modelRuntime, provider, modelId } = await fauxRuntime({ tokensPerSecond: 300 });
  const { fauxAssistantMessage: msg, fauxToolCall: call, fauxText: text } = faux;
  const workspace = mkdtempSync(join(tmpdir(), "pi-e2e-"));

  // --- thread + local runner binding ---
  const { threadId } = await client.mutation(api.threads.create, { title: "e2e local", cold: true });
  const token = randomBytes(32).toString("base64url");
  await client.mutation(api.admin.attachLocalRunner, { threadId, tokenHash: createHash("sha256").update(token).digest("hex") });

  const startDaemon = async () => {
    const cp = new ControlPlane(url!, token, randomUUID());
    const daemon = new Daemon(cp, {
      workspace,
      createHost: (opts) => AgentHost.create({ ...opts, provider, modelId, modelRuntime }),
      fatal: (code, reason) => {
        throw new Error(`daemon fatal ${code}: ${reason}`);
      },
    });
    const t0 = Date.now();
    await daemon.start();
    const ready = await waitFor("sandbox ready", async () => {
      const t = await client.query(api.threads.get, { threadId });
      return t?.sandbox?.state === "ready" && t.sandbox;
    });
    return { daemon, cp, registerMs: Date.now() - t0, sandbox: ready };
  };

  let d = await startDaemon();
  check(true, `daemon registered, sandbox ready in ${d.registerMs}ms (bootId ${d.sandbox.bootId?.slice(0, 8)})`);

  const runStatus = async (runId: Id<"runs">) => (await client.query(api.runs.listByThread, { threadId })).find((r) => r._id === runId);

  // --- turn 1: tools + streaming ---
  handle.setResponses([
    msg([text("Writing a script. "), call("write", { path: "fib.py", content: "print([0,1,1,2,3,5,8])\n" })], { stopReason: "toolUse" }),
    msg([call("bash", { command: "cat fib.py && echo done" }), call("glob", { pattern: "*.py" }), call("grep", { pattern: "print", path: "." })], {
      stopReason: "toolUse",
    }),
    msg([call("webfetch", { url: "https://example.com" }), call("websearch", { query: "daytona sandboxes" })], { stopReason: "toolUse" }),
    msg("Done. The secret word is PINEAPPLE. " + "streaming ".repeat(40)),
  ]);
  const tSend = Date.now();
  const { runId } = await client.mutation(api.messages.send, { threadId, text: "run the tools" });
  let firstDeltaAt = 0;
  const unsub = client.onUpdate(api.messages.list, { threadId }, (items) => {
    if (!firstDeltaAt && items.some((i) => i.kind === "message" && i.role === "assistant" && i.text.length > 0)) firstDeltaAt = Date.now();
  });
  const run1 = await waitFor("run 1 done", async () => {
    const r = await runStatus(runId);
    return r && ["completed", "failed", "aborted"].includes(r.status) && r;
  });
  unsub.unsubscribe();
  check(run1.status === "completed", `run 1 ${run1.status} ${run1.error ?? ""}`);
  check(run1.claimedAt! - run1.queuedAt < 1000, `dispatch (queued -> claimed, CP clock): ${run1.claimedAt! - run1.queuedAt}ms`);
  console.log(`     client send -> first assistant text visible: ${firstDeltaAt - tSend}ms; VM run_started -> llm_request: ${run1.vmLlmRequestAt! - run1.vmStartedAt!}ms; total ${run1.endedAt! - run1.queuedAt}ms`);

  const items = await client.query(api.messages.list, { threadId });
  const tools = items.filter((i) => i.kind === "tool");
  const names = tools.map((t) => (t.kind === "tool" ? t.name : ""));
  check(["write", "bash", "glob", "grep", "webfetch", "websearch"].every((n) => names.includes(n)), `tool calls projected: ${names.join(", ")}`);
  const byName = (n: string) => tools.find((t) => t.kind === "tool" && t.name === n) as Extract<(typeof tools)[number], { kind: "tool" }>;
  check(byName("bash")?.result?.text.includes("done"), "bash output stored");
  check(byName("webfetch")?.status === "done" && /HTTP 200/.test(byName("webfetch")!.result!.text), `webfetch via egress broker: ${byName("webfetch")?.result?.text.slice(0, 40)}`);
  check(byName("websearch")?.status !== "running", `websearch settled (${byName("websearch")?.status}; error expected without TAVILY_API_KEY)`);
  const assistant = items.filter((i) => i.kind === "message" && i.role === "assistant");
  check(assistant.some((m) => m.kind === "message" && m.text.includes("PINEAPPLE") && m.status === "complete"), "assistant message complete");
  const transcript = await client.query(api.observability.transcript, { threadId });
  const thread = await client.query(api.threads.get, { threadId });
  check(transcript.length > 0 && transcript.length === thread?.transcriptSeq, `transcript persisted (${transcript.length} entries)`);
  const events = await client.query(api.observability.events, { threadId, limit: 500 });
  const writes = new Set(events.filter((e) => e.source === "vm").map((e) => e.at)).size;
  check(events.some((e) => e.type === "egress.webfetch"), "egress logged on timeline");
  console.log(`     ${events.length} timeline events, ~${writes} ingest transactions for run 1`);

  // --- turn 2 + 3 queued back to back (FIFO) ---
  handle.setResponses([msg("first"), msg("second")]);
  const a = await client.mutation(api.messages.send, { threadId, text: "one" });
  const b = await client.mutation(api.messages.send, { threadId, text: "two" });
  const [ra, rb] = await waitFor("fifo runs", async () => {
    const ra = await runStatus(a.runId);
    const rb = await runStatus(b.runId);
    return ra?.status === "completed" && rb?.status === "completed" && ([ra, rb] as const);
  });
  check(ra.endedAt! <= rb.claimedAt!, "FIFO: second run claimed only after first ended");

  // --- cancel mid-stream ---
  handle.setResponses([msg("slow ".repeat(2000))]);
  const c = await client.mutation(api.messages.send, { threadId, text: "talk a lot" });
  await waitFor("streaming", async () => (await runStatus(c.runId))?.vmFirstTokenAt);
  const tCancel = Date.now();
  await client.mutation(api.runs.cancel, { runId: c.runId });
  const rc = await waitFor("aborted", async () => {
    const r = await runStatus(c.runId);
    return r && r.status !== "running" && r.status !== "claimed" && r;
  });
  check(rc.status === "aborted", `cancel -> ${rc.status} in ${Date.now() - tCancel}ms`);

  // --- daemon restart: new process state, memory from Convex ---
  d.daemon.stop();
  await d.cp.close();
  d = await startDaemon();
  handle.setResponses([
    (context) => msg(JSON.stringify(context.messages).includes("PINEAPPLE") ? "I remember PINEAPPLE" : "no memory"),
  ]);
  const m = await client.mutation(api.messages.send, { threadId, text: "what was the secret word?" });
  await waitFor("memory run", async () => (await runStatus(m.runId))?.status === "completed");
  const after = await client.query(api.messages.list, { threadId });
  check(after.some((i) => i.kind === "message" && i.text.includes("I remember PINEAPPLE")), "restarted daemon rehydrated conversation from Convex");

  d.daemon.stop();
  await d.cp.close();
  if (process.env.KEEP) console.log(`kept thread ${threadId}`);
  else await client.mutation(api.threads.remove, { threadId });
  await client.close();
  console.log(failures === 0 ? "\nE2E local: all checks passed" : `\nE2E local: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
