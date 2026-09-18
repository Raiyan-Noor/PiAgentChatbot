/**
 * Egress broker for the web tools. Tier 1/2 Daytona sandboxes can only reach
 * an allowlist (which includes *.convex.cloud but not search APIs or arbitrary
 * sites), so `webfetch`/`websearch` execute in the VM but their network request
 * happens here. The Tavily key never enters a VM, and every call is logged.
 *
 * Runs in Convex's default runtime (fetch is available; no Node cold start).
 */
import { ConvexError, v } from "convex/values";
import {
  capText,
  MAX_TOOL_OUTPUT_CHARS,
  type WebfetchResult,
  type WebsearchResultPayload,
} from "../../shared/protocol";
import { internal } from "../_generated/api";
import { action, internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { required } from "../config";
import { logEvent } from "../lib/log";
import { sandboxForToken } from "./auth";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_DOWNLOAD_BYTES = 5_000_000;

export const authorize = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const s = await sandboxForToken(ctx, token);
    return s && s.threadId ? { sandboxId: s._id, threadId: s.threadId } : null;
  },
});

export const logEgress = internalMutation({
  args: {
    sandboxId: v.id("sandboxes"),
    threadId: v.id("threads"),
    type: v.string(),
    durationMs: v.number(),
    data: v.any(),
  },
  handler: async (ctx, { sandboxId, threadId, type, durationMs, data }) => {
    await logEvent(ctx, { type, sandboxId, threadId, durationMs, data });
  },
});

async function authorizeOrThrow(ctx: ActionCtx, token: string) {
  const who = await ctx.runQuery(internal.execution.egress.authorize, { token });
  if (!who) throw new ConvexError({ code: "unauthorized", message: "invalid sandbox token" });
  return who;
}

export const webfetch = action({
  args: { token: v.string(), url: v.string(), maxChars: v.optional(v.number()) },
  handler: async (ctx, { token, url, maxChars }): Promise<WebfetchResult> => {
    const who = await authorizeOrThrow(ctx, token);
    const t0 = Date.now();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ConvexError({ code: "bad_url", message: `invalid URL: ${url}` });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ConvexError({ code: "bad_url", message: "only http(s) URLs are allowed" });
    }
    try {
      const res = await fetch(parsed, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "pi-agent-chatbot/0.1 (+egress-broker)", accept: "text/html,text/plain,application/json,*/*" },
      });
      const contentType = res.headers.get("content-type") ?? "";
      const body = await readCapped(res, MAX_DOWNLOAD_BYTES);
      const text = /html/i.test(contentType) ? htmlToText(body.text) : body.text;
      const capped = capText(text, Math.min(maxChars ?? MAX_TOOL_OUTPUT_CHARS, MAX_TOOL_OUTPUT_CHARS));
      const result: WebfetchResult = {
        url,
        finalUrl: res.url || url,
        status: res.status,
        contentType,
        bytes: body.bytes,
        truncated: capped.truncated || body.truncated,
        text: capped.text,
      };
      await ctx.runMutation(internal.execution.egress.logEgress, {
        ...who,
        type: "egress.webfetch",
        durationMs: Date.now() - t0,
        data: { url, status: res.status, bytes: body.bytes, contentType },
      });
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.execution.egress.logEgress, {
        ...who,
        type: "egress.webfetch.failed",
        durationMs: Date.now() - t0,
        data: { url, error: message },
      });
      throw new ConvexError({ code: "fetch_failed", message });
    }
  },
});

export const websearch = action({
  args: { token: v.string(), query: v.string(), maxResults: v.optional(v.number()) },
  handler: async (ctx, { token, query, maxResults }): Promise<WebsearchResultPayload> => {
    const who = await authorizeOrThrow(ctx, token);
    const t0 = Date.now();
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "content-type": "application/json", authorization: `Bearer ${required("TAVILY_API_KEY")}` },
        body: JSON.stringify({ query, max_results: Math.min(Math.max(maxResults ?? 5, 1), 10), include_answer: true }),
      });
      if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as {
        answer?: string;
        results?: { title?: string; url?: string; content?: string; score?: number }[];
      };
      const payload: WebsearchResultPayload = {
        query,
        answer: json.answer || undefined,
        results: (json.results ?? []).map((r) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          snippet: capText(r.content ?? "", 1_000).text,
          score: r.score,
        })),
      };
      await ctx.runMutation(internal.execution.egress.logEgress, {
        ...who,
        type: "egress.websearch",
        durationMs: Date.now() - t0,
        data: { query, results: payload.results.length },
      });
      return payload;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.execution.egress.logEgress, {
        ...who,
        type: "egress.websearch.failed",
        durationMs: Date.now() - t0,
        data: { query, error: message },
      });
      throw new ConvexError({ code: "search_failed", message });
    }
  },
});

async function readCapped(res: Response, maxBytes: number) {
  if (!res.body) return { text: "", bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    chunks.push(value);
    if (bytes >= maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const all = new Uint8Array(Math.min(bytes, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    const slice = c.subarray(0, Math.max(0, all.length - offset));
    all.set(slice, offset);
    offset += slice.length;
  }
  return { text: new TextDecoder().decode(all), bytes, truncated };
}

/** Deliberately simple HTML -> readable text (no DOM in the Convex runtime). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br|pre|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}
