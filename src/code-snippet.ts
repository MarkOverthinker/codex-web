export type FileLineRef = {
  path: string;
  line: number;
};

type KnownFile = {
  original_name: string;
  relative_path: string;
  host_path?: string;
};

const PROTOCOL_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const CODEX_SNIPPET_URL_PATTERN = /^codex-snippet:\/\/([^?]+)\?line=(\d{1,9})$/i;

function decodePathValue(value: string): string {
  let decoded = value.trim().replace(/^<|>$/g, "");
  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function normalizeFilePath(value: string): string | null {
  let normalized = decodePathValue(value).replace(/^sandbox:/i, "").replace(/^file:\/+/i, "").replace(/\\/g, "/");
  if (/^\/[a-z]:\//i.test(normalized)) normalized = normalized.slice(1);
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..") || normalized.includes("\0")) return null;
  return normalized.replace(/^\.\//, "").replace(/\/{2,}/g, "/") || null;
}

function isPlausibleFilePath(path: string, known: readonly KnownFile[]): boolean {
  const folded = path.toLocaleLowerCase();
  for (const file of known) {
    const relative = normalizeFilePath(file.relative_path)?.toLocaleLowerCase();
    const host = file.host_path ? normalizeFilePath(file.host_path)?.toLocaleLowerCase() : undefined;
    const name = file.original_name.toLocaleLowerCase();
    if (relative && (folded === relative || folded.endsWith(`/${relative}`))) return true;
    if (host && (folded === host || folded.endsWith(`/${host}`))) return true;
    if (!path.includes("/") && folded === name) return true;
  }
  if (/^[a-z]:\//i.test(folded) || folded.startsWith("/") || folded.startsWith("./") || /^(?:outputs|uploads|\.runtime)\//i.test(folded)) return true;
  return /[\\/]/.test(path) || /\.[a-z0-9]{1,12}$/i.test(path);
}

/** Parse a `path:line` fragment (inline code, link text or href) into a code reference. */
export function parseFileLine(value: string | undefined, known: readonly KnownFile[] = []): FileLineRef | null {
  if (!value) return null;
  const text = decodePathValue(value).replace(/^`+|`+$/g, "");
  const match = text.match(/^(.*):(\d{1,9})$/);
  if (!match) return null;
  const rawPath = match[1];
  if (PROTOCOL_URL_PATTERN.test(rawPath) || /^\d+$/.test(rawPath)) return null;
  const normalized = normalizeFilePath(rawPath);
  if (!normalized || !isPlausibleFilePath(normalized, known)) return null;
  return { path: normalized, line: Number(match[2]) };
}

/** Parse a Markdown href that points at a local file with a line number. */
export function parseSnippetHref(href: string | undefined, known: readonly KnownFile[] = []): FileLineRef | null {
  if (!href || PROTOCOL_URL_PATTERN.test(href)) return null;
  return parseFileLine(href, known);
}

/** Parse links emitted by sanitizeAgentMarkdown for `:codex-file-citation{... line_number=...}`. */
export function parseCodexSnippetUrl(href: string | undefined): FileLineRef | null {
  if (!href) return null;
  const match = href.match(CODEX_SNIPPET_URL_PATTERN);
  if (!match) return null;
  let decoded = match[1];
  try { decoded = decodeURIComponent(decoded); } catch { return null; }
  const normalized = normalizeFilePath(decoded);
  if (!normalized) return null;
  return { path: normalized, line: Number(match[2]) };
}
