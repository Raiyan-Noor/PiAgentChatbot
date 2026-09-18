/**
 * Builds the runner snapshot and points the Convex deployment at it.
 *
 *   npm run snapshot            build (if new) + set DAYTONA_SNAPSHOT in Convex
 *   npm run snapshot -- --no-set   build only
 *
 * The snapshot name is content-addressed (bundle + lockfile + entrypoint +
 * image recipe), so an unchanged runner is never rebuilt, and pooled sandboxes
 * on an older snapshot are rolled over by the reconciler.
 */
import { Daytona, Image } from "@daytona/sdk";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { convexEnvSet, loadEnvLocal, run } from "../scripts/util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runnerDir = join(root, "runner");

/**
 * `Image.addLocalFile`/`addLocalDir` (@daytona/sdk 0.214.0) drop the local path
 * verbatim into both the generated Dockerfile `COPY` line and the build-context
 * archive entry name, unquoted. An absolute Windows path (backslashes, a drive
 * letter, and — in this repo — a space in "Study Material") breaks both. npm
 * scripts always run with cwd at the repo root, so a relative, forward-slash
 * path sidesteps it entirely and works unchanged on POSIX.
 */
function toContextPath(absPath: string) {
  return relative(process.cwd(), absPath).split(sep).join("/");
}

/** Bump when the recipe below changes in a way file hashes can't see. */
const RECIPE_VERSION = "2";

/**
 * Pi's `find` tool (behind our `glob`) always passes `--no-require-git`, which
 * Debian bookworm's fd 8.6 rejects. Install a current static fd instead.
 */
const FD_VERSION = "10.2.0";

function recipe() {
  return (
    Image.base("node:22-bookworm-slim")
      .runCommands(
        "apt-get update && apt-get install -y --no-install-recommends ripgrep git ca-certificates curl python3 procps && rm -rf /var/lib/apt/lists/*",
        `curl -fsSL https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-x86_64-unknown-linux-gnu.tar.gz -o /tmp/fd.tgz` +
          " && tar -xzf /tmp/fd.tgz -C /tmp" +
          ` && install -m 0755 /tmp/fd-v${FD_VERSION}-x86_64-unknown-linux-gnu/fd /usr/local/bin/fd` +
          " && rm -rf /tmp/fd.tgz /tmp/fd-v*",
        // Fail the build (not a user's tool call) if the versions can't do what Pi needs.
        "fd --no-require-git --max-results 1 . / >/dev/null && rg --version",
        "mkdir -p /workspace /opt/runner && chmod 777 /workspace",
      )
      .env({ PI_OFFLINE: "1", NODE_ENV: "production", WORKSPACE_DIR: "/workspace" })
      .addLocalFile(toContextPath(join(runnerDir, "package.json")), "/opt/runner/package.json")
      .addLocalFile(toContextPath(join(runnerDir, "package-lock.json")), "/opt/runner/package-lock.json")
      .runCommands("cd /opt/runner && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force")
      .addLocalDir(toContextPath(join(runnerDir, "dist")), "/opt/runner/dist")
      .addLocalFile(toContextPath(join(runnerDir, "entrypoint.sh")), "/opt/runner/entrypoint.sh")
      .workdir("/workspace")
      .entrypoint(["/bin/bash", "/opt/runner/entrypoint.sh"])
  );
}

async function main() {
  const env = loadEnvLocal();
  const apiKey = env.DAYTONA_API_KEY ?? process.env.DAYTONA_API_KEY;
  if (!apiKey) throw new Error("DAYTONA_API_KEY missing (put it in .env.local)");

  console.log("building runner bundle…");
  run(process.execPath, [join(runnerDir, "build.mjs")], { cwd: runnerDir });

  const hash = createHash("sha256");
  for (const f of ["dist/daemon.mjs", "package-lock.json", "entrypoint.sh"]) hash.update(readFileSync(join(runnerDir, f)));
  hash.update(RECIPE_VERSION);
  hash.update(recipe().dockerfile);
  const name = `pi-runner-${hash.digest("hex").slice(0, 12)}`;

  const daytona = new Daytona({
    apiKey,
    apiUrl: env.DAYTONA_API_URL || undefined,
    target: env.DAYTONA_TARGET || undefined,
  });

  let exists = false;
  try {
    const existing = await daytona.snapshot.get(name);
    exists = true;
    console.log(`snapshot ${name} already exists (state: ${existing.state})`);
  } catch {
    // not found
  }
  if (!exists) {
    console.log(`creating snapshot ${name} (a few minutes the first time)…`);
    const t0 = Date.now();
    await daytona.snapshot.create(
      { name, image: recipe(), resources: { cpu: 1, memory: 1, disk: 3 } },
      { onLogs: (chunk) => process.stdout.write(chunk), timeout: 0 },
    );
    console.log(`\nsnapshot ${name} created in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }

  if (!process.argv.includes("--no-set")) {
    convexEnvSet("DAYTONA_SNAPSHOT", name);
    console.log(`Convex env DAYTONA_SNAPSHOT=${name} (pool will roll over within a reconcile tick)`);
  }
  console.log(name);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
