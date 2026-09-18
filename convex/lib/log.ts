import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export interface LogEvent {
  type: string;
  threadId?: Id<"threads">;
  runId?: Id<"runs">;
  sandboxId?: Id<"sandboxes">;
  durationMs?: number;
  vmAt?: number;
  data?: unknown;
}

/** Append a control-plane event to the timeline. Always call inside the mutation that made the change. */
export async function logEvent(ctx: MutationCtx, e: LogEvent, source: "cp" | "vm" = "cp") {
  await ctx.db.insert("events", { ...e, source, at: Date.now() });
}
