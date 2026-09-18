/**
 * Hosts one Pi AgentSession for one thread. The session keeps no durable
 * state of its own: history is rehydrated from the Convex transcript, and
 * every message it produces is streamed back (bridge -> sink -> ingest).
 */
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EgressClient } from "./controlPlane";
import { createTools } from "./tools";
import type { Bridge, PiEvent } from "./bridge";

export interface AgentHostOptions {
  threadId: string;
  modelId: string;
  cwd: string;
  egress: EgressClient;
  /** Prior transcript (raw Pi AgentMessages). */
  messages: unknown[];
  transcriptSeq: number;
  /** Test/spike hooks. */
  provider?: string;
  modelRuntime?: ModelRuntime;
}

export interface RunOutcome {
  status: "completed" | "failed" | "aborted";
  error?: string;
}

function systemPrompt(cwd: string, toolNames: string[]) {
  return [
    "You are a capable coding agent running inside an isolated Linux sandbox that belongs to one chat thread.",
    `Your working directory is ${cwd}. Files you create persist for this thread while its sandbox exists.`,
    `Tools: ${toolNames.join(", ")}.`,
    "- Use bash to run programs and inspect the system; read/write/edit for files; grep to search contents; glob to find files.",
    "- Use websearch to find current information and webfetch to read a specific URL.",
    "- Prefer doing over describing: run code to verify results. Keep answers concise and use Markdown.",
  ].join("\n");
}

function resourceLoaderFor(prompt: string): ResourceLoader {
  // No discovery: no extensions, skills, AGENTS.md, or prompt templates from disk.
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export class AgentHost {
  private aborted = false;

  private constructor(
    readonly threadId: string,
    readonly modelId: string,
    readonly session: AgentSession,
    public transcriptSeq: number,
  ) {}

  static async create(opts: AgentHostOptions): Promise<AgentHost> {
    mkdirSync(opts.cwd, { recursive: true });
    const agentDir = join(tmpdir(), "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    const provider = opts.provider ?? "openai";

    let modelRuntime = opts.modelRuntime;
    if (!modelRuntime) {
      modelRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(agentDir, "models-store.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      const key = process.env.OPENAI_API_KEY;
      if (key) await modelRuntime.setRuntimeApiKey(provider, key);
    }
    const model = modelRuntime.getModel(provider, opts.modelId);
    if (!model) throw new Error(`Unknown model ${provider}/${opts.modelId}`);

    const { names, customTools } = createTools(opts.cwd, opts.egress);
    const settingsManager = SettingsManager.inMemory({
      // Compaction would rewrite history the transcript cannot mirror; keep context exact.
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });
    const { session } = await createAgentSession({
      cwd: opts.cwd,
      agentDir,
      model,
      thinkingLevel: model.reasoning ? "low" : "off",
      modelRuntime,
      resourceLoader: resourceLoaderFor(systemPrompt(opts.cwd, names)),
      tools: names,
      customTools,
      sessionManager: SessionManager.inMemory(opts.cwd),
      settingsManager,
    });
    const host = new AgentHost(opts.threadId, opts.modelId, session, opts.transcriptSeq);
    host.rehydrate(opts.messages, opts.transcriptSeq);
    return host;
  }

  /** Replace in-memory history with the control plane's transcript. */
  rehydrate(messages: unknown[], transcriptSeq: number) {
    this.session.agent.state.messages = messages as AgentSession["messages"];
    this.transcriptSeq = transcriptSeq;
  }

  /** Runs one user turn to completion, forwarding every Pi event to the bridge. */
  async run(prompt: string, bridge: Bridge): Promise<RunOutcome> {
    this.aborted = false;
    let transcriptWrites = 0;
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === "message_end") transcriptWrites++;
      bridge.handle(event as PiEvent);
    });
    try {
      await this.session.prompt(prompt);
      const last = bridge.lastAssistant;
      if (this.aborted || last?.stopReason === "aborted") return { status: "aborted" };
      if (last?.stopReason === "error") return { status: "failed", error: last.errorMessage ?? "LLM error" };
      return { status: "completed" };
    } catch (e) {
      if (this.aborted) return { status: "aborted" };
      return { status: "failed", error: e instanceof Error ? e.message : String(e) };
    } finally {
      unsubscribe();
      this.transcriptSeq += transcriptWrites;
    }
  }

  async abort() {
    this.aborted = true;
    await this.session.abort();
  }

  dispose() {
    this.session.dispose();
  }
}
