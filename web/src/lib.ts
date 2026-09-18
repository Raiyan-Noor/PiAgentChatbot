import type { SandboxState } from "../../shared/protocol";

export function ms(n: number | undefined | null): string {
  if (n === undefined || n === null) return "–";
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`;
}

export function time(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false }) + `.${String(at % 1000).padStart(3, "0")}`;
}

export const stateStyle: Record<SandboxState, string> = {
  provisioning: "bg-amber-100 text-amber-800",
  pooled: "bg-sky-100 text-sky-800",
  ready: "bg-emerald-100 text-emerald-800",
  stopping: "bg-zinc-200 text-zinc-700",
  stopped: "bg-zinc-200 text-zinc-600",
  starting: "bg-amber-100 text-amber-800",
  error: "bg-red-100 text-red-800",
  deleting: "bg-zinc-200 text-zinc-500",
  deleted: "bg-zinc-100 text-zinc-400",
};

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}
