/**
 * Per-run waterfall. Bars are positioned on one axis: queue wait (control-plane
 * clock) followed by the VM-side run (VM clock), so no cross-clock subtraction.
 */
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import type { Id } from "../../../../convex/_generated/dataModel";
import { cx, ms } from "../../lib";

interface Bar {
  label: string;
  start: number;
  duration: number;
  color: string;
  note?: string;
}

export function Timeline({ threadId }: { threadId: Id<"threads"> }) {
  const runs = useQuery(api.observability.timeline, { threadId });
  const thread = useQuery(api.threads.get, { threadId });
  if (!runs) return <p className="text-zinc-500">Loading…</p>;
  const s = thread?.sandbox;

  return (
    <div className="space-y-5">
      {s && (
        <section>
          <h3 className="mb-1 font-semibold">Sandbox readiness</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-zinc-600">
            <span>source</span>
            <span>{s.cold ? "cold create" : "warm pool"}</span>
            <span>Daytona create</span>
            <span>{ms(s.spans.createMs)}</span>
            <span>Daytona start</span>
            <span>{ms(s.spans.startMs)}</span>
            <span>daemon boot (VM)</span>
            <span>{ms(s.spans.daemonBootMs)}</span>
            <span>request → registered</span>
            <span>{ms(s.spans.readyMs)}</span>
          </div>
        </section>
      )}
      {runs.length === 0 && <p className="text-zinc-500">No runs yet.</p>}
      {runs.map((run) => {
        const queue = run.queueWaitMs ?? 0;
        const bars: Bar[] = [{ label: "queue → claim", start: 0, duration: queue, color: "bg-zinc-400", note: "dispatch overhead (CP clock)" }];
        if (run.llmRequestOffsetMs !== undefined) {
          bars.push({ label: "claim → LLM request", start: queue, duration: run.llmRequestOffsetMs, color: "bg-violet-400", note: "VM overhead" });
        }
        if (run.firstTokenOffsetMs !== undefined && run.llmRequestOffsetMs !== undefined) {
          bars.push({
            label: "LLM → first token",
            start: queue + run.llmRequestOffsetMs,
            duration: run.firstTokenOffsetMs - run.llmRequestOffsetMs,
            color: "bg-sky-400",
            note: "model latency",
          });
        }
        for (const t of run.tools) {
          if (t.startOffsetMs === undefined) continue;
          bars.push({
            label: t.name,
            start: queue + t.startOffsetMs,
            duration: t.durationMs ?? 0,
            color: t.status === "error" ? "bg-red-400" : t.status === "running" ? "bg-amber-300 animate-pulse" : "bg-emerald-400",
          });
        }
        const total = Math.max(run.totalMs ?? 0, queue + (run.vmDurationMs ?? 0), ...bars.map((b) => b.start + b.duration), 1);
        return (
          <section key={run.runId} className="rounded-md border border-zinc-200 p-2">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{run.prompt}</span>
              <span
                className={cx(
                  "rounded px-1 text-[10px]",
                  run.status === "completed" ? "bg-emerald-100 text-emerald-800" : run.status === "failed" ? "bg-red-100 text-red-800" : "bg-zinc-100",
                )}
              >
                {run.status}
              </span>
              <span className="text-zinc-500">{ms(run.totalMs)}</span>
            </div>
            <div className="space-y-0.5">
              {bars.map((b, i) => (
                <div key={i} className="flex items-center gap-2" title={b.note}>
                  <span className="w-28 shrink-0 truncate text-[10px] text-zinc-600">{b.label}</span>
                  <div className="relative h-3 flex-1 rounded-sm bg-zinc-100">
                    <div
                      className={cx("absolute h-3 rounded-sm", b.color)}
                      style={{ left: `${(b.start / total) * 100}%`, width: `max(2px, ${(b.duration / total) * 100}%)` }}
                    />
                  </div>
                  <span className="w-14 shrink-0 text-right text-[10px] text-zinc-500">{ms(b.duration)}</span>
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex gap-3 text-[10px] text-zinc-500">
              <span>{run.turns} LLM turns</span>
              {run.usage && (
                <span>
                  {run.usage.input}→{run.usage.output} tok · ${run.usage.costUsd.toFixed(4)}
                </span>
              )}
              {run.error && <span className="text-red-700">{run.error}</span>}
            </div>
          </section>
        );
      })}
    </div>
  );
}
