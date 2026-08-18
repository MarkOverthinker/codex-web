import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { syncManagedSkills } from "./managed-skills.js";

const LEGACY_WORKSPACE_AGENTS = `# Conversation workspace\n\n- Work only inside this conversation directory unless the user explicitly asks otherwise.\n- User uploads are in uploads/. Save only finished deliverables in outputs/.\n- Put intermediate files, extracted assets, caches, and temporary environments in .runtime/; the service deletes it after every turn.\n- Prefer replying in Chinese unless the user requests another language.\n- Never reveal credentials, authentication files, browser profiles, or unrelated local data.\n- When a task creates useful files, mention only the final filenames the user needs. Do not list process files.\n`;

const MANAGED_INSTRUCTIONS_START = "<!-- codex-web-managed-start -->";
const MANAGED_INSTRUCTIONS_END = "<!-- codex-web-managed-end -->";
const WORKSPACE_AGENTS = `# Conversation workspace

${MANAGED_INSTRUCTIONS_START}
- Work only inside this conversation directory unless the user explicitly asks otherwise.
- Tenant boundary: access only this conversation and ../../library. Never read codex-home, application data, sibling conversations, or another user under /app/tenants.
- User uploads are in uploads/. Save only finished deliverables in outputs/.
- Put intermediate files, extracted assets, caches, and temporary environments in .runtime/; the service deletes it after every turn.
- Never reveal credentials, authentication files, browser profiles, or unrelated local data.
- In replies, mention only final filenames the user needs. Never expose absolute paths or list process files.
- Use the interpreter in \`CWW_SHARED_PYTHON\`; keep temporary scripts and caches in \`CWW_JOB_RUNTIME\`. Never install into the shared environment. If a required package is missing, invoke \`CWW_PYTHON_RUNNER\` in temporary mode instead.
${MANAGED_INSTRUCTIONS_END}
`;

const HOST_WORKSPACE_AGENTS = `# Conversation workspace (host mode)

${MANAGED_INSTRUCTIONS_START}
- You act as this machine user's local Codex agent with workspace-write access to the selected working directory, conversation workspace, and tenant library.
- User uploads are in uploads/. Save finished deliverables in outputs/ unless the task asks otherwise.
- You may read host paths that this user can access. Writes outside the writable roots, blocked network access, and other escalations require automatic approval review; do not ask the web user to approve them manually.
- Keep throwaway files, caches, and temporary environments in .runtime/; the service deletes it after every turn.
- Never reveal credentials, authentication files, browser profiles, or unrelated users' data.
- In replies, mention only final filenames the user needs. Never expose absolute paths or list process files.
- Use the interpreter in \`CWW_SHARED_PYTHON\`; keep temporary scripts and caches in \`CWW_JOB_RUNTIME\`. Never install into the shared environment. If a required package is missing, invoke \`CWW_PYTHON_RUNNER\` in temporary mode instead.
${MANAGED_INSTRUCTIONS_END}
`;

const GLOBAL_AGENTS = `# Codex Web Agent

- Prefer replying in Chinese unless the user requests another language.
- The persistent user knowledge library is in ../library relative to this file.
- Read the library when it is relevant. Update it only with useful, durable, user-approved knowledge; never save credentials, cookies, tokens, or authentication files.
- Keep user preferences in ../library/PROFILE.md, maintain ../library/INDEX.md as a concise catalog, and put project knowledge under ../library/projects/.
- Conversation uploads and generated deliverables stay in that conversation unless the user asks to organize or retain them in the library.
`;

const LIBRARY_AGENTS = `# Long-term knowledge library

- This directory belongs to one web user and persists across conversations.
- PROFILE.md stores stable preferences; INDEX.md catalogs durable topics and projects.
- Put source material and project facts under projects/, new unclassified material under inbox/, and retired material under archive/.
- Preserve originals when reorganizing important user files, and do not store credentials or authentication data.
`;

const TRANSIENT_OUTPUT_SUFFIXES = new Set([".bak", ".lock", ".part", ".swp", ".temp", ".tmp"]);

export function newId(): string {
  return crypto.randomUUID();
}

function assertUserId(userId: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Invalid user id");
}

export type TenantPaths = {
  root: string;
  codexHome: string;
  library: string;
  conversations: string;
};

export function tenantPaths(tenantRoot: string, userId: string): TenantPaths {
  assertUserId(userId);
  const root = path.resolve(tenantRoot, userId);
  return {
    root,
    codexHome: path.join(root, "codex-home"),
    library: path.join(root, "library"),
    conversations: path.join(root, "conversations"),
  };
}

/**
 * Host mode drops the codex child process into the machine user's uid/gid, so
 * web-created storage must be owned by that user. Only chowns when running as
 * root and when the top-level directory is not already owned by the tenant.
 */
export function chownTenantStorageIfNeeded(root: string, uid: number, gid: number): void {
  if (process.getuid?.() !== 0) return;
  try {
    const stat = fs.statSync(root);
    if (stat.uid === uid && stat.gid === gid) return;
  } catch {
    return;
  }
  execFileSync("chown", ["-R", `${uid}:${gid}`, root]);
}

export function ensureTenant(tenantRoot: string, userId: string, options: { skipCodexHome?: boolean } = {}): TenantPaths {
  const paths = tenantPaths(tenantRoot, userId);
  const storageDirs = [
    ...(options.skipCodexHome ? [] : [paths.codexHome]),
    paths.library,
    paths.conversations,
    path.join(paths.library, "inbox"),
    path.join(paths.library, "projects"),
    path.join(paths.library, "archive"),
  ];
  for (const directory of storageDirs) {
    fs.mkdirSync(directory, { recursive: true });
  }
  if (!options.skipCodexHome) {
    const globalAgents = path.join(paths.codexHome, "AGENTS.md");
    if (!fs.existsSync(globalAgents)) fs.writeFileSync(globalAgents, GLOBAL_AGENTS, "utf8");
    syncManagedSkills(paths.codexHome);
  }
  const libraryAgents = path.join(paths.library, "AGENTS.md");
  if (!fs.existsSync(libraryAgents)) fs.writeFileSync(libraryAgents, LIBRARY_AGENTS, "utf8");
  const profile = path.join(paths.library, "PROFILE.md");
  if (!fs.existsSync(profile)) fs.writeFileSync(profile, "# User profile\n\n<!-- Store stable preferences here. -->\n", "utf8");
  const index = path.join(paths.library, "INDEX.md");
  if (!fs.existsSync(index)) fs.writeFileSync(index, "# Knowledge index\n\n<!-- Keep a concise catalog of durable topics and projects here. -->\n", "utf8");
  return paths;
}

export function ensureTenantWorkspace(tenantRoot: string, userId: string, conversationId: string, hostMode = false): string {
  return ensureWorkspace(ensureTenant(tenantRoot, userId, { skipCodexHome: hostMode }).conversations, conversationId, hostMode);
}

export function ensureWorkspace(workspaceRoot: string, conversationId: string, hostMode = false): string {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new Error("Invalid conversation id");
  const root = path.resolve(workspaceRoot, conversationId);
  fs.mkdirSync(path.join(root, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
  fs.mkdirSync(path.join(root, ".runtime"), { recursive: true });
  const agentsPath = path.join(root, "AGENTS.md");
  syncWorkspaceInstructions(agentsPath, hostMode);
  const gitignorePath = path.join(root, ".gitignore");
  if (!fs.existsSync(gitignorePath)) fs.writeFileSync(gitignorePath, ".codex/\n.runtime/\n", "utf8");
  if (!fs.existsSync(path.join(root, ".git"))) {
    const result = spawnSync("git", ["init", "-b", "main"], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Unable to initialize workspace: ${result.stderr}`);
  }
  return root;
}

function syncWorkspaceInstructions(agentsPath: string, hostMode: boolean): void {
  const template = hostMode ? HOST_WORKSPACE_AGENTS : WORKSPACE_AGENTS;
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, template, "utf8");
    return;
  }
  const existing = fs.readFileSync(agentsPath, "utf8");
  if (existing === LEGACY_WORKSPACE_AGENTS) {
    fs.writeFileSync(agentsPath, template, "utf8");
    return;
  }
  const start = existing.indexOf(MANAGED_INSTRUCTIONS_START);
  const end = existing.indexOf(MANAGED_INSTRUCTIONS_END);
  if (start >= 0 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + MANAGED_INSTRUCTIONS_END.length);
    const managed = template.slice(template.indexOf(MANAGED_INSTRUCTIONS_START), template.indexOf(MANAGED_INSTRUCTIONS_END) + MANAGED_INSTRUCTIONS_END.length);
    const updated = `${before}${managed}${after}`;
    if (updated !== existing) fs.writeFileSync(agentsPath, updated, "utf8");
    return;
  }
  const managed = template.slice(template.indexOf(MANAGED_INSTRUCTIONS_START));
  fs.writeFileSync(agentsPath, `${existing.trimEnd()}\n\n${managed}`, "utf8");
}

export function safeUploadName(originalName: string): { diskName: string; displayName: string } {
  let displayName = path.basename(normalizeUploadFileName(originalName)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  if (!displayName) displayName = "file";
  const extension = path.extname(displayName).slice(0, 16);
  return { diskName: `${newId()}${extension}`, displayName: displayName.slice(0, 180) };
}

/**
 * Browsers send multipart filenames as UTF-8 bytes, while Busboy/Multer may
 * decode the legacy filename parameter as Latin-1. Repair only strings that
 * form a complete, valid UTF-8 byte sequence so genuine Latin-1 names such as
 * "café.xlsx" are left untouched.
 */
export function normalizeUploadFileName(originalName: string): string {
  const normalized = originalName.normalize("NFC");
  const characters = Array.from(normalized);
  if (!characters.some((character) => character.codePointAt(0)! >= 0x80)) return normalized;
  if (characters.some((character) => character.codePointAt(0)! > 0xff)) return normalized;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(normalized, "latin1"));
    return decoded.normalize("NFC");
  } catch {
    return normalized;
  }
}

export function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const normalized = normalizeStoredRelativePath(relativePath);
  const resolved = path.resolve(resolvedRoot, ...normalized.split("/"));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Path escapes workspace");
  }
  return resolved;
}

/** Store paths in a platform-neutral form while accepting legacy Windows rows. */
export function normalizeStoredRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

/**
 * Resolve a user-supplied host directory to its canonical absolute path.
 * Host mode makes the selected directory the workspace-write root for the
 * tenant machine user. Reject the application's own managed storage roots and
 * non-directories before starting the sandboxed task.
 */
export function resolveHostWorkingDir(input: string, options: { dataRoot: string; tenantRoot: string; workspaceRoot?: string }): string {
  if (typeof input !== "string" || !input.trim()) throw new Error("请输入有效的工作目录绝对路径。");
  const raw = input.trim();
  if (!path.isAbsolute(raw)) throw new Error("工作目录必须是绝对路径。");
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root) throw new Error("不能选择文件系统根目录作为工作目录。");
  let canonical: string;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    throw new Error("工作目录不存在或当前无法访问。");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonical);
  } catch {
    throw new Error("工作目录不存在或当前无法访问。");
  }
  if (!stat.isDirectory()) throw new Error("工作目录必须是一个目录。");
  if (isManagedHostPath(canonical, options)) {
    throw new Error("不能选择 Codex Web 自身的租户或数据目录作为工作目录。");
  }
  return canonical;
}

/**
 * Reject paths inside the application's own managed storage. Used by both
 * working-directory validation and the host path browser so a web user cannot
 * inspect or attach another tenant's conversation data.
 */
export function isManagedHostPath(canonical: string, options: { dataRoot: string; tenantRoot: string; workspaceRoot?: string }): boolean {
  const forbiddenRoots = [options.dataRoot, options.tenantRoot, options.workspaceRoot].filter((root): root is string => Boolean(root));
  for (const candidateRoot of forbiddenRoots) {
    const resolvedRoot = path.resolve(candidateRoot);
    const forbiddenRoot = (() => {
      try {
        return fs.realpathSync(resolvedRoot);
      } catch {
        return resolvedRoot;
      }
    })();
    if (canonical === forbiddenRoot || canonical.startsWith(`${forbiddenRoot}${path.sep}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a management-path input without requiring it to still exist. This is
 * used when renaming or removing a stale favorite: a directory may have been
 * deleted since it was saved, but the user must still be able to clean it up.
 */
export function resolveStoredWorkingDirInput(input: string): string {
  if (typeof input !== "string" || !input.trim()) throw new Error("请输入有效的工作目录绝对路径。");
  const raw = input.trim();
  if (!path.isAbsolute(raw)) throw new Error("工作目录必须是绝对路径。");
  const resolved = path.resolve(raw);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Verify the mapped tenant user can enter and write the selected directory.
 * When the web service runs as root, fs.accessSync would always succeed for
 * the root process, so the check must run as the tenant user.
 */
export function assertHostWorkingDirAccessible(workingDir: string, username?: string): void {
  if (process.platform === "win32" || process.getuid?.() !== 0) {
    fs.accessSync(workingDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return;
  }
  if (username) {
    try {
      // GNU coreutils test accepts only one unary operator per invocation, so
      // "test -r -w -x DIR" is a syntax error that always fails. Chain three
      // separate tests through sh to check read, write, and traverse access.
      execFileSync("runuser", ["-u", username, "--", "sh", "-c", 'test -r "$1" && test -w "$1" && test -x "$1"', "sh", workingDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return;
    } catch (error) {
      // Preserve the underlying probe failure so permission problems can be
      // diagnosed instead of being hidden behind a generic message.
      const stderr = error instanceof Error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
      const detail = stderr ? `（${stderr}）` : "";
      throw new Error(`无法验证工作目录对当前系统用户可读写，请检查目录权限。${detail}`);
    }
  }
  throw new Error("无法验证工作目录对当前系统用户可读写，请检查目录权限。");
}

/**
 * Verify the mapped tenant user can read a path without relying on a root web
 * process's privileges. Directories additionally need execute permission so
 * the browser can actually list their contents as that user.
 */
export function assertHostPathReadable(target: string, username: string | undefined, isDirectory: boolean): void {
  if (process.platform === "win32" || process.getuid?.() !== 0) {
    fs.accessSync(target, isDirectory ? fs.constants.R_OK | fs.constants.X_OK : fs.constants.R_OK);
    return;
  }
  if (username) {
    try {
      const probe = isDirectory ? 'test -r "$1" && test -x "$1"' : 'test -r "$1"';
      execFileSync("runuser", ["-u", username, "--", "sh", "-c", probe, "sh", target], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return;
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "").trim() : "";
      const detail = stderr ? `（${stderr}）` : "";
      throw new Error(`当前系统用户无法访问该路径。${detail}`.trim());
    }
  }
  throw new Error("当前系统用户无法访问该路径。");
}

export type HostPathEntryType = "dir" | "file" | "link" | "other";
export type HostPathEntry = {
  name: string;
  path: string;
  type: HostPathEntryType;
  size: number | null;
  mtime: string | null;
};
export type HostDirectoryListing = {
  path: string;
  parent: string | null;
  entries: HostPathEntry[];
  truncated: boolean;
};

export const MAX_HOST_BROWSE_ENTRIES = 1000;

/**
 * List a host directory for the path browser. Paths are canonicalized, kept
 * outside the application's managed roots, and checked against the mapped
 * tenant user's read/execute permissions before any entry is returned.
 */
export function listHostDirectory(raw: string | undefined, options: { dataRoot: string; tenantRoot: string; workspaceRoot?: string; home?: string; username?: string }): HostDirectoryListing {
  const input = raw && raw.trim() ? raw.trim() : options.home;
  if (!input) throw new Error("无法确定起始目录。");
  if (!path.isAbsolute(input)) throw new Error("请输入绝对路径。");
  let canonical: string;
  try {
    canonical = fs.realpathSync(input);
  } catch {
    throw new Error("目录不存在或当前无法访问。");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonical);
  } catch {
    throw new Error("目录不存在或当前无法访问。");
  }
  if (!stat.isDirectory()) throw new Error("所选路径不是目录。");
  if (isManagedHostPath(canonical, options)) throw new Error("不能浏览 Codex Web 自身的租户或数据目录。");
  assertHostPathReadable(canonical, options.username, true);

  let names: string[];
  try {
    names = fs.readdirSync(canonical);
  } catch {
    throw new Error("无法读取该目录。");
  }
  const truncated = names.length > MAX_HOST_BROWSE_ENTRIES;
  const entries: HostPathEntry[] = [];
  for (const name of names.slice(0, MAX_HOST_BROWSE_ENTRIES)) {
    const absolute = path.join(canonical, name);
    let type: HostPathEntryType = "other";
    let size: number | null = null;
    let mtime: string | null = null;
    try {
      const entryStat = fs.lstatSync(absolute);
      if (entryStat.isSymbolicLink()) {
        const target = fs.realpathSync(absolute);
        const targetStat = fs.statSync(target);
        if (isManagedHostPath(target, options)) continue;
        type = targetStat.isDirectory() ? "dir" : targetStat.isFile() ? "file" : "link";
        size = targetStat.size;
        mtime = targetStat.mtime.toISOString();
      } else if (entryStat.isDirectory()) {
        type = "dir";
      } else if (entryStat.isFile()) {
        type = "file";
        size = entryStat.size;
        mtime = entryStat.mtime.toISOString();
      }
    } catch {
      continue;
    }
    entries.push({ name, path: absolute, type, size, mtime });
  }
  entries.sort((left, right) => {
    const leftDir = left.type === "dir" ? 0 : 1;
    const rightDir = right.type === "dir" ? 0 : 1;
    return leftDir - rightDir || left.name.localeCompare(right.name);
  });
  const parent = path.dirname(canonical) === canonical ? null : path.dirname(canonical);
  return { path: canonical, parent, entries, truncated };
}

export const MAX_HOST_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/**
 * Resolve a user-selected host file for attachment. The result is the
 * canonical absolute path and is guaranteed to be a regular file outside the
 * application's managed roots that the mapped tenant user can read.
 */
export function resolveHostReadableFile(raw: string, options: { dataRoot: string; tenantRoot: string; workspaceRoot?: string; username?: string }): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("文件路径无效。");
  if (!path.isAbsolute(raw.trim())) throw new Error("文件路径必须是绝对路径。");
  let canonical: string;
  try {
    canonical = fs.realpathSync(raw.trim());
  } catch {
    throw new Error("文件不存在或当前无法访问。");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonical);
  } catch {
    throw new Error("文件不存在或当前无法访问。");
  }
  if (!stat.isFile()) throw new Error("所选路径不是普通文件。");
  if (stat.size > MAX_HOST_ATTACHMENT_BYTES) throw new Error("单个附件不能超过 100MB。");
  if (isManagedHostPath(canonical, options)) throw new Error("不能从 Codex Web 自身的租户或数据目录添加文件。");
  assertHostPathReadable(canonical, options.username, false);
  return canonical;
}

export function removeWorkspace(workspaceRoot: string, conversationId: string): void {
  const root = ensureWorkspace(workspaceRoot, conversationId);
  const expectedParent = path.resolve(workspaceRoot);
  if (path.dirname(root) !== expectedParent) throw new Error("Refusing to remove unexpected path");
  fs.rmSync(root, { recursive: true, force: true });
}

/** Locate the Codex rollout files that belong to one thread, inside sessions/ and archived_sessions/. */
export function findCodexThreadFiles(codexHome: string, threadId: string): string[] {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error("Invalid Codex thread id");
  const matches: string[] = [];
  for (const directoryName of ["sessions", "archived_sessions"]) {
    const root = path.resolve(codexHome, directoryName);
    if (!fs.existsSync(root)) continue;
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.resolve(directory, entry.name);
        if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("Refusing to inspect unexpected Codex session path");
        if (entry.isDirectory()) visit(absolute);
        if (entry.isFile() && entry.name.includes(threadId)) matches.push(absolute);
      }
    };
    visit(root);
  }
  return matches;
}

export function removeCodexThreadFiles(codexHome: string, threadId: string): number {
  let removed = 0;
  for (const absolute of findCodexThreadFiles(codexHome, threadId)) {
    fs.rmSync(absolute, { force: true });
    removed += 1;
  }
  return removed;
}

export function codexThreadRolloutBytes(codexHome: string, threadId: string): number | null {
  let largest: number | null = null;
  for (const absolute of findCodexThreadFiles(codexHome, threadId)) {
    const size = fs.statSync(absolute).size;
    largest = largest === null ? size : Math.max(largest, size);
  }
  return largest;
}

export async function snapshotWorkspace(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".codex") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      if (entry.isFile()) {
        const stat = await fs.promises.stat(absolute);
        snapshot.set(normalizeStoredRelativePath(path.relative(root, absolute)), `${stat.size}:${stat.mtimeMs}`);
      }
    }
  }
  await walk(root);
  return snapshot;
}

export function isDeliverablePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.length < 2 || !["outputs", "deliverables"].includes(parts[0].toLowerCase())) return false;
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) return false;
  const name = parts.at(-1)!;
  if (name.startsWith("~$") || name.endsWith("~")) return false;
  return !TRANSIENT_OUTPUT_SUFFIXES.has(path.extname(name).toLowerCase());
}

export function isPersistedDeliverablePath(relativePath: string): boolean {
  const parts = normalizeStoredRelativePath(relativePath).split("/");
  return parts.length === 3 && parts[0] === "deliverables" && /^[0-9a-f-]{36}$/i.test(parts[1])
    && parts.every((part) => part !== "." && part !== ".." && !part.startsWith("."));
}

function persistedDeliverablePath(fileId: string, originalPath: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw new Error("Invalid file id");
  return path.posix.join("deliverables", fileId, path.basename(normalizeStoredRelativePath(originalPath)));
}

export async function persistDeliverable(dataRoot: string, workspace: string, relativePath: string, fileId: string): Promise<string> {
  const source = resolveInside(workspace, relativePath);
  const storedPath = persistedDeliverablePath(fileId, relativePath);
  const destination = resolveInside(dataRoot, storedPath);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination);
  return storedPath;
}

export function persistDeliverableSync(dataRoot: string, workspace: string, relativePath: string, fileId: string): string {
  const source = resolveInside(workspace, relativePath);
  const storedPath = persistedDeliverablePath(fileId, relativePath);
  const destination = resolveInside(dataRoot, storedPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return storedPath;
}

export function removePersistedDeliverable(dataRoot: string, relativePath: string): void {
  if (!isPersistedDeliverablePath(relativePath)) return;
  const absolute = resolveInside(dataRoot, relativePath);
  const fileDirectory = path.dirname(absolute);
  const expectedParent = path.resolve(dataRoot, "deliverables");
  if (path.dirname(fileDirectory) !== expectedParent) throw new Error("Refusing to remove unexpected deliverable path");
  fs.rmSync(fileDirectory, { recursive: true, force: true });
}

export async function snapshotDeliverables(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  const outputRoot = path.join(root, "outputs");
  async function walk(directory: string): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      if (entry.isFile()) {
        const relativePath = normalizeStoredRelativePath(path.relative(root, absolute));
        if (!isDeliverablePath(relativePath)) continue;
        const stat = await fs.promises.stat(absolute);
        snapshot.set(relativePath, `${stat.size}:${stat.mtimeMs}`);
      }
    }
  }
  await walk(outputRoot);
  return snapshot;
}
