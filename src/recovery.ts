import type { Conversation, Job, JobEvent } from "./api";

export const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const PROCESS_EVENT_WINDOW = 50;
export const RETAINED_STAGE_FEEDBACK_LIMIT = 5;
export const RETAINED_APPROVAL_LIMIT = 20;

export function isTerminalJob(job: Job | null | undefined): boolean {
  return Boolean(job && TERMINAL_JOB_STATUSES.has(job.status));
}

export function chooseSelectedConversation(savedId: string | null, conversations: Conversation[]): string | null {
  if (savedId && conversations.some((conversation) => conversation.id === savedId)) return savedId;
  return conversations[0]?.id ?? null;
}

export function mergeJobEvents(current: JobEvent[], incoming: JobEvent[]): JobEvent[] {
  const merged = new Map<number, JobEvent>();
  for (const event of [...current, ...incoming]) merged.set(event.seq ?? -(merged.size + 1), event);
  const ordered = [...merged.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const rollingStart = Math.max(0, ordered.length - PROCESS_EVENT_WINDOW);
  const retainedStageFeedback = ordered
    .slice(0, rollingStart)
    .filter((event) => event.kind === "update")
    .slice(-RETAINED_STAGE_FEEDBACK_LIMIT);
  const retainedApprovalByReview = new Map<string, JobEvent>();
  for (const event of ordered.slice(0, rollingStart)) {
    if (event.kind !== "approval") continue;
    retainedApprovalByReview.set(event.reviewId ?? `seq:${event.seq ?? retainedApprovalByReview.size}`, event);
  }
  const retainedApprovals = [...retainedApprovalByReview.values()].slice(-RETAINED_APPROVAL_LIMIT);
  // Long tasks overflow the rolling window, which would otherwise drop the
  // first "running" event and make the completed "总用时" start from a status
  // update near the end (showing ~1 second). Keep the execution boundaries so
  // taskElapsedSeconds can still measure from the real start to the terminal
  // event.
  const firstRunning = ordered.find((event) => (event.kind === "status" || event.type === "status") && event.status === "running");
  const lastTerminal = ordered.findLast((event) => event.type === "done" || event.type === "failed");
  const retainedBoundaries: JobEvent[] = [];
  for (const event of [firstRunning, lastTerminal]) {
    if (event && event.seq !== undefined) retainedBoundaries.push(event);
  }
  const combined = [...retainedBoundaries, ...retainedStageFeedback, ...retainedApprovals, ...ordered.slice(rollingStart)];
  const deduped = new Map<number, JobEvent>();
  for (const event of combined) deduped.set(event.seq ?? -(deduped.size + 1), event);
  return [...deduped.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}
