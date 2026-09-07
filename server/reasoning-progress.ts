/**
 * Reasoning text arrives as a stream of growing snapshots. Publishing every
 * snapshot would create tens of thousands of job events for a single thought,
 * so progress events are coalesced into periodic snapshots of the same stream.
 */
export const REASONING_SNAPSHOT_MIN_CHARS = 120;
export const REASONING_SNAPSHOT_MAX_INTERVAL_MS = 500;

export type ReasoningProgressState = {
  detail: string;
  publishedDetail: string;
  lastPublishedAt: number;
};

export function continuesReasoningStream(detail: string, state: ReasoningProgressState | undefined): boolean {
  return Boolean(state && state.detail && detail.length >= state.detail.length && detail.startsWith(state.detail));
}

export function reasoningSnapshotDue(detail: string, state: ReasoningProgressState, now: number): boolean {
  return detail.length - state.publishedDetail.length >= REASONING_SNAPSHOT_MIN_CHARS
    || now - state.lastPublishedAt >= REASONING_SNAPSHOT_MAX_INTERVAL_MS;
}
