/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import schema from "./schema";

export const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts", "!./**/*.d.ts", "!./test.setup.ts"]);

export function makeTest() {
  return convexTest(schema, modules);
}

export async function sha256Hex(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
