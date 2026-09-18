/**
 * The one sandbox lifecycle state machine. Every state change in the codebase
 * goes through `transition`, which enforces the table below and writes a
 * `sandbox.transition` event in the same transaction.
 *
 *   provisioning ─register(unassigned)─▶ pooled ─claim─▶ ready ─idle─▶ stopping ─▶ stopped
 *   provisioning ─register(bound)──────────────────────▶ ready                       │
 *   ready ◀─register─ starting ◀─message/recover──────────────────────────────────────┘
 *   any ─failure─▶ error ─reconcile─▶ starting | deleting        any ─▶ deleting ─▶ deleted
 */
import type { SandboxState } from "../../shared/protocol";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { logEvent } from "../lib/log";

export const TRANSITIONS: Record<SandboxState, readonly SandboxState[]> = {
  provisioning: ["pooled", "ready", "error", "deleting", "deleted"],
  pooled: ["ready", "error", "deleting", "deleted"],
  ready: ["stopping", "error", "deleting", "deleted"],
  stopping: ["stopped", "error", "deleting", "deleted"],
  stopped: ["starting", "ready", "error", "deleting", "deleted"],
  starting: ["ready", "error", "deleting", "deleted"],
  error: ["starting", "ready", "pooled", "deleting", "deleted"],
  deleting: ["deleted", "error"],
  deleted: [],
};

export function canTransition(from: SandboxState, to: SandboxState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: SandboxState,
    readonly to: SandboxState,
  ) {
    super(`Illegal sandbox transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: SandboxState, to: SandboxState) {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** States in which the VM may be consuming compute. */
export const LIVE_STATES: readonly SandboxState[] = ["provisioning", "pooled", "ready", "starting", "stopping"];

export async function transition(
  ctx: MutationCtx,
  sandbox: Doc<"sandboxes">,
  to: SandboxState,
  reason: string,
  patch: Partial<Omit<Doc<"sandboxes">, "_id" | "_creationTime" | "state" | "stateChangedAt">> = {},
): Promise<Doc<"sandboxes">> {
  assertTransition(sandbox.state, to);
  const now = Date.now();
  const next = { ...patch, state: to, stateChangedAt: now };
  await ctx.db.patch(sandbox._id, next);
  await logEvent(ctx, {
    type: "sandbox.transition",
    sandboxId: sandbox._id,
    threadId: patch.threadId ?? sandbox.threadId,
    durationMs: now - sandbox.stateChangedAt,
    data: { from: sandbox.state, to, reason, ...(patch.error ? { error: patch.error } : {}) },
  });
  return { ...sandbox, ...next };
}
