"use node";
/**
 * The ONLY module that talks to Daytona. Lifecycle operations only:
 * create / start / stop / delete / probe / refresh / observe. Nothing on the
 * per-message path calls into here — messages reach the VM over the daemon's
 * own Convex subscription.
 *
 * Each action reports its outcome to an internal mutation in pool.ts, which
 * owns the state machine.
 */
import { Daytona, DaytonaNotFoundError, type Sandbox } from "@daytona/sdk";
import { createHash, randomBytes } from "node:crypto";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { config, required } from "../config";
import { DEFAULT_WORKSPACE_DIR } from "../../shared/protocol";

export const APP_LABEL = "pi-agent-chatbot";

let client: Daytona | undefined;
function daytona() {
  client ??= new Daytona({
    apiKey: required("DAYTONA_API_KEY"),
    apiUrl: process.env.DAYTONA_API_URL || undefined,
    target: process.env.DAYTONA_TARGET || undefined,
  });
  return client;
}

/** Labels scope every sandbox to this app + Convex deployment (for cleanup and drift detection). */
export function deploymentLabel() {
  const url = process.env.CONVEX_CLOUD_URL ?? "local";
  return url.replace(/^https?:\/\//, "").split(".")[0] ?? "local";
}

function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

function isNotFound(e: unknown) {
  return e instanceof DaytonaNotFoundError || /not found/i.test(errorMessage(e));
}

async function loadRow(ctx: ActionCtx, sandboxId: Id<"sandboxes">) {
  return await ctx.runQuery(internal.lifecycle.pool.getSandbox, { sandboxId });
}

/** Resolve the Daytona sandbox, reporting `missing` to the control plane. */
async function getVm(ctx: ActionCtx, sandboxId: Id<"sandboxes">, source: string): Promise<Sandbox | null> {
  const row = await loadRow(ctx, sandboxId);
  if (!row?.daytonaId) return null;
  try {
    return await daytona().get(row.daytonaId);
  } catch (e) {
    if (isNotFound(e)) {
      await ctx.runMutation(internal.lifecycle.pool.recordMissing, { sandboxId, source });
      return null;
    }
    throw e;
  }
}

export const createSandbox = internalAction({
  args: { sandboxId: v.id("sandboxes") },
  handler: async (ctx, { sandboxId }) => {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const begin = await ctx.runMutation(internal.lifecycle.pool.beginCreate, { sandboxId, tokenHash });
    if (!begin.proceed) return;
    const t0 = Date.now();
    try {
      if (!begin.snapshot) throw new Error("DAYTONA_SNAPSHOT is not set. Run `npm run snapshot`.");
      // Preferred: a Daytona org Secret, so the real OpenAI key never enters the VM
      // (the VM sees a placeholder that Daytona swaps on egress to api.openai.com).
      const openAiSecret = process.env.DAYTONA_OPENAI_SECRET;
      const vm = await daytona().create(
        {
          snapshot: begin.snapshot,
          labels: { app: APP_LABEL, deployment: deploymentLabel(), sandboxRow: sandboxId },
          envVars: {
            CONVEX_URL: required("CONVEX_CLOUD_URL"),
            SANDBOX_TOKEN: token,
            WORKSPACE_DIR: DEFAULT_WORKSPACE_DIR,
            ...(openAiSecret ? {} : { OPENAI_API_KEY: required("OPENAI_API_KEY") }),
          },
          ...(openAiSecret ? { secrets: { OPENAI_API_KEY: openAiSecret } } : {}),
          autoStopInterval: config.autoStopMinutes,
          // Never let Daytona archive/delete behind our back; the reconciler owns deletion.
          autoArchiveInterval: 0,
          autoDeleteInterval: -1,
        },
        { timeout: 180 },
      );
      const result = await ctx.runMutation(internal.lifecycle.pool.recordCreated, {
        sandboxId,
        daytonaId: vm.id,
        createMs: Date.now() - t0,
      });
      if (result.deleteNow) await vm.delete();
    } catch (e) {
      await ctx.runMutation(internal.lifecycle.pool.recordFailure, { sandboxId, op: "create", error: errorMessage(e) });
    }
  },
});

export const startSandbox = internalAction({
  args: { sandboxId: v.id("sandboxes") },
  handler: async (ctx, { sandboxId }) => {
    const t0 = Date.now();
    try {
      const vm = await getVm(ctx, sandboxId, "start");
      if (!vm) return;
      // Daytona error states can be recoverable (e.g. host issues).
      if (vm.state === "error" && vm.recoverable) await vm.recover(120);
      else if (vm.state !== "started") await vm.start(120);
      // The daemon is the snapshot entrypoint: starting the VM starts it. No exec needed.
      await ctx.runMutation(internal.lifecycle.pool.recordStarted, { sandboxId, startMs: Date.now() - t0 });
    } catch (e) {
      await ctx.runMutation(internal.lifecycle.pool.recordFailure, { sandboxId, op: "start", error: errorMessage(e) });
    }
  },
});

export const stopSandbox = internalAction({
  args: { sandboxId: v.id("sandboxes") },
  handler: async (ctx, { sandboxId }) => {
    const t0 = Date.now();
    try {
      const row = await loadRow(ctx, sandboxId);
      // No VM (create never finished, or a local dev runner): nothing to stop.
      const vm = row?.daytonaId ? await getVm(ctx, sandboxId, "stop") : null;
      if (row?.daytonaId && !vm) return; // reported missing
      if (vm && vm.state !== "stopped") await vm.stop(120);
      await ctx.runMutation(internal.lifecycle.pool.recordStopped, { sandboxId, stopMs: Date.now() - t0 });
    } catch (e) {
      await ctx.runMutation(internal.lifecycle.pool.recordFailure, { sandboxId, op: "stop", error: errorMessage(e) });
    }
  },
});

export const deleteSandbox = internalAction({
  args: { sandboxId: v.id("sandboxes") },
  handler: async (ctx, { sandboxId }) => {
    const t0 = Date.now();
    const row = await loadRow(ctx, sandboxId);
    try {
      if (row?.daytonaId) {
        try {
          await (await daytona().get(row.daytonaId)).delete(120);
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
      }
      await ctx.runMutation(internal.lifecycle.pool.recordDeleted, { sandboxId, deleteMs: Date.now() - t0 });
    } catch (e) {
      await ctx.runMutation(internal.lifecycle.pool.recordFailure, { sandboxId, op: "delete", error: errorMessage(e) });
    }
  },
});

export const probeSandbox = internalAction({
  args: { sandboxId: v.id("sandboxes") },
  handler: async (ctx, { sandboxId }) => {
    try {
      const row = await loadRow(ctx, sandboxId);
      if (!row) return;
      if (!row.daytonaId) {
        // Create never finished: treat as missing so the thread gets a fresh VM.
        await ctx.runMutation(internal.lifecycle.pool.recordMissing, { sandboxId, source: "probe_no_daytona_id" });
        return;
      }
      const vm = await getVm(ctx, sandboxId, "probe");
      if (!vm) return;
      await ctx.runMutation(internal.lifecycle.pool.recordProbe, { sandboxId, daytonaState: vm.state ?? "unknown" });
    } catch (e) {
      await ctx.runMutation(internal.lifecycle.pool.recordFailure, { sandboxId, op: "probe", error: errorMessage(e) });
    }
  },
});

/** Dead-man's switch upkeep: keep Daytona auto-stop from firing on live sandboxes. */
export const refreshActivity = internalAction({
  args: { sandboxIds: v.array(v.id("sandboxes")) },
  handler: async (ctx, { sandboxIds }) => {
    const ok: Id<"sandboxes">[] = [];
    const failed: Id<"sandboxes">[] = [];
    await Promise.all(
      sandboxIds.map(async (sandboxId) => {
        try {
          const vm = await getVm(ctx, sandboxId, "refresh");
          if (!vm) return;
          await vm.refreshActivity();
          ok.push(sandboxId);
        } catch {
          failed.push(sandboxId);
        }
      }),
    );
    await ctx.runMutation(internal.lifecycle.pool.recordRefreshed, { sandboxIds: ok, failed });
  },
});

/** Periodic drift detection: compare Daytona's view of our labelled sandboxes with our rows. */
export const observe = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!process.env.DAYTONA_API_KEY) return;
    const observed: { daytonaId: string; state: string; sandboxRow?: string }[] = [];
    for await (const vm of daytona().list({ labels: { app: APP_LABEL, deployment: deploymentLabel() } })) {
      observed.push({ daytonaId: vm.id, state: vm.state ?? "unknown", sandboxRow: vm.labels?.sandboxRow });
    }
    const { orphans } = await ctx.runMutation(internal.lifecycle.reconciler.applyObservation, { observed });
    for (const daytonaId of orphans) {
      try {
        await (await daytona().get(daytonaId)).delete(120);
      } catch (e) {
        if (!isNotFound(e)) console.warn(`orphan delete failed for ${daytonaId}: ${errorMessage(e)}`);
      }
    }
  },
});
