/**
 * Copies control-plane variables from .env.local into the Convex deployment.
 * Secrets are passed as process args to `convex env set` (never printed).
 */
import { convexEnvSet, loadEnvLocal } from "./util";

const REQUIRED = ["DAYTONA_API_KEY", "OPENAI_API_KEY", "TAVILY_API_KEY"];
const OPTIONAL = [
  "DAYTONA_API_URL",
  "DAYTONA_TARGET",
  "DAYTONA_SNAPSHOT",
  "DAYTONA_OPENAI_SECRET",
  "DEFAULT_MODEL",
  "SANDBOX_POOL_SIZE",
  "SANDBOX_IDLE_STOP_MINUTES",
  "DAYTONA_AUTOSTOP_MINUTES",
];

const env = loadEnvLocal();
const missing = REQUIRED.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing in .env.local: ${missing.join(", ")}`);
  process.exit(1);
}
for (const key of [...REQUIRED, ...OPTIONAL]) {
  if (!env[key]) continue;
  convexEnvSet(key, env[key]);
  console.log(`set ${key}`);
}
console.log("done. Check with: npx convex env list");
