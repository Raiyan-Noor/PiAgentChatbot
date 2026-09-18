import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { cx, stateStyle } from "../lib";
import { StateBadge } from "./StateBadge";

export function ThreadList({ selected, onSelect }: { selected: Id<"threads"> | null; onSelect: (id: Id<"threads"> | null) => void }) {
  const threads = useQuery(api.threads.list);
  const fleet = useQuery(api.observability.fleet);
  const create = useMutation(api.threads.create);
  const remove = useMutation(api.threads.remove);
  const [creating, setCreating] = useState(false);

  async function onCreate() {
    setCreating(true);
    try {
      const { threadId } = await create({});
      onSelect(threadId);
    } finally {
      setCreating(false);
    }
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col bg-zinc-50">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="text-sm font-semibold">Threads</span>
        <button
          onClick={onCreate}
          disabled={creating}
          className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          + New thread
        </button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2">
        {threads?.map((t) => (
          <li key={t._id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onSelect(t._id)}
              onKeyDown={(e) => e.key === "Enter" && onSelect(t._id)}
              className={cx(
                "group mb-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                selected === t._id ? "bg-white shadow-sm ring-1 ring-zinc-200" : "hover:bg-zinc-100",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {t.sandboxState && <StateBadge state={t.sandboxState} />}
              <button
                title="Delete thread and its sandbox"
                onClick={(e) => {
                  e.stopPropagation();
                  if (selected === t._id) onSelect(null);
                  void remove({ threadId: t._id });
                }}
                className="hidden text-zinc-400 hover:text-red-600 group-hover:block"
              >
                ×
              </button>
            </div>
          </li>
        ))}
        {threads?.length === 0 && <li className="px-2 py-4 text-xs text-zinc-500">No threads yet.</li>}
      </ul>
      {fleet && (
        <div className="border-t border-zinc-200 px-3 py-2 text-[11px] text-zinc-500">
          <div className="mb-1 font-medium text-zinc-600">Sandbox fleet</div>
          <div className="flex flex-wrap gap-1">
            {Object.entries(fleet)
              .filter(([, n]) => n > 0)
              .map(([state, n]) => (
                <span key={state} className={cx("rounded px-1.5 py-0.5", stateStyle[state as keyof typeof stateStyle])}>
                  {state} {n}
                </span>
              ))}
          </div>
        </div>
      )}
    </aside>
  );
}
