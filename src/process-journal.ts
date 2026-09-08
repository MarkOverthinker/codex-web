import type { JobEvent } from "./api";

const NARRATIVE_KINDS = new Set(["reasoning", "update"]);
const ACTION_KINDS = new Set(["command", "file", "search", "tool", "subagent", "approval", "error"]);

export type ProcessJournalEvent = JobEvent & {
  actionCount?: number;
  groupedDetails?: string[];
};

export function buildProcessJournal(activities: JobEvent[]): ProcessJournalEvent[] {
  const normalized: JobEvent[] = [];
  const reasoningById = new Map<string, JobEvent>();
  let lastReasoning: JobEvent | undefined;
  for (const activity of activities) {
    const kind = activity.kind ?? "";
    if (kind === "reasoning") {
      const detail = reasoningDetail(activity);
      if (!detail) continue;
      const nextIds = (activity.steps ?? []).flatMap((step) => step.id ? [step.id] : []);
      const identified = nextIds.map((id) => reasoningById.get(id)).find(Boolean);
      const previousReasoning = identified ?? lastReasoning;
      if (previousReasoning) {
        const currentDetail = previousReasoning.detail ?? "";
        const currentIds = new Set(previousReasoning.steps?.map((step) => step.id).filter(Boolean));
        const legacy = currentIds.size === 0 && nextIds.length === 0;
        if (identified || (legacy && (detail.startsWith(currentDetail) || currentDetail.startsWith(detail)))) {
          if (!currentDetail.startsWith(detail) || detail.length >= currentDetail.length) {
            previousReasoning.detail = detail;
            if (activity.steps) previousReasoning.steps = activity.steps;
          }
          for (const id of nextIds) reasoningById.set(id, previousReasoning);
          lastReasoning = previousReasoning;
          continue;
        }
      }
      normalized.push({ ...activity, detail });
      lastReasoning = normalized[normalized.length - 1];
      for (const id of nextIds) reasoningById.set(id, lastReasoning);
      continue;
    }
    if (kind === "update") {
      if (!activity.detail?.trim()) continue;
      const previous = normalized.at(-1);
      if (previous?.kind === activity.kind && previous?.detail === activity.detail) continue;
      normalized.push(activity);
      continue;
    }
    if (!ACTION_KINDS.has(kind) || !activity.label) continue;
    if (kind === "approval" && activity.reviewId) {
      const earlier = normalized.findLastIndex((item) => item.kind === "approval" && item.reviewId === activity.reviewId);
      if (earlier >= 0) normalized.splice(earlier, 1);
    }
    if (kind === "command" && activity.detail) {
      const earlier = normalized.findLastIndex((item) => item.kind === "command" && item.detail === activity.detail);
      if (earlier >= 0) normalized.splice(earlier, 1);
    }
    const previous = normalized.at(-1);
    if (activitySignature(previous) === activitySignature(activity)) continue;
    normalized.push(activity);
  }

  const journal: ProcessJournalEvent[] = [];
  let commandGroup: ProcessJournalEvent | undefined;
  for (const activity of normalized) {
    if (activity.kind === "update" || activity.kind === "approval") commandGroup = undefined;
    if (activity.kind !== "command") {
      journal.push(activity);
      continue;
    }
    if (!commandGroup) {
      commandGroup = {
        ...activity,
        actionCount: 1,
        groupedDetails: activity.detail ? [activity.detail] : [],
      };
      journal.push(commandGroup);
      continue;
    }
    commandGroup.actionCount = (commandGroup.actionCount ?? 1) + 1;
    if (activity.detail && !commandGroup.groupedDetails?.includes(activity.detail)) commandGroup.groupedDetails?.push(activity.detail);
    commandGroup.created_at = activity.created_at ?? commandGroup.created_at;
    commandGroup.label = activity.label?.startsWith("正在")
      ? `正在运行 ${commandGroup.actionCount} 个本机步骤`
      : `运行了 ${commandGroup.actionCount} 个本机步骤`;
  }
  return journal;
}

export function isNarrativeActivity(activity: JobEvent): boolean {
  return NARRATIVE_KINDS.has(activity.kind ?? "") && Boolean(activity.detail?.trim());
}

function reasoningDetail(activity: JobEvent): string {
  const parts = [activity.detail, ...(activity.steps ?? []).map((step) => step.detail ?? step.summary ?? step.title)]
    .map((part) => part?.trim() ?? "").filter(Boolean);
  return parts.filter((part, index) => !parts.some((other, otherIndex) =>
    otherIndex !== index && other.includes(part) && (other !== part || otherIndex < index),
  )).join("\n\n");
}

function activitySignature(activity: JobEvent | undefined): string {
  if (!activity) return "";
  return JSON.stringify([activity.kind, activity.label, activity.detail, activity.files, activity.reviewId, activity.reviewStatus]);
}
