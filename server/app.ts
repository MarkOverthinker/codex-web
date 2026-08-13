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
import { loadConfig, type AppConfig } from "./config.js";
import { CodexRunner, extractLeakedAutoTitleAnswer } from "./codex-runner.js";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import { ASK_AGENT_SELECTION_MAX_CHARS, buildAskAgentDraft, normalizeAskAgentSelection } from "../src/ask-agent-selection.js";
import { CHAT_FONT_SIZE_DEFAULT, normalizeChatFontSize } from "../src/chat-font-size.js";
import { CHAT_COLUMN_WIDTH_DEFAULT, normalizeChatColumnWidth } from "../src/chat-column-width.js";
import { AppDatabase, type ComposerDraftWithFiles, type ConversationRow, type FileRow, type JobRow, type MessageRow, type PendingPromptWithFiles, type SessionRow, type WorkingDirectoryFavorite } from "./db.js";
import { loadAgentOptions, repairAgentSelection, resolveAgentSelection, type AgentOptions, type AgentSelection } from "./model-options.js";
import { CODEX_CONFIG_HINT, hostTenantFor, isCodexConfigured } from "./host-mode.js";
import { chownTenantStorageIfNeeded, ensureTenant, ensureTenantWorkspace, isPersistedDeliverablePath, newId, persistDeliverableSync, removeCodexThreadFiles, removePersistedDeliverable, removeWorkspace, resolveHostWorkingDir, resolveInside, resolveStoredWorkingDirInput, safeUploadName, type TenantPaths } from "./paths.js";
import { AUDIO_MIME_EXTENSIONS, TranscriptionError, TranscriptionService } from "./transcription.js";
import { buildUserCancellationSummary } from "./cancellation-summary.js";
import { discoverImportableSessions, importSessionThread, normalizeImportedWorkingDir, readCodexThreadWorkingDir } from "./session-importer.js";
import {
  autoDirCategoryKey,
  customCategoryKey,
  listValidHiddenCategoryKeys,
  listValidPinnedCategoryKeys,
  type TaskListCategorySettings,
} from "../src/task-categories.js";

const COOKIE_NAME = "cww_session";
const CONVERSATION_MESSAGE_PAGE_SIZE = 30;
const FILE_INSTRUCTION_GUIDANCE = "文件已上传，请输入具体操作，例如“把图片背景改为白色”或“汇总这些表格”。收到明确指令后才会开始处理。";
type AuthenticatedRequest = Request & { appSession?: SessionRow };

export type AppOverrides = Partial<AppConfig> & { logger?: Logger };

export function createApp(overrides: AppOverrides = {}) {
  const config = loadConfig(overrides);
  const logger = overrides.logger ?? pino({ level: "warn" });
  fs.mkdirSync(config.dataRoot, { recursive: true });
  fs.mkdirSync(config.tenantRoot, { recursive: true });
  const db = new AppDatabase(config.dataRoot, { username: config.username, passwordHash: config.passwordHash, displayName: config.displayName });
  for (const user of db.listUsers()) storageFor(user.id);
  migrateExistingOutputFiles(config, db);
  const subscribers = new Map<string, Set<Response>>();

  function optionsForUser(userId: string): AgentOptions {
    return loadAgentOptions(config, codexHomeFor(userId));
  }

  function codexHomeFor(userId: string): string {
    if (config.hostMode) return hostTenantFor(config, db, userId)?.codexHome ?? config.codexHome;
    return storageFor(userId).codexHome;
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
    const selection = repairAgentSelection(options, stored?.model, stored?.reasoningEffort);
    if (!stored || stored.model !== selection.model || stored.reasoningEffort !== selection.reasoningEffort) {
      db.setAgentSelectionPreference(selection, userId);
    }
    return selection;
  }

  function conversationAgentSelection(conversation: ConversationRow, options: AgentOptions = optionsForUser(conversation.user_id)): AgentSelection {
    const fallback = conversation.agent_model && conversation.reasoning_effort
      ? { model: conversation.agent_model, reasoningEffort: conversation.reasoning_effort }
      : userAgentSelection(conversation.user_id, options);
    const selection = repairAgentSelection(options, fallback.model, fallback.reasoningEffort);
    if (conversation.agent_model !== selection.model || conversation.reasoning_effort !== selection.reasoningEffort) {
      db.updateConversation(conversation.id, { agentSelection: selection });
    }
    return selection;
  }

  function safeConversationMessages(conversation: ConversationRow, messages: Array<MessageRow & { files: FileRow[] }>) {
    const citationFiles = db.listFiles(conversation.id);
    return messages.map((message) => {
      if (message.role !== "assistant") return message;
      const visibleContent = conversation.title_source === "ai"
        ? extractLeakedAutoTitleAnswer(message.content, true) ?? message.content
        : message.content;
      return { ...message, content: sanitizeAgentMarkdown(visibleContent, citationFiles) };
    });
  }

  function saveAgentSelection(userId: string, rawModel: unknown, rawEffort: unknown, conversation?: ConversationRow): AgentSelection {
    const selection = resolveAgentSelection(optionsForUser(userId), rawModel, rawEffort);
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

  function removePendingPromptFiles(prompt: PendingPromptWithFiles, userId: string): void {
    const workspace = workspaceFor(userId, prompt.conversation_id);
    for (const file of prompt.files) {
      try { fs.rmSync(resolveInside(workspace, file.relative_path), { force: true }); }
      catch { /* Missing or already-cleaned drafts must not block queue cleanup. */ }
    }
  }

  function removeComposerDraftFiles(draft: ComposerDraftWithFiles, userId: string): void {
    const workspace = workspaceFor(userId, draft.conversation_id);
    for (const file of draft.files) {
      try { fs.rmSync(resolveInside(workspace, file.relative_path), { force: true }); }
      catch { /* Missing draft files must not block explicit draft cleanup. */ }
    }
  }

  function registerPendingUploads(conversationId: string, pendingPromptId: string, uploaded: Express.Multer.File[]): FileRow[] {
    const createdAt = new Date().toISOString();
    return uploaded.map((file) => {
      const row: FileRow = {
        id: newId(), conversation_id: conversationId, message_id: null, pending_prompt_id: pendingPromptId,
        original_name: safeUploadName(file.originalname).displayName,
        relative_path: path.posix.join("uploads", file.filename), mime_type: file.mimetype || "application/octet-stream",
        size: file.size, kind: "upload", created_at: createdAt,
      };
      db.addFile(row);
      return row;
    });
  }

  function registerComposerUploads(conversationId: string, uploaded: Express.Multer.File[]): FileRow[] {
    db.ensureComposerDraft(conversationId);
    const createdAt = new Date().toISOString();
    const rows = uploaded.map((file) => {
      const row: FileRow = {
        id: newId(), conversation_id: conversationId, message_id: null, pending_prompt_id: null, composer_draft_id: conversationId,
        original_name: safeUploadName(file.originalname).displayName,
        relative_path: path.posix.join("uploads", file.filename), mime_type: file.mimetype || "application/octet-stream",
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

  function agentPrompt(content: string, quoteExcerpt?: string | null): string {
    return quoteExcerpt ? buildAskAgentDraft(content, quoteExcerpt) : content;
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
        label: jobsAhead === 0 ? "任务即将开始" : `正在等待本会话前面的 ${jobsAhead} 个任务运行完毕`,
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
      const selection = repairAgentSelection(optionsForUser(conversation.user_id), job.agent_model, job.reasoning_effort);
      await runner.run(job.id, conversation.id, agentPrompt(message.content, message.quote_excerpt), db.listFilesForMessage(message.id), selection);
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
        let job = db.getNextRunnableQueuedJob();
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
    return res.json({
      authenticated: true,
      username: user.username,
      displayName: user.display_name,
      csrfToken,
      chatFontSize: db.getChatFontSize(user.id),
      chatColumnWidth: db.getChatColumnWidth(user.id),
      voiceEnabled,
    });
  });

  api.get("/auth/session", (req, res) => {
    const session = readSession(req, db, config);
    if (!session) return res.json({ authenticated: false });
    return res.json({
      authenticated: true,
      username: session.username,
      displayName: session.display_name,
      csrfToken: session.csrf_token,
      chatFontSize: db.getChatFontSize(session.user_id),
      chatColumnWidth: db.getChatColumnWidth(session.user_id),
      voiceEnabled,
    });
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
    return res.json({ conversations: db.listConversations(session.user_id) });
  });

  api.get("/conversations/archived", (req, res) => {
    const session = res.locals.session as SessionRow;
    const query = typeof req.query.query === "string" ? req.query.query : "";
    return res.json({ conversations: db.listArchivedConversations(session.user_id, query) });
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
    const configured = !config.hostMode || Boolean(hostTenant && isCodexConfigured(hostTenant.codexHome));
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
    try { return res.json({ selection: saveAgentSelection(session.user_id, req.body?.model, req.body?.reasoningEffort) }); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "模型选项无效。" }); }
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
    workspaceFor(session.user_id, id);
    const agentSelection = userAgentSelection(session.user_id);
    res.status(201).json({ conversation: db.createConversation(id, "新任务", agentSelection, session.user_id, workingDir), agentSelection });
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
    if (conversation.archived_at) return res.json({ conversation });
    const hasWork = conversation.status === "running"
      || db.listActiveJobsForConversation(conversation.id).length > 0
      || db.listPendingPrompts(conversation.id).length > 0
      || db.listPendingPrompts(conversation.id, "editing").length > 0;
    if (hasWork) return res.status(409).json({ error: "会话仍在运行或有待发送任务，请处理完成后再归档。" });
    const archived = db.archiveConversationForUser(conversation.id, session.user_id);
    return archived ? res.json({ conversation: archived }) : res.status(409).json({ error: "会话归档状态已经变化。" });
  });

  api.post("/conversations/:id/restore", async (req, res) => {
    const session = res.locals.session as SessionRow;
    const conversation = db.getConversationForUser(String(req.params.id), session.user_id);
    if (!conversation) return res.status(404).json({ error: "会话不存在。" });
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
    const outputFiles = db.listFiles(conversation.id).filter((file) => file.kind === "output");
    const agentSelection = conversationAgentSelection(conversation);
    const activeJob = latestJobWithStartedAt && ["queued", "running"].includes(latestJobWithStartedAt.status)
      ? { ...latestJobWithStartedAt, queuePosition: db.getQueuePosition(latestJobWithStartedAt.id) }
      : null;
    const pendingPrompts = db.listPendingPrompts(conversation.id);
    const editingPrompt = db.listPendingPrompts(conversation.id, "editing")[0] ?? null;
    const composerDraft = db.getComposerDraft(conversation.id) ?? null;
    return res.json({
      conversation,
      agentSelection,
      messages: safeMessages,
      outputFiles,
      messagePage: { hasMore: messagePage.hasMore, nextCursor: messagePage.nextCursor },
      pendingPrompts,
      editingPrompt,
      composerDraft,
      activeJob,
      latestJob: latestJobWithStartedAt,
      jobEvents,
      rolloutBytes,
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
    try { return res.json({ selection: saveAgentSelection(session.user_id, req.body?.model, req.body?.reasoningEffort, conversation) }); }
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
    if (deletingConversations.has(conversation.id)) return res.status(409).json({ error: "会话正在删除。" });
    deletingConversations.add(conversation.id);
    try {
      for (const prompt of [...db.listPendingPrompts(conversation.id), ...db.listPendingPrompts(conversation.id, "editing")]) {
        removePendingPromptFiles(prompt, session.user_id);
      }
      db.deletePendingPromptsForConversation(conversation.id);
      // Remove drafts before awaiting cancellation. A running job finishes its
      // queue pump during cancellation, so leaving drafts here could promote one
      // into a real message/job while the conversation is being deleted.
      await stopConversationJobs(conversation.id, false);
      for (const file of db.listFiles(conversation.id)) removePersistedDeliverable(config.dataRoot, file.relative_path);
      const tenant = storageFor(session.user_id);
      if (conversation.codex_thread_id && !db.isCodexThreadUsedByAnotherActiveConversation(conversation.codex_thread_id, conversation.id)) {
        removeCodexThreadFiles(codexHomeFor(session.user_id), conversation.codex_thread_id);
      }
      removeWorkspace(tenant.conversations, conversation.id);
      db.softDeleteConversation(conversation.id);
      return res.status(204).end();
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : "删除失败。" });
    } finally {
      deletingConversations.delete(conversation.id);
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
    const quoteExcerpt = submittedQuoteExcerpt(req.body?.quoteExcerpt);
    return res.json({ composerDraft: db.saveComposerDraft(conversation.id, content, quoteExcerpt) ?? null });
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
    registerComposerUploads(conversation.id, uploaded);
    return res.status(201).json({ composerDraft: db.getComposerDraft(conversation.id)! });
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
    return res.json({ composerDraft: db.getComposerDraft(conversation.id) ?? null });
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
      if (!hostTenant || !isCodexConfigured(hostTenant.codexHome)) {
        removeUnregisteredUploads(uploaded);
        return res.status(409).json({
          error: hostTenant ? CODEX_CONFIG_HINT : "该用户没有对应的系统账户，无法运行 Codex 任务。请先由管理员添加系统用户。",
        });
      }
    }
    if (conversation.archived_at) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "会话已归档，请恢复后再继续发送。" }); }
    if (deletingConversations.has(conversation.id)) { removeUnregisteredUploads(uploaded); return res.status(409).json({ error: "会话正在删除。" }); }
    const prompt = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 100_000) : "";
    const quoteExcerpt = submittedQuoteExcerpt(req.body?.quoteExcerpt);
    const useComposerDraft = req.body?.useComposerDraft === "true";
    if (useComposerDraft && uploaded.length > 0) {
      removeUnregisteredUploads(uploaded);
      return res.status(400).json({ error: "服务器草稿附件无需重复上传。" });
    }
    const composerDraft = useComposerDraft ? db.getComposerDraft(conversation.id) : undefined;
    const attachmentCount = uploaded.length + (composerDraft?.files.length ?? 0);
    if (!prompt && !quoteExcerpt && attachmentCount === 0) return res.status(400).json({ error: "请输入内容、添加引用或上传文件。" });
    const selection = conversationAgentSelection(conversation);
    const editingPrompt = db.listPendingPrompts(conversation.id, "editing")[0];

    if (useComposerDraft && editingPrompt) return res.status(409).json({ error: "请先完成或取消正在编辑的待发送任务。" });

    if (!prompt && !quoteExcerpt) {
      if (useComposerDraft) {
        const awaiting = db.materializeComposerDraftAsPending(newId(), conversation.id, "", selection, null, "editing");
        return res.status(202).json({ pendingPrompt: awaiting, editingPrompt: awaiting, queued: false, needsInstruction: true, guidance: FILE_INSTRUCTION_GUIDANCE });
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
      registerPendingUploads(conversation.id, awaiting.id, uploaded);
      const persisted = db.updateEditingPendingPrompt(awaiting.id, "", selection);
      return res.status(202).json({ pendingPrompt: persisted, editingPrompt: persisted, queued: false, needsInstruction: true, guidance: FILE_INSTRUCTION_GUIDANCE });
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
      registerPendingUploads(conversation.id, editingPrompt.id, uploaded);
      const updated = db.updatePendingPrompt(editingPrompt.id, prompt, selection, quoteExcerpt);
      if (!updated) return res.status(409).json({ error: "等待指令的文件状态已经变化，请刷新后重试。" });
      if (config.queueAutoStart) await pumpQueue();
      return res.status(202).json({ pendingPrompt: db.getPendingPrompt(updated.id) ?? null, queued: true });
    }

    if (db.listActiveJobsForConversation(conversation.id).length > 0 || db.listPendingPrompts(conversation.id).length > 0) {
      if (useComposerDraft) {
        const pendingPrompt = db.materializeComposerDraftAsPending(newId(), conversation.id, prompt, selection, quoteExcerpt);
        return res.status(202).json({ pendingPrompt, queued: true });
      }
      const pendingPrompt = db.createPendingPrompt(newId(), conversation.id, prompt, selection, quoteExcerpt);
      registerPendingUploads(conversation.id, pendingPrompt.id, uploaded);
      return res.status(202).json({ pendingPrompt: db.getPendingPrompt(pendingPrompt.id), queued: true });
    }

    const messageId = newId();
    const createdAt = new Date().toISOString();
    if (useComposerDraft) {
      const job = db.materializeComposerDraftAsJob(messageId, newId(), conversation.id, prompt, selection, quoteExcerpt);
      const queuePosition = db.getQueuePosition(job.id) ?? 1;
      publishQueuePositions();
      res.status(202).json({ job: { ...job, queuePosition }, message: { id: messageId }, queued: true });
      if (config.queueAutoStart) setImmediate(() => void pumpQueue());
      return;
    }
    db.addMessage({ id: messageId, conversation_id: conversation.id, role: "user", content: prompt, quote_excerpt: quoteExcerpt, created_at: createdAt });
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
    return res.json({ pendingPrompt: db.getPendingPrompt(prompt.id) ?? null, activeJob: db.getActiveJobForConversation(conversation.id) ?? null });
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
    registerPendingUploads(conversation.id, pending.id, uploaded);
    const selection = conversationAgentSelection(conversation);
    const updated = prompt || quoteExcerpt
      ? db.updatePendingPrompt(pending.id, prompt, selection, quoteExcerpt)
      : db.updateEditingPendingPrompt(pending.id, "", selection);
    if (!updated) return res.status(409).json({ error: "待发送队列已经变化，请刷新后重试。" });
    if (!prompt && !quoteExcerpt) {
      return res.status(202).json({ pendingPrompt: db.getPendingPrompt(pending.id) ?? null, activeJob: db.getActiveJobForConversation(conversation.id) ?? null, needsInstruction: true, guidance: FILE_INSTRUCTION_GUIDANCE });
    }
    if (config.queueAutoStart) await pumpQueue();
    return res.json({ pendingPrompt: db.getPendingPrompt(pending.id) ?? null, activeJob: db.getActiveJobForConversation(conversation.id) ?? null });
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
      const turnId = await runner.steer(running.id, agentPrompt(pending.content, pending.quote_excerpt), pending.files);
      const message = db.materializeSteeredPrompt(pending.id, newId());
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
    const workspace = workspaceFor(session.user_id, file.conversation_id);
    const storageRoot = file.kind === "output" && isPersistedDeliverablePath(file.relative_path) ? config.dataRoot : workspace;
    let absolute: string;
    try { absolute = resolveInside(storageRoot, file.relative_path); }
    catch { return res.status(400).json({ error: "文件路径无效。" }); }
    if (!fs.existsSync(absolute)) return res.status(404).json({ error: "文件已不存在。" });
    const inline = req.query.download !== "1" && (/^image\//.test(file.mime_type) || file.mime_type === "application/pdf" || /^text\/(plain|markdown|csv)/.test(file.mime_type));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", file.mime_type);
    res.setHeader("Content-Disposition", contentDisposition(inline ? "inline" : "attachment", file.original_name));
    return res.sendFile(path.basename(absolute), { root: path.dirname(absolute) });
  });

  router.use("/api", api);
  const distPath = path.join(config.projectRoot, "dist");
  if (fs.existsSync(distPath)) router.use(express.static(distPath, { index: false, maxAge: "1h" }));
  router.use((req, res, next) => {
    if (req.method !== "GET" || !req.accepts("html") || !fs.existsSync(path.join(distPath, "index.html"))) return next();
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
