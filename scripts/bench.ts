/**
 * Benchmark harness. Separates control-plane/Daytona overhead from LLM latency.
 *
 *   npm run bench                         all Daytona scenarios, 3 iterations
 *   npm run bench -- --n 5 --only hot,resume
 *   npm run bench -- --local              hot-turn dispatch overhead with an in-process
 *                                         runner + faux LLM (no Daytona, no keys)
 *
 * Scenarios
 *   cold    threads.create({cold}) -> sandbox registered          (Daytona create + VM boot + daemon boot)
 *   warm    threads.create() from the pool -> ready               (one mutation)
 *   hot     message on a ready sandbox -> first token / done      (the per-message path)
 *   resume  message on a stopped sandbox -> ready -> first token  (Daytona start + daemon boot)
 *
 * Span definitions (no cross-clock subtraction):
 *   dispatch     run.claimedAt - run.queuedAt                     control-plane clock
 *   vmOverhead   run.vmLlmRequestAt - run.vmStartedAt             VM clock
 *   llmTtft      run.vmFirstTokenAt - run.vmLlmRequestAt          VM clock (model + network to OpenAI)
 *   clientTtft   client send -> first assistant text pushed back  client clock (end to end)
 */
import { ConvexClient } from "convex/browser";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { loadEnvLocal, repoRoot } from "./util";

type Sample = Record<string, number | undefined>;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const N = Number(opt("n", "3"));
const LOCAL = flag("local");
const ONLY = opt("only", LOCAL ? "hot" : "cold,warm,hot,resume").split(",");
const PROMPT = "Reply with exactly the word: ok";

const env = loadEnvLocal();
const url = process.env.CONVEX_URL ?? env.VITE_CONVEX_URL;
if (!url) throw new Error("No Convex URL in .env.local");
const client = new ConvexClient(url);

async function waitFor<T>(label: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 300_000, everyMs = 50): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

const getThread = (threadId: Id<"threads">) => client.query(api.threads.get, { threadId });
const getRun = async (threadId: Id<"threads">, runId: Id<"runs">) =>
  (await client.query(api.runs.listByThread, { threadId })).find((r) => r._id === runId);

/** Send a message; resolve with run spans + client-observed first-text time. */
async function turn(threadId: Id<"threads">): Promise<{ run: Doc<"runs">; clientTtft?: number; clientTotal: number }> {
  const t0 = Date.now();
  let firstTextAt: number | undefined;
  const { runId } = await client.mutation(api.messages.send, { threadId, text: PROMPT });
  const sub = client.onUpdate(api.messages.list, { threadId }, (items) => {
    if (!firstTextAt && items.some((i) => i.kind === "message" && i.runId === runId && i.role === "assistant" && i.text)) firstTextAt = Date.now();
  });
  const run = await waitFor("run finished", async () => {
    const r = await getRun(threadId, runId);
    return r && ["completed", "failed", "aborted"].includes(r.status) && r;
  });
  sub.unsubscribe();
  if (run.status !== "completed") throw new Error(`run ${run.status}: ${run.error}`);
  return { run, clientTtft: firstTextAt && firstTextAt - t0, clientTotal: Date.now() - t0 };
}

function runSpans(run: Doc<"runs">): Sample {
  return {
    dispatch: run.claimedAt! - run.queuedAt,
    vmOverhead: run.vmLlmRequestAt! - run.vmStartedAt!,
    llmTtft: run.vmFirstTokenAt !== undefined ? run.vmFirstTokenAt - run.vmLlmRequestAt! : undefined,
    runTotal: run.endedAt! - run.queuedAt,
  };
}

async function waitReady(threadId: Id<"threads">) {
  return await waitFor("sandbox ready", async () => {
    const t = await getThread(threadId);
    if (t?.sandbox?.state === "error") throw new Error(`sandbox error: ${t.sandbox.error}`);
    return t?.sandbox?.state === "ready" && t.sandbox;
  });
}

const threads: Id<"threads">[] = [];

/**
 * Release a thread's sandbox as soon as its sample is taken. Daytona tiers cap
 * total CPUs, and one sandbox = one CPU, so holding every iteration's VM until
 * the end exhausts the quota mid-run.
 */
async function releaseThread(threadId: Id<"threads">) {
  await client.mutation(api.threads.remove, { threadId }).catch(() => {});
  const i = threads.indexOf(threadId);
  if (i >= 0) threads.splice(i, 1);
}

async function newThread(cold: boolean) {
  const t0 = Date.now();
  const res = await client.mutation(api.threads.create, { title: `bench ${cold ? "cold" : "warm"}`, cold });
  threads.push(res.threadId);
  const mutationMs = Date.now() - t0;
  const sandbox = await waitReady(res.threadId);
  return { ...res, mutationMs, clientReadyMs: Date.now() - t0, sandbox };
}

// ---------------------------------------------------------------------------

const scenarios: Record<string, () => Promise<Sample>> = {
  async cold() {
    const t = await newThread(true);
    const sample = {
      clientReady: t.clientReadyMs,
      daytonaCreate: t.sandbox.spans.createMs,
      daemonBoot: t.sandbox.spans.daemonBootMs,
      requestToRegistered: t.sandbox.spans.readyMs,
    };
    await releaseThread(t.threadId);
    return sample;
  },

  async warm() {
    await waitFor("pooled sandbox available", async () => ((await client.query(api.observability.fleet, {})).pooled ?? 0) > 0, 600_000, 1000);
    const t = await newThread(false);
    if (!t.fromPool) console.warn("  (pool was empty at claim time; this sample is a cold start)");
    const first = await turn(t.threadId);
    const sample = { createMutation: t.mutationMs, clientReady: t.clientReadyMs, fromPool: t.fromPool ? 1 : 0, firstTurnClientTtft: first.clientTtft };
    await releaseThread(t.threadId);
    return sample;
  },

  async hot() {
    const threadId = hotThread ?? (hotThread = (await newThread(false)).threadId);
    const { run, clientTtft, clientTotal } = await turn(threadId);
    return { ...runSpans(run), clientTtft, clientTotal };
  },

  async resume() {
    const threadId = resumeThread ?? (resumeThread = (await newThread(false)).threadId);
    if (!resumed) {
      await turn(threadId); // prime memory
      resumed = true;
    }
    await client.mutation(api.admin.stopThreadSandbox, { threadId });
    await waitFor("stopped", async () => (await getThread(threadId))?.sandbox?.state === "stopped", 300_000, 500);
    const { run, clientTtft, clientTotal } = await turn(threadId);
    const sandbox = (await getThread(threadId))!.sandbox!;
    return {
      daytonaStart: sandbox.spans.startMs,
      daemonBoot: sandbox.spans.daemonBootMs,
      requestToRegistered: sandbox.spans.readyMs,
      ...runSpans(run),
      clientTtft,
      clientTotal,
    };
  },
};
let hotThread: Id<"threads"> | undefined;
let resumeThread: Id<"threads"> | undefined;
let resumed = false;

/** --local: bind a thread to an in-process runner with a faux LLM (measures the control-plane path only). */
async function setupLocal() {
  const [{ AgentHost }, { ControlPlane }, { Daemon }, { fauxRuntime }] = await Promise.all([
    import("../runner/src/agentHost"),
    import("../runner/src/controlPlane"),
    import("../runner/src/daemon"),
    import("../runner/src/testing/faux"),
  ]);
  const rt = await fauxRuntime({ tokensPerSecond: 1000 });
  const { threadId } = await client.mutation(api.threads.create, { title: "bench local", cold: true });
  threads.push(threadId);
  const token = randomBytes(32).toString("base64url");
  await client.mutation(api.admin.attachLocalRunner, { threadId, tokenHash: createHash("sha256").update(token).digest("hex") });
  const cp = new ControlPlane(url!, token, randomUUID());
  const daemon = new Daemon(cp, {
    workspace: mkdtempSync(join(tmpdir(), "pi-bench-")),
    createHost: (o) => AgentHost.create({ ...o, provider: rt.provider, modelId: rt.modelId, modelRuntime: rt.modelRuntime }),
    fatal: (code, reason) => {
      throw new Error(`daemon fatal ${code}: ${reason}`);
    },
  });
  await daemon.start();
  await waitReady(threadId);
  // Every turn replies "ok" instantly.
  const step = () => rt.faux.fauxAssistantMessage("ok");
  rt.handle.setResponses(Array.from({ length: N + 5 }, step));
  hotThread = threadId;
  return async () => {
    daemon.stop();
    await cp.close();
  };
}

function percentile(values: number[], p: number) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

async function main() {
  const results: Record<string, Sample[]> = {};
  const teardown = LOCAL ? await setupLocal() : undefined;
  try {
    for (const name of ONLY) {
      const fn = scenarios[name];
      if (!fn) throw new Error(`unknown scenario ${name}`);
      results[name] = [];
      for (let i = 0; i < N; i++) {
        process.stdout.write(`${name} ${i + 1}/${N} … `);
        const sample = await fn();
        results[name].push(sample);
        console.log(JSON.stringify(sample));
      }
    }
  } finally {
    await teardown?.();
    for (const threadId of threads) await client.mutation(api.threads.remove, { threadId }).catch(() => {});
    await client.close();
  }

  const lines = [`| scenario | metric | p50 (ms) | p95 (ms) | n |`, `|---|---|---:|---:|---:|`];
  for (const [name, samples] of Object.entries(results)) {
    const metrics = [...new Set(samples.flatMap((s) => Object.keys(s)))];
    for (const m of metrics) {
      const vals = samples.map((s) => s[m]).filter((x): x is number => typeof x === "number");
      if (vals.length) lines.push(`| ${name} | ${m} | ${Math.round(percentile(vals, 50))} | ${Math.round(percentile(vals, 95))} | ${vals.length} |`);
    }
  }
  const table = lines.join("\n");
  console.log(`\n${LOCAL ? "local (faux LLM, in-process runner)" : "daytona"} — ${new Date().toISOString()} — ${url}\n\n${table}\n`);
  writeFileSync(join(repoRoot, "bench-results.json"), JSON.stringify({ at: new Date().toISOString(), local: LOCAL, url, results }, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
