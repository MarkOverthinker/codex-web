export type PublicReasoningStep = {
  id?: string;
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
 * match; otherwise each part becomes its own step so nothing is lost. When
 * itemId is available, each streamed update keeps the same item-scoped id, so
 * the client can merge growing snapshots without depending on the first line
 * staying stable.
 */
export function buildReasoningSteps(summaries: string[], contents: string[], itemId?: string): PublicReasoningStep[] | undefined {
  const cleanParts = (parts: string[]) => parts.map((part) => part.trim()).filter(Boolean);
  const summaryParts = cleanParts(summaries);
  const contentParts = cleanParts(contents);
  if (summaryParts.length === 0 && contentParts.length === 0) return undefined;

  const steps: PublicReasoningStep[] = [];
  const push = (id: string | undefined, title: string, detail: string) => {
    steps.push(id ? { id, title, detail } : { title, detail });
  };
  if (summaryParts.length > 0 && summaryParts.length === contentParts.length) {
    for (let index = 0; index < summaryParts.length; index += 1) {
      const title = reasoningStepTitle(summaryParts[index]);
      const detail = contentParts[index] || summaryParts[index];
      const id = itemId ? `reasoning:${itemId}:${index}` : undefined;
      push(id, title, detail);
    }
    return steps;
  }
  summaryParts.forEach((summary, index) => {
    const id = itemId ? `reasoning:${itemId}:summary:${index}` : undefined;
    push(id, reasoningStepTitle(summary), summary);
  });
  contentParts.forEach((content, index) => {
    const id = itemId ? `reasoning:${itemId}:content:${index}` : undefined;
    push(id, reasoningStepTitle(content), content);
  });
  return steps;
}
