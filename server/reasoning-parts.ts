export type PublicReasoningStep = {
  title: string;
  detail: string;
};

export function reasoningStepTitle(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  const title = line.replace(/^#{1,6}\s*/, "").trim();
  return title.slice(0, 120) || "思考步骤";
}

/**
 * Turns reasoning summaries and (when available) raw reasoning content into
 * collapsible steps. Summaries and raw content are paired 1:1 when counts
 * match; otherwise each part becomes its own step so nothing is lost.
 */
export function buildReasoningSteps(summaries: string[], contents: string[]): PublicReasoningStep[] | undefined {
  const cleanParts = (parts: string[]) => parts.map((part) => part.trim()).filter(Boolean);
  const summaryParts = cleanParts(summaries);
  const contentParts = cleanParts(contents);
  if (summaryParts.length === 0 && contentParts.length === 0) return undefined;

  const steps: PublicReasoningStep[] = [];
  if (summaryParts.length > 0 && summaryParts.length === contentParts.length) {
    for (let index = 0; index < summaryParts.length; index += 1) {
      const title = reasoningStepTitle(summaryParts[index]);
      const detail = contentParts[index] || summaryParts[index];
      steps.push({ title, detail });
    }
    return steps;
  }
  for (const summary of summaryParts) steps.push({ title: reasoningStepTitle(summary), detail: summary });
  for (const content of contentParts) steps.push({ title: reasoningStepTitle(content), detail: content });
  return steps;
}
