/**
 * Sandbox token authentication for the execution API. The VM holds a 32-byte
 * random token (env var); Convex stores only its SHA-256.
 */
import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sandboxForToken(ctx: QueryCtx, token: string): Promise<Doc<"sandboxes"> | null> {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const sandbox = await ctx.db
    .query("sandboxes")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!sandbox || sandbox.state === "deleted" || sandbox.state === "deleting") return null;
  return sandbox;
}

export async function requireSandbox(ctx: QueryCtx, token: string): Promise<Doc<"sandboxes">> {
  const sandbox = await sandboxForToken(ctx, token);
  if (!sandbox) throw new ConvexError({ code: "unauthorized", message: "invalid or revoked sandbox token" });
  return sandbox;
}
