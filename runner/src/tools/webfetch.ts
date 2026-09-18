/** `webfetch`: runs in the VM, but the HTTP request goes through the control-plane egress broker. */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WebfetchDetails } from "../../../shared/protocol";
import type { EgressClient } from "../controlPlane";

export function createWebfetchTool(egress: EgressClient) {
  return defineTool({
    name: "webfetch",
    label: "Web fetch",
    description:
      "Fetch a URL (http/https) and return its content as readable text (HTML is converted to text). Use for reading documentation or web pages.",
    promptSnippet: "webfetch: fetch a URL and read it as text",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http(s) URL" }),
      max_chars: Type.Optional(Type.Number({ description: "Max characters to return (default 64000)" })),
    }),
    async execute(_toolCallId, params) {
      const r = await egress.webfetch(params.url, params.max_chars);
      const details: WebfetchDetails = {
        url: r.url,
        finalUrl: r.finalUrl,
        status: r.status,
        contentType: r.contentType,
        bytes: r.bytes,
        truncated: r.truncated,
      };
      const header = `HTTP ${r.status} ${r.finalUrl} (${r.contentType || "unknown type"}, ${r.bytes} bytes${r.truncated ? ", truncated" : ""})`;
      if (r.status >= 400) throw new Error(`${header}\n\n${r.text.slice(0, 2_000)}`);
      return { content: [{ type: "text", text: `${header}\n\n${r.text}` }], details };
    },
  });
}
