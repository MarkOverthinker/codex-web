import type { JobEvent } from "./api";

/**
 * Total execution time of the latest task in seconds, measured from the first
 * `running` status event to the terminal `done`/`failed` event.
 */
export function taskElapsedSeconds(activities: JobEvent[]): number | null {
  const startedAt = activities.find((activity) => activity.kind === "status" && activity.status === "running")?.created_at;
  const endedAt = activities.findLast((activity) => activity.type === "done" || activity.type === "failed")?.created_at;
  if (!startedAt || !endedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.max(1, Math.round((end - start) / 1000));
}

export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes > 0 ? `${minutes} 分 ${String(rest).padStart(2, "0")} 秒` : `${total} 秒`;
}
