export type FileLineRef = {
  path: string;
  line?: number;
};

type KnownFile = {
  original_name: string;
  relative_path: string;
  host_path?: string;
  mime_type?: string;
};

const PROTOCOL_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const NON_CODE_MIME_PATTERN = /^(?:image\/(?!svg)|application\/(?:pdf|vnd\.|zip|gzip|x-|octet-stream)|audio\/|video\/)/i;
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
    const matches = Boolean(
      (relative && (folded === relative || folded.endsWith(`/${relative}`)))
      || (host && (folded === host || folded.endsWith(`/${host}`)))
      || (!path.includes("/") && folded === name),
    );
    if (matches) return Boolean(file.mime_type && !NON_CODE_MIME_PATTERN.test(file.mime_type)) || !file.mime_type;
  }
  if (/^[a-z]:\//i.test(folded) || folded.startsWith("/") || folded.startsWith("./") || /^(?:outputs|uploads|\.runtime)\//i.test(folded)) return true;
  return /[\\/]/.test(path) || /\.[a-z0-9]{1,12}$/i.test(path);
}

function isExternalUrl(value: string): boolean {
  return PROTOCOL_URL_PATTERN.test(value) && !/^file:\/\//i.test(value);
}

/** Parse a local file path, optionally with a `:line` suffix, into a code reference. */
export function parseFileRef(value: string | undefined, known: readonly KnownFile[] = []): FileLineRef | null {
  if (!value) return null;
  const text = decodePathValue(value).replace(/^`+|`+$/g, "");
  if (isExternalUrl(text)) return null;
  const match = text.match(/^(.*):(\d{1,9})$/);
  if (match) {
    const rawPath = match[1];
    if (/^\d+$/.test(rawPath)) return null;
    const normalized = normalizeFilePath(rawPath);
    if (normalized && isPlausibleFilePath(normalized, known)) return { path: normalized, line: Number(match[2]) };
    return null;
  }
  const normalized = normalizeFilePath(text);
  if (!normalized || !isPlausibleFilePath(normalized, known)) return null;
  return { path: normalized };
}

/** Parse a `path:line` fragment (inline code, link text or href) into a code reference. */
export function parseFileLine(value: string | undefined, known: readonly KnownFile[] = []): FileLineRef | null {
  const ref = parseFileRef(value, known);
  return ref?.line ? ref : null;
}

/** Parse a Markdown href that points at a local file, with or without a line number. */
export function parseSnippetHref(href: string | undefined, known: readonly KnownFile[] = []): FileLineRef | null {
  return parseFileRef(href, known);
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
