/** Whether a MIME type can be safely previewed as inline text (code, config, data). */
const TEXT_PREFIX_PATTERN = /^text\//i;
const STRUCTURED_TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
]);

export function isTextPreviewMime(mime: string): boolean {
  const normalized = mime.toLowerCase().split(";", 1)[0].trim();
  return TEXT_PREFIX_PATTERN.test(normalized) || STRUCTURED_TEXT_MIMES.has(normalized);
}
