/** Deployment configuration, read from Convex environment variables. */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing Convex env var ${name}. See .env.example and run \`npm run env:push\`.`);
  return value;
}

export const config = {
  get snapshot() {
    return process.env.DAYTONA_SNAPSHOT ?? "";
  },
  get defaultModel() {
    return process.env.DEFAULT_MODEL || "gpt-5.4-mini";
  },
  get poolSize() {
    return num("SANDBOX_POOL_SIZE", 1);
  },
  get idleStopMs() {
    return num("SANDBOX_IDLE_STOP_MINUTES", 10) * 60_000;
  },
  get autoStopMinutes() {
    return num("DAYTONA_AUTOSTOP_MINUTES", 30);
  },
};

/** Reconciler timing. Not env-tunable on purpose: these are safety rails. */
export const timing = {
  /** Refresh Daytona activity (dead-man's switch) at least this often. */
  refreshEveryMs: 5 * 60_000,
  /** provisioning/starting without a register -> error. */
  bootTimeoutMs: 4 * 60_000,
  /** stopping/deleting without completion -> retry. */
  opTimeoutMs: 3 * 60_000,
  /** A queued run on a ready sandbox not claimed in this window -> probe the VM. */
  claimTimeoutMs: 45_000,
  /** Throttle for activity timestamps written by ingest. */
  activityWriteEveryMs: 10_000,
  /** Max sandboxes created per reconcile tick. */
  maxCreatesPerTick: 3,
};
