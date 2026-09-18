/**
 * Live acceptance test against real Daytona + OpenAI + Tavily.
 *
 *   npx tsx scripts/e2e-daytona.ts [--keep]
 *
 * 1. new thread (warm pool) -> ready
 * 2. one prompt exercising all 8 tools, streamed
 * 3. stop mid-run -> aborted
 * 4. idle/operator stop -> resume -> the agent still remembers, files still there
 * 5. VM deleted behind our back -> recreated, conversation kept, workspace reset logged
 * 6. cleanup -> no orphaned sandboxes left for this deployment
 */
import { Daytona } from "@daytona/sdk";
import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { loadEnvLocal } from "./util";

const env = loadEnvLocal();
const url = env.VITE_CONVEX_URL;
if (!url) throw new Error("VITE_CONVEX_URL missing (run `npx convex dev`)");
const client = new ConvexClient(url);
const daytona = new Daytona({ apiKey: env.DAYTONA_API_KEY, apiUrl: env.DAYTONA_API_URL, target: env.DAYTONA_TARGET });
const deployment = url.replace(/^https?:\/\//, "").split(".")[0]!;

let failures = 0;
function check(cond: unknown, msg: string) {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures++;
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 180_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const getThread = (threadId: Id<"threads">) => client.query(api.threads.get, { threadId });
const getRun = async (threadId: Id<"threads">, runId: Id<"runs">) =>
  (await client.query(api.runs.listByThread, { threadId })).find((r) => r._id === runId);
const settled = ["completed", "failed", "aborted"];

async function send(threadId: Id<"threads">, text: string) {
  const t0 = Date.now();
  const { runId } = await client.mutation(api.messages.send, { threadId, text });
  const run = await waitFor(`run "${text.slice(0, 30)}"`, async () => {
    const r = await getRun(threadId, runId);
    return r && settled.includes(r.status) && r;
  });
  return { run, clientMs: Date.now() - t0 };
}

async function assistantText(threadId: Id<"threads">, runId: Id<"runs">) {
  const items = await client.query(api.messages.list, { threadId });
  return items
    .filter((i) => i.kind === "message" && i.role === "assistant" && i.runId === runId)
    .map((i) => (i.kind === "message" ? i.text : ""))
    .join("\n");
}

async function main() {
  // 1. new thread from the warm pool
  const t0 = Date.now();
  const { threadId, fromPool } = await client.mutation(api.threads.create, { title: "live acceptance" });
  const ready = await waitFor("sandbox ready", async () => {
    const t = await getThread(threadId);
    if (t?.sandbox?.state === "error") throw new Error(`sandbox error: ${t.sandbox.error}`);
    return t?.sandbox?.state === "ready" && t.sandbox;
  });
  check(true, `thread ready in ${Date.now() - t0}ms (${fromPool ? "warm pool" : "cold"}), daytonaId ${ready.daytonaId}`);
  const firstDaytonaId = ready.daytonaId;

  // 2. all eight tools in one turn
  const tools = await send(
    threadId,
    "Do all of these in order, using your tools: create fib.py that prints the first 10 Fibonacci numbers; run it with bash; " +
      "edit it to print 20 terms and run it again; read fib.py back with the read tool; grep for 'def' in the workspace; glob for *.py; " +
      "fetch https://example.com; and search the web for 'Daytona sandboxes'. " +
      "Then reply with one short sentence and the exact word PINEAPPLE.",
  );
  check(tools.run.status === "completed", `tool run ${tools.run.status} in ${tools.clientMs}ms (${tools.run.turns} LLM turns) ${tools.run.error ?? ""}`);
  const items = await client.query(api.messages.list, { threadId });
  const calls = items.filter((i) => i.kind === "tool") as Extract<(typeof items)[number], { kind: "tool" }>[];
  const used = new Set(calls.map((c) => c.name));
  for (const name of ["write", "bash", "edit", "read", "grep", "glob", "webfetch", "websearch"]) {
    check(used.has(name), `tool used: ${name}`);
  }
  const errored = calls.filter((c) => c.isError);
  check(errored.length === 0, `no tool errors${errored.length ? `: ${errored.map((c) => `${c.name}: ${c.result?.text.slice(0, 80)}`).join(" | ")}` : ""}`);
  const search = calls.find((c) => c.name === "websearch");
  check(
    !!search && Array.isArray((search.result?.details as { results?: unknown[] })?.results) && (search.result!.details as { results: unknown[] }).results.length > 0,
    `websearch returned results via the egress broker (Tavily key never entered the VM)`,
  );
  const fetched = calls.find((c) => c.name === "webfetch");
  check(/HTTP 200/.test(fetched?.result?.text ?? ""), "webfetch reached example.com through Convex (blocked from the VM itself)");
  check(/PINEAPPLE/.test(await assistantText(threadId, tools.run._id)), "assistant answered with the marker word");
  const usage = tools.run.usage;
  console.log(`     usage: ${usage?.input}→${usage?.output} tokens, $${usage?.costUsd.toFixed(4)}`);

  // 3. stop mid-run
  const long = await client.mutation(api.messages.send, {
    threadId,
    text: "Run this exact bash command and report what it prints: for i in $(seq 1 120); do echo $i; sleep 1; done",
  });
  await waitFor("run streaming", async () => {
    const r = await getRun(threadId, long.runId);
    return r && (r.status === "running" || settled.includes(r.status));
  });
  const tCancel = Date.now();
  await client.mutation(api.runs.cancel, { runId: long.runId });
  const cancelled = await waitFor("aborted", async () => {
    const r = await getRun(threadId, long.runId);
    return r && settled.includes(r.status) && r;
  });
  check(cancelled.status === "aborted", `stop mid-run -> ${cancelled.status} in ${Date.now() - tCancel}ms`);

  // 4. stop the VM, then resume: memory and workspace must both survive
  await client.mutation(api.admin.stopThreadSandbox, { threadId });
  await waitFor("stopped", async () => (await getThread(threadId))?.sandbox?.state === "stopped");
  check(true, "sandbox stopped");
  const resumed = await send(threadId, "Without using any tools, what is the name of the python file you created earlier?");
  check(/fib\.py/i.test(await assistantText(threadId, resumed.run._id)), `resumed agent remembers the conversation (${resumed.clientMs}ms incl. VM start)`);
  const stillThere = await send(threadId, "Use bash to cat the python file you created earlier, then say FILE_OK if it exists.");
  check(/FILE_OK/.test(await assistantText(threadId, stillThere.run._id)), "workspace files survived stop/start");
  const sameVm = (await getThread(threadId))?.sandbox?.daytonaId === firstDaytonaId;
  check(sameVm, "same VM resumed (not recreated)");

  // 5. delete the VM behind the control plane's back
  await daytona.delete(await daytona.get(firstDaytonaId!), 120);
  console.log(`     deleted ${firstDaytonaId} directly via the Daytona API`);
  const recovered = await send(threadId, "Say READY and tell me the python file name you created earlier.");
  const t = await getThread(threadId);
  check(t?.sandbox?.daytonaId !== firstDaytonaId && t?.sandbox?.state === "ready", `thread recovered onto a new VM (${t?.sandbox?.daytonaId})`);
  check(/fib\.py/i.test(await assistantText(threadId, recovered.run._id)), "conversation survived the VM loss (rehydrated from Convex)");
  const events = await client.query(api.observability.events, { threadId, limit: 500 });
  check(events.some((e) => e.type === "thread.workspace_reset"), "workspace loss recorded as thread.workspace_reset");

  // 6. cleanup
  if (!process.argv.includes("--keep")) {
    await client.mutation(api.threads.remove, { threadId });
    await waitFor(
      "sandbox deleted",
      async () => {
        const rows = await client.query(api.observability.fleet, {});
        return (rows.ready ?? 0) + (rows.deleting ?? 0) === 0;
      },
      120_000,
    );
    // Daytona's listing lags a delete by a few seconds, so poll instead of sampling once.
    let live: string[];
    let expected: number;
    const deadline = Date.now() + 90_000;
    do {
      live = [];
      for await (const vm of daytona.list({ labels: { app: "pi-agent-chatbot", deployment } })) {
        if (vm.state !== "destroyed") live.push(`${vm.id}:${vm.state}`);
      }
      const fleet = await client.query(api.observability.fleet, {});
      expected = (fleet.pooled ?? 0) + (fleet.provisioning ?? 0);
      if (live.length <= expected) break;
      await new Promise((r) => setTimeout(r, 3000));
    } while (Date.now() < deadline);
    check(live.length <= expected, `no orphaned sandboxes: ${live.length} live VM(s), ${expected} expected (warm pool) [${live.join(", ")}]`);
  } else {
    console.log(`     kept thread ${threadId}`);
  }

  await client.close();
  console.log(failures === 0 ? "\nLive acceptance: all checks passed" : `\nLive acceptance: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await client.close();
  process.exit(1);
});
