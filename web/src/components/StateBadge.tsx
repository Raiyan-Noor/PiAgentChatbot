import type { SandboxState } from "../../../shared/protocol";
import { cx, stateStyle } from "../lib";

export function StateBadge({ state }: { state: SandboxState }) {
  const busy = state === "provisioning" || state === "starting" || state === "stopping";
  return (
    <span className={cx("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", stateStyle[state], busy && "animate-pulse")}>
      {state}
    </span>
  );
}
