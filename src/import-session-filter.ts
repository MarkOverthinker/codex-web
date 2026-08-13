import type { ImportableSession } from "./api.js";

/**
 * Filter importable sessions by local calendar dates. Empty bounds keep all
 * sessions; a bound that fails to parse is ignored so a bad manual input
 * degrades to "no narrower filter" instead of an empty list.
 */
export function filterImportableSessionsByDateRange(
  sessions: readonly ImportableSession[],
  fromDate: string,
  toDate: string,
): ImportableSession[] {
  const fromMs = fromDate ? Date.parse(`${fromDate}T00:00:00`) : Number.NaN;
  const toMs = toDate ? Date.parse(`${toDate}T00:00:00`) + 86_400_000 - 1 : Number.NaN;
  const hasFrom = Number.isFinite(fromMs);
  const hasTo = Number.isFinite(toMs);
  if (!hasFrom && !hasTo) return [...sessions];
  return sessions.filter((session) => {
    const createdAtMs = Date.parse(session.createdAt);
    if (!Number.isFinite(createdAtMs)) return false;
    if (hasFrom && createdAtMs < fromMs) return false;
    if (hasTo && createdAtMs > toMs) return false;
    return true;
  });
}
