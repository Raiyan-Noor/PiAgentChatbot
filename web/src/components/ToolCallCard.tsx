/**
 * One card per tool call: name, inputs, live output tail while running, and a
 * structured result. Each tool has a small renderer keyed by name.
 */
import { useState, type ReactNode } from "react";
import type { Doc } from "../../../convex/_generated/dataModel";
import type {
  BashDetails,
  EditDetails,
  GlobDetails,
  GrepDetails,
  ToolDetailsByName,
  WebfetchDetails,
  WebsearchDetails,
} from "../../../shared/protocol";
import { cx, ms } from "../lib";

type Args = Record<string, unknown>;
type Renderer = { summary: (args: Args) => ReactNode; result?: (details: unknown, text: string) => ReactNode };

const str = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

const Pre = ({ children, className }: { children: ReactNode; className?: string }) => (
  <pre className={cx("max-h-72 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed text-zinc-100 whitespace-pre-wrap break-all", className)}>
    {children}
  </pre>
);

const renderers: { [K in keyof ToolDetailsByName]: Renderer } = {
  bash: {
    summary: (a) => <code>$ {str(a.command)}</code>,
    result: (d, text) => {
      const x = d as BashDetails;
      return (
        <>
          <div className="mb-1 text-[11px] text-zinc-500">
            exit code <b className={x.exitCode === 0 ? "text-emerald-700" : "text-red-700"}>{x.exitCode ?? "?"}</b>
            {x.truncation?.truncated && ` · truncated (${x.truncation.outputLines}/${x.truncation.totalLines} lines)`}
          </div>
          <Pre>{text}</Pre>
        </>
      );
    },
  },
  read: { summary: (a) => <code>{str(a.path)}</code> },
  write: {
    summary: (a) => (
      <code>
        {str(a.path)} <span className="text-zinc-400">({str(a.content).length} chars)</span>
      </code>
    ),
    result: (_d, text) => <div className="text-xs text-zinc-600">{text}</div>,
  },
  edit: {
    summary: (a) => (
      <code>
        {str(a.path)} <span className="text-zinc-400">({Array.isArray(a.edits) ? a.edits.length : 1} edit)</span>
      </code>
    ),
    result: (d, text) => {
      const patch = (d as EditDetails).patch;
      if (!patch) return <Pre>{text}</Pre>;
      return (
        <Pre>
          {patch.split("\n").map((line, i) => (
            <div key={i} className={line.startsWith("+") ? "text-emerald-300" : line.startsWith("-") ? "text-red-300" : undefined}>
              {line}
            </div>
          ))}
        </Pre>
      );
    },
  },
  grep: {
    summary: (a) => (
      <code>
        /{str(a.pattern)}/ {a.path ? `in ${str(a.path)}` : ""} {a.glob ? `(${str(a.glob)})` : ""}
      </code>
    ),
    result: (d, text) => (
      <>
        <div className="mb-1 text-[11px] text-zinc-500">{(d as GrepDetails).matchCount} matching lines</div>
        <Pre>{text}</Pre>
      </>
    ),
  },
  glob: {
    summary: (a) => <code>{str(a.pattern)}</code>,
    result: (d, text) => {
      const paths = (d as GlobDetails).paths ?? [];
      return paths.length ? (
        <ul className="font-mono text-[11px]">
          {paths.slice(0, 50).map((p) => (
            <li key={p}>{p}</li>
          ))}
          {paths.length > 50 && <li className="text-zinc-500">…{paths.length - 50} more</li>}
        </ul>
      ) : (
        <div className="text-xs text-zinc-500">{text}</div>
      );
    },
  },
  webfetch: {
    summary: (a) => <code>{str(a.url)}</code>,
    result: (d, text) => {
      const x = d as WebfetchDetails;
      return (
        <>
          <div className="mb-1 text-[11px] text-zinc-500">
            HTTP {x.status} · {x.contentType} · {x.bytes} bytes{x.truncated ? " · truncated" : ""} · via control-plane egress
          </div>
          <Pre>{text}</Pre>
        </>
      );
    },
  },
  websearch: {
    summary: (a) => <code>“{str(a.query)}”</code>,
    result: (d) => (
      <ol className="space-y-1.5 text-xs">
        {(d as WebsearchDetails).results?.map((r) => (
          <li key={r.url}>
            <a href={r.url} target="_blank" rel="noreferrer" className="font-medium text-sky-700 hover:underline">
              {r.title || r.url}
            </a>
            <div className="text-zinc-500">{r.snippet.slice(0, 200)}</div>
          </li>
        ))}
      </ol>
    ),
  },
};

export function ToolCallCard({ call }: { call: Doc<"toolCalls"> }) {
  const [open, setOpen] = useState(false);
  const r = renderers[call.name as keyof typeof renderers];
  const args = (call.args ?? {}) as Args;
  const running = call.status === "running";

  return (
    <div className={cx("rounded-lg border text-sm", call.status === "error" ? "border-red-200 bg-red-50/40" : "border-zinc-200 bg-white")}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left">
        <span className={cx("h-2 w-2 shrink-0 rounded-full", running ? "animate-pulse bg-amber-400" : call.status === "error" ? "bg-red-500" : "bg-emerald-500")} />
        <span className="font-mono text-xs font-semibold">{call.name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-600">{r ? r.summary(args) : <code>{JSON.stringify(args)}</code>}</span>
        <span className="text-[11px] text-zinc-400">{running ? "running…" : ms(call.durationMs)}</span>
        <span className="text-zinc-400">{open ? "▾" : "▸"}</span>
      </button>
      {running && call.liveOutputTail && (
        <div className="px-3 pb-2">
          <Pre className="max-h-40">{call.liveOutputTail}</Pre>
        </div>
      )}
      {open && (
        <div className="space-y-2 border-t border-zinc-100 px-3 py-2">
          <details>
            <summary className="cursor-pointer text-[11px] text-zinc-500">input</summary>
            <Pre>{JSON.stringify(call.args, null, 2)}</Pre>
          </details>
          {call.result &&
            (call.isError || !r?.result ? (
              <Pre className={call.isError ? "bg-red-950" : undefined}>{call.result.text}</Pre>
            ) : (
              r.result(call.result.details, call.result.text)
            ))}
          {call.result?.truncated && <div className="text-[11px] text-zinc-500">output truncated to fit storage limits</div>}
        </div>
      )}
    </div>
  );
}
