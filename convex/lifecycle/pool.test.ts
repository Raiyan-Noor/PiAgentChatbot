import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { makeTest } from "../test.setup";

describe("warm pool", () => {
  test("concurrent thread creation never double-claims a pooled sandbox", async () => {
    vi.stubEnv("DAYTONA_SNAPSHOT", "snap-1");
    vi.stubEnv("SANDBOX_POOL_SIZE", "2");
    const t = makeTest();
    const pooled = await t.run(async (ctx) => {
      const now = Date.now();
      const mk = () =>
        ctx.db.insert("sandboxes", { state: "pooled", stateChangedAt: now, tokenHash: crypto.randomUUID(), snapshot: "snap-1", cold: false, lastActivityAt: now, spans: {} });
      return [await mk(), await mk()];
    });

    const results = await Promise.all([1, 2, 3].map(() => t.mutation(api.threads.create, {})));
    const fromPool = results.filter((r) => r.fromPool);
    expect(fromPool).toHaveLength(2);
    expect(new Set(fromPool.map((r) => r.sandboxId)).size).toBe(2);
    expect(fromPool.map((r) => r.sandboxId).sort()).toEqual([...pooled].sort());

    const cold = results.find((r) => !r.fromPool)!;
    const row = await t.run((ctx) => ctx.db.get(cold.sandboxId));
    expect(row).toMatchObject({ state: "provisioning", cold: true, pendingOp: { op: "create" } });
    vi.unstubAllEnvs();
  });

  test("pool members on an old snapshot are not handed out", async () => {
    vi.stubEnv("DAYTONA_SNAPSHOT", "snap-2");
    const t = makeTest();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("sandboxes", { state: "pooled", stateChangedAt: now, tokenHash: "x", snapshot: "snap-1", cold: false, lastActivityAt: now, spans: {} });
    });
    const r = await t.mutation(api.threads.create, {});
    expect(r.fromPool).toBe(false);
    vi.unstubAllEnvs();
  });

  test("message on a stopped sandbox wakes it (one scheduled start, no duplicates)", async () => {
    const t = makeTest();
    const threadId = await t.run(async (ctx) => {
      const now = Date.now();
      const threadId = await ctx.db.insert("threads", { title: "t", model: "m", transcriptSeq: 0, lastActivityAt: now });
      const sandboxId = await ctx.db.insert("sandboxes", {
        state: "stopped",
        stateChangedAt: now,
        threadId,
        daytonaId: "d1",
        tokenHash: "h",
        snapshot: "s",
        cold: true,
        lastActivityAt: now,
        spans: {},
      });
      await ctx.db.patch(threadId, { sandboxId });
      return threadId;
    });
    await t.mutation(api.messages.send, { threadId, text: "wake up" });
    await t.mutation(api.messages.send, { threadId, text: "and again" });
    const thread = await t.query(api.threads.get, { threadId });
    expect(thread?.sandbox).toMatchObject({ state: "starting", pendingOp: { op: "start" } });
    const transitions = await t.run((ctx) => ctx.db.query("events").filter((q) => q.eq(q.field("type"), "sandbox.transition")).collect());
    expect(transitions.map((e) => (e.data as { to: string }).to)).toEqual(["starting"]);
  });
});
