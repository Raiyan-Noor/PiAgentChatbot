/** Structured stdout logging (visible via Daytona session logs). */
export function log(level: "debug" | "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...data });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e && "data" in e) return JSON.stringify((e as { data: unknown }).data);
  return String(e);
}
