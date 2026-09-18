import { describe, expect, test } from "vitest";
import { SANDBOX_STATES } from "../../shared/protocol";
import { assertTransition, canTransition, IllegalTransitionError, TRANSITIONS } from "./stateMachine";

describe("sandbox state machine", () => {
  test("happy paths are legal", () => {
    const paths = [
      ["provisioning", "pooled", "ready", "stopping", "stopped", "starting", "ready"],
      ["provisioning", "ready", "deleting", "deleted"],
      ["ready", "error", "starting", "ready"],
    ] as const;
    for (const path of paths) {
      for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!), `${path[i - 1]} -> ${path[i]}`).toBe(true);
    }
  });

  test("illegal transitions throw", () => {
    expect(() => assertTransition("deleted", "ready")).toThrow(IllegalTransitionError);
    expect(() => assertTransition("pooled", "stopped")).toThrow(/pooled -> stopped/);
    expect(() => assertTransition("stopped", "pooled")).toThrow();
    expect(() => assertTransition("ready", "ready")).toThrow();
  });

  test("deleted is terminal and every other state can be deleted", () => {
    expect(TRANSITIONS.deleted).toEqual([]);
    for (const s of SANDBOX_STATES) if (s !== "deleted" && s !== "deleting") expect(canTransition(s, "deleting") || canTransition(s, "deleted")).toBe(true);
  });

  test("table covers every state", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...SANDBOX_STATES].sort());
  });
});
