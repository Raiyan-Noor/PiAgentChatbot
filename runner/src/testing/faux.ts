/**
 * Test support: Pi's faux LLM provider wired into a ModelRuntime, so the real
 * AgentHost can run scripted turns without an API key.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EgressClient } from "../controlPlane";

// Minimal structural types for pi-ai's faux provider (pi-ai is a transitive, nested dependency).
export type FauxMessage = { role: "assistant"; content: unknown[] };
export type FauxStep = FauxMessage | ((context: { messages: unknown[] }) => FauxMessage);
export interface FauxHandle {
  provider: Parameters<ModelRuntime["registerNativeProvider"]>[0] & { id: string };
  getModel(): { id: string };
  setResponses(steps: FauxStep[]): void;
  appendResponses(steps: FauxStep[]): void;
  getPendingResponseCount(): number;
}
export interface FauxModule {
  fauxProvider(opts?: { tokensPerSecond?: number; provider?: string }): FauxHandle;
  fauxAssistantMessage(content: string | unknown[], opts?: { stopReason?: string }): FauxMessage;
  fauxToolCall(name: string, args: Record<string, unknown>): unknown;
  fauxText(text: string): unknown;
}

export async function importFaux(): Promise<FauxModule> {
  // Package exports hide package.json; locate the package from its main entry (dist/index.js).
  const pkgDir = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  const candidates = [
    join(pkgDir, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js"),
    join(pkgDir, "../pi-ai/dist/providers/faux.js"),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error("pi-ai faux provider not found");
  return (await import(pathToFileURL(path).href)) as FauxModule;
}

export async function fauxRuntime(opts: { tokensPerSecond?: number; provider?: string } = {}) {
  const faux = await importFaux();
  const handle = faux.fauxProvider(opts);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
    authPath: join(tmpdir(), `pi-faux-auth-${process.pid}.json`),
  });
  modelRuntime.registerNativeProvider(handle.provider);
  return { faux, handle, modelRuntime, provider: handle.provider.id, modelId: handle.getModel().id };
}

export const fakeEgress: EgressClient = {
  async webfetch(url) {
    return { url, finalUrl: url, status: 200, contentType: "text/html", bytes: 42, truncated: false, text: "Example Domain" };
  },
  async websearch(query) {
    return { query, answer: "Daytona runs sandboxes.", results: [{ title: "Daytona", url: "https://daytona.io", snippet: "Secure infra" }] };
  },
};
