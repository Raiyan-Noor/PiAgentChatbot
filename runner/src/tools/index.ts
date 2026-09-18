/**
 * Tool registry. Adding a tool = one file in this folder + one line here
 * (+ optionally a renderer in web/src/components/ToolCallCard.tsx).
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolName } from "../../../shared/protocol";
import type { EgressClient } from "../controlPlane";
import { createGlobTool } from "./glob";
import { createWebfetchTool } from "./webfetch";
import { createWebsearchTool } from "./websearch";

/** Pi built-ins, enabled by name. */
const BUILTIN = ["bash", "read", "write", "edit", "grep"] as const satisfies readonly ToolName[];

export function createTools(cwd: string, egress: EgressClient) {
  const custom = [createGlobTool(cwd), createWebfetchTool(egress), createWebsearchTool(egress)];
  const names: ToolName[] = [...BUILTIN, ...(custom.map((t) => t.name) as ToolName[])];
  return { names, customTools: custom as ToolDefinition[] };
}
