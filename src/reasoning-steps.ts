import type { JobEvent, ReasoningStep } from "./api";

export function firstReasoningLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.replace(/^#{1,6}\s*/, "").trim().slice(0, 120);
}

/**
 * Collects the collapsible reasoning steps from persisted/streamed job events.
 *
 * Reasoning items stream incrementally: the same step may arrive as a partial
 * text first and its full text later. Identical steps are deduplicated and a
 * later detail that extends an earlier one replaces it. Legacy events that only
 * carry a flat `detail` are split into steps by headings or blank lines.
 */
export function collectReasoningSteps(activities: JobEvent[]): ReasoningStep[] {
  const steps: ReasoningStep[] = [];
  const seen = new Set<string>();
  const byId = new Map<string, number>();
  const byTitle = new Map<string, number>();
  for (const activity of activities) {
    if (activity.kind !== "reasoning" && activity.kind !== "approval") continue;
    const candidates = Array.isArray(activity.steps) && activity.steps.length > 0
      ? activity.steps
      : splitLegacyReasoning(activity.detail ?? "");
    for (const candidate of candidates) {
      const detail = (candidate.detail ?? candidate.summary ?? "").trim();
      const title = (candidate.title ?? firstReasoningLine(detail)).trim() || "思考步骤";
      const id = candidate.id?.trim();
      if (id) {
        const existingIndex = byId.get(id);
        const step = { id, title, detail };
        if (existingIndex === undefined) {
          steps.push(step);
          byId.set(id, steps.length - 1);
        } else {
          steps[existingIndex] = step;
        }
        continue;
      }
      const signature = `${title}\u0000${detail}`;
      if (seen.has(signature)) continue;
      const existingIndex = byTitle.get(title);
      if (existingIndex !== undefined) {
        const existing = steps[existingIndex];
        if (detail && (!existing.detail || detail.startsWith(existing.detail))) {
          if (detail !== existing.detail) {
            existing.detail = detail;
            seen.add(signature);
          }
          continue;
        }
      }
      steps.push({ title, detail });
      seen.add(signature);
      byTitle.set(title, steps.length - 1);
    }
  }
  return steps;
}

function splitLegacyReasoning(text: string): ReasoningStep[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const headingSegments = trimmed
    .split(/^(?=#{1,6}\s+)/m)
    .map((part) => part.trim())
    .filter(Boolean);
  const parts = headingSegments.length > 1
    ? headingSegments
    : trimmed.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  return parts.map((part) => {
    const firstLine = part.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
    return {
      title: firstLine.replace(/^#{1,6}\s*/, "").trim() || firstReasoningLine(part),
      detail: part,
    };
  });
}
