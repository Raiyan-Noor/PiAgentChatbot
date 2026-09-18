import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { cx, ms } from "../../lib";

/** Ordered tool-usage history across the thread. */
export function Tools({ threadId }: { threadId: Id<"threads"> }) {
  const items = useQuery(api.messages.list, { threadId });
  const calls = items?.filter((i) => i.kind === "tool") ?? [];
  if (!items) return <p className="text-zinc-500">Loading…</p>;
  if (calls.length === 0) return <p className="text-zinc-500">No tool calls yet.</p>;
  return (
    <table className="w-full table-fixed border-collapse">
      <thead>
        <tr className="text-left text-[10px] text-zinc-500 uppercase">
          <th className="w-6 pb-1">#</th>
          <th className="w-20 pb-1">tool</th>
          <th className="pb-1">input → output</th>
          <th className="w-14 pb-1 text-right">time</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((c, i) => (
          <tr key={c._id} className="border-t border-zinc-100 align-top">
            <td className="py-1 text-zinc-400">{i + 1}</td>
            <td className="py-1">
              <span className={cx("font-mono font-semibold", c.status === "error" && "text-red-700")}>{c.name}</span>
            </td>
            <td className="py-1">
              <div className="truncate font-mono text-[10px] text-zinc-700" title={JSON.stringify(c.args)}>
                {JSON.stringify(c.args)}
              </div>
              <div className="truncate font-mono text-[10px] text-zinc-400" title={c.result?.text}>
                {c.status === "running" ? "running…" : (c.result?.text.split("\n")[0] ?? "")}
              </div>
            </td>
            <td className="py-1 text-right text-zinc-500">{ms(c.durationMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
