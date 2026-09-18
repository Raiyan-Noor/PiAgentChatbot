/**
 * Spikes S2 + S4 against real Daytona (needs DAYTONA_API_KEY and a built snapshot):
 *   S4  the snapshot entrypoint (daemon supervisor) is running after create,
 *       and comes back by itself after stop -> start.
 *   S2  from inside the VM: env vars visible to the entrypoint, and Node's
 *       ConvexClient gets a WSS subscription update from *.convex.cloud.
 *
 *   npm run spike:daytona -- <snapshot-name> [convex-cloud-url]
 *
 * The sandbox is deleted at the end. (S1 — Daytona SDK inside a Convex Node
 * action — is exercised by the first real `threads.create`.)
 */
import { Daytona, type Sandbox } from "@daytona/sdk";
import { loadEnvLocal } from "../scripts/util";

const env = loadEnvLocal();
const snapshot = process.argv[2] ?? env.DAYTONA_SNAPSHOT;
const convexUrl = process.argv[3] ?? env.VITE_CONVEX_URL;

async function sh(vm: Sandbox, cmd: string) {
  const r = await vm.process.executeCommand(cmd, undefined, undefined, 60);
  return { code: r.exitCode, out: r.result.trim() };
}

async function daemonRunning(vm: Sandbox) {
  const r = await sh(vm, "ps -eo pid,etimes,args | grep -E 'entrypoint.sh|daemon.mjs' | grep -v grep || true");
  return r.out;
}

async function main() {
  if (!snapshot) throw new Error("usage: npm run spike:daytona -- <snapshot> [convex-url]");
  const daytona = new Daytona({ apiKey: env.DAYTONA_API_KEY, apiUrl: env.DAYTONA_API_URL, target: env.DAYTONA_TARGET });
  const report: Record<string, unknown> = { snapshot, convexUrl };
  let t = Date.now();
  const vm = await daytona.create({
    snapshot,
    labels: { app: "pi-agent-chatbot", spike: "true" },
    envVars: { CONVEX_URL: convexUrl ?? "", SANDBOX_TOKEN: "spike-invalid-token", WORKSPACE_DIR: "/workspace" },
    autoStopInterval: 15,
  });
  report.createMs = Date.now() - t;
  try {
    await new Promise((r) => setTimeout(r, 3000));
    report.s4_processesAfterCreate = await daemonRunning(vm);
    report.envInToolboxShell = (await sh(vm, "printenv CONVEX_URL WORKSPACE_DIR || true")).out;
    // The entrypoint's own environment (what the daemon actually sees):
    report.s2_envInEntrypoint = (await sh(vm, "cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n' | grep -E '^(CONVEX_URL|WORKSPACE_DIR|SANDBOX_TOKEN)=' | sed 's/=.*/=<set>/' || true")).out;
    if (convexUrl) {
      report.s2_convexSubscription = (await sh(vm, `cd /opt/runner && CONVEX_URL='${convexUrl}' node dist/spikeConvex.mjs`)).out;
    }
    report.nodeVersion = (await sh(vm, "node --version")).out;
    report.tools = (await sh(vm, "rg --version | head -1; fdfind --version; git --version; python3 --version")).out;
    report.egress = (await sh(vm, "curl -s -o /dev/null -w 'openai:%{http_code} ' https://api.openai.com/v1/models; curl -s -m 5 -o /dev/null -w 'example.com:%{http_code}' https://example.com || echo ' example.com:blocked'")).out;

    t = Date.now();
    await vm.stop();
    report.stopMs = Date.now() - t;
    t = Date.now();
    await vm.start();
    report.startMs = Date.now() - t;
    await new Promise((r) => setTimeout(r, 3000));
    report.s4_processesAfterRestart = await daemonRunning(vm);
  } finally {
    await vm.delete();
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
