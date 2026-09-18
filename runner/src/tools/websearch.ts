/** `websearch`: Tavily search, brokered by the control plane (the API key never enters the VM). */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WebsearchDetails } from "../../../shared/protocol";
import type { EgressClient } from "../controlPlane";

export function createWebsearchTool(egress: EgressClient) {
  return defineTool({
    name: "websearch",
    label: "Web search",
    description: "Search the web. Returns titles, URLs and snippets of the top results (plus a short answer when available).",
    promptSnippet: "websearch: search the web for current information",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      max_results: Type.Optional(Type.Number({ description: "1-10, default 5" })),
    }),
    async execute(_toolCallId, params) {
      const r = await egress.websearch(params.query, params.max_results);
      const details: WebsearchDetails = { query: r.query, results: r.results };
      const lines = r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet.replace(/\s+/g, " ")}`);
      const text = [r.answer ? `Answer: ${r.answer}\n` : "", ...lines].join("\n") || "No results.";
      return { content: [{ type: "text", text }], details };
    },
  });
}
