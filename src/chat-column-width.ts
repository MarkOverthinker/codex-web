export const CHAT_COLUMN_WIDTH_MIN = 720;
export const CHAT_COLUMN_WIDTH_MAX = 1280;
export const CHAT_COLUMN_WIDTH_DEFAULT = 960;
export const CHAT_COLUMN_WIDTH_STEP = 40;

export function normalizeChatColumnWidth(value: unknown, fallback = CHAT_COLUMN_WIDTH_DEFAULT): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(CHAT_COLUMN_WIDTH_MAX, Math.max(CHAT_COLUMN_WIDTH_MIN, Math.round(parsed)));
}
