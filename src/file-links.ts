import { fileUrl, type WorkFile } from "./api";
import { isTextPreviewMime } from "./text-preview";

export type ResolvedMessageLink =
  | { kind: "download"; href: string }
  | { kind: "unavailable" }
  | { kind: "regular"; href: string };

function decodePath(value: string): string {
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

function normalizePath(value: string): string | null {
  let normalized = decodePath(value).replace(/^file:\/+/i, "").replace(/\\/g, "/");
  if (/^\/[a-z]:\//i.test(normalized)) normalized = normalized.slice(1);
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..") || normalized.includes("\0")) return null;
  return normalized.replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function isLocalMachinePath(raw: string, normalized: string): boolean {
  const decoded = decodePath(raw);
  return /^[a-z]:[\\/]/i.test(decoded)
    || /^file:\/\//i.test(decoded)
    || /^\\\\/.test(decoded)
    || /^\/(?:home|users|var|tmp|srv|opt)\//i.test(normalized)
    || /\/workspaces\//i.test(normalized);
}

export function isLocalMarkdownUrl(url: string): boolean {
  return /^sandbox:/i.test(url) || /^[a-z]:[\\/]/i.test(url) || /^file:\/\//i.test(url) || /^\\\\/.test(url);
}

/** Human-readable path for a local Markdown link, safe to display and copy. */
export function localPathText(href: string | undefined): string {
  if (!href) return "";
  const stripped = href.replace(/^sandbox:/i, "");
  return normalizePath(stripped) || decodePath(stripped);
}

export function isBrowserPreviewable(file: WorkFile): boolean {
  const mime = normalizedMimeType(file.mime_type);
  return mime.startsWith("image/")
    || mime === "application/pdf"
    || isMarkdownFile(file)
    || isTextPreviewMime(mime);
}

export type FilePreviewKind = "image" | "pdf" | "markdown" | "text";

export const FILE_PREVIEW_TEXT_LIMIT_BYTES = 5 * 1024 * 1024;

export function filePreviewKind(file: WorkFile): FilePreviewKind | null {
  const mime = normalizedMimeType(file.mime_type);
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (isMarkdownFile(file)) return "markdown";
  if (isTextPreviewMime(mime)) return "text";
  return null;
}

function normalizedMimeType(mime: string): string {
  return mime.toLowerCase().split(";", 1)[0].trim();
}

function isMarkdownFile(file: Pick<WorkFile, "mime_type" | "original_name" | "relative_path">): boolean {
  return normalizedMimeType(file.mime_type) === "text/markdown"
    || /\.(?:md|markdown)$/i.test(file.original_name ?? "")
    || /\.(?:md|markdown)$/i.test(file.relative_path ?? "");
}

export function canPreviewInline(file: WorkFile): boolean {
  const kind = filePreviewKind(file);
  if (!kind) return false;
  if (kind === "markdown" || kind === "text") return file.size <= FILE_PREVIEW_TEXT_LIMIT_BYTES;
  return true;
}

export function resolveMessageFileLink(href: string | undefined, files: WorkFile[]): ResolvedMessageLink {
  if (!href) return { kind: "unavailable" };
  const normalized = normalizePath(href);
  if (!normalized) return { kind: "unavailable" };
  const folded = normalized.toLocaleLowerCase();
  const candidates = files.map((file) => ({
    file,
    relative: normalizePath(file.relative_path)?.toLocaleLowerCase() ?? "",
    name: normalizePath(file.original_name)?.toLocaleLowerCase() ?? "",
  }));
  const exact = candidates.find((candidate) => candidate.relative && (folded === candidate.relative || folded.endsWith(`/${candidate.relative}`)));
  const basename = folded.split("/").pop() ?? "";
  const named = candidates.find((candidate) => candidate.name && basename === candidate.name);
  const matched = exact ?? named;
  if (matched) return { kind: "download", href: fileUrl(matched.file, true) };
  if (/^sandbox:/i.test(href) || isLocalMachinePath(href, normalized) || /^(?:outputs|uploads)\//i.test(normalized)) return { kind: "unavailable" };
  return { kind: "regular", href };
}
