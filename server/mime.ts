import path from "node:path";

/** Extension-based MIME lookup for host attachments and generated deliverables. */
export const MIME_BY_EXTENSION: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".jsonl": "application/x-ndjson", ".toml": "application/toml",
  ".yaml": "application/yaml", ".yml": "application/yaml", ".xml": "application/xml",
  ".py": "text/x-python", ".pyi": "text/x-python",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
  ".ts": "text/x-typescript", ".tsx": "text/x-typescript", ".jsx": "text/x-javascript",
  ".vue": "text/x-vue", ".svelte": "text/x-svelte",
  ".html": "text/html", ".css": "text/css", ".scss": "text/x-scss", ".less": "text/x-less",
  ".sh": "text/x-shellscript", ".bash": "text/x-shellscript", ".zsh": "text/x-shellscript",
  ".ps1": "text/x-powershell", ".bat": "text/x-bat",
  ".ini": "text/plain", ".conf": "text/plain", ".cfg": "text/plain", ".log": "text/plain",
  ".properties": "text/plain", ".sql": "text/x-sql",
  ".go": "text/x-go", ".rs": "text/x-rust", ".java": "text/x-java", ".rb": "text/x-ruby",
  ".php": "text/x-php", ".c": "text/x-c", ".h": "text/x-c", ".cpp": "text/x-c++", ".cc": "text/x-c++",
  ".hpp": "text/x-c++", ".cs": "text/x-csharp", ".swift": "text/x-swift", ".kt": "text/x-kotlin",
  ".kts": "text/x-kotlin", ".dart": "text/x-dart", ".lua": "text/x-lua", ".pl": "text/x-perl",
  ".r": "text/x-r", ".ex": "text/x-elixir", ".exs": "text/x-elixir",
  ".graphql": "text/x-graphql", ".proto": "text/x-protobuf",
  ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".bmp": "image/bmp", ".ico": "image/x-icon", ".pdf": "application/pdf",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip", ".tar": "application/x-tar", ".gz": "application/gzip", ".7z": "application/x-7z-compressed",
};

/** Dotfiles and other extensionless config files that are plain text. */
const MIME_BY_BASE_NAME: Record<string, string> = {
  ".env": "text/plain", ".gitignore": "text/plain", ".gitattributes": "text/plain",
  ".dockerignore": "text/plain", ".editorconfig": "text/plain",
  "dockerfile": "text/x-dockerfile", "makefile": "text/x-makefile",
};

export function mimeTypeForPath(filePath: string): string {
  const baseName = path.basename(filePath).toLowerCase();
  if (baseName.startsWith(".env")) return "text/plain";
  const byBaseName = MIME_BY_BASE_NAME[baseName];
  if (byBaseName) return byBaseName;
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
