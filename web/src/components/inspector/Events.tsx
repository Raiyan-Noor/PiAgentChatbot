import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { cx, ms, time } from "../../lib";

/** Live raw event log (newest first), both planes. */
export function Events({ threadId }: { threadId: Id<"threads"> }) {
  const events = useQuery(api.observability.events, { threadId, limit: 500 });
  const [filter, setFilter] = useState("");
  if (!events) return <p className="text-zinc-500">Loading…</p>;
  const shown = filter ? events.filter((e) => e.type.includes(filter)) : events;
  return (
    <div>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="filter by type (e.g. vm.tool, sandbox, egress)"
        className="mb-2 w-full rounded border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-zinc-500"
      />
      <ol className="space-y-0.5 font-mono text-[10px]">
        {shown.map((e) => (
          <li key={e._id}>
            <details>
              <summary className="flex cursor-pointer gap-2">
                <span className="text-zinc-400">{time(e.at)}</span>
                <span className={cx("w-6", e.source === "vm" ? "text-violet-600" : "text-sky-700")}>{e.source}</span>
                <span className="flex-1 truncate">{e.type}</span>
                {e.durationMs !== undefined && <span className="text-zinc-500">{ms(e.durationMs)}</span>}
              </summary>
              <pre className="my-1 overflow-x-auto rounded bg-zinc-50 p-1.5 whitespace-pre-wrap break-all">
                {JSON.stringify({ ...(e.data ?? {}), vmAt: e.vmAt, runId: e.runId, sandboxId: e.sandboxId }, null, 2)}
              </pre>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}
