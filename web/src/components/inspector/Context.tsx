import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { cx } from "../../lib";

/** The raw transcript: exactly the messages a (re)hydrated agent sees. */
export function Context({ threadId }: { threadId: Id<"threads"> }) {
  const entries = useQuery(api.observability.transcript, { threadId });
  if (!entries) return <p className="text-zinc-500">Loading…</p>;
  if (entries.length === 0) return <p className="text-zinc-500">Empty transcript.</p>;
  const bytes = entries.reduce((n, e) => n + JSON.stringify(e.raw).length, 0);
  return (
    <div>
      <p className="mb-2 text-zinc-500">
        {entries.length} messages · {(bytes / 1024).toFixed(1)} KiB · rehydrated into any new VM for this thread
      </p>
      <ol className="space-y-1">
        {entries.map((e) => {
          const raw = e.raw as { role?: string; toolName?: string };
          return (
            <li key={e._id}>
              <details>
                <summary className="cursor-pointer font-mono text-[10px]">
                  <span className="text-zinc-400">#{e.seq}</span>{" "}
                  <span className={cx(raw.role === "user" ? "text-sky-700" : raw.role === "assistant" ? "text-violet-700" : "text-emerald-700")}>
                    {raw.role}
                  </span>
                  {raw.toolName && <span className="text-zinc-500"> ({raw.toolName})</span>}
                </summary>
                <pre className="my-1 max-h-80 overflow-auto rounded bg-zinc-50 p-1.5 font-mono text-[10px] whitespace-pre-wrap break-all">
                  {JSON.stringify(e.raw, null, 2)}
                </pre>
              </details>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
