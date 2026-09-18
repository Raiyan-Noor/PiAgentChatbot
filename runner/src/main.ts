/** Process entry for the runner daemon (see daemon.ts). */
import { randomUUID } from "node:crypto";
import { DEFAULT_WORKSPACE_DIR } from "../../shared/protocol";
import { ControlPlane } from "./controlPlane";
import { Daemon } from "./daemon";
import { errorMessage, log } from "./log";

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    log("error", `missing env ${name}`);
    process.exit(3);
  }
  return value;
}

const cp = new ControlPlane(env("CONVEX_URL"), env("SANDBOX_TOKEN"), randomUUID());
const daemon = new Daemon(cp, { workspace: process.env.WORKSPACE_DIR || DEFAULT_WORKSPACE_DIR });

process.on("unhandledRejection", (e) => {
  log("error", "unhandled rejection", { error: errorMessage(e) });
  process.exit(1);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    daemon.stop();
    void cp.close().finally(() => process.exit(0));
  });
}

void daemon.start();
