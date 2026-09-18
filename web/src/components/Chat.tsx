import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { cx } from "../lib";
import { StateBadge } from "./StateBadge";
import { ToolCallCard } from "./ToolCallCard";

export function Chat({
  threadId,
  inspectorOpen,
  onToggleInspector,
}: {
  threadId: Id<"threads">;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}) {
  const thread = useQuery(api.threads.get, { threadId });
  const items = useQuery(api.messages.list, { threadId });
  const runs = useQuery(api.runs.listByThread, { threadId });
  const send = useMutation(api.messages.send);
  const cancel = useMutation(api.runs.cancel);
  const stopSandbox = useMutation(api.admin.stopThreadSandbox);
  const [text, setText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  const active = runs?.find((r) => r.status === "claimed" || r.status === "running");
  const queued = runs?.filter((r) => r.status === "queued") ?? [];

  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [items]);

  async function onSend() {
    const prompt = text.trim();
    if (!prompt) return;
    setText("");
    await send({ threadId, text: prompt });
    requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
  }

  if (thread === null) return <div className="m-auto text-sm text-zinc-500">Thread not found.</div>;

  return (
    <>
      <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2.5">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{thread?.title ?? "…"}</h1>
        <span className="text-xs text-zinc-500">{thread?.model}</span>
        {thread?.sandbox && <StateBadge state={thread.sandbox.state} />}
        {thread?.sandbox?.state === "ready" && !active && (
          <button onClick={() => void stopSandbox({ threadId })} className="text-xs text-zinc-500 hover:text-zinc-900" title="Stop the VM now (next message resumes it)">
            Stop VM
          </button>
        )}
        <button onClick={onToggleInspector} className="text-xs text-zinc-500 hover:text-zinc-900">
          {inspectorOpen ? "Hide inspector" : "Inspector"}
        </button>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
          {items?.map((item) =>
            item.kind === "tool" ? (
              <ToolCallCard key={item._id} call={item} />
            ) : (
              <MessageBubble key={item._id} message={item} />
            ),
          )}
          {active && !items?.some((i) => i.kind === "message" && i.runId === active._id && i.role === "assistant") && (
            <div className="text-xs text-zinc-500">
              <span className="animate-pulse">●</span> {active.status === "claimed" ? "agent picked up the message…" : "thinking…"}
            </div>
          )}
          {queued.length > 0 && !active && (
            <div className="text-xs text-zinc-500">
              <span className="animate-pulse">●</span> queued — waiting for sandbox ({thread?.sandbox?.state ?? "…"})
            </div>
          )}
        </div>
      </div>

      <footer className="border-t border-zinc-200 p-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSend();
              }
            }}
            rows={Math.min(6, Math.max(1, text.split("\n").length))}
            placeholder={active ? "Agent is working — messages will queue" : "Message the agent (Enter to send, Shift+Enter for newline)"}
            className="min-h-[38px] flex-1 resize-none rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
          />
          {active ? (
            <button
              onClick={() => void cancel({ runId: active._id })}
              disabled={!!active.cancelRequestedAt}
              className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
            >
              {active.cancelRequestedAt ? "Stopping…" : "Stop"}
            </button>
          ) : null}
          <button onClick={() => void onSend()} className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700">
            Send
          </button>
        </div>
        {queued.length > 0 && <div className="mx-auto mt-1 max-w-3xl text-[11px] text-zinc-500">{queued.length} message(s) queued</div>}
      </footer>
    </>
  );
}

function MessageBubble({ message }: { message: Doc<"messages"> }) {
  const [showThinking, setShowThinking] = useState(false);
  const isUser = message.role === "user";
  return (
    <div className={cx("flex", isUser && "justify-end")}>
      <div
        className={cx(
          "max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words",
          isUser ? "bg-zinc-900 text-white" : "bg-zinc-100",
          message.status === "error" && "bg-red-50 text-red-900 ring-1 ring-red-200",
        )}
      >
        {message.thinking && (
          <button onClick={() => setShowThinking((s) => !s)} className="mb-1 block text-[11px] text-zinc-500 hover:text-zinc-800">
            {showThinking ? "▾" : "▸"} reasoning
          </button>
        )}
        {showThinking && message.thinking && <div className="mb-2 border-l-2 border-zinc-300 pl-2 text-xs text-zinc-500">{message.thinking}</div>}
        {message.text}
        {message.status === "streaming" && <span className="ml-0.5 animate-pulse">▍</span>}
        {message.usage && (
          <div className="mt-1 text-[10px] text-zinc-400">
            {message.usage.input}→{message.usage.output} tok{message.usage.costUsd ? ` · $${message.usage.costUsd.toFixed(4)}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}
