// Bundles the runner (our code + shared/ + convex client) into dist/.
// Pi packages stay external: they ship wasm/assets and are installed in the image with `npm ci`.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: { daemon: "src/main.ts", spikePi: "src/spikePi.ts", spikeConvex: "src/spikeConvex.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: "linked",
  external: Object.keys(pkg.dependencies),
  // ../shared imports `convex/server`; resolve it from the runner's own node_modules.
  nodePaths: [fileURLToPath(new URL("./node_modules", import.meta.url))],
  define: { __RUNNER_VERSION__: JSON.stringify(pkg.version) },
  // Some bundled CJS deps call require(); give ESM output a real one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
