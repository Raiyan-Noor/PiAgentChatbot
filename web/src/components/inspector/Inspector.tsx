import { useState } from "react";
import type { Id } from "../../../../convex/_generated/dataModel";
import { cx } from "../../lib";
import { Context } from "./Context";
import { Events } from "./Events";
import { Sandbox } from "./Sandbox";
import { Timeline } from "./Timeline";
import { Tools } from "./Tools";

const TABS = ["Timeline", "Tools", "Sandbox", "Events", "Context"] as const;
type Tab = (typeof TABS)[number];

export function Inspector({ threadId }: { threadId: Id<"threads"> }) {
  const [tab, setTab] = useState<Tab>("Timeline");
  return (
    <aside className="flex w-[440px] shrink-0 flex-col bg-zinc-50">
      <nav className="flex gap-1 border-b border-zinc-200 px-2 pt-2">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cx(
              "rounded-t-md px-2.5 py-1.5 text-xs font-medium",
              tab === t ? "border border-b-0 border-zinc-200 bg-white text-zinc-900" : "text-zinc-500 hover:text-zinc-900",
            )}
          >
            {t}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto bg-white p-3 text-xs">
        {tab === "Timeline" && <Timeline threadId={threadId} />}
        {tab === "Tools" && <Tools threadId={threadId} />}
        {tab === "Sandbox" && <Sandbox threadId={threadId} />}
        {tab === "Events" && <Events threadId={threadId} />}
        {tab === "Context" && <Context threadId={threadId} />}
      </div>
    </aside>
  );
}
