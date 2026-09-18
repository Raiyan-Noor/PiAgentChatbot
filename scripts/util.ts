/** Cross-platform helpers for repo scripts (no shell: works the same on Windows). */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnvLocal(): Record<string, string> {
  const path = join(repoRoot, ".env.local");
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    if (value !== "") out[m[1]!] = value;
  }
  return out;
}

export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${res.status}`);
  return res;
}

/** Runs the Convex CLI through node directly (no npx/.cmd shims, no shell quoting issues). */
export function convex(args: string[], opts: SpawnSyncOptions = {}) {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve("convex/package.json")), "bin", "main.js");
  return run(process.execPath, [cli, ...args], opts);
}

export function convexEnvSet(name: string, value: string) {
  convex(["env", "set", name, value], { stdio: ["ignore", "ignore", "inherit"] });
}
