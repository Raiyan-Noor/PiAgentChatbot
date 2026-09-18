/** `glob`: Pi's fd-backed `find` tool under the name the assignment asks for, with structured paths. */
import { createFindToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import type { GlobDetails } from "../../../shared/protocol";
import { contentText } from "../bridge";

export function createGlobTool(cwd: string) {
  const find = createFindToolDefinition(cwd);
  return defineTool({
    name: "glob",
    label: "Glob",
    description:
      "Find files by glob pattern (e.g. '**/*.py', 'src/**/*.test.ts'). Respects .gitignore. Returns matching paths relative to the search directory.",
    promptSnippet: "glob: find files by glob pattern",
    parameters: find.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await find.execute(toolCallId, params, signal, onUpdate, ctx);
      const text = contentText(result);
      const paths = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("[") && !/^No files found/i.test(l));
      const details: GlobDetails = { paths, resultLimitReached: result.details?.resultLimitReached };
      return { content: result.content, details };
    },
  });
}
