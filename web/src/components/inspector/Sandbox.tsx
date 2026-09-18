import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ms, time } from "../../lib";
import { StateBadge } from "../StateBadge";

/** Every sandbox this thread has had (recreations included) with its transition history. */
export function Sandbox({ threadId }: { threadId: Id<"threads"> }) {
  const rows = useQuery(api.observability.sandboxHistory, { threadId });
  if (!rows) return <p className="text-zinc-500">Loading…</p>;
  if (rows.length === 0) return <p className="text-zinc-500">No sandbox.</p>;
  return (
    <div className="space-y-4">
      {rows.map((s, i) => (
        <section key={s._id} className="rounded-md border border-zinc-200 p-2">
          <div className="mb-2 flex items-center gap-2">
            <StateBadge state={s.state} />
            <span className="font-medium">{i === 0 ? "current" : "previous"}</span>
            <span className="ml-auto text-[10px] text-zinc-400">{s.cold ? "cold" : "from pool"}</span>
          </div>
          <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-0.5 text-zinc-600">
            <dt>Daytona id</dt>
            <dd className="truncate font-mono">{s.daytonaId ?? "–"}</dd>
            <dt>snapshot</dt>
            <dd className="truncate font-mono">{s.snapshot || "–"}</dd>
            <dt>runner</dt>
            <dd className="font-mono">
              {s.runnerVersion ?? "–"} (protocol {s.protocolVersion ?? "–"})
            </dd>
            <dt>boot id</dt>
            <dd className="truncate font-mono">{s.bootId ?? "–"}</dd>
            <dt>create / start</dt>
            <dd>
              {ms(s.spans.createMs)} / {ms(s.spans.startMs)}
            </dd>
            <dt>daemon boot</dt>
            <dd>{ms(s.spans.daemonBootMs)}</dd>
            <dt>request → ready</dt>
            <dd>{ms(s.spans.readyMs)}</dd>
            <dt>last activity</dt>
            <dd>{time(s.lastActivityAt)}</dd>
            {s.pendingOp && (
              <>
                <dt>pending op</dt>
                <dd>{s.pendingOp.op}</dd>
              </>
            )}
            {s.error && (
              <>
                <dt>error</dt>
                <dd className="text-red-700">{s.error}</dd>
              </>
            )}
          </dl>
          <h4 className="mt-2 mb-1 font-semibold">History</h4>
          <ol className="space-y-0.5">
            {s.events.map((e) => {
              const d = (e.data ?? {}) as { from?: string; to?: string; reason?: string };
              return (
                <li key={e._id} className="flex gap-2 font-mono text-[10px]">
                  <span className="text-zinc-400">{time(e.at)}</span>
                  {e.type === "sandbox.transition" ? (
                    <span>
                      {d.from} → <b>{d.to}</b> <span className="text-zinc-500">({d.reason})</span>
                    </span>
                  ) : (
                    <span className="text-zinc-600">
                      {e.type}
                      {e.durationMs !== undefined && <span className="text-zinc-400"> {ms(e.durationMs)}</span>}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
