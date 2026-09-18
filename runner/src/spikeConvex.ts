/**
 * Spike S2 (runs INSIDE a Daytona sandbox): are sandbox env vars visible, and
 * can Node's ConvexClient hold a WSS subscription to *.convex.cloud from this tier?
 * Prints a JSON verdict and exits.
 */
import { ConvexClient } from "convex/browser";
import { executionApi } from "../../shared/protocol";

async function main() {
  const url = process.env.CONVEX_URL;
  const token = process.env.SANDBOX_TOKEN ?? "spike-invalid-token";
  const result: Record<string, unknown> = {
    node: process.version,
    envVisible: { CONVEX_URL: !!url, SANDBOX_TOKEN: !!process.env.SANDBOX_TOKEN, OPENAI_API_KEY: !!process.env.OPENAI_API_KEY },
    hasGlobalWebSocket: typeof WebSocket !== "undefined",
  };
  if (!url) {
    console.log(JSON.stringify({ ...result, verdict: "no CONVEX_URL" }));
    process.exit(2);
  }
  const client = new ConvexClient(url);
  const t0 = Date.now();
  const verdict = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve("timeout: no subscription update in 15s (WSS likely blocked)"), 15_000);
    client.onUpdate(
      executionApi.watch,
      { token, bootId: "spike" },
      (value) => {
        clearTimeout(timer);
        result.firstUpdateMs = Date.now() - t0;
        result.watchValue = value;
        resolve("subscription ok");
      },
      (err) => {
        clearTimeout(timer);
        resolve(`subscription error: ${err.message}`);
      },
    );
  });
  console.log(JSON.stringify({ ...result, verdict, connection: client.connectionState() }));
  await client.close();
  process.exit(verdict === "subscription ok" ? 0 : 1);
}

void main();
