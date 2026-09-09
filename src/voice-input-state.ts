export function validVoiceModel(saved: string | null, models: ReadonlyArray<{ id: string }>): string {
  return models.some((model) => model.id === saved) ? saved! : models[0]?.id ?? "";
}

export function appendVoiceTranscript(draft: string, transcript: string): string {
  const text = transcript.trim();
  if (!text) return draft;
  return draft ? `${draft}${/\s$/.test(draft) ? "" : "\n"}${text}` : text;
}
