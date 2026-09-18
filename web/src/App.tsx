import { useEffect, useState } from "react";
import type { Id } from "../../convex/_generated/dataModel";
import { Chat } from "./components/Chat";
import { Inspector } from "./components/inspector/Inspector";
import { ThreadList } from "./components/ThreadList";

function readHash(): Id<"threads"> | null {
  const m = /thread=([a-z0-9]+)/.exec(window.location.hash);
  return m ? (m[1] as Id<"threads">) : null;
}

export function App() {
  // Selected thread lives in the URL hash (#thread=<id>) so links and reloads keep it.
  const [threadId, setThreadId] = useState<Id<"threads"> | null>(readHash);
  const [inspectorOpen, setInspectorOpen] = useState(true);

  useEffect(() => {
    const onHash = () => setThreadId(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    const next = threadId ? `#thread=${threadId}` : "";
    if (window.location.hash !== next) history.replaceState(null, "", next || window.location.pathname);
  }, [threadId]);

  return (
    <div className="flex h-full min-h-0">
      <ThreadList selected={threadId} onSelect={setThreadId} />
      <main className="flex min-w-0 flex-1 flex-col border-x border-zinc-200 bg-white">
        {threadId ? (
          <Chat threadId={threadId} inspectorOpen={inspectorOpen} onToggleInspector={() => setInspectorOpen((o) => !o)} />
        ) : (
          <div className="m-auto max-w-sm p-6 text-center text-sm text-zinc-500">
            Create a thread. Each thread gets its own Daytona sandbox running the Pi agent.
          </div>
        )}
      </main>
      {threadId && inspectorOpen && <Inspector threadId={threadId} />}
    </div>
  );
}
