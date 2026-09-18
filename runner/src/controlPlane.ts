/**
 * The ONLY runner module that talks to Convex. One WebSocket (ConvexClient)
 * carries everything: the inbox subscription, ordered exactly-once mutations,
 * and egress actions. Every call is authenticated with the sandbox token.
 */
import { ConvexClient } from "convex/browser";
import {
  executionApi,
  type AppendResult,
  type ClaimRunResult,
  type RegisterResult,
  type RunnerEvent,
  type TranscriptResult,
  type WatchResult,
  type WebfetchResult,
  type WebsearchResultPayload,
} from "../../shared/protocol";

export class ControlPlane {
  private readonly client: ConvexClient;

  constructor(
    url: string,
    private readonly token: string,
    readonly bootId: string,
  ) {
    this.client = new ConvexClient(url, { unsavedChangesWarning: false });
  }

  register(args: { protocolVersion: number; runnerVersion: string; bootMs: number }): Promise<RegisterResult> {
    return this.client.mutation(executionApi.register, { token: this.token, bootId: this.bootId, ...args });
  }

  /** Reactive inbox. `onUpdate` fires on every change pushed by the server. */
  watch(onUpdate: (w: WatchResult | null) => void, onError: (e: Error) => void): () => void {
    const sub = this.client.onUpdate(executionApi.watch, { token: this.token, bootId: this.bootId }, onUpdate, onError);
    return () => sub.unsubscribe();
  }

  transcript(): Promise<TranscriptResult> {
    return this.client.query(executionApi.transcript, { token: this.token });
  }

  claimRun(runId: string): Promise<ClaimRunResult> {
    return this.client.mutation(executionApi.claimRun, { token: this.token, bootId: this.bootId, runId });
  }

  append(runId: string, events: RunnerEvent[]): Promise<AppendResult> {
    return this.client.mutation(executionApi.append, { token: this.token, bootId: this.bootId, runId, events });
  }

  webfetch(url: string, maxChars?: number): Promise<WebfetchResult> {
    return this.client.action(executionApi.webfetch, { token: this.token, url, maxChars });
  }

  websearch(query: string, maxResults?: number): Promise<WebsearchResultPayload> {
    return this.client.action(executionApi.websearch, { token: this.token, query, maxResults });
  }

  connectionState() {
    return this.client.connectionState();
  }

  close() {
    return this.client.close();
  }
}

/** The subset of ControlPlane that tools need (keeps tools testable without Convex). */
export type EgressClient = Pick<ControlPlane, "webfetch" | "websearch">;
