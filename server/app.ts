import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import pino, { type Logger } from "pino";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { loadConfig, type AppConfig } from "./config.js";
import { CodexRunner, extractLeakedAutoTitleAnswer } from "./codex-runner.js";
import { isTextPreviewMime } from "../src/text-preview.js";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import { ASK_AGENT_SELECTION_MAX_CHARS, buildAskAgentDraft, normalizeAskAgentSelection } from "../src/ask-agent-selection.js";
import { CHAT_FONT_SIZE_DEFAULT, normalizeChatFontSize } from "../src/chat-font-size.js";
import { CHAT_COLUMN_WIDTH_DEFAULT, normalizeChatColumnWidth } from "../src/chat-column-width.js";
import { buildConversationContextExcerpt, buildDerivedTaskPrompt, normalizeMessageSourceReference, normalizeSourceExcerpt, type MessageSourceReference } from "../src/message-source.js";
import {
  AppDatabase,
  DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  MAX_CONVERSATION_PRESET_PROMPTS,
  MAX_PRESET_PROMPTS_PER_USER,
  PRESET_PROMPT_CONTENT_MAX,
  PRESET_PROMPT_NAME_MAX,
  type ComposerDraftWithFiles,
  type ConversationRow,
  type FileRow,
  type JobRow,
  type MessageRow,
  type PendingPromptWithFiles,
  type PresetPromptRow,
  type SessionRow,
  type SideConversationRow,
  type WorkingDirectoryFavorite,
} from "./db.js";
import { loadAgentOptions, repairAgentSelection, resolveAgentExecutionSelection, resolveAgentSelection, type AgentOptions, type AgentSelection } from "./model-options.js";
import {
  assertProviderProtocolConfiguration,
  assertOfficialOAuthLimit,
  ensureProviderConfig,
  importCatalogModels,
  importProvidersFromConfig,
  listProviderModelsPublic,
  listProvidersPublic,
  nextProviderId,
  writeProviderConfig,
} from "./provider-manager.js";
import { CODEX_CONFIG_HINT, hostTenantFor, isCodexConfigured } from "./host-mode.js";
import { assertHostPathReadable, chownTenantStorageIfNeeded, ensureTenant, ensureTenantWorkspace, isManagedHostPath, isPersistedDeliverablePath, listHostDirectory, newId, persistDeliverableSync, removeCodexThreadFiles, removePersistedDeliverable, removeWorkspace, resolveHostReadableFile, resolveHostWorkingDir, resolveInside, resolveStoredWorkingDirInput, safeUploadName, tenantPaths, type TenantPaths } from "./paths.js";
import { AUDIO_MIME_EXTENSIONS, TranscriptionError, TranscriptionService } from "./transcription.js";
import { createShareToken, parseShareToken, SHARE_LIFETIME_SECONDS } from "./share-link.js";
import { MIME_BY_EXTENSION, mimeTypeForPath } from "./mime.js";
import { buildUserCancellationSummary } from "./cancellation-summary.js";
import { buildBillingState, BUILTIN_PROVIDER_ID, syncProviderPricing } from "./billing.js";
import { discoverImportableSessions, importSessionThread, normalizeImportedWorkingDir, readCodexThreadWorkingDir } from "./session-importer.js";
import { locateMessageInCodexRollout } from "./message-source-locator.js";
import {
  autoDirCategoryKey,
  customCategoryKey,
  listValidHiddenCategoryKeys,
  listValidPinnedCategoryKeys,
  parseCategoryKey,
  type TaskListCategorySettings,
} from "../src/task-categories.js";

const COOKIE_NAME = "cww_session";
const CONVERSATION_MESSAGE_PAGE_SIZE = 30;
const FILE_INSTRUCTION_GUIDANCE = "文件已上传，请输入具体操作，例如“把图片背景改为白色”或“汇总这些表格”。收到明确指令后才会开始处理。";
const USERNAME_PATTERN = /^[a-z_][a-z0-9._-]{0,31}$/i;
const MIN_PASSWORD_LENGTH = 12;
type AuthenticatedRequest = Request & { appSession?: SessionRow };
const FRONTEND_NOT_BUILT_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>前端资源未构建 · Codex Web</title>
<style>
  body { margin: 0; color: #1f2333; background: #f7f8f6; font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { max-width: 640px; margin: 12vh auto; padding: 32px; border: 1px solid #e0e3ec; border-radius: 12px; background: #fff; }
  h1 { margin: 0 0 12px; font-size: 20px; }
  p { margin: 8px 0; line-height: 1.7; }
  code { padding: 2px 6px; border-radius: 6px; color: #29356f; background: #eef0fa; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
</style>
</head>
<body>
<main>
  <h1>前端资源未构建或构建不完整</h1>
  <p>服务端 API 正常，但缺少前端入口文件 <code>dist/index.html</code>，无法加载页面。</p>
  <p>请在仓库根目录运行 <code>npm run build</code>（或使用已安装的 reloader 执行 <code>npm run reload</code>），然后刷新本页。</p>
</main>
</body>
</html>`;

export type AppOverrides = Partial<AppConfig> & { logger?: Logger };

export function createApp(overrides: AppOverrides = {}) {
  const config = loadConfig(overrides);
  const logger = overrides.logger ?? pino({ level: "warn" });
  fs.mkdirSync(config.dataRoot, { recursive: true });
  fs.mkdirSync(config.tenantRoot, { recursive: true });
  const db = new AppDatabase(config.dataRoot, { username: config.username, passwordHash: config.passwordHash, displayName: config.displayName });
  for (const user of db.listUsers()) {
    storageFor(user.id);
    if (db.getProviderManagementEnabled(user.id)) {
      ensureProviderConfig(config, codexHomeFor(user.id), db, user.id, providerConfigOwner(user.id));
    }
  }
  migrateExistingOutputFiles(config, db);
  migrateUploadFileMimes(db);
  const subscribers = new Map<string, Set<Response>>();

  function optionsForUser(userId: string): AgentOptions {
    return db.getProviderManagementEnabled(userId)
      ? loadAgentOptions(config, codexHomeFor(userId), db, userId)
      : loadAgentOptions(config, codexHomeFor(userId));
  }

  function codexHomeFor(userId: string): string {
    if (config.hostMode) return hostTenantFor(config, db, userId)?.codexHome ?? config.codexHome;
    return storageFor(userId).codexHome;
  }

  function providerConfigOwner(userId: string): { uid: number; gid: number } | undefined {
    if (!config.hostMode) return undefined;
    const host = hostTenantFor(config, db, userId);
    return host ? { uid: host.uid, gid: host.gid } : undefined;
  }

  function storageFor(userId: string): TenantPaths {
    const paths = ensureTenant(config.tenantRoot, userId, { skipCodexHome: config.hostMode });
    const host = config.hostMode ? hostTenantFor(config, db, userId) : null;
    if (host) chownTenantStorageIfNeeded(paths.root, host.uid, host.gid);
    return paths;
  }

  function workspaceFor(userId: string, conversationId: string): string {
    const workspace = ensureTenantWorkspace(config.tenantRoot, userId, conversationId, config.hostMode);
    const host = config.hostMode ? hostTenantFor(config, db, userId) : null;
    if (host) chownTenantStorageIfNeeded(workspace, host.uid, host.gid);
    return workspace;
  }

  function workingDirSettingsFor(userId: string): { enabled: boolean; favorites: WorkingDirectoryFavorite[]; defaultWorkingDir: string | null } {
    const host = config.hostMode ? hostTenantFor(config, db, userId) : null;
    return {
      enabled: Boolean(host),
      favorites: db.getFavoriteWorkingDirectories(userId),
      defaultWorkingDir: db.getDefaultWorkingDir(userId),
    };
  }

  function normalizeTaskCategoryName(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim()) throw new Error("请输入分类名称。");
    return raw.trim().replace(/\s+/g, " ").slice(0, 100);
  }

  function taskListCategorySettingsFor(userId: string): TaskListCategorySettings {
    return db.getTaskListCategorySettings(userId);
  }

  function saveTaskListCategorySettings(userId: string, settings: TaskListCategorySettings): TaskListCategorySettings {
    db.setTaskListCategorySettings(settings, userId);
    return db.getTaskListCategorySettings(userId);
  }

  function requireHostWorkingTenant(session: SessionRow) {
    if (!config.hostMode) return null;
    return hostTenantFor(config, db, session.user_id);
  }

  function resolveSubmittedWorkingDir(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim()) throw new Error("工作目录必须是绝对路径。");
    return resolveHostWorkingDir(raw, { dataRoot: config.dataRoot, tenantRoot: config.tenantRoot, workspaceRoot: config.workspaceRoot });
  }

  function userAgentSelection(userId: string, options: AgentOptions = optionsForUser(userId)): AgentSelection {
    const stored = db.getAgentSelectionPreference(userId);
    const selection = repairAgentSelection(options, stored?.model, stored?.reasoningEffort, stored?.sandbox);
    if (!stored || stored.model !== selection.model || stored.reasoningEffort !== selection.reasoningEffort
      || (stored.provider ?? null) !== (selection.provider ?? null) || (stored.sandbox ?? "workspace-write") !== selection.sandbox) {
      db.setAgentSelectionPreference(selection, userId);
    }
    return selection;
  }

  function conversationAgentSelection(conversation: ConversationRow, options: AgentOptions = optionsForUser(conversation.user_id)): AgentSelection {
    const fallback = conversation.agent_model && conversation.reasoning_effort
      ? { model: conversation.agent_model, reasoningEffort: conversation.reasoning_effort, sandbox: conversation.sandbox_mode ?? "workspace-write" }
      : userAgentSelection(conversation.user_id, options);
    const selection = repairAgentSelection(options, fallback.model, fallback.reasoningEffort, fallback.sandbox);
    if (conversation.agent_model !== selection.model || conversation.reasoning_effort !== selection.reasoningEffort
      || conversation.agent_provider !== (selection.provider ?? null) || (conversation.sandbox_mode ?? "workspace-write") !== selection.sandbox) {
      db.updateConversation(conversation.id, { agentSelection: selection });
    }
    return selection;
  }

  function safeConversationMessages(conversation: ConversationRow, messages: Array<MessageRow & { files: FileRow[] }>) {
    const citationFiles = db.listFiles(conversation.id);
    return messages.map((message) => {
      const sourceReference = parseStoredSourceReference(message.source_reference);
      const publicMessage = {
        id: message.id,
        conversation_id: message.conversation_id,
        role: message.role,
        content: message.content,
        quote_excerpt: message.quote_excerpt ?? null,
        source_reference: sourceReference,
        created_at: message.created_at,
        can_edit: message.role === "user" && Boolean(message.codex_turn_id),
      };
      if (message.role !== "assistant") return { ...publicMessage, files: message.files.map((file) => fileForClient(file, conversation.user_id)) };
      const visibleContent = conversation.title_source === "ai"
        ? extractLeakedAutoTitleAnswer(message.content, true) ?? message.content
        : message.content;
      return { ...publicMessage, content: sanitizeAgentMarkdown(visibleContent, citationFiles), files: message.files.map((file) => fileForClient(file, conversation.user_id)) };
    });
  }

  function fileStorageRoot(file: FileRow, userId: string, workspace?: string): string {
    if (file.kind === "output" && isPersistedDeliverablePath(file.relative_path)) return config.dataRoot;
    return workspace ?? workspaceFor(userId, file.conversation_id);
  }

  function fileForClient(file: FileRow, userId: string, workspace?: string) {
    const storageRoot = fileStorageRoot(file, userId, workspace);
    let hostPath = file.relative_path;
    try { hostPath = resolveInside(storageRoot, file.relative_path); } catch { /* Keep the stored relative path when the row is malformed. */ }
    return { ...file, host_path: hostPath };
  }

  function isSharePreviewable(file: FileRow): boolean {
    const mime = file.mime_type.toLowerCase();
    return mime.startsWith("image/") || mime === "application/pdf" || isTextPreviewMime(mime);
  }

  function fileAbsolutePath(file: FileRow, userId: string): string | null {
    const storageRoot = fileStorageRoot(file, userId);
    try {
      const absolute = resolveInside(storageRoot, file.relative_path);
      return fs.existsSync(absolute) ? absolute : null;
    } catch {
      return null;
    }
  }

  function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] ?? character
    ));
  }

  function renderShareMarkdown(content: string): string {
    return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, content));
  }

  const CODE_SNIPPET_MAX_BYTES = 20 * 1024 * 1024;
  const CODE_SNIPPET_MAX_WINDOW = 500;
  const FILE_TREE_MAX_ENTRIES = 1000;
  const FILE_TREE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
  const FILE_TREE_SENSITIVE_NAMES = new Set([
    ".aws", ".config", ".codex", ".env", ".env.local", ".env.production", ".gnupg", ".runtime", ".ssh",
    ".npmrc", ".pypirc", "auth.json", "credentials", "credentials.json", "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa", "known_hosts", "rightcode_auth.json",
  ]);

  type FileTreeRootId = "working-dir" | "workspace" | "library";
  type FileTreeRootSpec = {
    id: FileTreeRootId;
    label: string;
    absolute: string;
    displayPath: string;
    available: boolean;
  };

  function normalizeFileTreePath(raw: unknown): string {
    if (raw === undefined || raw === null || raw === "") return "";
    if (typeof raw !== "string") throw new Error("文件路径无效。");
    let value = raw.trim().replace(/\\/g, "/");
    for (let index = 0; index < 2; index += 1) {
      try {
        const decoded = decodeURIComponent(value);
        if (decoded === value) break;
        value = decoded.replace(/\\/g, "/");
      } catch {
        break;
      }
    }
    if (!value || value === ".") return "";
    if (value.startsWith("/") || value.includes("\0")) throw new Error("文件路径无效。");
    const parts = value.split("/").filter(Boolean);
    if (parts.some((part) => part === ".." || part === ".")) throw new Error("文件路径无效。");
    return parts.join("/");
  }

  function pathWithin(root: string, candidate: string): boolean {
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
  }

  function fileTreeRootsFor(conversation: ConversationRow): FileTreeRootSpec[] {
    const storage = storageFor(conversation.user_id);
    const roots: FileTreeRootSpec[] = [
      { id: "workspace", label: "会话工作区", absolute: workspaceFor(conversation.user_id, conversation.id), displayPath: "会话工作区", available: true },
      { id: "library", label: "资料库", absolute: storage.library, displayPath: "资料库", available: true },
    ];
    if (config.hostMode && conversation.working_dir) {
      const host = hostTenantFor(config, db, conversation.user_id);
      if (host) {
        try {
          const workingDir = resolveHostWorkingDir(conversation.working_dir, { dataRoot: config.dataRoot, tenantRoot: config.tenantRoot, workspaceRoot: config.workspaceRoot });
          roots.unshift({ id: "working-dir", label: "当前工作目录", absolute: workingDir, displayPath: workingDir, available: true });
        } catch {
          roots.unshift({ id: "working-dir", label: "当前工作目录", absolute: conversation.working_dir, displayPath: conversation.working_dir, available: false });
        }
      }
    }
    return roots;
  }

  function fileTreeRootFor(conversation: ConversationRow, rootId: string): FileTreeRootSpec | null {
    return fileTreeRootsFor(conversation).find((root) => root.id === rootId) ?? null;
  }

  function fileTreeRootForClient(root: FileTreeRootSpec) {
    return { id: root.id, label: root.label, path: root.displayPath, available: root.available };
  }

  function fileTreeDisplayPath(root: FileTreeRootSpec, relativePath: string): string {
    if (!relativePath) return root.displayPath;
    return root.id === "working-dir" ? path.join(root.displayPath, ...relativePath.split("/")) : `${root.displayPath}/${relativePath}`;
  }

  function isSensitiveFileTreeName(name: string): boolean {
    const lower = name.toLocaleLowerCase();
    return FILE_TREE_SENSITIVE_NAMES.has(lower) || lower.endsWith(".pem") || lower.endsWith(".key");
  }

  function isSensitiveFileTreePath(filePath: string): boolean {
    return filePath.split(path.sep).some(isSensitiveFileTreeName);
  }

  function fileTreeTargetFor(conversation: ConversationRow, rootId: string, rawPath: unknown) {
    const root = fileTreeRootFor(conversation, rootId);
    if (!root || !root.available) return null;
    const relativePath = normalizeFileTreePath(rawPath);
    const absoluteInput = resolveInside(root.absolute, relativePath);
    const rootCanonical = fs.realpathSync(root.absolute);
    const absolute = fs.realpathSync(absoluteInput);
    if (root.id !== "working-dir" && !pathWithin(rootCanonical, absolute)) throw new Error("文件路径无效。");
    if (root.id === "working-dir" && isManagedHostPath(absolute, { dataRoot: config.dataRoot, tenantRoot: config.tenantRoot, workspaceRoot: config.workspaceRoot })) {
      throw new Error("文件路径无效。");
    }
    if (isSensitiveFileTreePath(path.relative(rootCanonical, absolute))) throw new Error("该文件不允许通过文件浏览器访问。");
    const host = config.hostMode ? hostTenantFor(config, db, conversation.user_id) : null;
    const stat = fs.statSync(absolute);
    if (host) assertHostPathReadable(absolute, host.username, stat.isDirectory());
    if (relativePath.split("/").some(isSensitiveFileTreeName)) throw new Error("该文件不允许通过文件浏览器访问。");
    return {
      root,
      relativePath,
      absolute,
      stat,
      mimeType: mimeTypeForPath(absolute),
      displayPath: fileTreeDisplayPath(root, relativePath),
    };
  }

  function fileTreeEntryPreviewable(mimeType: string, size: number | null): boolean {
    return Boolean(size !== null && (mimeType.startsWith("image/") || mimeType === "application/pdf" || (isTextPreviewMime(mimeType) && size <= FILE_TREE_PREVIEW_MAX_BYTES)));
  }

  function listFileTreeDirectory(conversation: ConversationRow, rootId: string, rawPath: unknown) {
    const target = fileTreeTargetFor(conversation, rootId, rawPath);
    if (!target) throw new Error("文件根目录不可用。");
    if (!target.stat.isDirectory()) throw new Error("不是目录，无法浏览。");
    let names: string[];
    try { names = fs.readdirSync(target.absolute); } catch { throw new Error("无法读取该目录。"); }
    const truncated = names.length > FILE_TREE_MAX_ENTRIES;
    const entries = names.slice(0, FILE_TREE_MAX_ENTRIES).flatMap((name) => {
      if (isSensitiveFileTreeName(name)) return [];
      const childInput = path.join(target.absolute, name);
      try {
        const childLinkStat = fs.lstatSync(childInput);
        let childStat = childLinkStat;
        let type: "dir" | "file" | "link" | "other" = "other";
        if (childLinkStat.isSymbolicLink()) {
          const childTarget = fs.realpathSync(childInput);
          if (target.root.id !== "working-dir" && !pathWithin(fs.realpathSync(target.root.absolute), childTarget)) return [];
          if (target.root.id === "working-dir" && isManagedHostPath(childTarget, { dataRoot: config.dataRoot, tenantRoot: config.tenantRoot, workspaceRoot: config.workspaceRoot })) return [];
          if (isSensitiveFileTreePath(path.relative(fs.realpathSync(target.root.absolute), childTarget))) return [];
          childStat = fs.statSync(childTarget);
          type = childStat.isDirectory() ? "dir" : childStat.isFile() ? "file" : "link";
        } else {
          type = childLinkStat.isDirectory() ? "dir" : childLinkStat.isFile() ? "file" : "other";
        }
        const relativePath = target.relativePath ? `${target.relativePath}/${name}` : name;
        const mimeType = type === "file" ? mimeTypeForPath(childInput) : "application/octet-stream";
        return [{
          name,
          path: relativePath,
          display_path: fileTreeDisplayPath(target.root, relativePath),
          type,
          mime_type: mimeType,
          size: type === "file" ? childStat.size : null,
          mtime: type === "file" ? childStat.mtime.toISOString() : null,
          previewable: type === "file" && fileTreeEntryPreviewable(mimeType, childStat.size),
        }];
      } catch {
        return [];
      }
    });
    entries.sort((left, right) => (left.type === "dir" ? 0 : 1) - (right.type === "dir" ? 0 : 1) || left.name.localeCompare(right.name));
    return {
      rootId: target.root.id,
      path: target.relativePath,
      parentPath: target.relativePath ? path.posix.dirname(target.relativePath) === "." ? "" : path.posix.dirname(target.relativePath) : null,
      entries,
      truncated,
    };
  }

  function normalizeSnippetPath(raw: string): string | null {
    let value = String(raw ?? "").trim().replace(/^<|>$/g, "");
    for (let index = 0; index < 2; index += 1) {
      try {
        const next = decodeURIComponent(value);
        if (next === value) break;
        value = next;
      } catch {
        break;
      }
    }
    value = value.replace(/^sandbox:/i, "").replace(/^file:\/+/i, "").replace(/\\/g, "/");
    if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
    const parts = value.split("/");
    if (parts.some((part) => part === "..") || value.includes("\0")) return null;
    return value.replace(/^\.\//, "").replace(/\/{2,}/g, "/") || null;
  }

  function snippetTargetFor(conversation: ConversationRow, userId: string, rawPath: string): { absolute: string; displayPath: string; originalName?: string } | null {
    const normalized = normalizeSnippetPath(rawPath);
    if (!normalized) return null;
    const folded = normalized.toLocaleLowerCase();
    let workspace: string | undefined;
    const clientFile = (file: FileRow) => {
      if (!(file.kind === "output" && isPersistedDeliverablePath(file.relative_path))) workspace ??= workspaceFor(userId, conversation.id);
      return fileForClient(file, userId, workspace);
    };
    const files = db.listFiles(conversation.id);
    const basename = folded.split("/").pop() ?? "";
    const registered = files.find((file) => {
      const relative = normalizeSnippetPath(file.relative_path)?.toLocaleLowerCase() ?? "";
      if (relative && (folded === relative || folded.endsWith(`/${relative}`))) return true;
      if (!normalized.includes("/") && file.original_name.toLocaleLowerCase() === basename) return true;
      const hostPath = normalizeSnippetPath(clientFile(file).host_path)?.toLocaleLowerCase() ?? "";
      return Boolean(hostPath) && (folded === hostPath || folded.endsWith(`/${hostPath}`));
    });
    if (registered) {
      const storageRoot = fileStorageRoot(registered, userId, workspace);
      try {
        const absolute = resolveInside(storageRoot, registered.relative_path);
        if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
          return { absolute, displayPath: clientFile(registered).host_path, originalName: registered.original_name };
        }
      } catch { /* Fall through to the workspace lookup below. */ }
    }
    workspace ??= workspaceFor(userId, conversation.id);
    const roots = [{ root: workspace }, ...(config.hostMode && conversation.working_dir ? [{ root: conversation.working_dir }] : []), { root: storageFor(userId).library }];
    for (const { root } of roots) {
      try {
        const absolute = resolveInside(root, normalized);
        if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return { absolute, displayPath: normalized };
      } catch { /* Path escapes this root; try the next one. */ }
    }
    return null;
  }

  function parseStoredSourceReference(value: string | null | undefined) {
    if (!value) return null;
    try { return normalizeMessageSourceReference(JSON.parse(value)); }
    catch { return null; }
  }

  function composerDraftForClient(draft: ComposerDraftWithFiles | null | undefined, userId: string) {
    if (!draft) return null;
    return {
      ...draft,
      source_reference: parseStoredSourceReference(draft.source_reference),
      files: draft.files.map((file) => fileForClient(file, userId)),
    };
  }

  function pendingPromptForClient(prompt: PendingPromptWithFiles, userId: string) {
    return { ...prompt, source_reference: parseStoredSourceReference(prompt.source_reference), files: prompt.files.map((file) => fileForClient(file, userId)) };
  }

  function presetPromptForClient(preset: PresetPromptRow) {
    return {
      id: preset.id,
      name: preset.name,
      content: preset.content,
      position: preset.position,
      defaultEnabled: preset.default_enabled === 1,
      createdAt: preset.created_at,
      updatedAt: preset.updated_at,
    };
  }


  function conversationForClient(conversation: ConversationRow) {
    return {
      ...conversation,
      contextUsage: conversation.context_used_tokens === null ? null : { usedTokens: conversation.context_used_tokens, contextWindow: conversation.context_window, updatedAt: conversation.context_updated_at },
    };
  }
  function sideConversationForClient(sideChat: SideConversationRow) {
    const { parent_conversation_id, parent_title, side_created_at, last_opened_at, ...conversation } = sideChat;
    return {
      conversation,
      parentConversationId: parent_conversation_id,
      parentConversationTitle: parent_title,
      createdAt: side_created_at,
      lastOpenedAt: last_opened_at,
    };
  }

  function normalizePresetPromptName(value: unknown): string {
    if (typeof value !== "string") throw new Error("预设名称不能为空。");
    const name = value.trim();
    if (!name) throw new Error("预设名称不能为空。");
    if (name.length > PRESET_PROMPT_NAME_MAX) throw new Error(`预设名称不能超过 ${PRESET_PROMPT_NAME_MAX} 个字符。`);
    return name;
  }

  function normalizePresetPromptContent(value: unknown): string {
    if (typeof value !== "string") throw new Error("预设内容不能为空。");
    const content = value.trim();
    if (!content) throw new Error("预设内容不能为空。");
    if (content.length > PRESET_PROMPT_CONTENT_MAX) throw new Error(`预设内容不能超过 ${PRESET_PROMPT_CONTENT_MAX} 个字符。`);
    return content;
  }

  function normalizePresetPromptDefaultEnabled(value: unknown): boolean {
    if (typeof value !== "boolean") throw new Error("默认启用状态无效。");
    return value;
  }

  function countDefaultEnabledPresetPrompts(userId: string): number {
    return db.listPresetPrompts(userId).filter((preset) => preset.default_enabled).length;
  }

  function saveAgentSelection(userId: string, rawModel: unknown, rawEffort: unknown, conversation?: ConversationRow, rawProvider?: unknown, rawSandbox?: unknown): AgentSelection {
    const selection = resolveAgentSelection(optionsForUser(userId), rawModel, rawEffort, rawProvider, rawSandbox);
    db.setAgentSelectionPreference(selection, userId);
    if (conversation) db.updateConversation(conversation.id, { agentSelection: selection });
    return selection;
  }

  for (const user of db.listUsers()) userAgentSelection(user.id);
  for (const conversation of db.listConversations()) {
    if (conversation.agent_model || conversation.reasoning_effort) conversationAgentSelection(conversation);
  }

  function publish(jobId: string, eventType: string, payload: unknown): void {
    const seq = db.appendEvent(jobId, eventType, payload);
    const livePayload = {
      ...(payload && typeof payload === "object" ? payload : { payload }),
      created_at: new Date().toISOString(),
    };
    for (const response of subscribers.get(jobId) ?? []) writeSse(response, seq, eventType, livePayload);
    if (["done", "failed"].includes(eventType)) {
      setTimeout(() => {
        for (const response of subscribers.get(jobId) ?? []) response.end();
        subscribers.delete(jobId);
      }, 100);
    }
  }

  const runner = new CodexRunner(config, db, publish);
  const transcription = new TranscriptionService(config);
  const voiceEnabled = Boolean(config.dashscopeApiKey && config.publicBaseUrl.startsWith("https://"));
  const deletingConversations = new Set<string>();
  let queuePumpBusy = false;
  let shuttingDown = false;

  function sessionResponse(session: Pick<SessionRow, "user_id" | "csrf_token" | "username" | "display_name">): Record<string, unknown> {
    return {
      authenticated: true,
      username: session.username,
      displayName: session.display_name,
      csrfToken: session.csrf_token,
      chatFontSize: db.getChatFontSize(session.user_id),
      chatColumnWidth: db.getChatColumnWidth(session.user_id),
      voiceEnabled,
      canChangeUsername: !config.hostMode,
      providerManagementEnabled: db.getProviderManagementEnabled(session.user_id),
    };
  }

  function requireProviderManagement(session: SessionRow, res: Response): boolean {
    if (db.getProviderManagementEnabled(session.user_id)) return true;
    res.status(403).json({ error: "API 源管理未启用，请先在个人设置中打开。", code: "provider-management-disabled" });
    return false;
  }

  function removePendingPromptFiles(prompt: PendingPromptWithFiles, userId: string): void {
    const workspace = resolveInside(tenantPaths(config.tenantRoot, userId).conversations, prompt.conversation_id);
    for (const file of prompt.files) {
      try { fs.rmSync(resolveInside(workspace, file.relative_path), { force: true }); }
      catch { /* Missing or already-cleaned drafts must not block queue cleanup. */ }
    }
  }

  function removeComposerDraftFiles(draft: ComposerDraftWithFiles, userId: string): void {
    const workspace = resolveInside(tenantPaths(config.tenantRoot, userId).conversations, draft.conversation_id);
    for (const file of draft.files) {
      try { fs.rmSync(resolveInside(workspace, file.relative_path), { force: true }); }
      catch { /* Missing draft files must not block explicit draft cleanup. */ }
    }
  }

  type StoredUpload = { originalName: string; diskName: string; mimeType: string; size: number };

  function storedUploads(uploaded: Express.Multer.File[]): StoredUpload[] {
    return uploaded.map((file) => ({
      originalName: file.originalname,
      diskName: file.filename,
      mimeType: normalizeUploadMime(file),
      size: file.size,
    }));
  }

  function registerPendingUploads(conversationId: string, pendingPromptId: string, uploaded: StoredUpload[]): FileRow[] {
    const createdAt = new Date().toISOString();
    return uploaded.map((file) => {
      const row: FileRow = {
        id: newId(), conversation_id: conversationId, message_id: null, pending_prompt_id: pendingPromptId,
        original_name: safeUploadName(file.originalName).displayName,
        relative_path: path.posix.join("uploads", file.diskName), mime_type: file.mimeType,
        size: file.size, kind: "upload", created_at: createdAt,
      };
      db.addFile(row);
      return row;
    });
  }

  function registerComposerUploads(conversationId: string, uploaded: StoredUpload[]): FileRow[] {
    db.ensureComposerDraft(conversationId);
    const createdAt = new Date().toISOString();
    const rows = uploaded.map((file) => {
      const row: FileRow = {
        id: newId(), conversation_id: conversationId, message_id: null, pending_prompt_id: null, composer_draft_id: conversationId,
        original_name: safeUploadName(file.originalName).displayName,
        relative_path: path.posix.join("uploads", file.diskName), mime_type: file.mimeType,
        size: file.size, kind: "upload", created_at: createdAt,
      };
      db.addFile(row);
      return row;
    });
    db.touchComposerDraft(conversationId);
    return rows;
  }

  function removeUnregisteredUploads(uploaded: Express.Multer.File[]): void {
    for (const file of uploaded) {
      try { fs.rmSync(file.path, { force: true }); }
      catch { /* A rejected multipart request must not leave orphaned uploads. */ }
    }
  }

  function submittedQuoteExcerpt(value: unknown): string | null {
    if (typeof value !== "string") return null;
    return normalizeAskAgentSelection(value).slice(0, ASK_AGENT_SELECTION_MAX_CHARS + 1) || null;
  }

  function submittedSourceReference(value: unknown): string | null {
    let candidate = value;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return null;
      try { candidate = JSON.parse(trimmed); } catch { return null; }
    }
    const reference = normalizeMessageSourceReference(candidate);
    return reference ? JSON.stringify(reference) : null;
  }

  function agentPrompt(content: string, quoteExcerpt?: string | null, sourceReference?: string | null): string {
    const parsedSource = parseStoredSourceReference(sourceReference);
    if (parsedSource) return buildDerivedTaskPrompt(content, parsedSource);
    return quoteExcerpt ? buildAskAgentDraft(content, quoteExcerpt) : content;
  }

  async function sourceReferenceFor(
    sourceConversation: ConversationRow,
    sourceMessage: MessageRow,
    excerpt: string,
    requireJsonlLocation = false,
  ): Promise<MessageSourceReference | null> {
    const sourceLocation = sourceConversation.codex_thread_id
      ? await locateMessageInCodexRollout({
          codexHome: codexHomeFor(sourceConversation.user_id),
          threadId: sourceConversation.codex_thread_id,
          role: sourceMessage.role === "assistant" ? "assistant" : "user",
          messageContent: sourceMessage.content,
          messageCreatedAt: sourceMessage.created_at,
          excerpt,
        })
      : null;
    if (requireJsonlLocation && !sourceLocation) return null;
    return normalizeMessageSourceReference({
      sourceConversationId: sourceConversation.id,
      sourceMessageId: sourceMessage.id,
      sourceConversationTitle: sourceConversation.title,
      sourceRole: sourceMessage.role === "assistant" ? "assistant" : "user",
      sourceCreatedAt: sourceMessage.created_at,
      excerpt,
      ...(sourceLocation ? { sourceLocation } : {}),
    });
  }

  function recordUserCancelledJob(job: JobRow): void {
    if (db.getJob(job.id)?.status !== "cancelled" || !db.getConversation(job.conversation_id)) return;
    db.addMessage({
      id: newId(), conversation_id: job.conversation_id, role: "assistant",
      content: buildUserCancellationSummary(db.listEvents(job.id)), created_at: new Date().toISOString(),
    });
  }

  async function stopConversationJobs(conversationId: string, recordCancellation = true): Promise<void> {
    const activeJobs = db.listActiveJobsForConversation(conversationId);
    const runningJobs = activeJobs.filter((job) => job.status === "running");
    for (const job of activeJobs) {
      if (job.status === "queued" && db.cancelQueuedJob(job.id)) {
        publish(job.id, "done", { status: "cancelled", message: "任务已停止" });
        continue;
      }
      if (job.status !== "running") continue;
      if (runner.cancel(job.id)) continue;
      if (db.getJob(job.id)?.status === "running") {
        db.finishJob(job.id, conversationId, "cancelled", "任务已停止");
        publish(job.id, "done", { status: "cancelled", message: "任务已停止" });
      }
    }
    publishQueuePositions();
    if (config.queueAutoStart) setImmediate(() => void pumpQueue());

    const deadline = Date.now() + 15_000;
    while (db.listActiveJobsForConversation(conversationId).length > 0) {
      if (Date.now() >= deadline) throw new Error("相关任务未能在限定时间内停止，请稍后重试。");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (recordCancellation) for (const job of runningJobs) recordUserCancelledJob(job);
  }

  function publishQueuePositions(): void {
    for (const queued of db.listQueuedJobs()) {
      const queuePosition = db.getQueuePosition(queued.id) ?? 1;
      const jobsAhead = Math.max(0, queuePosition - 1);
      publish(queued.id, "status", {
        status: "queued",
        queuePosition,
        jobsAhead,
        label: jobsAhead === 0 ? "任务即将开始" : `正在等待前面的 ${jobsAhead} 个任务运行完毕`,
      });
    }
  }

  async function runQueuedJob(job: JobRow): Promise<void> {
    try {
      const conversation = db.getConversation(job.conversation_id);
      const message = job.message_id ? db.getMessage(job.message_id) : undefined;
      if (!conversation || !message) {
        db.finishJob(job.id, job.conversation_id, "failed", "排队任务的数据不完整");
        publish(job.id, "failed", { status: "failed", message: "排队任务的数据不完整" });
        return;
      }
      const options = optionsForUser(conversation.user_id);
      const selection = repairAgentSelection(options, job.agent_model, job.reasoning_effort, job.sandbox_mode);
      const executionSelection = resolveAgentExecutionSelection(options, selection);
      await runner.run(job.id, conversation.id, agentPrompt(message.content, message.quote_excerpt, message.source_reference), db.listFilesForMessage(message.id), executionSelection);
    } finally {
      publishQueuePositions();
      await pumpQueue();
    }
  }

  async function pumpQueue(): Promise<void> {
    if (queuePumpBusy || shuttingDown) return;
    queuePumpBusy = true;
    try {
      for (;;) {
        if (shuttingDown) break;
        // Jobs explicitly promoted past the queue must start first, even when
        // another session is already running in the same working directory.
        let job = db.getNextSkipQueueJob() ?? db.getNextRunnableQueuedJob();
        if (!job) {
          const pending = db.getNextDispatchablePendingPrompt();
          if (pending) {
            job = db.materializePendingPrompt(pending.id, newId(), newId());
            if (!job) continue;
          }
        }
        if (!job) break;
        // Reserve the conversation synchronously before launching the async
        // runner. This lets other conversations start immediately while keeping
        // every turn in this conversation strictly serial.
        db.updateJob(job.id, "running");
        db.updateConversation(job.conversation_id, { status: "running" });
        void runQueuedJob(job);
      }
    } finally {
      queuePumpBusy = false;
      publishQueuePositions();
    }
  }

  const app = express();
  app.set("trust proxy", "loopback");
  app.enable("strict routing");
  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
        // Helmet 默认会在 CSP 里加入 upgrade-insecure-requests，纯 HTTP 部署
        // 时浏览器会把 JS/CSS 请求强制升级为 HTTPS 导致白屏，这里显式移除。
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    // 自托管默认走纯 HTTP/局域网，关闭 HSTS，避免普通 HTTP 响应携带该头。
    strictTransportSecurity: false,
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));

  const router = express.Router();
  const api = express.Router();

  api.get("/health", (_req, res) => res.json({ ok: true, service: "codex-web", time: new Date().toISOString() }));
  api.get("/reload-status", async (_req, res) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const statusUrl = new URL("/status", config.reloaderStatusUrl);
        const response = await fetch(statusUrl, { signal: controller.signal });
        if (!response.ok) return res.json({ available: false });
        return res.json({ available: true, ...(await response.json() as Record<string, unknown>) });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return res.json({ available: false });
    }
  });

  // DashScope fetches this short-lived, HMAC-signed URL without a browser
  // session. Keep it before the authentication middleware and expose no other
  // temporary files through this route.
  api.get("/transcription-audio/:fileName", (req, res) => transcription.serveSignedAudio(req, res));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "尝试次数过多，请稍后再试。" },
  });

  api.post("/auth/login", loginLimiter, async (req, res) => {
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const user = db.getUserByUsername(username);
    const valid = Boolean(user && user.status === "active" && user.password_hash && await bcrypt.compare(password, user.password_hash));
    if (!valid || !user) return res.status(401).json({ error: "用户名或密码不正确。" });

    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
    db.createSession(hashToken(token, config.sessionSecret), csrfToken, expiresAt.toISOString(), user.id);
    const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: req.secure || forwardedProto === "https",
      sameSite: "strict",
      path: config.basePath || "/",
      expires: expiresAt,
    });
    return res.json(sessionResponse({ user_id: user.id, csrf_token: csrfToken, username: user.username, display_name: user.display_name }));
  });

  api.get("/auth/session", (req, res) => {
    const session = readSession(req, db, config);
    if (!session) return res.json({ authenticated: false });
    return res.json(sessionResponse(session));
  });

  api.use((req, res, next) => {
    const session = readSession(req, db, config);
    if (!session) return res.status(401).json({ error: "请先登录。" });
    res.locals.session = session;
    (req as AuthenticatedRequest).appSession = session;
    return next();
  });

  api.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const session = res.locals.session as SessionRow;
    if (req.get("x-csrf-token") !== session.csrf_token) return res.status(403).json({ error: "安全校验失败，请刷新页面后重试。" });
    const origin = req.get("origin");
    const expectedHost = String(req.headers["x-forwarded-host"] ?? req.get("host") ?? "").split(",")[0].trim();
    if (origin) {
      try {
        if (new URL(origin).host !== expectedHost) return res.status(403).json({ error: "请求来源不受信任。" });
      } catch {
        return res.status(403).json({ error: "请求来源不受信任。" });
      }
    }
    return next();
  });

  api.post("/auth/logout", (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (token) db.deleteSession(hashToken(token, config.sessionSecret));
    res.clearCookie(COOKIE_NAME, { path: config.basePath || "/" });
    res.json({ ok: true });
  });

  api.put("/auth/account", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const user = db.getUser(session.user_id);
    const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    const newUsernameRaw = req.body?.newUsername;
    const newUsername = typeof newUsernameRaw === "string" ? newUsernameRaw.trim() : undefined;
    const newPassword = typeof req.body?.newPassword === "string" && req.body.newPassword ? req.body.newPassword : undefined;
    const wantsUsername = Boolean(user && newUsername !== undefined && newUsername !== user.username);
    const wantsPassword = newPassword !== undefined;
    if (!wantsUsername && !wantsPassword) return res.status(400).json({ error: "没有需要保存的变更。" });
    if (!user || !user.password_hash || !await bcrypt.compare(currentPassword, user.password_hash)) {
      return res.status(403).json({ error: "当前密码不正确。" });
    }

    if (wantsUsername) {
      if (config.hostMode) {
        return res.status(400).json({ error: "宿主模式下用户名对应系统账户，不能在网页修改。请使用系统工具或联系管理员。" });
      }
      if (!USERNAME_PATTERN.test(newUsername as string)) {
        return res.status(400).json({ error: "用户名只能包含字母、数字、点、横线、下划线，且不能以数字开头。" });
      }
      const duplicate = db.getUserByUsername(newUsername as string);
      if (duplicate && duplicate.id !== user.id) {
        return res.status(400).json({ error: "该用户名已被使用。" });
      }
      try {
        db.setUserUsername(user.id, newUsername as string);
      } catch {
        return res.status(400).json({ error: "该用户名已被使用。" });
      }
    }

    if (wantsPassword) {
      if (newPassword!.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: "新密码至少需要 12 个字符。" });
      }
      db.setUserPassword(user.id, bcrypt.hashSync(newPassword as string, 12));
      const token = req.cookies?.[COOKIE_NAME];
      if (typeof token === "string" && token) {
        db.deleteOtherUserSessions(user.id, hashToken(token, config.sessionSecret));
      }
    }

    const updated = db.getUser(user.id);
    if (!updated) return res.status(500).json({ error: "账户更新失败，请刷新后重试。" });
    return res.json(sessionResponse({ ...session, username: updated.username, display_name: updated.display_name }));
  });

  const clientErrorLimiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { ok: true },
  });
  api.post("/client-errors", clientErrorLimiter, (req, res) => {
    const session = res.locals.session as SessionRow;
    const raw = req.body as Record<string, unknown> | undefined;
    const message = typeof raw?.message === "string" ? raw.message.trim().slice(0, 2000) : "";
    const stack = typeof raw?.stack === "string" ? raw.stack.trim().slice(0, 8000) : "";
    const componentStack = typeof raw?.componentStack === "string" ? raw.componentStack.trim().slice(0, 8000) : "";
    const source = typeof raw?.source === "string" ? raw.source.trim().slice(0, 100) : "";
    const href = typeof raw?.href === "string" ? raw.href.trim().slice(0, 1000) : "";
    if (message) logger.warn({ userId: session.user_id, source, href, message, stack, componentStack }, "client error");
    return res.json({ ok: true });
  });

  api.get("/conversations", (_req, res) => {
    const session = res.locals.session as SessionRow;
    return res.json({ conversations: db.listPrimaryConversations(session.user_id).map(conversationForClient) });
  });

  api.get("/conversations/archived", (req, res) => {
    const session = res.locals.session as SessionRow;
    const query = typeof req.query.query === "string" ? req.query.query : "";
    return res.json({ conversations: db.listArchivedConversations(session.user_id, query).map(conversationForClient) });
  });

  api.get("/conversations/importable-sessions", async (_req, res) => {
    const session = res.locals.session as SessionRow;
    if (config.hostMode && !hostTenantFor(config, db, session.user_id)) return res.json({ sessions: [] });
    const existingThreadIds = new Set(db.listCodexThreadIds());
    const sessions = await discoverImportableSessions(codexHomeFor(session.user_id), existingThreadIds);
    return res.json({ sessions });
  });

  api.post("/conversations/import-sessions", async (req, res) => {
    const session = res.locals.session as SessionRow;
    if (config.hostMode && !hostTenantFor(config, db, session.user_id)) {
      return res.status(409).json({ error: "该用户没有对应的系统账户和 Codex Home，无法导入会话。" });
    }
    const rawThreadIds = Array.isArray(req.body?.threadIds) ? req.body.threadIds as unknown : [];
    const threadIds = (Array.isArray(rawThreadIds) ? rawThreadIds : [])
      .filter((value): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value))
      .slice(0, 500);
    if (threadIds.length === 0) return res.status(400).json({ error: "请选择要导入的历史会话。" });
    const codexHome = codexHomeFor(session.user_id);
    const existingThreadIds = new Set(db.listCodexThreadIds());
    const discovered = await discoverImportableSessions(codexHome, existingThreadIds);
    const discoveredById = new Map(discovered.map((item) => [item.threadId, item]));
    const conversations: ConversationRow[] = [];
    const skipped: string[] = [];
    for (const threadId of threadIds) {
      const discovered = discoveredById.get(threadId);
      if (!discovered) {
        skipped.push(threadId);
        continue;
      }
      const workingDir = config.hostMode
        ? normalizeImportedWorkingDir(discovered.cwd, (raw) =>
          resolveHostWorkingDir(raw, { dataRoot: config.dataRoot, tenantRoot: config.tenantRoot, workspaceRoot: config.workspaceRoot }))
        : null;
      try {
        const conversation = await importSessionThread(db, codexHome, threadId, session.user_id, workingDir);
        if (conversation) conversations.push(conversation);
        else skipped.push(threadId);
      } catch {
        skipped.push(threadId);
      }
    }
    return res.json({ conversations, skipped });
  });

  api.get("/agent-options", (_req, res) => {
    const session = res.locals.session as SessionRow;
    const options = optionsForUser(session.user_id);
    const hostTenant = config.hostMode ? hostTenantFor(config, db, session.user_id) : null;
    const configured = !config.hostMode || Boolean(hostTenant && isCodexConfigured(hostTenant.codexHome, { uid: hostTenant.uid, gid: hostTenant.gid }));
    return res.json({
      ...options,
      selection: userAgentSelection(session.user_id, options),
      codexConfigured: configured,
      codexConfigHint: configured
        ? undefined
        : hostTenant
          ? CODEX_CONFIG_HINT
          : "该用户没有对应的系统账户，无法运行 Codex 任务。请先由管理员添加系统用户。",
    });
  });

  api.put("/agent-selection", (req, res) => {
    const session = res.locals.session as SessionRow;
    try { return res.json({ selection: saveAgentSelection(session.user_id, req.body?.model, req.body?.reasoningEffort, undefined, req.body?.provider, req.body?.sandbox) }); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "模型选项无效。" }); }
  });

  api.get("/providers", (_req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireProviderManagement(session, res)) return;
    return res.json({ providers: listProvidersPublic(db, session.user_id), models: listProviderModelsPublic(db, session.user_id) });
  });

  api.get("/billing", (req, res) => {
    const session = res.locals.session as SessionRow;
    const rawDays = typeof req.query.days === "string" ? Number(req.query.days) : 30;
    return res.json(buildBillingState(db, session.user_id, rawDays));
  });

  api.put("/billing/pricing-rules/:providerId/:modelId", (req, res) => {
    const session = res.locals.session as SessionRow;
    const providerId = String(req.params.providerId);
    const modelId = String(req.params.modelId);
    const raw = req.body as Record<string, unknown> | undefined;
    const values = ["inputPerMillion", "cachedInputPerMillion", "cacheWritePerMillion", "outputPerMillion"]
      .map((key) => Number(raw?.[key]));
    if (!values.every((value) => Number.isFinite(value) && value >= 0)) return res.status(400).json({ error: "费率必须是非负数字。" });
    if (providerId !== BUILTIN_PROVIDER_ID && !db.getProvider(session.user_id, providerId)) return res.status(404).json({ error: "API 源不存在。" });
    if (!modelId.trim() || modelId.length > 160) return res.status(400).json({ error: "模型标识无效。" });
    const currency = typeof raw?.currency === "string" && /^[A-Za-z]{3}$/.test(raw.currency.trim()) ? raw.currency.trim().toUpperCase() : "USD";
    db.upsertPricingRule({
      user_id: session.user_id, provider_id: providerId, model_id: modelId,
      input_per_million: values[0], cached_input_per_million: values[1], cache_write_per_million: values[2], output_per_million: values[3],
      currency, source: "manual", pricing_url: null,
    });
    return res.json(buildBillingState(db, session.user_id, Number(req.query.days) || 30));
  });

  api.post("/billing/sync-pricing", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const results: Array<{ providerId: string; imported: number; error?: string }> = [];
    for (const provider of db.listProviders(session.user_id).filter((candidate) => candidate.enabled)) {
      try {
        const result = await syncProviderPricing(db, session.user_id, provider);
        results.push({ providerId: provider.id, imported: result.imported });
      } catch (error) {
        results.push({ providerId: provider.id, imported: 0, error: error instanceof Error ? error.message : "同步失败" });
      }
    }
    return res.json({ results, imported: results.reduce((sum, result) => sum + result.imported, 0), billing: buildBillingState(db, session.user_id) });
  });

  api.post("/billing/providers/:id/sync-pricing", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const provider = db.getProvider(session.user_id, String(req.params.id));
    if (!provider) return res.status(404).json({ error: "API 源不存在。" });
    try {
      const result = await syncProviderPricing(db, session.user_id, provider, typeof req.body?.pricingUrl === "string" ? req.body.pricingUrl : undefined);
      return res.json({ ...result, billing: buildBillingState(db, session.user_id) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "同步计费标准失败。" });
    }
  });

  api.post("/providers", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireProviderManagement(session, res)) return;
    const raw = req.body as Record<string, unknown> | undefined;
    const name = typeof raw?.name === "string" ? raw.name.trim().slice(0, 100) : "";
    const baseUrl = typeof raw?.baseUrl === "string" ? raw.baseUrl.trim().slice(0, 500) : "";
    if (!name || !baseUrl) return res.status(400).json({ error: "请填写源名称和 Base URL。" });
    const wireApi = raw?.wireApi === "chat" || raw?.wireApi === "anthropic" ? raw.wireApi : "responses";
    const requiresOpenaiAuth = raw?.requiresOpenaiAuth === true;
    const apiKey = typeof raw?.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : null;
    const modelsFile = typeof raw?.modelsFile === "string" && raw.modelsFile.trim() ? raw.modelsFile.trim().replace(/^[./\\]+/, "") : null;
    const autoReviewModelOverride = typeof raw?.autoReviewModelOverride === "string" && raw.autoReviewModelOverride.trim()
      ? raw.autoReviewModelOverride.trim().slice(0, 200)
      : null;
    try {
      assertProviderProtocolConfiguration({ wireApi, requiresOpenaiAuth });
      assertOfficialOAuthLimit(db, session.user_id, { requiresOpenaiAuth, enabled: raw?.enabled !== false });
      const provider = db.createProvider({
        userId: session.user_id,
        id: nextProviderId(db, session.user_id, name),
        name,
        baseUrl,
        apiKey,
        modelsFile,
        autoReviewModelOverride,
        wireApi,
        requiresOpenaiAuth,
        enabled: raw?.enabled !== false,
      });
      writeProviderConfig(codexHomeFor(session.user_id), db, session.user_id, providerConfigOwner(session.user_id));
      return res.status(201).json({ provider: listProvidersPublic(db, session.user_id).find((item) => item.id === provider.id) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "添加源失败。" });
    }
  });

  api.put("/providers/:id", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireProviderManagement(session, res)) return;
    const id = String(req.params.id);
    const provider = db.getProvider(session.user_id, id);
    if (!provider) return res.status(404).json({ error: "源不存在。" });
    const raw = req.body as Record<string, unknown> | undefined;
    const fields: Parameters<typeof db.updateProvider>[2] = {};
    if (typeof raw?.name === "string") {
      const name = raw.name.trim().slice(0, 100);
      if (!name) return res.status(400).json({ error: "源名称不能为空。" });
      fields.name = name;
    }
    if (typeof raw?.baseUrl === "string") {
      const baseUrl = raw.baseUrl.trim().slice(0, 500);
      if (!baseUrl) return res.status(400).json({ error: "Base URL 不能为空。" });
      fields.baseUrl = baseUrl;
    }
    if ("apiKey" in (raw ?? {})) {
      if (raw!.apiKey === null) fields.apiKey = null;
      else if (typeof raw!.apiKey === "string" && raw!.apiKey.trim()) fields.apiKey = raw!.apiKey.trim();
    }
    if ("modelsFile" in (raw ?? {})) {
      fields.modelsFile = typeof raw!.modelsFile === "string" && raw!.modelsFile.trim()
        ? raw!.modelsFile.trim().replace(/^[./\\]+/, "")
        : null;
    }
    if ("autoReviewModelOverride" in (raw ?? {})) {
      fields.autoReviewModelOverride = typeof raw!.autoReviewModelOverride === "string" && raw!.autoReviewModelOverride.trim()
        ? raw!.autoReviewModelOverride.trim().slice(0, 200)
        : null;
    }
    if (raw?.wireApi === "chat" || raw?.wireApi === "anthropic" || raw?.wireApi === "responses") fields.wireApi = raw.wireApi;
    if (typeof raw?.requiresOpenaiAuth === "boolean") fields.requiresOpenaiAuth = raw.requiresOpenaiAuth;
    if (typeof raw?.enabled === "boolean") fields.enabled = raw.enabled;
    try {
      assertProviderProtocolConfiguration({
        wireApi: fields.wireApi ?? provider.wire_api,
        requiresOpenaiAuth: fields.requiresOpenaiAuth ?? Boolean(provider.requires_openai_auth),
      });
      assertOfficialOAuthLimit(db, session.user_id, { id, ...fields });
      const updated = db.updateProvider(session.user_id, id, fields);
      if (!updated) return res.status(404).json({ error: "源不存在。" });
      writeProviderConfig(codexHomeFor(session.user_id), db, session.user_id, providerConfigOwner(session.user_id));
      return res.json({ provider: listProvidersPublic(db, session.user_id).find((item) => item.id === id) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "更新源失败。" });
    }
  });

  api.delete("/providers/:id", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireProviderManagement(session, res)) return;
    const id = String(req.params.id);
    if (!db.getProvider(session.user_id, id)) return res.status(404).json({ error: "源不存在。" });
    if (db.isProviderReferenced(session.user_id, id)) {
      return res.status(409).json({ error: "该源仍被会话或任务使用，请先在页面中禁用该源，再删除。", code: "provider-in-use" });
    }
    try {
      db.deleteProvider(session.user_id, id);
      writeProviderConfig(codexHomeFor(session.user_id), db, session.user_id, providerConfigOwner(session.user_id));
      return res.status(204).end();
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "删除源失败。" });
    }
  });

  api.post("/providers/import-config", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireProviderManagement(session, res)) return;
    try {
      const providers = importProvidersFromConfig(codexHomeFor(session.user_id), db, session.user_id);
      writeProviderConfig(codexHomeFor(session.user_id), db, session.user_id, providerConfigOwner(session.user_id));
      return res.json({ providers, models: listProviderModelsPublic(db, session.user_id) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "导入配置失败。" });
    }
  });

  api.post("/providers/:id/import-models", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireProviderManagement(session, res)) return;
    const id = String(req.params.id);
    if (!db.getProvider(session.user_id, id)) return res.status(404).json({ error: "源不存在。" });
    try {
      const models = importCatalogModels(id, codexHomeFor(session.user_id), db, session.user_id);
      writeProviderConfig(codexHomeFor(session.user_id), db, session.user_id, providerConfigOwner(session.user_id));
      return res.json({ models });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "导入模型失败。" });
    }
  });

  api.post("/providers/:id/models", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireProviderManagement(session, res)) return;
    const providerId = String(req.params.id);
    if (!db.getProvider(session.user_id, providerId)) return res.status(404).json({ error: "源不存在。" });
    const raw = req.body as Record<string, unknown> | undefined;
    const modelId = typeof raw?.modelId === "string" ? raw.modelId.trim().slice(0, 120) : "";
    if (!modelId) return res.status(400).json({ error: "请填写模型 ID。" });
    try {
      db.createProviderModel({
        userId: session.user_id,
        id: newId(),
        providerId,
        modelId,
        slug: modelId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"),
        displayName: typeof raw?.displayName === "string" ? raw.displayName : modelId,
        description: typeof raw?.description === "string" ? raw.description : "",
        reasoningEfforts: Array.isArray(raw?.reasoningEfforts) ? raw.reasoningEfforts.filter((item): item is string => typeof item === "string") : undefined,
        inputModalities: Array.isArray(raw?.inputModalities) ? raw.inputModalities.filter((item): item is string => typeof item === "string") : undefined,
        priority: typeof raw?.priority === "number" ? raw.priority : undefined,
        visible: raw?.visible !== false,
        modelContextWindow: typeof raw?.modelContextWindow === "number" ? raw.modelContextWindow : null,
        autoCompactTokenLimit: typeof raw?.autoCompactTokenLimit === "number" ? raw.autoCompactTokenLimit : null,
      });
      writeProviderConfig(codexHomeFor(session.user_id), db, session.user_id, providerConfigOwner(session.user_id));
      return res.status(201).json({ models: listProviderModelsPublic(db, session.user_id, providerId) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "添加模型失败。" });
    }
  });

  api.put("/providers/:id/models/:modelId", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireProviderManagement(session, res)) return;
    const providerId = String(req.params.id);
    const id = String(req.params.modelId);
    const model = db.getProviderModel(session.user_id, id);
    if (!model || model.provider_id !== providerId) return res.status(404).json({ error: "模型不存在。" });
    const raw = req.body as Record<string, unknown> | undefined;
    const fields: Parameters<typeof db.updateProviderModel>[2] = {};
    if (typeof raw?.modelId === "string" && raw.modelId.trim()) fields.modelId = raw.modelId.trim().slice(0, 120);
    if (typeof raw?.displayName === "string") fields.displayName = raw.displayName;
    if (typeof raw?.description === "string") fields.description = raw.description;
    if (Array.isArray(raw?.reasoningEfforts)) {
      fields.reasoningEfforts = raw.reasoningEfforts.filter((item): item is string => typeof item === "string");
    }
    if (Array.isArray(raw?.inputModalities)) {
      fields.inputModalities = raw.inputModalities.filter((item): item is string => typeof item === "string");
    }
    if (typeof raw?.priority === "number") fields.priority = raw.priority;
    if (raw?.modelContextWindow === null || typeof raw?.modelContextWindow === "number") {
      fields.modelContextWindow = raw.modelContextWindow;
    }
    if (raw?.autoCompactTokenLimit === null || typeof raw?.autoCompactTokenLimit === "number") {
      fields.autoCompactTokenLimit = raw.autoCompactTokenLimit;
    }
    if (typeof raw?.visible === "boolean") fields.visible = raw.visible;
    try {
      db.updateProviderModel(session.user_id, id, fields);
      writeProviderConfig(codexHomeFor(session.user_id), db, session.user_id, providerConfigOwner(session.user_id));
      return res.json({ models: listProviderModelsPublic(db, session.user_id, providerId) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "更新模型失败。" });
    }
  });

  api.delete("/providers/:id/models/:modelId", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireProviderManagement(session, res)) return;
    const providerId = String(req.params.id);
    const id = String(req.params.modelId);
    const model = db.getProviderModel(session.user_id, id);
    if (!model || model.provider_id !== providerId) return res.status(404).json({ error: "模型不存在。" });
    try {
      db.deleteProviderModel(session.user_id, id);
      writeProviderConfig(codexHomeFor(session.user_id), db, session.user_id, providerConfigOwner(session.user_id));
      return res.status(204).end();
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "删除模型失败。" });
    }
  });

  api.put("/user-settings/provider-management", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "API 源管理开关无效。" });
    const enabled = db.setProviderManagementEnabled(req.body.enabled, session.user_id);
    if (enabled) {
      ensureProviderConfig(config, codexHomeFor(session.user_id), db, session.user_id, providerConfigOwner(session.user_id));
    }
    return res.json({ providerManagementEnabled: enabled });
  });

  api.put("/user-settings/chat-font-size", (req, res) => {
    const session = res.locals.session as SessionRow;
    const rawValue = req.body?.chatFontSize;
    if ((typeof rawValue !== "number" && typeof rawValue !== "string") || !Number.isFinite(Number(rawValue))) {
      return res.status(400).json({ error: "字号设置无效。" });
    }
    const chatFontSize = db.setChatFontSize(normalizeChatFontSize(rawValue, CHAT_FONT_SIZE_DEFAULT), session.user_id);
    return res.json({ chatFontSize });
  });

  api.put("/user-settings/chat-column-width", (req, res) => {
    const session = res.locals.session as SessionRow;
    const rawValue = req.body?.chatColumnWidth;
    if ((typeof rawValue !== "number" && typeof rawValue !== "string") || !Number.isFinite(Number(rawValue))) {
      return res.status(400).json({ error: "聊天区宽度设置无效。" });
    }
    const chatColumnWidth = db.setChatColumnWidth(normalizeChatColumnWidth(rawValue, CHAT_COLUMN_WIDTH_DEFAULT), session.user_id);
    return res.json({ chatColumnWidth });
  });

  api.get("/working-dirs", (req, res) => {
    const session = res.locals.session as SessionRow;
    return res.json({ settings: workingDirSettingsFor(session.user_id) });
  });

  api.get("/path-browser", (req, res) => {
    const session = res.locals.session as SessionRow;
    const host = requireHostWorkingTenant(session);
    if (!host) {
      return res.status(403).json({ error: "路径浏览仅支持已映射系统账户的 host 模式。" });
    }
    const raw = typeof req.query?.path === "string" ? req.query.path : undefined;
    try {
      return res.json({
        listing: listHostDirectory(raw, {
          dataRoot: config.dataRoot,
          tenantRoot: config.tenantRoot,
          workspaceRoot: config.workspaceRoot,
          home: host.home,
          username: host.username,
        }),
      });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "无法浏览该目录。" });
    }
  });

  api.put("/working-dirs/favorites", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireHostWorkingTenant(session)) {
      return res.status(403).json({ error: "工作目录收藏仅支持已映射系统账户的 host 模式。" });
    }
    const action = req.body?.action;
    if (!["add", "remove", "rename", "move"].includes(action)) return res.status(400).json({ error: "收藏操作无效。" });
    let target: string;
    try {
      target = action === "add"
        ? resolveSubmittedWorkingDir(req.body?.path)
        : resolveStoredWorkingDirInput(typeof req.body?.path === "string" ? req.body.path : "");
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "工作目录路径无效。" });
    }
    const favorites = db.getFavoriteWorkingDirectories(session.user_id);
    if (action === "add") {
      const label = typeof req.body?.label === "string" && req.body.label.trim()
        ? req.body.label.trim().slice(0, 100)
        : path.basename(target);
      const existing = favorites.find((favorite) => favorite.path === target);
      if (existing) {
        existing.label = label;
      } else {
        if (favorites.length >= 50) return res.status(400).json({ error: "最多收藏 50 个目录。" });
        favorites.unshift({ path: target, label, added_at: new Date().toISOString() });
      }
    } else if (action === "remove") {
      const removed = favorites.filter((favorite) => favorite.path !== target);
      db.setFavoriteWorkingDirectories(removed, session.user_id);
      if (db.getDefaultWorkingDir(session.user_id) === target) db.setDefaultWorkingDir(null, session.user_id);
      const settings = taskListCategorySettingsFor(session.user_id);
      const hiddenWithoutDir = settings.hidden.filter((key) => key !== autoDirCategoryKey(target));
      if (hiddenWithoutDir.length !== settings.hidden.length) {
        settings.hidden = hiddenWithoutDir;
        saveTaskListCategorySettings(session.user_id, settings);
      }
      return res.json({ settings: workingDirSettingsFor(session.user_id) });
    } else if (action === "move") {
      const direction = req.body?.direction;
      if (direction !== "up" && direction !== "down") return res.status(400).json({ error: "排序方向无效。" });
      const index = favorites.findIndex((favorite) => favorite.path === target);
      if (index < 0) return res.status(404).json({ error: "收藏目录不存在。" });
      const swapIndex = direction === "up" ? index - 1 : index + 1;
      if (swapIndex < 0 || swapIndex >= favorites.length) return res.status(400).json({ error: "已处于列表最前/最后。" });
      const [moved] = favorites.splice(index, 1);
      favorites.splice(swapIndex, 0, moved);
    } else {
      const favorite = favorites.find((candidate) => candidate.path === target);
      if (!favorite) return res.status(404).json({ error: "收藏目录不存在。" });
      const label = typeof req.body?.label === "string" && req.body.label.trim()
        ? req.body.label.trim().slice(0, 100)
        : favorite.label;
      favorite.label = label;
    }
    db.setFavoriteWorkingDirectories(favorites, session.user_id);
    return res.json({ settings: workingDirSettingsFor(session.user_id) });
  });

  api.put("/working-dirs/default", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireHostWorkingTenant(session)) {
      return res.status(403).json({ error: "默认工作目录仅支持已映射系统账户的 host 模式。" });
    }
    const raw = req.body?.path;
    let next: string | null = null;
    if (raw !== null && raw !== undefined && raw !== "") {
      let target: string;
      try { target = resolveSubmittedWorkingDir(raw); }
      catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "工作目录路径无效。" }); }
      const exists = db.getFavoriteWorkingDirectories(session.user_id).some((favorite) => favorite.path === target);
      if (!exists) return res.status(400).json({ error: "请先收藏该目录，再设为默认。" });
      next = target;
    }
    db.setDefaultWorkingDir(next, session.user_id);
    return res.json({ settings: workingDirSettingsFor(session.user_id) });
  });

  api.get("/task-categories", (req, res) => {
    const session = res.locals.session as SessionRow;
    return res.json({ settings: taskListCategorySettingsFor(session.user_id) });
  });

  api.post("/task-categories/custom", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireHostWorkingTenant(session)) {
      return res.status(403).json({ error: "任务列表分类仅支持已映射系统账户的 host 模式。" });
    }
    let name: string;
    try { name = normalizeTaskCategoryName(req.body?.name); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "分类名称无效。" }); }
    const settings = taskListCategorySettingsFor(session.user_id);
    if (settings.customCategories.length >= 50) return res.status(400).json({ error: "最多创建 50 个自定义分类。" });
    if (settings.customCategories.some((category) => category.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: "已存在同名分类。" });
    }
    settings.customCategories.push({ id: crypto.randomUUID(), name, assignedDirs: [] });
    return res.json({ settings: saveTaskListCategorySettings(session.user_id, settings) });
  });

  api.patch("/task-categories/custom/:id", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireHostWorkingTenant(session)) {
      return res.status(403).json({ error: "任务列表分类仅支持已映射系统账户的 host 模式。" });
    }
    const id = String(req.params.id);
    let name: string;
    try { name = normalizeTaskCategoryName(req.body?.name); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "分类名称无效。" }); }
    const settings = taskListCategorySettingsFor(session.user_id);
    const category = settings.customCategories.find((candidate) => candidate.id === id);
    if (!category) return res.status(404).json({ error: "自定义分类不存在。" });
    if (settings.customCategories.some((candidate) => candidate.id !== id && candidate.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: "已存在同名分类。" });
    }
    category.name = name;
    return res.json({ settings: saveTaskListCategorySettings(session.user_id, settings) });
  });

  api.delete("/task-categories/custom/:id", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireHostWorkingTenant(session)) {
      return res.status(403).json({ error: "任务列表分类仅支持已映射系统账户的 host 模式。" });
    }
    const id = String(req.params.id);
    const settings = taskListCategorySettingsFor(session.user_id);
    const before = settings.customCategories.length;
    settings.customCategories = settings.customCategories.filter((category) => category.id !== id);
    if (settings.customCategories.length === before) return res.status(404).json({ error: "自定义分类不存在。" });
    settings.pinned = settings.pinned.filter((key) => key !== customCategoryKey(id));
    settings.hidden = settings.hidden.filter((key) => key !== customCategoryKey(id));
    delete settings.conversationOrders[customCategoryKey(id)];
    return res.json({ settings: saveTaskListCategorySettings(session.user_id, settings) });
  });

  api.put("/task-categories/dirs", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireHostWorkingTenant(session)) {
      return res.status(403).json({ error: "工作目录归类仅支持已映射系统账户的 host 模式。" });
    }
    let dir: string;
    try {
      dir = resolveStoredWorkingDirInput(typeof req.body?.dir === "string" ? req.body.dir : "");
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "工作目录路径无效。" });
    }
    const rawCategoryId = req.body?.categoryId;
    const customId = rawCategoryId === null || rawCategoryId === undefined || rawCategoryId === ""
      ? null
      : String(rawCategoryId);
    const settings = taskListCategorySettingsFor(session.user_id);
    if (customId && !settings.customCategories.some((category) => category.id === customId)) {
      return res.status(404).json({ error: "自定义分类不存在。" });
    }
    for (const category of settings.customCategories) {
      category.assignedDirs = category.assignedDirs.filter((candidate) => candidate !== dir);
    }
    if (customId) {
      const category = settings.customCategories.find((candidate) => candidate.id === customId)!;
      category.assignedDirs = [...new Set([...category.assignedDirs, dir])];
    }
    return res.json({ settings: saveTaskListCategorySettings(session.user_id, settings) });
  });

  api.put("/task-categories/pins", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireHostWorkingTenant(session)) {
      return res.status(403).json({ error: "任务列表分类仅支持已映射系统账户的 host 模式。" });
    }
    const rawKeys = req.body?.keys;
    if (!Array.isArray(rawKeys)) return res.status(400).json({ error: "置顶顺序无效。" });
    const settings = taskListCategorySettingsFor(session.user_id);
    const favoritePaths = db.getFavoriteWorkingDirectories(session.user_id).map((favorite) => favorite.path);
    const activeDirs = db.listConversations(session.user_id).map((row) => row.working_dir).filter((dir): dir is string => Boolean(dir));
    settings.pinned = listValidPinnedCategoryKeys(
      { customCategories: settings.customCategories, pinned: rawKeys.filter((key): key is string => typeof key === "string") },
      favoritePaths,
      activeDirs,
    );
    return res.json({ settings: saveTaskListCategorySettings(session.user_id, settings) });
  });

  api.put("/task-categories/hidden", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireHostWorkingTenant(session)) {
      return res.status(403).json({ error: "任务列表分类仅支持已映射系统账户的 host 模式。" });
    }
    const rawKeys = req.body?.keys;
    if (!Array.isArray(rawKeys)) return res.status(400).json({ error: "隐藏分类列表无效。" });
    const settings = taskListCategorySettingsFor(session.user_id);
    const favoritePaths = db.getFavoriteWorkingDirectories(session.user_id).map((favorite) => favorite.path);
    const activeDirs = db.listConversations(session.user_id).map((row) => row.working_dir).filter((dir): dir is string => Boolean(dir));
    settings.hidden = listValidHiddenCategoryKeys(
      { customCategories: settings.customCategories, hidden: rawKeys.filter((key): key is string => typeof key === "string") },
      favoritePaths,
      activeDirs,
    );
    return res.json({ settings: saveTaskListCategorySettings(session.user_id, settings) });
  });

  api.put("/task-categories/conversation-order", (req, res) => {
    const session = res.locals.session as SessionRow;
    if (!requireHostWorkingTenant(session)) {
      return res.status(403).json({ error: "任务列表分类仅支持已映射系统账户的 host 模式。" });
    }
    const rawCategoryKey = req.body?.categoryKey;
    const rawIds = req.body?.conversationIds;
    if (typeof rawCategoryKey !== "string" || !parseCategoryKey(rawCategoryKey)) {
      return res.status(400).json({ error: "分类标识无效。" });
    }
    if (!Array.isArray(rawIds)) return res.status(400).json({ error: "任务顺序无效。" });
    const settings = taskListCategorySettingsFor(session.user_id);
    const ids = [...new Set(rawIds.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, 2000);
    if (ids.length) settings.conversationOrders[rawCategoryKey] = ids;
    else delete settings.conversationOrders[rawCategoryKey];
    return res.json({ settings: saveTaskListCategorySettings(session.user_id, settings) });
  });

  api.get("/preset-prompts", (req, res) => {
    const session = res.locals.session as SessionRow;
    return res.json({ presetPrompts: db.listPresetPrompts(session.user_id).map(presetPromptForClient) });
  });

  api.post("/preset-prompts", (req, res) => {
    const session = res.locals.session as SessionRow;
    let name: string;
    let content: string;
    let defaultEnabled = false;
    try {
      name = normalizePresetPromptName(req.body?.name);
      content = normalizePresetPromptContent(req.body?.content);
      if (req.body?.defaultEnabled !== undefined) defaultEnabled = normalizePresetPromptDefaultEnabled(req.body.defaultEnabled);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "预设内容无效。" });
    }
    if (db.listPresetPrompts(session.user_id).length >= MAX_PRESET_PROMPTS_PER_USER) {
      return res.status(400).json({ error: `最多创建 ${MAX_PRESET_PROMPTS_PER_USER} 条预设。` });
    }
    if (defaultEnabled && countDefaultEnabledPresetPrompts(session.user_id) >= MAX_CONVERSATION_PRESET_PROMPTS) {
      return res.status(400).json({ error: `默认打开的预设最多 ${MAX_CONVERSATION_PRESET_PROMPTS} 条。` });
    }
    const preset = db.createPresetPrompt(session.user_id, newId(), name, content, defaultEnabled);
    return res.status(201).json({ presetPrompt: presetPromptForClient(preset) });
  });

  api.put("/preset-prompts/:id", (req, res) => {
    const session = res.locals.session as SessionRow;
    const id = String(req.params.id);
    const current = db.getPresetPrompt(session.user_id, id);
    if (!current) return res.status(404).json({ error: "预设不存在。" });
    const fields: { name?: string; content?: string; position?: number; defaultEnabled?: boolean } = {};
    if (req.body?.name !== undefined) {
      try { fields.name = normalizePresetPromptName(req.body.name); }
      catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "预设名称无效。" }); }
    }
    if (req.body?.content !== undefined) {
      try { fields.content = normalizePresetPromptContent(req.body.content); }
      catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "预设内容无效。" }); }
    }
    if (req.body?.position !== undefined) {
      const position = Number(req.body.position);
      if (!Number.isInteger(position) || position < 0) return res.status(400).json({ error: "预设排序位置无效。" });
      fields.position = position;
    }
    if (req.body?.defaultEnabled !== undefined) {
      try { fields.defaultEnabled = normalizePresetPromptDefaultEnabled(req.body.defaultEnabled); }
      catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "默认启用状态无效。" }); }
    }
    if (fields.defaultEnabled === true && !current.default_enabled
      && countDefaultEnabledPresetPrompts(session.user_id) >= MAX_CONVERSATION_PRESET_PROMPTS) {
      return res.status(400).json({ error: `默认打开的预设最多 ${MAX_CONVERSATION_PRESET_PROMPTS} 条。` });
    }
    if (fields.name === undefined && fields.content === undefined && fields.position === undefined && fields.defaultEnabled === undefined) {
      return res.status(400).json({ error: "没有需要更新的内容。" });
    }
    const updated = db.updatePresetPrompt(session.user_id, id, fields);
    if (!updated) return res.status(404).json({ error: "预设不存在。" });
    return res.json({ presetPrompt: presetPromptForClient(updated) });
  });

  api.delete("/preset-prompts/:id", (req, res) => {
    const session = res.locals.session as SessionRow;
    const id = String(req.params.id);
    if (!db.deletePresetPrompt(session.user_id, id)) return res.status(404).json({ error: "预设不存在。" });
    return res.status(204).end();
  });

  api.put("/conversations/:id/preset-prompts", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.archived_at) return res.status(409).json({ error: "会话已归档，请恢复后再修改预设。" });
    const raw = req.body?.presetPromptIds;
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || !id)) {
      return res.status(400).json({ error: "预设列表无效。" });
    }
    if (raw.length > MAX_CONVERSATION_PRESET_PROMPTS) {
      return res.status(400).json({ error: `每个对话最多启用 ${MAX_CONVERSATION_PRESET_PROMPTS} 条预设。` });
    }
    const enabled = db.setConversationPresetPrompts(conversation.id, session.user_id, [...new Set(raw)]);
    if (enabled === null) return res.status(400).json({ error: "预设列表包含不存在的预设。" });
    return res.json({ enabledPresetPromptIds: enabled });
  });

  api.post("/conversations/from-source", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const sourceConversationId = typeof req.body?.sourceConversationId === "string" ? req.body.sourceConversationId : "";
    const sourceMessageId = typeof req.body?.sourceMessageId === "string" ? req.body.sourceMessageId : "";
    if (!/^[0-9a-f-]{36}$/i.test(sourceConversationId) || !/^[0-9a-f-]{36}$/i.test(sourceMessageId)) {
      return res.status(400).json({ error: "引用来源无效。" });
    }
    const excerpt = normalizeSourceExcerpt(req.body?.excerpt);
    if (!excerpt) return res.status(400).json({ error: "请选择要引用的文本。" });

    const sourceConversation = db.getConversationForUser(sourceConversationId, session.user_id);
    if (!sourceConversation) return res.status(404).json({ error: "来源任务不存在。" });
    const sourceMessage = db.getMessage(sourceMessageId);
    if (!sourceMessage || sourceMessage.conversation_id !== sourceConversation.id) {
      return res.status(404).json({ error: "来源消息不存在。" });
    }

    let workingDir: string | null = null;
    if (sourceConversation.working_dir) {
      if (!requireHostWorkingTenant(session)) {
        return res.status(403).json({ error: "来源任务使用了宿主工作目录，但当前用户没有可映射的系统账户。" });
      }
      try {
        workingDir = resolveSubmittedWorkingDir(sourceConversation.working_dir);
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : "来源任务工作目录已失效。" });
      }
    }

    const reference = await sourceReferenceFor(sourceConversation, sourceMessage, excerpt);
    if (!reference) return res.status(400).json({ error: "无法生成引用快照。" });

    const id = newId();
    const agentSelection = userAgentSelection(session.user_id);
    const conversation = db.createConversation(id, "新任务", agentSelection, session.user_id, workingDir);
    db.applyDefaultPresetPrompts(conversation.id, session.user_id);
    const composerDraft = db.saveComposerDraft(id, "", excerpt, JSON.stringify(reference));
    return res.status(201).json({ conversation, agentSelection, composerDraft: composerDraftForClient(composerDraft, session.user_id) });
  });

  function createSideChatFor(parent: ConversationRow) {
    const id = newId();
    workspaceFor(parent.user_id, id);
    const selection = conversationAgentSelection(parent);
    const conversation = db.createSideConversation(parent, id, selection);
    db.setConversationPresetPrompts(conversation.id, parent.user_id, db.getConversationPresetPromptIds(parent.id));
    return { conversation, agentSelection: selection };
  }

  api.get("/side-chats", (req, res) => {
    const session = res.locals.session as SessionRow;
    return res.json({ sideChats: db.listSideConversations(session.user_id).filter((sideChat) => !sideChat.archived_at).map(sideConversationForClient) });
  });

  api.post("/side-chats/:id/open", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.touchSideConversation(String(req.params.id), session.user_id);
    return conversation ? res.json({ conversation }) : res.status(404).json({ error: "侧边对话不存在。" });
  });

  api.get("/conversations/:id/side-chat", (req, res) => {
    const session = res.locals.session as SessionRow;
    const parent = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!parent || db.getSideConversationParent(parent.id, session.user_id)) return res.status(404).json({ error: "主会话不存在。" });
    return res.json({ conversation: db.getSideConversation(parent.id, session.user_id) ?? null });
  });

  api.get("/conversations/:id/side-chats", (req, res) => {
    const session = res.locals.session as SessionRow;
    const parent = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!parent || db.getSideConversationParent(parent.id, session.user_id)) return res.status(404).json({ error: "主会话不存在。" });
    return res.json({ sideChats: db.listSideConversations(session.user_id, parent.id).map(sideConversationForClient) });
  });

  api.post("/conversations/:id/side-chat", (req, res) => {
    const session = res.locals.session as SessionRow;
    const parent = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!parent || db.getSideConversationParent(parent.id, session.user_id)) return res.status(404).json({ error: "主会话不存在。" });
    if (parent.archived_at) return res.status(409).json({ error: "主会话已归档，请恢复后再打开侧边聊天。" });
    const existing = db.getSideConversation(parent.id, session.user_id);
    if (existing) return res.json({ conversation: existing, agentSelection: conversationAgentSelection(existing) });
    return res.status(201).json(createSideChatFor(parent));
  });

  api.post("/conversations/:id/side-chats", (req, res) => {
    const session = res.locals.session as SessionRow;
    const parent = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!parent || db.getSideConversationParent(parent.id, session.user_id)) return res.status(404).json({ error: "主会话不存在。" });
    if (parent.archived_at) return res.status(409).json({ error: "主会话已归档，请恢复后再新建侧边聊天。" });
    return res.status(201).json(createSideChatFor(parent));
  });

  api.post("/side-chats/:id/context", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation || !db.getSideConversationParent(conversation.id, session.user_id)) return res.status(404).json({ error: "侧边对话不存在。" });
    const source = db.getConversationForUser(String(req.body?.sourceConversationId ?? ""), session.user_id);
    if (!source || db.getSideConversationParent(source.id, session.user_id)) return res.status(404).json({ error: "主会话不存在。" });
    if (source.archived_at) return res.status(409).json({ error: "主会话已归档，请恢复后再引用。" });
    const messages = db.listMessages(source.id)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
    const reference = normalizeMessageSourceReference({
      kind: "conversation-context",
      sourceConversationId: source.id,
      sourceConversationTitle: source.title,
      excerpt: buildConversationContextExcerpt(messages),
      messageCount: messages.length,
    });
    if (!reference || reference.kind !== "conversation-context") return res.status(409).json({ error: "当前主对话没有可引用的上下文。" });
    const currentDraft = db.getComposerDraft(conversation.id);
    const composerDraft = db.saveComposerDraft(conversation.id, currentDraft?.content ?? "", reference.excerpt, JSON.stringify(reference));
    db.touchSideConversation(conversation.id, session.user_id);
    return res.json({ conversation, agentSelection: conversationAgentSelection(conversation), composerDraft: composerDraftForClient(composerDraft, session.user_id), reference });
  });

  api.post("/side-chats/:id/reference", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation || !db.getSideConversationParent(conversation.id, session.user_id)) return res.status(404).json({ error: "侧边对话不存在。" });
    const source = db.getConversationForUser(String(req.body?.sourceConversationId ?? ""), session.user_id);
    if (!source || db.getSideConversationParent(source.id, session.user_id)) return res.status(404).json({ error: "主会话不存在。" });
    if (source.archived_at) return res.status(409).json({ error: "主会话已归档，请恢复后再引用。" });
    const sourceMessageId = typeof req.body?.sourceMessageId === "string" ? req.body.sourceMessageId : "";
    const excerpt = normalizeSourceExcerpt(req.body?.excerpt);
    if (!/^[0-9a-f-]{36}$/i.test(sourceMessageId) || !excerpt) return res.status(400).json({ error: "引用来源无效。" });
    const sourceMessage = db.getMessage(sourceMessageId);
    if (!sourceMessage || sourceMessage.conversation_id !== source.id) return res.status(404).json({ error: "来源消息不存在。" });
    const reference = await sourceReferenceFor(source, sourceMessage, excerpt, true);
    if (!reference) return res.status(409).json({ error: "这段内容尚未写入 Codex rollout JSONL，请等待当前任务完成后重试。", code: "source-jsonl-pending" });
    const currentDraft = db.getComposerDraft(conversation.id);
    const draftContent = typeof req.body?.content === "string" ? req.body.content.slice(0, 100_000) : currentDraft?.content ?? "";
    const composerDraft = db.saveComposerDraft(conversation.id, draftContent, excerpt, JSON.stringify(reference));
    db.touchSideConversation(conversation.id, session.user_id);
    return res.json({ conversation, agentSelection: conversationAgentSelection(conversation), composerDraft: composerDraftForClient(composerDraft, session.user_id), reference });
  });

  api.post("/conversations/:id/side-chat/context", (req, res) => {
    const session = res.locals.session as SessionRow;
    const parent = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!parent || db.getSideConversationParent(parent.id, session.user_id)) return res.status(404).json({ error: "主会话不存在。" });
    if (parent.archived_at) return res.status(409).json({ error: "主会话已归档，请恢复后再引用。" });
    const messages = db.listMessages(parent.id)
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
    const reference = normalizeMessageSourceReference({
      kind: "conversation-context",
      sourceConversationId: parent.id,
      sourceConversationTitle: parent.title,
      excerpt: buildConversationContextExcerpt(messages),
      messageCount: messages.length,
    });
    if (!reference || reference.kind !== "conversation-context") return res.status(409).json({ error: "当前主对话没有可引用的上下文。" });
    let conversation = db.getSideConversation(parent.id, session.user_id);
    if (!conversation) {
      const id = newId();
      const selection = conversationAgentSelection(parent);
      conversation = db.createSideConversation(parent, id, selection);
      db.setConversationPresetPrompts(conversation.id, session.user_id, db.getConversationPresetPromptIds(parent.id));
    }
    const currentDraft = db.getComposerDraft(conversation.id);
    const composerDraft = db.saveComposerDraft(conversation.id, currentDraft?.content ?? "", reference.excerpt, JSON.stringify(reference));
    return res.json({ conversation, agentSelection: conversationAgentSelection(conversation), composerDraft: composerDraftForClient(composerDraft, session.user_id), reference });
  });

  api.post("/conversations/:id/side-chat/reference", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const parent = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!parent || db.getSideConversationParent(parent.id, session.user_id)) return res.status(404).json({ error: "主会话不存在。" });
    if (parent.archived_at) return res.status(409).json({ error: "主会话已归档，请恢复后再引用。" });
    const sourceMessageId = typeof req.body?.sourceMessageId === "string" ? req.body.sourceMessageId : "";
    const excerpt = normalizeSourceExcerpt(req.body?.excerpt);
    if (!/^[0-9a-f-]{36}$/i.test(sourceMessageId) || !excerpt) return res.status(400).json({ error: "引用来源无效。" });
    const sourceMessage = db.getMessage(sourceMessageId);
    if (!sourceMessage || sourceMessage.conversation_id !== parent.id) return res.status(404).json({ error: "来源消息不存在。" });
    const reference = await sourceReferenceFor(parent, sourceMessage, excerpt, true);
    if (!reference) return res.status(409).json({ error: "这段内容尚未写入 Codex rollout JSONL，请等待当前任务完成后重试。", code: "source-jsonl-pending" });
    const draftContent = typeof req.body?.content === "string" ? req.body.content.slice(0, 100_000) : undefined;
    let conversation = db.getSideConversation(parent.id, session.user_id);
    if (!conversation) {
      const id = newId();
      const selection = conversationAgentSelection(parent);
      conversation = db.createSideConversation(parent, id, selection);
      db.setConversationPresetPrompts(conversation.id, session.user_id, db.getConversationPresetPromptIds(parent.id));
    }
    const currentDraft = db.getComposerDraft(conversation.id);
    const composerDraft = db.saveComposerDraft(conversation.id, draftContent ?? currentDraft?.content ?? "", excerpt, JSON.stringify(reference));
    return res.json({ conversation, agentSelection: conversationAgentSelection(conversation), composerDraft: composerDraftForClient(composerDraft, session.user_id), reference });
  });

  api.post("/conversations", (req, res) => {
    const session = res.locals.session as SessionRow;
    const id = newId();
    const rawWorkingDir = req.body?.workingDir;
    let workingDir: string | null = null;
    if (rawWorkingDir === undefined) {
      const storedDefault = requireHostWorkingTenant(session) ? db.getDefaultWorkingDir(session.user_id) : null;
      if (storedDefault) {
        try {
          workingDir = resolveHostWorkingDir(storedDefault, { dataRoot: config.dataRoot, tenantRoot: config.tenantRoot, workspaceRoot: config.workspaceRoot });
        } catch {
          workingDir = null;
        }
      }
    } else if (rawWorkingDir !== null && rawWorkingDir !== "") {
      if (!requireHostWorkingTenant(session)) {
        return res.status(403).json({ error: "自定义工作目录仅支持已映射系统账户的 host 模式。" });
      }
      try { workingDir = resolveSubmittedWorkingDir(rawWorkingDir); }
      catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "工作目录路径无效。" }); }
    }
    const agentSelection = userAgentSelection(session.user_id);
    const conversation = db.createConversation(id, "新任务", agentSelection, session.user_id, workingDir);
    db.applyDefaultPresetPrompts(conversation.id, session.user_id);
    res.status(201).json({ conversation, agentSelection });
  });

  api.put("/conversations/:id/working-dir", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.archived_at) return res.status(409).json({ error: "会话已归档，请恢复后再修改工作目录。" });
    if (
      conversation.status === "running"
      || db.listActiveJobsForConversation(conversation.id).length > 0
      || db.listPendingPrompts(conversation.id).length > 0
      || db.listPendingPrompts(conversation.id, "editing").length > 0
    ) {
      return res.status(409).json({ error: "会话仍有运行或待发送任务，请处理完成后再修改工作目录。" });
    }
    const raw = req.body?.workingDir;
    let workingDir: string | null = null;
    if (raw !== null && raw !== undefined && raw !== "") {
      if (!requireHostWorkingTenant(session)) {
        return res.status(403).json({ error: "自定义工作目录仅支持已映射系统账户的 host 模式。" });
      }
      try { workingDir = resolveSubmittedWorkingDir(raw); }
      catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "工作目录路径无效。" }); }
    }
    const workingDirBusy = Boolean(workingDir && db.listActiveJobsForWorkingDir(workingDir).length > 0);
    if (workingDirBusy && req.body?.confirm !== true) {
      return res.status(409).json({
        error: "该工作目录已有其他会话正在排队或运行任务。确认切换后，本会话将与这些任务在同一目录交替执行，可能互相影响文件状态。",
        code: "working-dir-busy",
      });
    }
    db.updateConversation(conversation.id, { workingDir });
    return res.json({ conversation: db.getConversationForUser(conversation.id, session.user_id) });
  });

  api.post("/conversations/:id/archive", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (db.getSideConversationParent(conversation.id, session.user_id)) return res.status(404).json({ error: "主会话不存在。" });
    if (conversation.archived_at) return res.json({ conversation });
    const family = [conversation, ...db.listSideConversations(session.user_id, conversation.id)];
    const hasWork = family.some((item) => item.status === "running"
      || db.listActiveJobsForConversation(item.id).length > 0
      || db.listPendingPrompts(item.id).length > 0
      || db.listPendingPrompts(item.id, "editing").length > 0);
    if (hasWork) return res.status(409).json({ error: "会话仍在运行或有待发送任务，请处理完成后再归档。" });
    const archived = db.archiveConversationForUser(conversation.id, session.user_id);
    return archived ? res.json({ conversation: archived }) : res.status(409).json({ error: "会话归档状态已经变化。" });
  });

  api.post("/conversations/:id/restore", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (db.getSideConversationParent(conversation.id, session.user_id)) return res.status(404).json({ error: "主会话不存在。" });
    if (!conversation.archived_at) return res.json({ conversation });
    if (config.hostMode && conversation.codex_thread_id && !conversation.working_dir) {
      try {
        const cwd = await readCodexThreadWorkingDir(codexHomeFor(session.user_id), conversation.codex_thread_id);
        const workingDir = normalizeImportedWorkingDir(cwd, (raw) =>
          resolveHostWorkingDir(raw, { dataRoot: config.dataRoot, tenantRoot: config.tenantRoot, workspaceRoot: config.workspaceRoot }));
        if (workingDir) db.updateConversation(conversation.id, { workingDir });
      } catch {
        // 推导失败（目录已删除或指向应用隔离目录）时保持原状态，任务落入独立工作区，不阻塞恢复。
      }
    }
    const restored = db.restoreConversationForUser(conversation.id, session.user_id);
    return restored ? res.json({ conversation: restored }) : res.status(409).json({ error: "会话归档状态已经变化。" });
  });

  api.get("/conversations/:id", (req, res) => {
    const session = res.locals.session as SessionRow;
    let conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const jobStartedAt = (jobId: string): string | null => {
      for (const event of db.listEvents(jobId)) {
        const payload = JSON.parse(event.payload) as Record<string, unknown>;
        if (payload.status === "running") return event.created_at;
      }
      return null;
    };
    const rolloutBytes = runner.conversationRolloutBytes(conversation.id);
    if (rolloutBytes !== conversation.rollout_bytes) {
      db.setConversationRolloutBytes(conversation.id, rolloutBytes);
      conversation = db.getConversationForUser(conversation.id, session.user_id)!;
    }
    const latestJob = db.getLatestJobForConversation(conversation.id) ?? null;
    const latestJobWithStartedAt = latestJob ? { ...latestJob, startedAt: jobStartedAt(latestJob.id) } : null;
    const jobEvents = latestJob
      ? db.listEvents(latestJob.id).map((event) => ({ seq: event.seq, type: event.event_type, created_at: event.created_at, ...JSON.parse(event.payload) }))
      : [];
    const messagePage = db.listMessagesPage(conversation.id, undefined, CONVERSATION_MESSAGE_PAGE_SIZE)!;
    const safeMessages = safeConversationMessages(conversation, messagePage.messages);
    const outputFiles = db.listFiles(conversation.id).filter((file) => file.kind === "output").map((file) => fileForClient(file, session.user_id));
    const agentSelection = conversationAgentSelection(conversation);
    const activeJob = latestJobWithStartedAt && ["queued", "running"].includes(latestJobWithStartedAt.status)
      ? { ...latestJobWithStartedAt, queuePosition: db.getQueuePosition(latestJobWithStartedAt.id) }
      : null;
    const pendingPrompts = db.listPendingPrompts(conversation.id).map((prompt) => pendingPromptForClient(prompt, session.user_id));
    const editingPromptRow = db.listPendingPrompts(conversation.id, "editing")[0] ?? null;
    const editingPrompt = editingPromptRow ? pendingPromptForClient(editingPromptRow, session.user_id) : null;
    const composerDraft = composerDraftForClient(db.getComposerDraft(conversation.id), session.user_id);
    return res.json({
      conversation,
      agentSelection,
      messages: safeMessages,
      outputFiles,
      messagePage: { hasMore: messagePage.hasMore, nextCursor: messagePage.nextCursor },
      pendingPrompts,
      editingPrompt,
      composerDraft,
      enabledPresetPromptIds: db.getConversationPresetPromptIds(conversation.id),
      activeJob,
      latestJob: latestJobWithStartedAt,
      jobEvents,
      rolloutBytes,
      contextUsage: conversation.context_used_tokens === null ? null : { usedTokens: conversation.context_used_tokens, contextWindow: conversation.context_window, updatedAt: conversation.context_updated_at },
    });
  });

  api.get("/conversations/:id/messages", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const before = typeof req.query.before === "string" ? req.query.before : "";
    if (!before) return res.status(400).json({ error: "缺少消息游标。" });
    const messagePage = db.listMessagesPage(conversation.id, before, CONVERSATION_MESSAGE_PAGE_SIZE);
    if (!messagePage) return res.status(400).json({ error: "消息游标无效。" });
    return res.json({
      messages: safeConversationMessages(conversation, messagePage.messages),
      messagePage: { hasMore: messagePage.hasMore, nextCursor: messagePage.nextCursor },
    });
  });

  api.get("/conversations/:id/file-tree", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const roots = fileTreeRootsFor(conversation);
    const rootId = typeof req.query.root === "string" ? req.query.root : "";
    if (!rootId) return res.json({ roots: roots.map(fileTreeRootForClient) });
    try {
      return res.json({
        roots: roots.map(fileTreeRootForClient),
        listing: listFileTreeDirectory(conversation, rootId, req.query.path),
      });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "无法读取文件目录。" });
    }
  });

  api.get("/conversations/:id/file-tree/preview", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const rootId = typeof req.query.root === "string" ? req.query.root : "";
    try {
      const target = fileTreeTargetFor(conversation, rootId, req.query.path);
      if (!target) return res.status(404).json({ error: "文件不存在或不可访问。" });
      if (!target.stat.isFile()) return res.status(400).json({ error: "不是文件，无法预览。" });
      if (!fileTreeEntryPreviewable(target.mimeType, target.stat.size)) return res.status(400).json({ error: "该文件格式暂不支持页内预览。" });
      if (target.stat.size > FILE_TREE_PREVIEW_MAX_BYTES) return res.status(413).json({ error: "文件过大，无法预览。" });
      const content = fs.readFileSync(target.absolute, "utf8");
      if (content.includes("\0")) return res.status(400).json({ error: "二进制文件无法预览。" });
      res.setHeader("Cache-Control", "private, no-store");
      return res.json({ mimeType: target.mimeType, content });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "文件读取失败。" });
    }
  });

  api.get("/conversations/:id/file-tree/file", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const rootId = typeof req.query.root === "string" ? req.query.root : "";
    try {
      const target = fileTreeTargetFor(conversation, rootId, req.query.path);
      if (!target) return res.status(404).json({ error: "文件不存在或不可访问。" });
      if (!target.stat.isFile()) return res.status(400).json({ error: "不是文件。" });
      const download = req.query.download === "1";
      const inline = !download && (target.mimeType.startsWith("image/") || target.mimeType === "application/pdf" || isTextPreviewMime(target.mimeType));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Type", target.mimeType);
      res.setHeader("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", path.basename(target.absolute)));
      return res.sendFile(path.basename(target.absolute), { root: path.dirname(target.absolute) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "文件读取失败。" });
    }
  });

  api.get("/conversations/:id/code-snippet", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const rawPath = typeof req.query.path === "string" ? req.query.path : "";
    const line = Number(req.query.line);
    const before = Number(req.query.before ?? 80);
    const after = Number(req.query.after ?? 80);
    const full = req.query.full === "1";
    if (!rawPath) return res.status(400).json({ error: "缺少文件路径。" });
    if (!Number.isInteger(line) || line < 1) return res.status(400).json({ error: "行号无效。" });
    if (!full && ![before, after].every((value) => Number.isInteger(value) && value >= 0 && value <= CODE_SNIPPET_MAX_WINDOW)) {
      return res.status(400).json({ error: "行窗口无效。" });
    }
    const target = snippetTargetFor(conversation, session.user_id, rawPath);
    if (!target) return res.status(404).json({ error: "文件不存在或不可访问。" });
    let stat: fs.Stats;
    try { stat = fs.statSync(target.absolute); } catch { return res.status(404).json({ error: "文件不存在。" }); }
    if (!stat.isFile()) return res.status(400).json({ error: "不是文件，无法预览。" });
    if (stat.size > CODE_SNIPPET_MAX_BYTES) return res.status(413).json({ error: "文件过大，无法预览。" });
    let content: string;
    try { content = fs.readFileSync(target.absolute, "utf8"); } catch { return res.status(500).json({ error: "文件读取失败。" }); }
    if (content.includes("\0")) return res.status(400).json({ error: "二进制文件无法预览。" });
    const lines = content.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const totalLines = lines.length;
    if (full) {
      return res.json({
        path: target.displayPath,
        originalName: target.originalName ?? path.basename(target.absolute),
        totalLines,
        start: 1,
        end: totalLines,
        line: 1,
        lines: [],
        content,
      });
    }
    const start = Math.max(1, line - before);
    const end = Math.min(totalLines, line + after);
    return res.json({
      path: target.displayPath,
      originalName: target.originalName ?? path.basename(target.absolute),
      totalLines,
      start,
      end,
      line,
      lines: lines.slice(start - 1, end).map((value) => value.replace(/\r$/, "")),
    });
  });

  api.patch("/conversations/:id", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 80) : "";
    if (!title) return res.status(400).json({ error: "标题不能为空。" });
    db.updateConversation(conversation.id, { title, titleSource: "manual" });
    return res.json({ conversation: db.getConversationForUser(conversation.id, session.user_id) });
  });

  api.post("/conversations/:id/seen", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.markConversationResultSeenForUser(String(req.params.id), session.user_id);
    return conversation ? res.json({ conversation }) : res.status(404).json({ error: "会话不存在。" });
  });

  api.put("/conversations/:id/agent-selection", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.archived_at) return res.status(409).json({ error: "会话已归档，请恢复后再修改。" });
    try { return res.json({ selection: saveAgentSelection(session.user_id, req.body?.model, req.body?.reasoningEffort, conversation, req.body?.provider, req.body?.sandbox) }); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "模型选项无效。" }); }
  });

  api.post("/conversations/:id/cancel", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    try {
      await stopConversationJobs(conversation.id);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : "停止任务失败。" });
    }
  });

  api.delete("/conversations/:id", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (db.getSideConversationParent(conversation.id, session.user_id)) return res.status(404).json({ error: "主会话不存在。" });
    const family = [...db.listSideConversations(session.user_id, conversation.id), conversation];
    if (family.some((item) => deletingConversations.has(item.id))) return res.status(409).json({ error: "会话正在删除。" });
    for (const item of family) deletingConversations.add(item.id);
    try {
      for (const item of family) {
        for (const prompt of [...db.listPendingPrompts(item.id), ...db.listPendingPrompts(item.id, "editing")]) {
          removePendingPromptFiles(prompt, session.user_id);
        }
        db.deletePendingPromptsForConversation(item.id);
      }
      // Remove drafts before awaiting cancellation. A running job finishes its
      // queue pump during cancellation, so leaving drafts here could promote one
      // into a real message/job while the conversation is being deleted.
      for (const item of family) await stopConversationJobs(item.id, false);
      const tenant = tenantPaths(config.tenantRoot, session.user_id);
      for (const item of family) {
        for (const file of db.listFiles(item.id)) removePersistedDeliverable(config.dataRoot, file.relative_path);
        if (item.codex_thread_id && !db.isCodexThreadUsedByAnotherActiveConversation(item.codex_thread_id, item.id)) {
          removeCodexThreadFiles(codexHomeFor(session.user_id), item.codex_thread_id);
        }
        removeWorkspace(tenant.conversations, item.id);
      }
      for (const item of family) db.softDeleteConversation(item.id);
      return res.status(204).end();
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : "删除失败。" });
    } finally {
      for (const item of family) deletingConversations.delete(item.id);
    }
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination(req, _file, callback) {
        try {
          const session = (req as AuthenticatedRequest).appSession;
          const conversationId = String(req.params.id);
          const conversation = session ? db.getConversationForUser(conversationId, session.user_id) : undefined;
          if (!session || deletingConversations.has(conversationId) || !conversation || conversation.archived_at) throw new Error("会话不存在或已归档");
          callback(null, path.join(workspaceFor(session.user_id, String(req.params.id)), "uploads"));
        } catch (error) { callback(error as Error, ""); }
      },
      filename(_req, file, callback) { callback(null, safeUploadName(file.originalname).diskName); },
    }),
    limits: { files: 12, fields: 4 },
  });

  api.put("/conversations/:id/draft", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.archived_at) return res.status(409).json({ error: "会话已归档，请恢复后再继续编辑。" });
    if (deletingConversations.has(conversation.id)) return res.status(409).json({ error: "会话正在删除。" });
    if (typeof req.body?.content !== "string") return res.status(400).json({ error: "草稿正文无效。" });
    const content = req.body.content.slice(0, 100_000);
    let quoteExcerpt = submittedQuoteExcerpt(req.body?.quoteExcerpt);
    const sourceReference = submittedSourceReference(req.body?.sourceReference);
    return res.json({ composerDraft: composerDraftForClient(db.saveComposerDraft(conversation.id, content, quoteExcerpt, sourceReference), session.user_id) });
  });

  api.post("/conversations/:id/draft/files", upload.array("files", 12), (req, res) => {
    const session = res.locals.session as SessionRow;
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) { removeUnregisteredUploads(uploaded); return res.status(404).json({ error: "会话不存在。" }); }
    if (conversation.archived_at) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "会话已归档，请恢复后再继续编辑。" }); }
    if (deletingConversations.has(conversation.id)) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "会话正在删除。" }); }
    if (uploaded.length === 0) return res.status(400).json({ error: "没有收到附件。" });
    const existing = db.getComposerDraft(conversation.id);
    if ((existing?.files.length ?? 0) + uploaded.length > 12) {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "单个会话草稿最多包含 12 个附件。" });
    }
    registerComposerUploads(conversation.id, storedUploads(uploaded));
    return res.status(201).json({ composerDraft: composerDraftForClient(db.getComposerDraft(conversation.id), session.user_id)! });
  });

  api.post("/conversations/:id/draft/files/from-host", (req, res) => {
    const session = res.locals.session as SessionRow;
    const host = requireHostWorkingTenant(session);
    if (!host) {
      return res.status(403).json({ error: "从宿主路径添加附件仅支持已映射系统账户的 host 模式。" });
    }
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    if (conversation.archived_at) return res.status(409).json({ error: "会话已归档，请恢复后再继续编辑。" });
    if (deletingConversations.has(conversation.id)) return res.status(409).json({ error: "会话正在删除。" });
    const rawPaths = Array.isArray(req.body?.paths) ? req.body.paths.filter((value: unknown): value is string => typeof value === "string") : [];
    if (rawPaths.length === 0) return res.status(400).json({ error: "没有选择文件。" });
    const existing = db.getComposerDraft(conversation.id);
    if ((existing?.files.length ?? 0) + rawPaths.length > 12) {
      return res.status(400).json({ error: "单个会话草稿最多包含 12 个附件。" });
    }
    const workspace = workspaceFor(session.user_id, conversation.id);
    const uploadsDir = path.join(workspace, "uploads");
    const registered: StoredUpload[] = [];
    const copied: string[] = [];
    try {
      for (const raw of rawPaths) {
        const source = resolveHostReadableFile(raw, {
          dataRoot: config.dataRoot,
          tenantRoot: config.tenantRoot,
          workspaceRoot: config.workspaceRoot,
          username: host.username,
        });
        const safe = safeUploadName(path.basename(source));
        const destination = path.join(uploadsDir, safe.diskName);
        fs.copyFileSync(source, destination);
        if (process.getuid?.() === 0) {
          try { fs.chownSync(destination, host.uid, host.gid); } catch { /* The web service can still manage draft cleanup as root. */ }
        }
        copied.push(destination);
        registered.push({
          originalName: safe.displayName,
          diskName: safe.diskName,
          mimeType: mimeTypeForPath(source),
          size: fs.statSync(destination).size,
        });
      }
    } catch (error) {
      for (const file of copied) {
        try { fs.rmSync(file, { force: true }); } catch {}
      }
      return res.status(400).json({ error: error instanceof Error ? error.message : "从宿主路径添加附件失败。" });
    }
    registerComposerUploads(conversation.id, registered);
    return res.status(201).json({ composerDraft: composerDraftForClient(db.getComposerDraft(conversation.id), session.user_id)! });
  });

  api.delete("/conversations/:id/draft/files/:fileId", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const file = db.getFileForUser(String(req.params.fileId), session.user_id);
    if (!file || file.conversation_id !== conversation.id || file.composer_draft_id !== conversation.id) {
      return res.status(404).json({ error: "草稿附件不存在。" });
    }
    const workspace = workspaceFor(session.user_id, conversation.id);
    try { fs.rmSync(resolveInside(workspace, file.relative_path), { force: true }); } catch {}
    db.removeFile(file.id);
    db.pruneEmptyComposerDraft(conversation.id);
    if (db.getComposerDraft(conversation.id)) db.touchComposerDraft(conversation.id);
    return res.json({ composerDraft: composerDraftForClient(db.getComposerDraft(conversation.id), session.user_id) });
  });

  api.delete("/conversations/:id/draft", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const draft = db.getComposerDraft(conversation.id);
    if (draft) {
      removeComposerDraftFiles(draft, session.user_id);
      db.deleteComposerDraft(conversation.id);
    }
    return res.status(204).end();
  });

  const voiceUpload = multer({
    storage: multer.diskStorage({
      destination: transcription.audioRoot,
      filename(_req, file, callback) {
        const mime = file.mimetype.toLowerCase().split(";", 1)[0];
        callback(null, `${crypto.randomUUID()}${AUDIO_MIME_EXTENSIONS[mime] ?? ""}`);
      },
    }),
    limits: { files: 1, fileSize: 15 * 1024 * 1024, fields: 3, fieldSize: 10 * 1024 },
    fileFilter(_req, file, callback) {
      const mime = file.mimetype.toLowerCase().split(";", 1)[0];
      callback(null, Boolean(AUDIO_MIME_EXTENSIONS[mime]));
    },
  });

  const transcriptionLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator(_req, res) { return String((res.locals.session as SessionRow).user_id); },
    message: { error: "语音识别请求过于频繁，请稍后再试。" },
  });

  api.post("/transcriptions", transcriptionLimiter, voiceUpload.single("audio"), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "没有收到可识别的录音，请重新录制。" });
    try {
      const session = res.locals.session as SessionRow;
      const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId.trim() : "";
      const conversation = conversationId ? db.getConversationForUser(conversationId, session.user_id) : undefined;
      if (conversationId && !conversation) return res.status(404).json({ error: "会话不存在。" });
      let attachmentNames: string[] = [];
      try {
        const parsed = JSON.parse(typeof req.body?.attachmentNames === "string" ? req.body.attachmentNames : "[]");
        if (Array.isArray(parsed)) attachmentNames = parsed.filter((value): value is string => typeof value === "string").slice(0, 12);
      } catch {}
      const recentMessages = conversation
        ? db.listMessages(conversation.id).slice(-4).map((message) => ({ role: message.role, content: message.content }))
        : [];
      const attachments = conversation ? (() => {
        const workspace = workspaceFor(session.user_id, conversation.id);
        const available = db.listFiles(conversation.id).filter((candidate) => candidate.kind === "upload").reverse();
        const used = new Set<string>();
        return attachmentNames.flatMap((name) => {
          const row = available.find((candidate) => !used.has(candidate.id) && candidate.original_name === name);
          if (!row) return [];
          used.add(row.id);
          try {
            const filePath = resolveInside(workspace, row.relative_path);
            if (!fs.existsSync(filePath)) return [];
            return [{ name: row.original_name, filePath, mimeType: row.mime_type, size: row.size }];
          } catch { return []; }
        });
      })() : [];
      const text = await transcription.transcribe(file.filename, {
        draftText: typeof req.body?.draftText === "string" ? req.body.draftText : "",
        attachmentNames,
        attachments,
        recentMessages,
      });
      return res.json({ text });
    } catch (error) {
      const status = error instanceof TranscriptionError ? error.status : 502;
      return res.status(status).json({ error: error instanceof Error ? error.message : "语音识别失败，请重试。" });
    } finally {
      try { fs.rmSync(file.path, { force: true }); } catch {}
    }
  });

  const codexUpdateMaintenanceFile = path.join(config.dataRoot, ".codex-update-maintenance");
  const rejectDuringCodexUpdate: express.RequestHandler = (_req, res, next) => {
    try {
      const ageMs = Date.now() - fs.statSync(codexUpdateMaintenanceFile).mtimeMs;
      if (ageMs >= 0 && ageMs < 60 * 60 * 1000) {
        return res.status(503).json({ error: "Codex 正在进行夜间更新，请稍后重新发送。" });
      }
    } catch {}
    next();
  };

  api.post("/conversations/:id/messages", rejectDuringCodexUpdate, upload.array("files", 12), async (req, res) => {
    const session = res.locals.session as SessionRow;
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) { removeUnregisteredUploads(uploaded); return res.status(404).json({ error: "会话不存在。" }); }
    if (config.hostMode) {
      const hostTenant = hostTenantFor(config, db, session.user_id);
      if (!hostTenant || !isCodexConfigured(hostTenant.codexHome, { uid: hostTenant.uid, gid: hostTenant.gid })) {
        removeUnregisteredUploads(uploaded);
        return res.status(409).json({
          error: hostTenant ? CODEX_CONFIG_HINT : "该用户没有对应的系统账户，无法运行 Codex 任务。请先由管理员添加系统用户。",
        });
      }
    }
    if (conversation.archived_at) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "会话已归档，请恢复后再继续发送。" }); }
    if (deletingConversations.has(conversation.id)) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "会话正在删除。" }); }
    const prompt = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 100_000) : "";
    let quoteExcerpt = submittedQuoteExcerpt(req.body?.quoteExcerpt);
    const useComposerDraft = req.body?.useComposerDraft === "true";
    if (useComposerDraft && uploaded.length > 0) {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "服务器草稿附件无需重复上传。" });
    }
    const composerDraft = useComposerDraft ? db.getComposerDraft(conversation.id) : undefined;
    const sourceReference = useComposerDraft ? composerDraft?.source_reference ?? null : submittedSourceReference(req.body?.sourceReference);
    if (useComposerDraft && sourceReference) {
      const parsedSource = parseStoredSourceReference(sourceReference);
      if (parsedSource) quoteExcerpt = parsedSource.excerpt;
    }
    const attachmentCount = uploaded.length + (composerDraft?.files.length ?? 0);
    if (!prompt && !quoteExcerpt && attachmentCount === 0) return res.status(400).json({ error: "请输入内容、添加引用或上传文件。" });
    const selection = conversationAgentSelection(conversation);
    const editingPrompt = db.listPendingPrompts(conversation.id, "editing")[0];

    if (useComposerDraft && editingPrompt) return res.status(409).json({ error: "请先完成或取消正在编辑的待发送任务。" });

    if (!prompt && !quoteExcerpt) {
      if (useComposerDraft) {
        const awaiting = db.materializeComposerDraftAsPending(newId(), conversation.id, "", selection, null, null, "editing");
        return res.status(202).json({ pendingPrompt: awaiting ? pendingPromptForClient(awaiting, session.user_id) : null, editingPrompt: awaiting ? pendingPromptForClient(awaiting, session.user_id) : null, queued: false, needsInstruction: true, guidance: FILE_INSTRUCTION_GUIDANCE });
      }
      if (editingPrompt?.content.trim() || editingPrompt?.quote_excerpt) {
        removeUnregisteredUploads(uploaded);
        return res.status(409).json({ error: "请先完成或取消正在编辑的待发送任务。" });
      }
      if (editingPrompt && editingPrompt.files.length + uploaded.length > 12) {
        removeUnregisteredUploads(uploaded);
        return res.status(400).json({ error: "等待指令的附件最多保留 12 个。" });
      }
      const awaiting = editingPrompt ?? db.createPendingPrompt(newId(), conversation.id, "", selection);
      if (!editingPrompt) db.beginEditingPendingPrompt(awaiting.id);
      registerPendingUploads(conversation.id, awaiting.id, storedUploads(uploaded));
      const persisted = db.updateEditingPendingPrompt(awaiting.id, "", selection);
      return res.status(202).json({ pendingPrompt: persisted ? pendingPromptForClient(persisted, session.user_id) : null, editingPrompt: persisted ? pendingPromptForClient(persisted, session.user_id) : null, queued: false, needsInstruction: true, guidance: FILE_INSTRUCTION_GUIDANCE });
    }

    if (editingPrompt) {
      if (editingPrompt.content.trim() || editingPrompt.quote_excerpt) {
        removeUnregisteredUploads(uploaded);
        return res.status(409).json({ error: "请先完成或取消正在编辑的待发送任务。" });
      }
      if (editingPrompt.files.length + uploaded.length > 12) {
        removeUnregisteredUploads(uploaded);
        return res.status(400).json({ error: "单条任务最多包含 12 个附件。" });
      }
      registerPendingUploads(conversation.id, editingPrompt.id, storedUploads(uploaded));
      const updated = db.updatePendingPrompt(editingPrompt.id, prompt, selection, quoteExcerpt, sourceReference);
      if (!updated) return res.status(409).json({ error: "等待指令的文件状态已经变化，请刷新后重试。" });
      if (config.queueAutoStart) await pumpQueue();
      const stored = db.getPendingPrompt(updated.id);
      return res.status(202).json({ pendingPrompt: stored ? pendingPromptForClient(stored, session.user_id) : null, queued: true });
    }

    if (db.listActiveJobsForConversation(conversation.id).length > 0 || db.listPendingPrompts(conversation.id).length > 0) {
      if (useComposerDraft) {
        const pendingPrompt = db.materializeComposerDraftAsPending(newId(), conversation.id, prompt, selection, quoteExcerpt, sourceReference);
        return res.status(202).json({ pendingPrompt: pendingPromptForClient(pendingPrompt, session.user_id), queued: true });
      }
      const pendingPrompt = db.createPendingPrompt(newId(), conversation.id, prompt, selection, quoteExcerpt, sourceReference);
      registerPendingUploads(conversation.id, pendingPrompt.id, storedUploads(uploaded));
      const stored = db.getPendingPrompt(pendingPrompt.id);
      return res.status(202).json({ pendingPrompt: stored ? pendingPromptForClient(stored, session.user_id) : null, queued: true });
    }

    const messageId = newId();
    const createdAt = new Date().toISOString();
    if (useComposerDraft) {
      const job = db.materializeComposerDraftAsJob(messageId, newId(), conversation.id, prompt, selection, quoteExcerpt, sourceReference);
      const queuePosition = db.getQueuePosition(job.id) ?? 1;
      publishQueuePositions();
      res.status(202).json({ job: { ...job, queuePosition }, message: { id: messageId }, queued: true });
      if (config.queueAutoStart) setImmediate(() => void pumpQueue());
      return;
    }
    db.addMessage({ id: messageId, conversation_id: conversation.id, role: "user", content: prompt, quote_excerpt: quoteExcerpt, source_reference: sourceReference, created_at: createdAt });
    const fileRows = uploaded.map((file) => {
      const row = {
        id: newId(), conversation_id: conversation.id, message_id: messageId, pending_prompt_id: null,
        original_name: safeUploadName(file.originalname).displayName,
        relative_path: path.posix.join("uploads", file.filename), mime_type: file.mimetype || "application/octet-stream",
        size: file.size, kind: "upload" as const, created_at: createdAt,
      };
      db.addFile(row);
      return row;
    });
    const job = db.createJob(newId(), conversation.id, messageId, selection);
    const queuePosition = db.getQueuePosition(job.id) ?? 1;
    publishQueuePositions();
    res.status(202).json({ job: { ...job, queuePosition }, message: { id: messageId } });
    if (config.queueAutoStart) setImmediate(() => void pumpQueue());
  });

  api.put("/conversations/:id/messages/:messageId", rejectDuringCodexUpdate, upload.array("files", 12), async (req, res) => {
    const session = res.locals.session as SessionRow;
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) { removeUnregisteredUploads(uploaded); return res.status(404).json({ error: "会话不存在。" }); }
    if (config.hostMode) {
      const hostTenant = hostTenantFor(config, db, session.user_id);
      if (!hostTenant || !isCodexConfigured(hostTenant.codexHome, { uid: hostTenant.uid, gid: hostTenant.gid })) {
        removeUnregisteredUploads(uploaded);
        return res.status(409).json({
          error: hostTenant ? CODEX_CONFIG_HINT : "该用户没有对应的系统账户，无法运行 Codex 任务。请先由管理员添加系统用户。",
        });
      }
    }
    if (conversation.archived_at) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "会话已归档，请恢复后再继续发送。" }); }
    if (deletingConversations.has(conversation.id)) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "会话正在删除。" }); }
    if (db.listActiveJobsForConversation(conversation.id).length > 0 || db.listPendingPrompts(conversation.id).length > 0) {
      removeUnregisteredUploads(uploaded);
      return res.status(409).json({ error: "当前会话仍有运行中或待发送任务，请完成后再编辑历史消息。" });
    }
    const sourceMessage = db.getMessageForUser(String(req.params.messageId), session.user_id);
    if (!sourceMessage || sourceMessage.conversation_id !== conversation.id) {
      removeUnregisteredUploads(uploaded);
      return res.status(404).json({ error: "消息不存在。" });
    }
    if (sourceMessage.role !== "user") {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "只能编辑用户消息。" });
    }
    const forkBeforeTurnId = sourceMessage.codex_turn_id;
    if (sourceMessage.superseded_at || !forkBeforeTurnId || !conversation.codex_thread_id) {
      removeUnregisteredUploads(uploaded);
      return res.status(409).json({ error: "这条消息没有可用的 Codex 线程分叉点，无法编辑重发。" });
    }
    const prompt = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 100_000) : "";
    const quoteExcerpt = submittedQuoteExcerpt(req.body?.quoteExcerpt);
    const sourceReference = req.body?.sourceReference === undefined
      ? sourceMessage.source_reference ?? null
      : submittedSourceReference(req.body.sourceReference);
    let removedFileIds: string[] = [];
    try {
      const raw = typeof req.body?.removedFileIds === "string" ? JSON.parse(req.body.removedFileIds) : req.body?.removedFileIds;
      if (raw !== undefined && !Array.isArray(raw)) throw new Error("not-array");
      removedFileIds = (Array.isArray(raw) ? raw : []).filter((id): id is string => typeof id === "string");
    } catch {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "待移除文件列表无效。" });
    }
    const sourceFiles = db.listFilesForMessage(sourceMessage.id).filter((file) => file.kind === "upload");
    const sourceFileIds = new Set(sourceFiles.map((file) => file.id));
    const removedFileIdSet = new Set(removedFileIds);
    if (removedFileIds.some((fileId) => !sourceFileIds.has(fileId))) {
      removeUnregisteredUploads(uploaded);
      return res.status(409).json({ error: "编辑消息的附件状态已经变化，请刷新后重试。" });
    }
    const retainedCount = sourceFiles.filter((file) => !removedFileIdSet.has(file.id)).length;
    if (retainedCount + uploaded.length > 12) {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "单条任务最多包含 12 个附件。" });
    }
    if (!prompt && !quoteExcerpt && retainedCount === 0 && uploaded.length === 0) {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "请至少保留一个文件，或者输入具体操作。" });
    }
    const messageId = newId();
    const createdAt = new Date().toISOString();
    const uploadedFiles: FileRow[] = uploaded.map((file) => ({
      id: newId(), conversation_id: conversation.id, message_id: messageId, pending_prompt_id: null, composer_draft_id: null,
      original_name: safeUploadName(file.originalname).displayName,
      relative_path: path.posix.join("uploads", file.filename), mime_type: normalizeUploadMime(file),
      size: file.size, kind: "upload", created_at: createdAt,
    }));
    try {
      const result = db.createEditedMessageJob({
        sourceMessageId: sourceMessage.id,
        messageId,
        jobId: newId(),
        conversationId: conversation.id,
        content: prompt,
        quoteExcerpt,
        sourceReference,
        forkBeforeTurnId,
        selection: conversationAgentSelection(conversation),
        retainedFileIds: sourceFiles.filter((file) => !removedFileIdSet.has(file.id)).map((file) => file.id),
        uploadedFiles,
      });
      if (!result) {
        removeUnregisteredUploads(uploaded);
        return res.status(409).json({ error: "消息分支已经变化，请刷新后重试。" });
      }
      const queuePosition = db.getQueuePosition(result.job.id) ?? 1;
      publishQueuePositions();
      res.status(202).json({ job: { ...result.job, queuePosition }, message: { id: result.message.id }, queued: true });
      if (config.queueAutoStart) setImmediate(() => void pumpQueue());
    } catch (error) {
      removeUnregisteredUploads(uploaded);
      return res.status(409).json({ error: error instanceof Error ? error.message : "编辑消息失败。" });
    }
  });

  api.put("/conversations/:id/pending-prompts/order", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === "string") : [];
    try { return res.json({ pendingPrompts: db.reorderPendingPrompts(conversation.id, ids) }); }
    catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : "调整顺序失败。" }); }
  });

  api.post("/conversations/:id/pending-prompts/:promptId/edit", (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const prompt = db.getPendingPromptForUser(String(req.params.promptId), session.user_id);
    if (!prompt || prompt.conversation_id !== conversation.id) return res.status(404).json({ error: "待发送任务不存在。" });
    if (db.listPendingPrompts(conversation.id, "editing").length > 0) return res.status(409).json({ error: "请先完成或取消正在编辑的待发送任务。" });
    const editingPrompt = db.beginEditingPendingPrompt(prompt.id);
    return editingPrompt ? res.json({ editingPrompt }) : res.status(409).json({ error: "待发送队列已经变化，请刷新后重试。" });
  });

  api.post("/conversations/:id/pending-prompts/:promptId/restore", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const prompt = db.getPendingPromptForUser(String(req.params.promptId), session.user_id);
    if (!prompt || prompt.conversation_id !== conversation.id) return res.status(404).json({ error: "待发送任务不存在。" });
    if (!prompt.content.trim() && !prompt.quote_excerpt) return res.status(409).json({ error: "请先输入具体操作，或者清除这批待处理文件。" });
    const restored = db.restorePendingPrompt(prompt.id);
    if (!restored) return res.status(409).json({ error: "该任务当前不在编辑状态。" });
    if (config.queueAutoStart) await pumpQueue();
    const stored = db.getPendingPrompt(prompt.id);
    return res.json({ pendingPrompt: stored ? pendingPromptForClient(stored, session.user_id) : null, activeJob: db.getActiveJobForConversation(conversation.id) ?? null });
  });

  api.put("/conversations/:id/pending-prompts/:promptId", rejectDuringCodexUpdate, upload.array("files", 12), async (req, res) => {
    const session = res.locals.session as SessionRow;
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) { removeUnregisteredUploads(uploaded); return res.status(404).json({ error: "会话不存在。" }); }
    const pending = db.getPendingPromptForUser(String(req.params.promptId), session.user_id);
    if (!pending || pending.conversation_id !== conversation.id) { removeUnregisteredUploads(uploaded); return res.status(404).json({ error: "待发送任务不存在。" }); }
    if (pending.status !== "editing") { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "请先点击编辑。" }); }
    const prompt = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 100_000) : "";
    const quoteExcerpt = submittedQuoteExcerpt(req.body?.quoteExcerpt);
    const sourceReference = req.body?.sourceReference === undefined ? pending.source_reference : submittedSourceReference(req.body.sourceReference);
    let removedFileIds: string[] = [];
    try {
      const raw = typeof req.body?.removedFileIds === "string" ? JSON.parse(req.body.removedFileIds) : [];
      if (Array.isArray(raw)) removedFileIds = raw.filter((id): id is string => typeof id === "string");
    } catch { removeUnregisteredUploads(uploaded); return res.status(400).json({ error: "待移除文件列表无效。" }); }
    const removed = pending.files.filter((file) => removedFileIds.includes(file.id));
    const retainedCount = pending.files.length - removed.length;
    if (retainedCount + uploaded.length > 12) {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "单条任务最多包含 12 个附件。" });
    }
    if (!prompt && !quoteExcerpt && retainedCount === 0 && uploaded.length === 0) {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "请至少保留一个文件，或者输入具体操作。" });
    }
    const workspace = workspaceFor(session.user_id, conversation.id);
    for (const file of removed) {
      try { fs.rmSync(resolveInside(workspace, file.relative_path), { force: true }); } catch {}
      db.removeFile(file.id);
    }
    registerPendingUploads(conversation.id, pending.id, storedUploads(uploaded));
    const selection = conversationAgentSelection(conversation);
    const updated = prompt || quoteExcerpt
      ? db.updatePendingPrompt(pending.id, prompt, selection, quoteExcerpt, sourceReference)
      : db.updateEditingPendingPrompt(pending.id, "", selection, null, sourceReference);
    if (!updated) return res.status(409).json({ error: "待发送队列已经变化，请刷新后重试。" });
    if (!prompt && !quoteExcerpt) {
      const stored = db.getPendingPrompt(pending.id);
      return res.status(202).json({ pendingPrompt: stored ? pendingPromptForClient(stored, session.user_id) : null, activeJob: db.getActiveJobForConversation(conversation.id) ?? null, needsInstruction: true, guidance: FILE_INSTRUCTION_GUIDANCE });
    }
    if (config.queueAutoStart) await pumpQueue();
    const stored = db.getPendingPrompt(pending.id);
    return res.json({ pendingPrompt: stored ? pendingPromptForClient(stored, session.user_id) : null, activeJob: db.getActiveJobForConversation(conversation.id) ?? null });
  });

  api.delete("/conversations/:id/pending-prompts/:promptId", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const pending = db.getPendingPromptForUser(String(req.params.promptId), session.user_id);
    if (!pending || pending.conversation_id !== conversation.id) return res.status(404).json({ error: "待发送任务不存在。" });
    removePendingPromptFiles(pending, session.user_id);
    db.deletePendingPrompt(pending.id);
    if (config.queueAutoStart) await pumpQueue();
    return res.status(204).end();
  });

  api.post("/conversations/:id/pending-prompts/:promptId/steer", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
    const pending = db.getPendingPromptForUser(String(req.params.promptId), session.user_id);
    if (!pending || pending.conversation_id !== conversation.id || pending.status !== "queued") return res.status(404).json({ error: "待发送任务不存在。" });
    const running = db.listActiveJobsForConversation(conversation.id).find((job) => job.status === "running");
    if (!running) return res.status(409).json({ error: "当前任务尚未进入可引导状态。" });
    try {
      const turnId = await runner.steer(running.id, agentPrompt(pending.content, pending.quote_excerpt, pending.source_reference), pending.files);
      const message = db.materializeSteeredPrompt(pending.id, newId(), turnId);
      if (!message) throw new Error("引导已送达，但本地记录队列发生变化，请刷新确认。 ");
      return res.json({ ok: true, turnId, message });
    } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : "引导失败。" });
    }
  });

  api.get("/jobs/:id/events", (req, res) => {
    const session = res.locals.session as SessionRow;
    const job = db.getJobForUser(String(req.params.id), session.user_id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Content-Encoding", "identity");
    res.flushHeaders();
    const after = Number(req.get("last-event-id") ?? req.query.after ?? 0) || 0;
    let lastSent = after;
    res.write("retry: 2000\n\n");
    for (const event of db.listEvents(job.id, after)) {
      writeSse(res, event.seq, event.event_type, { created_at: event.created_at, ...JSON.parse(event.payload) });
      lastSent = event.seq;
    }
    const terminalStatuses = ["completed", "failed", "cancelled", "interrupted"];
    if (terminalStatuses.includes(db.getJob(job.id)?.status ?? "interrupted")) return res.end();
    const set = subscribers.get(job.id) ?? new Set<Response>();
    set.add(res);
    subscribers.set(job.id, set);
    const checkedJob = db.getJob(job.id);
    if (!checkedJob || terminalStatuses.includes(checkedJob.status)) {
      for (const event of db.listEvents(job.id, lastSent)) writeSse(res, event.seq, event.event_type, { created_at: event.created_at, ...JSON.parse(event.payload) });
      set.delete(res);
      if (set.size === 0) subscribers.delete(job.id);
      return res.end();
    }
    const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      set.delete(res);
      if (set.size === 0) subscribers.delete(job.id);
    });
  });

  api.post("/jobs/:id/skip-queue", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const job = db.getJobForUser(String(req.params.id), session.user_id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    if (shuttingDown) return res.status(503).json({ error: "服务正在停止，无法启动新任务。" });
    if (job.status !== "queued" || !db.markJobSkipQueue(job.id)) {
      return res.status(409).json({ error: "任务已经不在排队状态。" });
    }
    publishQueuePositions();
    const started = db.startJobImmediately(job.id);
    if (!started) {
      // The queue pump may have already promoted this job; the client refresh
      // will observe the running state either way.
      return res.json({ ok: true, job: db.getJob(job.id) });
    }
    void runQueuedJob(started);
    return res.json({ ok: true, job: { ...started, queuePosition: 0 } });
  });

  api.post("/jobs/:id/cancel", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const job = db.getJobForUser(String(req.params.id), session.user_id);
    if (!job) return res.status(404).json({ error: "任务不存在。" });
    if (job.status === "queued" && db.cancelQueuedJob(job.id)) {
      publish(job.id, "done", { status: "cancelled", message: "任务已停止" });
      publishQueuePositions();
      if (config.queueAutoStart) setImmediate(() => void pumpQueue());
      return res.json({ ok: true });
    }
    if (job.status !== "running" || !runner.cancel(job.id)) return res.status(409).json({ error: "任务已经结束。" });
    const deadline = Date.now() + 15_000;
    while (db.getJob(job.id)?.status === "running") {
      if (Date.now() >= deadline) return res.status(503).json({ error: "任务未能在限定时间内停止，请稍后重试。" });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    recordUserCancelledJob(job);
    return res.json({ ok: true });
  });

  api.get("/files/:id", (req, res) => {
    const session = res.locals.session as SessionRow;
    const file = db.getFileForUser(String(req.params.id), session.user_id);
    if (!file) return res.status(404).json({ error: "文件不存在。" });
    const storageRoot = fileStorageRoot(file, session.user_id);
    let absolute: string;
    try { absolute = resolveInside(storageRoot, file.relative_path); }
    catch { return res.status(400).json({ error: "文件路径无效。" }); }
    if (!fs.existsSync(absolute)) return res.status(404).json({ error: "文件已不存在。" });
    const inline = req.query.download !== "1" && (file.mime_type.startsWith("image/") || file.mime_type === "application/pdf" || isTextPreviewMime(file.mime_type));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", file.mime_type);
    res.setHeader("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", file.original_name));
    return res.sendFile(path.basename(absolute), { root: path.dirname(absolute) });
  });

  api.post("/files/:id/share", (req, res) => {
    const session = res.locals.session as SessionRow;
    const file = db.getFileForUser(String(req.params.id), session.user_id);
    if (!file || file.kind !== "output") return res.status(404).json({ error: "文件不存在。" });
    if (!isSharePreviewable(file)) return res.status(400).json({ error: "该文件类型不支持分享预览。" });
    if (!fileAbsolutePath(file, session.user_id)) return res.status(404).json({ error: "文件已不存在。" });
    const expires = Math.floor(Date.now() / 1000) + SHARE_LIFETIME_SECONDS;
    const token = createShareToken(config.sessionSecret, file.id, expires);
    return res.json({
      url: `${config.basePath.replace(/\/$/, "")}/share/${token}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    });
  });

  router.use("/api", api);
  const SHARE_TEXT_LIMIT_BYTES = 2 * 1024 * 1024;
  function shareBytesLabel(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }
  router.get("/share/:token", (req, res) => {
    const parsed = parseShareToken(config.sessionSecret, String(req.params.token ?? ""));
    const file = parsed ? db.getFile(parsed.fileId) : undefined;
    const conversation = file ? db.getConversation(file.conversation_id) : undefined;
    const absolute = file && conversation ? fileAbsolutePath(file, conversation.user_id) : null;
    if (!parsed || !file || file.kind !== "output" || !isSharePreviewable(file) || !absolute) {
      return res.status(404).type("text/plain; charset=utf-8").send("分享链接无效或已过期。");
    }
    const stat = fs.statSync(absolute);
    const contentUrl = `${config.basePath.replace(/\/$/, "")}/share/${req.params.token}/content`;
    const downloadUrl = `${config.basePath.replace(/\/$/, "")}/share/${req.params.token}/download`;
    const image = file.mime_type.startsWith("image/");
    const pdf = file.mime_type === "application/pdf";
    const markdown = file.mime_type === "text/markdown";
    let body: string;
    if (image) {
      body = `<img class="media" src="${escapeHtml(contentUrl)}" alt="${escapeHtml(file.original_name)}">`;
    } else if (pdf) {
      body = `<iframe class="media" src="${escapeHtml(contentUrl)}" title="${escapeHtml(file.original_name)}"></iframe>`;
    } else {
      const buffer = Buffer.alloc(Math.min(stat.size, SHARE_TEXT_LIMIT_BYTES));
      const fd = fs.openSync(absolute, "r");
      let bytesRead = 0;
      try {
        bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      const content = buffer.subarray(0, bytesRead).toString("utf8");
      const truncated = bytesRead < stat.size;
      if (content.includes("\0")) {
        body = `<p class="notice">文件包含二进制数据，无法以文本方式预览。</p>`;
      } else if (markdown) {
        body = `<div class="markdown">${renderShareMarkdown(content)}</div>${truncated ? `<p class="notice">文件较大，分享页仅展示前 ${shareBytesLabel(SHARE_TEXT_LIMIT_BYTES)}。</p>` : ""}`;
      } else {
        body = `<pre class="text">${escapeHtml(content)}</pre>${truncated ? `<p class="notice">文件较大，分享页仅展示前 ${shareBytesLabel(SHARE_TEXT_LIMIT_BYTES)}。</p>` : ""}`;
      }
    }
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>分享预览 · ${escapeHtml(file.original_name)}</title>
<style>
  body { margin: 0; color: #1f2333; background: #f4f5f9; font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 22px; border-bottom: 1px solid #e0e3ec; background: #fff; }
  header h1 { margin: 0; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .header-right { display: flex; align-items: center; gap: 12px; flex: 0 0 auto; }
  .header-right small { color: #7b7f8e; font-size: 11px; }
  .header-right a { display: inline-flex; align-items: center; padding: 6px 12px; border: 1px solid #d6d9e3; border-radius: 8px; color: #1f2333; background: #fff; font-size: 12px; font-weight: 600; text-decoration: none; }
  .header-right a:hover { background: #f0f2f8; }
  main { padding: 18px 22px 32px; }
  .media { display: block; max-width: 100%; max-height: calc(100vh - 120px); margin: 0 auto; border: 0; border-radius: 10px; background: #fff; box-shadow: 0 10px 28px rgba(15, 17, 32, .08); }
  iframe.media { width: 100%; height: calc(100vh - 130px); }
  pre.text { margin: 0; padding: 18px; border: 1px solid #e0e3ec; border-radius: 10px; background: #fff; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
  .markdown { max-width: 900px; margin: 0 auto; padding: 20px 22px; border: 1px solid #e0e3ec; border-radius: 10px; background: #fff; line-height: 1.72; overflow-wrap: anywhere; }
  .markdown > :first-child { margin-top: 0; }
  .markdown > :last-child { margin-bottom: 0; }
  .markdown a { color: #334a98; font-weight: 650; text-decoration-color: rgba(51, 74, 152, .35); text-underline-offset: 2px; }
  .markdown ul, .markdown ol { padding-inline-start: 1.5em; }
  .markdown li + li { margin-top: .25em; }
  .markdown blockquote { margin-inline: 0; padding: .0625em 0 .0625em .8125em; border-left: 3px solid #c5cae2; color: #4b5063; }
  .markdown pre { overflow-x: auto; padding: .875em; border: 1px solid #e3e5ed; border-radius: .625em; color: #e9ebf4; background: #171b32; }
  .markdown code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
  .markdown :not(pre) > code { padding: .125em .3125em; border-radius: .3125em; color: #29356f; background: #eef0fa; }
  .markdown table { width: 100%; border-collapse: collapse; }
  .markdown th, .markdown td { padding: .5em; border: 1px solid #dfe2ec; text-align: left; }
  .markdown th { color: #29356f; background: #eef0fa; }
  .markdown hr { border: 0; border-top: 1px solid #e0e3ec; }
  .notice { padding: 16px; border: 1px solid #ead7b7; border-radius: 10px; color: #704b18; background: #fff4df; font-size: 13px; }
</style>
</head>
<body>
<header><h1>分享预览 · ${escapeHtml(file.original_name)}</h1><span class="header-right"><small>${shareBytesLabel(stat.size)} · 7 天内有效</small><a href="${escapeHtml(downloadUrl)}">下载</a></span></header>
<main>${body}</main>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(html);
  });
  router.get("/share/:token/content", (req, res) => {
    const parsed = parseShareToken(config.sessionSecret, String(req.params.token ?? ""));
    const file = parsed ? db.getFile(parsed.fileId) : undefined;
    const conversation = file ? db.getConversation(file.conversation_id) : undefined;
    const absolute = file && conversation ? fileAbsolutePath(file, conversation.user_id) : null;
    const media = file && (file.mime_type.startsWith("image/") || file.mime_type === "application/pdf");
    if (!parsed || !file || file.kind !== "output" || !media || !absolute) {
      return res.status(404).type("text/plain; charset=utf-8").send("分享链接无效或已过期。");
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", file.mime_type);
    res.setHeader("Content-Disposition", contentDisposition("inline", file.original_name));
    return res.sendFile(path.basename(absolute), { root: path.dirname(absolute) });
  });
  router.get("/share/:token/download", (req, res) => {
    const parsed = parseShareToken(config.sessionSecret, String(req.params.token ?? ""));
    const file = parsed ? db.getFile(parsed.fileId) : undefined;
    const conversation = file ? db.getConversation(file.conversation_id) : undefined;
    const absolute = file && conversation ? fileAbsolutePath(file, conversation.user_id) : null;
    if (!parsed || !file || file.kind !== "output" || !isSharePreviewable(file) || !absolute) {
      return res.status(404).type("text/plain; charset=utf-8").send("分享链接无效或已过期。");
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", file.mime_type);
    res.setHeader("Content-Disposition", contentDisposition("attachment", file.original_name));
    return res.sendFile(path.basename(absolute), { root: path.dirname(absolute) });
  });
  const distPath = path.join(config.projectRoot, "dist");
  const distIndexPath = path.join(distPath, "index.html");
  if (fs.existsSync(distPath)) router.use(express.static(distPath, { index: false, maxAge: "1h" }));
  router.use((req, res, next) => {
    if (req.method !== "GET" || !req.accepts("html")) return next();
    if (!fs.existsSync(distIndexPath)) {
      logger.warn({ url: req.originalUrl }, "frontend bundle missing; serving maintenance page");
      return res.status(503).type("html").send(FRONTEND_NOT_BUILT_HTML);
    }
    return res.sendFile("index.html", { root: distPath });
  });
  app.get(config.basePath, (_req, res) => res.redirect(308, `${config.basePath}/`));
  app.use(config.basePath || "/", router);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof multer.MulterError) return res.status(413).json({ error: "上传失败，请检查单次选择的文件数量。" });
    const message = error instanceof Error ? error.message : "服务器发生错误。";
    return res.status(500).json({ error: message });
  });

  if (config.queueAutoStart) setImmediate(() => void pumpQueue());
  return {
    app, db, runner, config, logger, pumpQueue,
    beginShutdown: () => { shuttingDown = true; },
  };
}

export function migrateExistingOutputFiles(config: AppConfig, db: AppDatabase): number {
  let migrated = 0;
  for (const file of db.listFiles()) {
    if (file.kind !== "output" || isPersistedDeliverablePath(file.relative_path)) continue;
    const conversation = db.getConversation(file.conversation_id);
    if (!conversation) continue;
    const workspace = ensureTenantWorkspace(config.tenantRoot, conversation.user_id, file.conversation_id, config.hostMode);
    if (config.hostMode) {
      const host = hostTenantFor(config, db, conversation.user_id);
      if (host) chownTenantStorageIfNeeded(workspace, host.uid, host.gid);
    }
    let source: string;
    try { source = resolveInside(workspace, file.relative_path); }
    catch { continue; }
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    const storedPath = persistDeliverableSync(config.dataRoot, workspace, file.relative_path, file.id);
    db.updateFilePath(file.id, storedPath);
    migrated += 1;
  }
  return migrated;
}

function normalizeUploadMime(file: Express.Multer.File): string {
  const reported = file.mimetype || "application/octet-stream";
  const byExtension = MIME_BY_EXTENSION[path.extname(file.originalname).toLowerCase()];
  if (!byExtension || (reported !== "application/octet-stream" && reported !== "text/plain")) return reported;
  return byExtension;
}

export function migrateUploadFileMimes(db: AppDatabase): number {
  let migrated = 0;
  for (const file of db.listFiles()) {
    if (file.kind !== "upload") continue;
    const expected = MIME_BY_EXTENSION[path.extname(file.original_name).toLowerCase()];
    if (!expected || file.mime_type === expected) continue;
    if (file.mime_type !== "application/octet-stream" && file.mime_type !== "text/plain") continue;
    db.updateFileMime(file.id, expected);
    migrated += 1;
  }
  return migrated;
}

function hashToken(token: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

function readSession(req: Request, db: AppDatabase, config: AppConfig): SessionRow | undefined {
  const token = req.cookies?.[COOKIE_NAME];
  if (typeof token !== "string" || !token) return undefined;
  return db.getSession(hashToken(token, config.sessionSecret));
}

function writeSse(res: Response, seq: number, eventType: string, payload: unknown): void {
  res.write(`id: ${seq}\ndata: ${JSON.stringify({ type: eventType, ...(payload && typeof payload === "object" ? payload : { payload }) })}\n\n`);
}

function contentDisposition(disposition: "inline" | "attachment", originalName: string): string {
  const extension = path.extname(originalName).replace(/[^.a-z0-9]/gi, "").slice(0, 16);
  const sourceStem = path.basename(originalName, path.extname(originalName)).normalize("NFKD");
  const asciiStem = sourceStem.replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "_").replace(/[^a-z0-9._ -]/gi, "_").trim().slice(0, 80);
  const fallback = `${asciiStem || "download"}${extension}`;
  const encoded = encodeURIComponent(originalName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
