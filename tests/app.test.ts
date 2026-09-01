import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import request from "supertest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { createApp, migrateExistingOutputFiles } from "../server/app.js";
import { assertProductionConfig, loadConfig } from "../server/config.js";
import { AUTO_TITLE_OUTPUT_SCHEMA, extractLeakedAutoTitleAnswer, parseAutoTitleResponse, redactBrandForDisplay, summarizeEvent } from "../server/codex-runner.js";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { resolveSystemUser } from "../server/host-mode.js";
import { createShareToken, parseShareToken, SHARE_LIFETIME_SECONDS } from "../server/share-link.js";
import { loadAgentOptions, repairAgentSelection, resolveAgentSelection } from "../server/model-options.js";
import { mimeTypeForPath } from "../server/mime.js";
import { codexThreadRolloutBytes, ensureTenant, ensureTenantWorkspace, ensureWorkspace, isDeliverablePath, isPersistedDeliverablePath, listHostDirectory, normalizeStoredRelativePath, normalizeUploadFileName, persistDeliverable, resolveHostReadableFile, resolveHostWorkingDir, resolveInside, resolveStoredWorkingDirInput, safeUploadName } from "../server/paths.js";
import { buildShellEnvironment, cleanupJobRuntime, prepareJobRuntime } from "../server/python-runtime.js";
import { assessTaskPolicy } from "../server/task-policy.js";
import { listTenantIdentities, tenantIdentityForUser } from "../server/tenant-identities.js";
import { consumeTenantTurnEvents, validateTenantWorkerRequest } from "../server/tenant-worker-execution.js";
import type { TenantWorkerRunRequest } from "../server/tenant-worker-protocol.js";
import { describeUpstreamError, isRetryableUpstreamError, runWithTransientRetries } from "../server/retry-policy.js";
import { deriveImportedTitle, discoverImportableSessions, importSessionThread, normalizeImportedWorkingDir, readCodexThreadWorkingDir } from "../server/session-importer.js";
import { buildReasoningSteps } from "../server/reasoning-parts.js";
import { canPreviewInline, FILE_PREVIEW_TEXT_LIMIT_BYTES, filePreviewKind, firstMarkdownPreviewFile, isBrowserPreviewable, isLocalMarkdownUrl, localPathText, orderPreviewedFiles, resolveMessageFileLink } from "../src/file-links.js";
import { parseCodexSnippetUrl, parseFileLine, parseFileRef, parseSnippetHref } from "../src/code-snippet.js";
import { findUserMessageJump, findViewportAnchorMessageId } from "../src/message-jump.js";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";
import { resolveAccountIdentity } from "../src/account-identity.js";
import { chooseComposerPrimaryAction } from "../src/composer-action.js";
import { ASK_AGENT_SELECTION_MAX_CHARS, buildAskAgentDraft, normalizeAskAgentSelection } from "../src/ask-agent-selection.js";
import { mergeMessagePages, preservePrependedScrollTop } from "../src/message-history.js";
import { resolveScrollFollow } from "../src/scroll-follow.js";
import { CHAT_FONT_SIZE_DEFAULT, CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN, normalizeChatFontSize } from "../src/chat-font-size.js";
import { CHAT_COLUMN_WIDTH_DEFAULT, CHAT_COLUMN_WIDTH_MAX, CHAT_COLUMN_WIDTH_MIN, normalizeChatColumnWidth } from "../src/chat-column-width.js";
import { chooseSelectedConversation, isTerminalJob, mergeJobEvents } from "../src/recovery.js";
import { normalizeThemePreference, readStoredThemePreference, resolveTheme, THEME_PREFERENCE_KEY } from "../src/theme.js";
import type { Conversation, WorkFile } from "../src/api.js";
import { buildAgentSteerPrompt, buildAgentTurnPrompt } from "../server/agent-context.js";
import { buildProcessJournal } from "../src/process-journal.js";
import { collectReasoningSteps } from "../src/reasoning-steps.js";
import { formatElapsed, taskElapsedSeconds } from "../src/task-timing.js";
import { DEFAULT_OPTIONAL_AGENT_CAPABILITIES, buildOptionalCapabilityConfig, detectOptionalAgentCapabilities } from "../server/optional-capabilities.js";
import { USER_CANCELLED_TASK_MARKER, latestUserCancellationContext } from "../server/cancellation-summary.js";
import { formatRolloutBytes, ROLLOUT_WARNING_BYTES, shouldWarnAboutRollout } from "../src/rollout-capacity.js";
import { readLocalStorageValue, removeLocalStorageValue, writeLocalStorageValue } from "../src/App.js";

// A developer .env (loaded by server/config.ts) must not leak deployment mode
// flags into the suite; the tests control these through createApp overrides.
for (const key of ["HOST_MODE", "CONTAINERIZED", "TENANT_WORKER_ISOLATION"]) delete process.env[key];

test("user-visible branding uses Codex Web without the private product name", () => {
  const index = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8")
    .replace(/^const SELECTED_CONVERSATION_KEY = .*$/m, "");
  assert.match(index, /<title>Codex Web<\/title>/);
  assert.match(index, /name="application-name" content="Codex Web"/);
  assert.doesNotMatch(`${index}\n${appSource}`, /PP Agent/i);
  assert.doesNotMatch(appSource, /localStorage\.setItem\([^)]*codex-web:(?:model|reasoning)/);
  assert.equal(redactBrandForDisplay("Codex / CHATGPT / agent"), "Codex / Codex Web / agent");
});

test("missing frontend bundle serves a clear maintenance page instead of Cannot GET", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-no-bundle-test-"));
  const instance = createApp({
    projectRoot: root, dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("No-Bundle-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const page = await request(instance.app)
    .get("/codex-web/")
    .set("Accept", "text/html")
    .expect(503);
  assert.match(page.text, /dist\/index\.html/);
  assert.match(page.text, /npm run build/);
  assert.doesNotMatch(page.text, /Cannot GET/);

  const health = await request(instance.app).get("/codex-web/api/health").expect(200);
  assert.equal(health.body.ok, true);
});

test("login form leaves the username empty for each user to enter", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /const \[username, setUsername\] = useState\(""\)/);
  assert.doesNotMatch(appSource, /useState\("owner"\)/);
  assert.match(appSource, /用户名<input autoComplete="username" autoFocus/);
});

test("account settings expose username and password changes with password confirmation", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  assert.match(apiSource, /updateAccount: \(payload: \{ currentPassword: string; newUsername\?: string; newPassword\?: string \}\)/);
  assert.match(appSource, /账户与密码/);
  assert.match(appSource, /修改账户与密码/);
  assert.match(appSource, /account-security-trigger/);
  assert.match(appSource, /account-security-dialog/);
  assert.match(appSource, /登录用户名/);
  assert.match(appSource, /autoComplete="current-password"/);
  assert.match(appSource, /autoComplete="new-password"/);
  assert.match(appSource, /两次输入的新密码不一致/);
  assert.match(appSource, /新密码至少需要 12 个字符/);
  assert.match(appSource, /宿主模式下用户名由系统账户决定/);
});

test("frontend installs an error boundary and client error reporting", () => {
  const mainSource = fs.readFileSync(path.join(process.cwd(), "src", "main.tsx"), "utf8");
  const boundarySource = fs.readFileSync(path.join(process.cwd(), "src", "error-boundary.tsx"), "utf8");
  const reportingSource = fs.readFileSync(path.join(process.cwd(), "src", "client-errors.ts"), "utf8");
  assert.match(mainSource, /AppErrorBoundary/);
  assert.match(mainSource, /installClientErrorReporting\(\)/);
  assert.match(mainSource, /function renderBootstrapFallback/);
  assert.match(mainSource, /if \(!rootElement\)/);
  assert.match(mainSource, /rootElement\)\.render/);
  assert.ok(mainSource.indexOf("installClientErrorReporting();") < mainSource.indexOf("applyThemePreference("));
  assert.match(boundarySource, /componentDidCatch/);
  assert.match(boundarySource, /getDerivedStateFromError/);
  assert.match(boundarySource, /window\.location\.reload\(\)/);
  // Render failures must remain on the stable fallback until the user
  // explicitly chooses a recovery action; automatic remount/reload loops are
  // intentionally not part of the boundary contract.
  assert.doesNotMatch(boundarySource, /AUTO_RELOAD_COOLDOWN_MS/);
  assert.doesNotMatch(boundarySource, /autoRetried/);
  assert.doesNotMatch(boundarySource, /sessionStorage/);
  assert.match(boundarySource, /private readonly retry/);
  assert.match(boundarySource, /private readonly reload/);
  assert.match(reportingSource, /unhandledrejection/);
  assert.match(reportingSource, /reportClientError/);
  assert.match(reportingSource, /REACT_RECOVERY_NOTICE/);
  assert.match(reportingSource, /componentStack/);
});

test("frontend storage cache failures never escape into rendering", () => {
  assert.equal(readLocalStorageValue("blocked", { getItem: () => { throw new Error("storage blocked"); } }), null);

  let written: string | null = null;
  writeLocalStorageValue("key", "value", { setItem: (_key, value) => { written = value; } });
  assert.equal(written, "value");
  writeLocalStorageValue("blocked", "value", { setItem: () => { throw new Error("quota exceeded"); } });

  let removed = false;
  removeLocalStorageValue("key", { removeItem: () => { removed = true; } });
  assert.equal(removed, true);
  removeLocalStorageValue("blocked", { removeItem: () => { throw new Error("storage blocked"); } });

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /api\.session\(\)[\s\S]*\.catch\(/);
  assert.match(appSource, /无法连接到服务/);
  assert.doesNotMatch(appSource, /window\.localStorage\.(getItem|setItem|removeItem)/);
});

test("client error endpoint records authenticated reports and rejects anonymous ones", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-client-error-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Client-Error-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);

  await agent.post("/codex-web/api/client-errors").send({ message: "anonymous report" }).expect(401);

  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Client-Error-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;
  const reported = await agent.post("/codex-web/api/client-errors")
    .set("X-CSRF-Token", csrf)
    .send({
      message: "render: boom",
      stack: "TypeError: boom\n    at MessageCard",
      source: "error-boundary",
      href: "https://example.test/codex-web/",
    })
    .expect(200);
  assert.deepEqual(reported.body, { ok: true });

  const oversized = await agent.post("/codex-web/api/client-errors")
    .set("X-CSRF-Token", csrf)
    .send({ message: "x".repeat(5000) })
    .expect(200);
  assert.deepEqual(oversized.body, { ok: true });
});

test("users can change their username and password through the account API", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-account-change-test-"));
  const initialPassword = "Account-Initial-2026!";
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync(initialPassword, 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: initialPassword }).expect(200);
  const csrf = login.body.csrfToken as string;
  assert.equal(login.body.canChangeUsername, true);

  const updated = await agent.put("/codex-web/api/auth/account")
    .set("X-CSRF-Token", csrf)
    .send({ currentPassword: initialPassword, newUsername: "renamed-owner", newPassword: "Account-Renamed-2026!" })
    .expect(200);
  assert.equal(updated.body.username, "renamed-owner");
  assert.equal(updated.body.displayName, "Owner");
  assert.equal(updated.body.canChangeUsername, true);
  assert.equal(instance.db.getUserByUsername("renamed-owner")?.username, "renamed-owner");

  await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Account-Renamed-2026!" }).expect(401);
  const relogin = await agent.post("/codex-web/api/auth/login").send({ username: "renamed-owner", password: "Account-Renamed-2026!" }).expect(200);
  assert.equal(relogin.body.username, "renamed-owner");
});

test("account API rejects wrong current password, duplicates, invalid names, and short passwords", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-account-guard-test-"));
  const ownerPassword = "Account-Guard-2026!";
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync(ownerPassword, 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const now = new Date().toISOString();
  instance.db.createUser({
    id: crypto.randomUUID(), username: "member", display_name: "Member",
    password_hash: bcrypt.hashSync("Member-Guard-2026!", 8), role: "member", status: "active",
    created_at: now, updated_at: now,
  });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: ownerPassword }).expect(200);
  const csrf = login.body.csrfToken as string;

  await agent.put("/codex-web/api/auth/account")
    .set("X-CSRF-Token", csrf).send({ currentPassword: "wrong-password", newUsername: "renamed" }).expect(403);
  await agent.put("/codex-web/api/auth/account")
    .set("X-CSRF-Token", csrf).send({ currentPassword: ownerPassword, newUsername: "MEMBER" }).expect(400);
  await agent.put("/codex-web/api/auth/account")
    .set("X-CSRF-Token", csrf).send({ currentPassword: ownerPassword, newUsername: "1invalid" }).expect(400);
  await agent.put("/codex-web/api/auth/account")
    .set("X-CSRF-Token", csrf).send({ currentPassword: ownerPassword, newPassword: "short" }).expect(400);
  await agent.put("/codex-web/api/auth/account")
    .set("X-CSRF-Token", csrf).send({ currentPassword: ownerPassword, newUsername: "owner" }).expect(400);
});

test("password change keeps the current session and revokes other sessions", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-account-session-test-"));
  const password = "Session-Rotate-2026!";
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync(password, 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const first = request.agent(instance.app);
  const second = request.agent(instance.app);
  const firstLogin = await first.post("/codex-web/api/auth/login").send({ username: "owner", password }).expect(200);
  await second.post("/codex-web/api/auth/login").send({ username: "owner", password }).expect(200);
  await second.get("/codex-web/api/conversations").expect(200);

  await first.put("/codex-web/api/auth/account")
    .set("X-CSRF-Token", firstLogin.body.csrfToken as string)
    .send({ currentPassword: password, newPassword: "Session-Rotated-2026!" })
    .expect(200);
  await second.get("/codex-web/api/conversations").expect(401);
  await first.get("/codex-web/api/conversations").expect(200);
});

test("host mode forbids web username changes but still allows password changes", async (context) => {
  const username = process.env.USER || process.env.LOGNAME || "root";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-account-host-mode-test-"));
  const password = "Host-Password-2026!";
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    hostMode: true, username, passwordHash: bcrypt.hashSync(password, 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username, password }).expect(200);
  assert.equal(login.body.canChangeUsername, false);

  const blocked = await agent.put("/codex-web/api/auth/account")
    .set("X-CSRF-Token", login.body.csrfToken as string)
    .send({ currentPassword: password, newUsername: "another-user" })
    .expect(400);
  assert.match(blocked.body.error, /宿主模式/);

  const changed = await agent.put("/codex-web/api/auth/account")
    .set("X-CSRF-Token", login.body.csrfToken as string)
    .send({ currentPassword: password, newPassword: "Host-Renamed-2026!" })
    .expect(200);
  assert.equal(changed.body.username, username);
});

test("owner username survives app restarts instead of being reset by the env seed", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-account-persist-test-"));
  const seed = { username: "owner", passwordHash: bcrypt.hashSync("Seed-Persist-2026!", 8), displayName: "Owner" };
  const first = new AppDatabase(path.join(root, "data"), seed, false);
  first.setUserUsername(LEGACY_USER_ID, "renamed-owner");
  first.close();
  const reopened = new AppDatabase(path.join(root, "data"), seed, false);
  context.after(() => { reopened.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(reopened.getUser(LEGACY_USER_ID)?.username, "renamed-owner");
});

test("composer replaces stop with send as soon as there is sendable input", () => {
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: false, hasAttachments: false, voiceActive: false }), "stop");
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: true, hasAttachments: false, voiceActive: false }), "send");
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: false, hasAttachments: true, voiceActive: false }), "send");
  assert.equal(chooseComposerPrimaryAction({ running: true, hasText: false, hasAttachments: false, voiceActive: true }), "send");
  assert.equal(chooseComposerPrimaryAction({ running: false, hasText: false, hasAttachments: false, voiceActive: false }), "send");
});

test("non-controlled composer still applies external clears when the state value is unchanged", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /const \[composerInputRevision, setComposerInputRevision\] = useState\(0\)/);
  assert.match(appSource, /setComposerInputRevision\(\(revision\) => revision \+ 1\)/);
  assert.match(appSource, /input=\{input\} inputRevision=\{composerInputRevision\}/);
  assert.match(appSource, /useLayoutEffect\(\(\) => \{/);
  assert.match(appSource, /\}, \[input, inputRevision\]\);/);
});

test("stale conversation responses cannot restore a draft after sending", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const sendSource = appSource.slice(appSource.indexOf("async function send(message?: string)"), appSource.indexOf("async function beginPendingEdit"));
  assert.match(appSource, /const responseIsStale = \(draftMutationGenerationRef\.current\.get\(id\) \?\? 0\) !== draftGenerationAtRequest/);
  assert.match(appSource, /const shouldRestore = !responseIsStale && \(wasEditing \|\| draftLoadedConversationRef\.current !== id\)/);
  assert.match(sendSource, /draftLoadedConversationRef\.current = id;/);
  assert.match(sendSource, /applyExternalComposerText\(""\);/);
});

test("composer top edge resizes the input height by pointer drag", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /className="composer-resize-handle"/);
  assert.match(appSource, /aria-hidden="true"/);
  assert.match(appSource, /title="拖动调整输入框高度"/);
  assert.match(appSource, /beginComposerResize\(/);
  assert.match(appSource, /startHeight \+ \(startY - moveEvent\.clientY\)/);
  assert.match(appSource, /document\.body\.classList\.add\("resizing-composer"\)/);
  assert.match(styles, /\.composer-resize-handle \{[^}]*cursor: ns-resize;/);
  assert.match(styles, /body\.resizing-composer \* \{[^}]*cursor: ns-resize !important;/);
});

test("side chat pane resizes independently by pointer and keyboard", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const paneSource = fs.readFileSync(path.join(process.cwd(), "src", "side-chat-pane.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /const SIDE_CHAT_WIDTH_KEY = "codex-web:side-chat-width"/);
  assert.match(appSource, /const \[sideChatWidth, setSideChatWidth\]/);
  assert.match(appSource, /SIDE_CHAT_WIDTH_MIN/);
  assert.match(appSource, /SIDE_CHAT_WIDTH_MAX/);
  assert.match(appSource, /onResizeStart=\{\(event\) => beginPaneResize\(event, sideChatWidth/);
  assert.match(appSource, /onResizeKeyDown=\{\(event\) => handlePaneResizerKey\(event, "side-chat"\)\}/);
  assert.match(paneSource, /className="side-chat-resizer"/);
  assert.match(paneSource, /aria-label="调整侧边聊天宽度"/);
  assert.match(paneSource, /onPointerDown=\{onResizeStart\}/);
  assert.match(paneSource, /onKeyDown=\{onResizeKeyDown\}/);
  assert.match(styles, /\.side-chat-resizer \{ display: none; \}/);
  assert.match(styles, /\.side-chat-pane \{ width: 100vw !important; \}/);
});

test("side chat keeps history available while primary tasks change", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const paneSource = fs.readFileSync(path.join(process.cwd(), "src", "side-chat-pane.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const serverSource = fs.readFileSync(path.join(process.cwd(), "server", "app.ts"), "utf8");
  assert.match(paneSource, /历史侧边对话/);
  assert.match(paneSource, /api\.sideChats\(\)/);
  assert.match(paneSource, /api\.createNewSideChat\(parent\.id\)/);
  assert.match(paneSource, /api\.setSelectedSideChatContext\(target\.conversation\.id, currentConversation\.id\)/);
  assert.match(apiSource, /setSelectedSideChatContext:/);
  assert.match(serverSource, /api\.get\("\/side-chats"/);
  assert.match(serverSource, /api\.post\("\/conversations\/:id\/side-chats"/);
  assert.match(serverSource, /buildConversationContextExcerpt\(messages\)/);
  assert.match(appSource, /sideChatOpen && sideChatCurrentConversation && <SideChatPane/);
  assert.doesNotMatch(appSource, /key=\{currentDetail\.conversation\.id\}[\s\S]*currentConversation=/);
});

test("chat font sizing keeps readable bounds and scales from the default", () => {
  assert.equal(normalizeChatFontSize(undefined), CHAT_FONT_SIZE_DEFAULT);
  assert.equal(normalizeChatFontSize("18"), 18);
  assert.equal(normalizeChatFontSize(9), CHAT_FONT_SIZE_MIN);
  assert.equal(normalizeChatFontSize(99), CHAT_FONT_SIZE_MAX);
});

test("chat column width keeps usable bounds and scales from the default", () => {
  assert.equal(normalizeChatColumnWidth(undefined), CHAT_COLUMN_WIDTH_DEFAULT);
  assert.equal(normalizeChatColumnWidth("1000"), 1000);
  assert.equal(normalizeChatColumnWidth(640), CHAT_COLUMN_WIDTH_MIN);
  assert.equal(normalizeChatColumnWidth(1600), CHAT_COLUMN_WIDTH_MAX);
});

test("appearance setting supports light, dark, and live system preference", () => {
  assert.equal(THEME_PREFERENCE_KEY, "codex-web:theme");
  assert.equal(normalizeThemePreference("light"), "light");
  assert.equal(normalizeThemePreference("dark"), "dark");
  assert.equal(normalizeThemePreference("system"), "system");
  assert.equal(normalizeThemePreference("unexpected"), "light");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(readStoredThemePreference({ getItem: () => "dark" }), "dark");
  assert.equal(readStoredThemePreference({ getItem: () => { throw new Error("storage blocked"); } }), "light");

  const themeSource = fs.readFileSync(path.join(process.cwd(), "src", "theme.ts"), "utf8");
  // The global storage getter must be resolved inside the guarded function,
  // not in a default-parameter expression evaluated before try/catch.
  assert.doesNotMatch(themeSource, /storage[^\n]*=\s*window\.localStorage/);
  assert.match(themeSource, /window\.localStorage/);

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /使用浅色模式[\s\S]*使用深色模式[\s\S]*外观跟随系统/);
  assert.match(appSource, /matchMedia\?\.\("\(prefers-color-scheme: dark\)"\)/);
  assert.match(styles, /:root\[data-theme="dark"\]/);
  assert.match(styles, /\.theme-options button\[aria-pressed="true"\]/);

  const darkBlock = styles.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/)?.[1] ?? "";
  const color = (name: string) => darkBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1] ?? "";
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
  };
  const contrast = (foreground: string, background: string) => {
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + .05) / (values[1] + .05);
  };
  assert.ok(contrast(color("ink"), color("canvas")) >= 7);
  assert.ok(contrast(color("ink-soft"), color("canvas")) >= 4.5);
  assert.ok(contrast(color("indigo"), color("paper")) >= 4.5);
});

test("user messages wrap long unbroken input inside their bubble", () => {
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(styles, /\.message-body > p \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word;/);
});
test("switching conversations hides stale detail until the selected task loads", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /currentDetail = detail\?\.conversation\.id === selectedId \? detail : null/);
  assert.match(appSource, /loadingConversation \? <ConversationLoading \/>/);
  assert.match(appSource, /const composerElement = useMemo\(\(\) => <Composer/);
  assert.match(appSource, /\(!selectedId \|\| \(currentDetail && !currentDetail\.conversation\.archived_at\)\) && composerElement/);
  assert.match(appSource, /role="status" aria-live="polite"/);
  assert.match(styles, /\.conversation-loading \{[^}]*place-content: center;/);
});
test("host working directory picker exposes favorites, manual paths, and per-conversation overrides", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(apiSource, /working_dir: string \| null/);
  assert.match(apiSource, /workingDirs: \(\) => request<\{ settings: WorkingDirSettings \}>\(\"\/working-dirs\"\)/);
  assert.match(apiSource, /updateFavoriteWorkingDir:/);
  assert.match(apiSource, /action: "add" \| "remove" \| "rename" \| "move"/);
  assert.match(apiSource, /createConversation: \(workingDir\?: string \| null\)/);
  assert.match(apiSource, /export class ApiError extends Error/);
  assert.match(apiSource, /updateConversationWorkingDir: \(id: string, workingDir: string \| null, confirm = false\)/);
  assert.match(appSource, /className="new-task-dir-panel"/);
  assert.match(appSource, /管理收藏…/);
  assert.match(appSource, /或手动输入绝对路径/);
  assert.match(appSource, /moveFavoriteWorkingDir/);
  assert.match(appSource, /title="上移"/);
  assert.match(appSource, /toggleFavoriteAsDefault/);
  assert.match(appSource, /title=\{workingDirSettings\.defaultWorkingDir === favorite\.path \? "取消默认" : "设为默认"\}/);
  assert.match(appSource, /className="chat-working-dir"/);
  assert.match(appSource, /reason\.code !== "working-dir-busy"/);
  assert.match(appSource, /window\.confirm\("该工作目录已有其他会话/);
  assert.match(styles, /\.new-task-dir-panel \{/);
  assert.match(styles, /\.working-dir-manager \{/);
  assert.match(styles, /\.chat-working-dir \{/);
  assert.match(styles, /:root\[data-theme="dark"\] \.working-dir-manager/);
  assert.match(apiSource, /browsePath: \(path\?: string\)/);
  assert.match(apiSource, /addHostDraftFiles:/);
  assert.match(appSource, /PathBrowserDialog/);
  assert.match(appSource, /服务器文件/);
  assert.match(appSource, /浏览其他目录…/);
  assert.match(appSource, /onBrowseHostFiles/);
  assert.match(styles, /\.path-browser-backdrop \{/);
});
test("offline bundle packaging ships the in-place upgrade script", () => {
  const packageScript = fs.readFileSync(path.join(process.cwd(), "scripts", "package-offline.sh"), "utf8");
  const dockerfile = fs.readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");
  const upgradeScript = fs.readFileSync(path.join(process.cwd(), "scripts", "upgrade.sh"), "utf8");
  assert.match(packageScript, /copying upgrade script/);
  assert.match(packageScript, /cp "\$REPO_ROOT\/scripts\/upgrade.sh" "\$STAGING\/upgrade.sh"/);
  assert.match(packageScript, /升级已部署的实例/);
  assert.match(packageScript, /env_runtime_path="\$\(sed -n 's\/\^CODEX_RUNTIME_PATH=\/\/p'/);
  assert.match(packageScript, /export CODEX_RUNTIME_PATH="\$\{CODEX_RUNTIME_PATH:-\$\{env_runtime_path:-\$PACKAGE_ROOT\/bin\/codex\}\}"/);
  assert.match(packageScript, /CODEX_RELAY_VERSION="0\.5\.8"/);
  assert.match(packageScript, /CODEX_RELAY_WHEEL_SHA256="d493b4fc30cbb3fe99f9c3cc367d44a121d43ae5478f2d9791d7bab11b2c8f9f"/);
  assert.match(packageScript, /--relay-binary PATH/);
  assert.match(packageScript, /bundling codex-relay from local binary/);
  assert.match(packageScript, /licenses\/codex-relay/);
  assert.match(packageScript, /install -m 0755 .*codex-relay.* "\$STAGING\/bin\/codex-relay"/);
  assert.match(packageScript, /export CODEX_RELAY_PATH="\$\{CODEX_RELAY_PATH:-\$\{env_relay_path:-\$PACKAGE_ROOT\/bin\/codex-relay\}\}"/);
  assert.match(dockerfile, /ARG CODEX_RELAY_VERSION=0\.5\.8/);
  assert.match(dockerfile, /d493b4fc30cbb3fe99f9c3cc367d44a121d43ae5478f2d9791d7bab11b2c8f9f/);
  assert.match(dockerfile, /sha256sum -c -/);
  assert.match(dockerfile, /COPY --from=codex-relay-baked \/opt\/codex-relay \/opt\/codex-relay/);
  assert.match(dockerfile, /CODEX_RELAY_PATH=\/opt\/codex-relay\/bin\/codex-relay/);
  assert.match(upgradeScript, /\.\/upgrade\.sh <离线包\.tar\.zst> \[部署根\] \[--no-start\]/);
  assert.match(upgradeScript, /备份运行数据到:/);
  assert.match(upgradeScript, /只同步程序文件/);
  assert.match(upgradeScript, /内置 codex-relay/);
  assert.match(upgradeScript, /codex-relay: \$RELAY_VERSION/);
  assert.match(upgradeScript, /回滚命令:/);
});
test("closed mobile sidebar is not painted as an offscreen shadow layer", () => {
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const mobileBlock = styles.match(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(mobileBlock, /\.sidebar \{[^}]*visibility: hidden;[^}]*pointer-events: none;[^}]*box-shadow: none;/);
  assert.match(mobileBlock, /\.sidebar\.open \{[^}]*visibility: visible;[^}]*pointer-events: auto;[^}]*box-shadow:/);
  assert.match(styles, /:root\[data-theme="dark"\] \.sidebar:not\(\.open\) \{ box-shadow: none; \}/);
});

test("sidebar task actions collapse into a stable overflow menu", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const rowActions = appSource.match(/<div className="row-actions">([\s\S]*?)<\/div>/)?.[1] ?? "";
  assert.match(rowActions, /className="task-menu-trigger"[\s\S]*?<MoreHorizontal/);
  assert.doesNotMatch(rowActions, /<Pencil|<Trash2/);
  assert.match(appSource, /className="task-menu-panel"[\s\S]*?<Archive[\s\S]*?<Pencil[\s\S]*?<Trash2/);
  assert.match(styles, /\.row-actions \{[^}]*width: 30px;[^}]*flex: 0 0 30px;[^}]*opacity: 0;[^}]*pointer-events: none;/);
  assert.match(styles, /\.conversation-row:hover \.row-actions, \.conversation-row:focus-within \.row-actions, \.conversation-row\.menu-open \.row-actions \{ opacity: 1; pointer-events: auto; \}/);
  assert.match(styles, /@media \(hover: none\) \{\s*\.row-actions \{ opacity: 1; pointer-events: auto; \}/);
});

test("category menu can start a new task in the category's working directory", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const categoryMenu = appSource.slice(
    appSource.indexOf("categoryMenuCategory && createPortal"),
    appSource.indexOf("categoryNewTaskCategory && createPortal"),
  );
  assert.match(categoryMenu, /<Plus size=\{16\} \/><span>新建任务<\/span>/);
  assert.match(appSource, /function startNewTaskInCategory\(category: TaskListCategoryView\)[\s\S]*?newConversation\(category\.assignedDirs\[0\] \?\? null\)/);
  assert.match(appSource, /setCategoryNewTaskMenu\(\{ categoryKey: category\.key, top, left \}\)/);
  assert.match(appSource, /categoryNewTaskCategory && createPortal\(<div[\s\S]*?className="task-menu-panel category-new-task-panel"[\s\S]*?assignedDirs\.map/);
  assert.match(appSource, /data-category-new-task-menu/);
  assert.match(styles, /\.task-menu-panel\.category-new-task-panel \{[^}]*overflow-y: auto;/);
});

test("mobile Safari keeps the app shell fixed while only inner regions scroll", () => {
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(styles, /html, body, #root \{[^}]*overflow: hidden;[^}]*overscroll-behavior: none;/);
  assert.match(styles, /body \{[^}]*position: fixed;[^}]*inset: 0;[^}]*height: 100dvh;/);
  assert.match(styles, /#root \{[^}]*width: 100%;/);
  assert.match(styles, /\.messages \{[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain;[^}]*-webkit-overflow-scrolling: touch;/);
});

test("provider management stays vertically scrollable on mobile web", () => {
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const providerMobileBlock = styles.slice(styles.lastIndexOf("@media (max-width: 720px)"));
  assert.match(styles, /\.provider-manager-list \{[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain;[^}]*touch-action: pan-y;[^}]*-webkit-overflow-scrolling: touch;/);
  assert.match(styles, /\.provider-form-fields \{[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain;[^}]*touch-action: pan-y;[^}]*-webkit-overflow-scrolling: touch;/);
  assert.match(providerMobileBlock, /\.provider-manager-backdrop,[\s\S]*?\.provider-form-backdrop[^{]*\{[^}]*align-items: stretch;[^}]*padding: 0;/);
  assert.match(providerMobileBlock, /\.provider-manager,[\s\S]*?\.provider-form[^{]*\{[^}]*height: 100dvh;[^}]*max-height: none;/);
  assert.match(providerMobileBlock, /\.provider-manager-list,[\s\S]*?\.provider-form-fields \{ overflow-y: scroll; \}/);
});

test("provider model submenu stays above the viewport bottom", () => {
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const submenuRule = styles.match(/\.model-provider-submenu \{[^}]+\}/)?.[0] ?? "";
  assert.match(submenuRule, /bottom: -6px;/);
  assert.match(submenuRule, /max-height: min\(360px, calc\(100dvh - 80px\)\);/);
  assert.match(submenuRule, /overflow-y: auto;/);
  assert.match(styles, /\.model-provider-submenu \{ left: 0; bottom: -6px;/);
});

test("offscreen user messages stay out of scroll painting", () => {
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(styles, /\.message\.user \{[^}]*content-visibility: auto;[^}]*contain-intrinsic-size: auto 320px;/);
  const baseMessage = styles.match(/\.message \{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(baseMessage, /content-visibility/);
});

test("rollout capacity warning uses a 500 MiB threshold and readable binary units", () => {
  assert.equal(ROLLOUT_WARNING_BYTES, 524_288_000);
  assert.equal(shouldWarnAboutRollout(ROLLOUT_WARNING_BYTES - 1), false);
  assert.equal(shouldWarnAboutRollout(ROLLOUT_WARNING_BYTES), true);
  assert.equal(formatRolloutBytes(971_549_720), "926.5 MiB");
  assert.equal(formatRolloutBytes(1.25 * 1024 ** 3), "1.3 GiB");
});

test("completed conversations stay visibly unread until their detail is viewed", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /conversation\.has_unread_result \? "unread" : ""/);
  assert.match(appSource, /result\.conversation\.has_unread_result[\s\S]*?api\.markConversationSeen\(id\)/);
  assert.match(appSource, /window\.setInterval\([\s\S]*?refreshList\(\)[\s\S]*?10_000/);
  assert.match(apiSource, /markConversationSeen:[\s\S]*?\/conversations\/\$\{id\}\/seen[\s\S]*?method: "POST"/);
  assert.match(styles, /\.conversation-row\.unread \.conversation-select::after \{[^}]*background: #38c976;[^}]*content: "";/);
});

test("selected message text can be quoted into a focused Agent question", () => {
  assert.equal(normalizeAskAgentSelection("  第一行  \r\n\r\n\r\n第二行  \n"), "第一行\n\n第二行");
  assert.equal(buildAskAgentDraft("", "第一行\n第二行"), "请结合以下引用回答我的问题：\n\n> 第一行\n> 第二行\n\n请解释这段引用。");
  assert.equal(buildAskAgentDraft("已有草稿", "引用"), "请结合以下引用回答我的问题：\n\n> 引用\n\n我的问题：\n已有草稿");
  const capped = buildAskAgentDraft("", "很".repeat(ASK_AGENT_SELECTION_MAX_CHARS + 50));
  assert.match(capped, /引用内容过长，已截断/);
  assert.ok(capped.length < ASK_AGENT_SELECTION_MAX_CHARS + 100);

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /data-agent-selectable="true"/);
  assert.match(appSource, /document\.addEventListener\("selectionchange", update\)/);
  assert.match(appSource, /询问 Agent/);
  assert.match(appSource, /className="ask-agent-reference"/);
  assert.match(appSource, /setAskAgentQuote\(normalized\.slice/);
  assert.doesNotMatch(appSource, /buildAskAgentDraft/);
  assert.match(appSource, /api\.sendMessage\(id, (message|content), useComposerDraft \? \[\] : files, askAgentQuote, useComposerDraft\)/);
  assert.match(appSource, /className="message-reference"/);
  assert.match(appSource, /focusRequest=\{composerFocusRequest\}/);
  assert.match(styles, /\.ask-agent-selection \{[^}]*position: fixed;[^}]*touch-action: manipulation/);
  assert.match(styles, /\.ask-agent-reference \{/);
  assert.match(styles, /\.message-reference \{/);
  assert.match(styles, /:root\[data-theme="dark"\] \.ask-agent-selection/);
  assert.match(styles, /:root\[data-theme="dark"\] \.ask-agent-reference/);
});

test("pending queue stays translucent and vertically compact in both themes", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /className=\{`workspace \$\{currentDetail\?\.pendingPrompts\.length \? "has-pending-queue" : ""\}`\}/);
  assert.match(styles, /\.pending-queue \{[^}]*background: rgba\(255, 255, 255, \.72\);[^}]*backdrop-filter: blur\(10px\)/);
  assert.match(styles, /\.pending-queue-heading \{[^}]*min-height: 26px;[^}]*padding: 4px 9px 3px;/);
  assert.match(styles, /\.pending-queue-list \{[^}]*max-height: 174px;[^}]*overflow-y: auto;[^}]*overscroll-behavior-y: contain;[^}]*touch-action: pan-y;/);
  assert.match(styles, /\.pending-queue-item \{[^}]*min-height: 34px;[^}]*padding: 2px 4px 2px 0;/);
  assert.match(styles, /\.workspace\.has-pending-queue \.composer-wrap \{[^}]*position: relative;[^}]*flex: 0 0 auto;[^}]*align-self: center;[^}]*transform: none;/);
  assert.match(styles, /\.workspace\.has-pending-queue \.messages \{ padding-bottom: 24px; \}/);
  assert.match(styles, /:root\[data-theme="dark"\] \.pending-queue \{[^}]*background: rgba\(40, 41, 46, \.72\);/);
});

test("queued jobs expose a skip-queue action in the process panel", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(apiSource, /skipQueuedJob: \(id: string\) => request<\{ ok: true; job\?: Job \}\>\(`\/jobs\/\$\{id\}\/skip-queue`/);
  assert.match(appSource, /跳过排队直接执行/);
  assert.match(appSource, /window\.confirm\("跳过排队将立即启动该任务/);
  assert.match(appSource, /前方还有 \$\{queueStatus\.jobsAhead\} 个任务 · 当前排在第 \$\{queueStatus\.queuePosition\} 位/);
  assert.match(appSource, /前方无任务，即将自动开始/);
  assert.match(appSource, /activity-skip-queue/);
  assert.match(styles, /\.activity-skip-queue \{/);
});

test("live updates pause while reading older paged messages", () => {
  assert.equal(resolveScrollFollow({ previousScrollTop: 500, scrollTop: 496, scrollHeight: 1000, clientHeight: 500, following: true }), false);
  assert.equal(resolveScrollFollow({ previousScrollTop: 420, scrollTop: 420, scrollHeight: 1080, clientHeight: 500, following: true }), true);
  assert.equal(resolveScrollFollow({ previousScrollTop: 500, scrollTop: 510, scrollHeight: 1080, clientHeight: 500, following: false }), true);
  const newest = [
    { id: "m3", created_at: "2026-07-20T00:00:03.000Z", content: "3" },
    { id: "m4", created_at: "2026-07-20T00:00:04.000Z", content: "4" },
  ];
  const older = [
    { id: "m1", created_at: "2026-07-20T00:00:01.000Z", content: "1" },
    { id: "m2", created_at: "2026-07-20T00:00:02.000Z", content: "2" },
    { id: "m3", created_at: "2026-07-20T00:00:03.000Z", content: "updated" },
  ];
  assert.deepEqual(mergeMessagePages(newest, older).map((message) => [message.id, message.content]), [
    ["m1", "1"], ["m2", "2"], ["m3", "updated"], ["m4", "4"],
  ]);
  assert.equal(preservePrependedScrollTop(40, 900, 1350), 490);
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.doesNotMatch(appSource, /scrollIntoView/);
  assert.match(appSource, /messages\.scrollTop <= 80/);
  assert.match(appSource, /conversationMessages\(conversationId, before\)/);
});

test("streaming activity flushes stay outside message list and composer renders", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  // Derived chat values stay constant while a turn streams, so memoized
  // MessageList/MessageCard subtrees can bail out on every 60ms flush.
  assert.match(appSource, /sending \? EMPTY_REASONING_STEPS : collectReasoningSteps\(activities\)/);
  assert.match(appSource, /LiveActivitiesContext\.Provider value=\{activities\}/);
  // Already rendered journal notes keep their identity and are not re-parsed.
  assert.match(appSource, /const ProcessJournalNote = memo\(/);
});

test("progress labels do not report intermediate agent messages as complete", () => {
  assert.equal(summarizeEvent({ type: "item.updated", item: { type: "agent_message", text: "draft" } } as never), null);
  assert.deepEqual(summarizeEvent({ type: "item.completed", item: { type: "agent_message", text: "正在核对表格结构" } } as never), {
    kind: "update", label: "阶段反馈", detail: "正在核对表格结构",
  });
  assert.deepEqual(summarizeEvent({ type: "item.completed", item: { type: "reasoning", text: "先核对排名口径，再制作图表。" } } as never), {
    kind: "reasoning",
    label: "思考过程",
    detail: "先核对排名口径，再制作图表。",
    steps: [{ title: "先核对排名口径，再制作图表。", detail: "先核对排名口径，再制作图表。" }],
  });
  assert.deepEqual(summarizeEvent({ type: "turn.completed" } as never), {
    kind: "status", label: "工作已完成，正在整理结果",
  });
  assert.deepEqual(summarizeEvent({
    type: "item.started",
    item: { type: "command_execution", status: "in_progress", command: "& $py slides_test.py result.pptx" },
  } as never), {
    kind: "command", label: "正在检查演示文稿质量", detail: "& $py slides_test.py result.pptx",
  });
  assert.deepEqual(summarizeEvent({
    type: "item.completed",
    item: { type: "command_execution", status: "completed", command: "Get-Content slides_test.py" },
  } as never), {
    kind: "command", label: "质量验证完成", detail: "Get-Content slides_test.py",
  });
});

test("running work journal retains every important direction and compacts repeated actions", () => {
  const journal = buildProcessJournal([
    { seq: 1, kind: "reasoning", label: "模型思路摘要", detail: "先确认数据口径" },
    { seq: 2, kind: "command", label: "正在读取并核对资料", detail: "rg sales" },
    { seq: 3, kind: "command", label: "资料读取与核对完成", detail: "rg sales" },
    { seq: 31, kind: "command", label: "质量验证完成", detail: "npm test" },
    { seq: 4, kind: "update", label: "阶段反馈", detail: "已确认按自然月统计" },
    { seq: 5, kind: "file", label: "已更新文件", files: ["outputs/report.xlsx"] },
    { seq: 6, kind: "file", label: "已更新文件", files: ["outputs/report.xlsx"] },
    { seq: 7, kind: "reasoning", label: "模型思路摘要", detail: "再验证汇总结果" },
    { seq: 8, kind: "status", label: "工作已完成，正在整理结果" },
    { seq: 9, kind: "update", label: "阶段反馈", detail: "桌面检查通过，继续检查手机布局" },
  ]);
  assert.deepEqual(journal.map((event) => event.seq), [1, 3, 4, 5, 7, 9]);
  assert.equal(journal[1].label, "运行了 2 个本机步骤");
  assert.equal(journal[1].actionCount, 2);
  assert.deepEqual(journal[1].groupedDetails, ["rg sales", "npm test"]);
  assert.deepEqual(journal.filter((event) => ["reasoning", "update"].includes(event.kind ?? "")).map((event) => event.detail), [
    "先确认数据口径", "已确认按自然月统计", "再验证汇总结果", "桌面检查通过，继续检查手机布局",
  ]);
  assert.equal(journal.filter((event) => event.kind === "update").length, 2);
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.doesNotMatch(appSource, /compactActivitySteps\(activities\)\.slice/);
  assert.match(appSource, /journal\.map\(\(activity, index\) => isNarrativeActivity\(activity\)/);
  assert.doesNotMatch(appSource, /stageFeedback|process-journal-pinned/);
  assert.match(styles, /\.process-journal \{[^}]*position: relative;[^}]*overflow-x: hidden;[^}]*border-top:/);
  assert.doesNotMatch(styles, /\.process-journal \{[^}]*max-height:|\.process-journal \{[^}]*overflow-y: auto|\.process-journal \{[^}]*overscroll-behavior-y:/);
  assert.doesNotMatch(styles, /\.process-journal-pinned/);
  assert.doesNotMatch(styles, /\.process-journal[^{]*\{[^}]*position:\s*sticky/);
  assert.match(appSource, /\{sending && <article className="message assistant running"/);
  assert.match(appSource, /完成前持续保留，可随时引导/);
});

test("completed reasoning panel collects incremental steps and legacy details", () => {
  assert.deepEqual(buildReasoningSteps(["先确认数据口径", "再验证汇总结果"], ["先确认数据口径，再核对排名", "再验证汇总结果"]), [
    { title: "先确认数据口径", detail: "先确认数据口径，再核对排名" },
    { title: "再验证汇总结果", detail: "再验证汇总结果" },
  ]);
  assert.deepEqual(buildReasoningSteps(["## 先确认数据口径\n读取表格。"], []), [
    { title: "先确认数据口径", detail: "## 先确认数据口径\n读取表格。" },
  ]);
  assert.equal(buildReasoningSteps([], []), undefined);

  const steps = collectReasoningSteps([
    { kind: "reasoning", detail: "先确认数据口径", steps: [{ title: "先确认数据口径", detail: "先确认数据口径" }] },
    { kind: "reasoning", detail: "先确认数据口径", steps: [{ title: "先确认数据口径", detail: "先确认数据口径，再核对排名" }] },
    { kind: "reasoning", detail: "再验证汇总结果", steps: [{ title: "再验证汇总结果", detail: "再验证汇总结果" }] },
  ]);
  assert.deepEqual(steps, [
    { title: "先确认数据口径", detail: "先确认数据口径，再核对排名" },
    { title: "再验证汇总结果", detail: "再验证汇总结果" },
  ]);

  const legacy = collectReasoningSteps([
    { kind: "reasoning", detail: "## 先确认数据口径\n读取表格。\n\n## 再验证汇总结果\n检查小计。" },
  ]);
  assert.deepEqual(legacy, [
    { title: "先确认数据口径", detail: "## 先确认数据口径\n读取表格。" },
    { title: "再验证汇总结果", detail: "## 再验证汇总结果\n检查小计。" },
  ]);

  assert.deepEqual(collectReasoningSteps([{ kind: "update", detail: "阶段反馈" }]), []);
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /CompletedReasoningPanel/);
  assert.match(appSource, /思考过程/);
  assert.match(styles, /\.reasoning-panel \{/);
  assert.match(styles, /\.reasoning-step-detail/);
  assert.match(styles, /\.reasoning-steps \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.reasoning-step \{ min-width: 0/);
  assert.match(styles, /\.reasoning-step-title \{[^}]*overflow-wrap: anywhere/);
  assert.doesNotMatch(styles, /\.reasoning-step-title \{[^}]*white-space: nowrap/);
});

test("task timing shows live elapsed time and completed total duration", () => {
  assert.equal(formatElapsed(0), "0 秒");
  assert.equal(formatElapsed(45), "45 秒");
  assert.equal(formatElapsed(125), "2 分 05 秒");
  const activities = [
    { seq: 1, type: "status", status: "running", created_at: "2026-08-12T00:00:00.000Z" },
    { seq: 2, type: "status", status: "running", label: "正在登记结果文件", created_at: "2026-08-12T00:02:05.000Z" },
    { seq: 3, type: "done", status: "completed", created_at: "2026-08-12T00:02:05.000Z" },
  ];
  assert.equal(taskElapsedSeconds(activities), 125);
  assert.equal(taskElapsedSeconds([{ seq: 1, type: "status", status: "running", created_at: "2026-08-12T00:00:00.000Z" }]), null);
  assert.equal(taskElapsedSeconds([{ seq: 1, kind: "status", status: "running", created_at: "2026-08-12T00:00:00.000Z" }, { seq: 2, type: "done", created_at: "2026-08-12T00:00:30.000Z" }]), 30);
  assert.equal(taskElapsedSeconds([]), null);

  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(appSource, /reasoningMessageIndex/);
  assert.match(appSource, /reasoningAbove/);
  assert.match(appSource, /总用时/);
  assert.match(appSource, /已用时/);
  assert.match(appSource, /process-timer-row/);
  assert.match(appSource, /reasoning-duration/);
  assert.match(appSource, /activeJob\?\.startedAt/);
  assert.match(styles, /\.process-timer-row/);
  assert.match(styles, /\.reasoning-duration/);
});

test("running progress expands inline without a nested vertical scroller", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  assert.match(appSource, /<ProcessPanel key=\{detail\.conversation\.id\} activities=\{activities\}/);
  assert.match(appSource, /<div className="process-journal">\{journal\.length/);
  assert.doesNotMatch(appSource, /journalElement|journalFollowingRef|handleJournalScroll/);
});

test("recoverable stream errors remain progress events until the turn completes", async () => {
  async function* stream(): AsyncIterable<ThreadEvent> {
    yield { type: "thread.started", thread_id: crypto.randomUUID() } as ThreadEvent;
    yield { type: "turn.started" } as ThreadEvent;
    yield { type: "error", message: "Reconnecting... 2/2 (stream disconnected before completion: websocket closed by server before response.completed)" } as ThreadEvent;
    yield {
      type: "item.completed",
      item: { id: "item_1", type: "error", message: "Falling back from WebSockets to HTTPS transport." },
    } as ThreadEvent;
    yield { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "recovered" } } as ThreadEvent;
    yield { type: "turn.completed", usage: {} } as ThreadEvent;
  }
  const progress: unknown[] = [];
  const response = await consumeTenantTurnEvents(stream(), {
    onThreadStarted: () => undefined,
    onProgress: (event) => progress.push(event),
  });
  assert.equal(response, "recovered");
  assert.ok(progress.some((event) => (event as { status?: string }).status === "retrying"));
});

test("a stream that never completes still fails with its last upstream error", async () => {
  async function* stream(): AsyncIterable<ThreadEvent> {
    yield { type: "turn.started" } as ThreadEvent;
    yield { type: "error", message: "stream disconnected before completion" } as ThreadEvent;
  }
  await assert.rejects(() => consumeTenantTurnEvents(stream(), {
    onThreadStarted: () => undefined,
    onProgress: () => undefined,
  }), /stream disconnected before completion/);
});

test("structured first-turn responses separate the visible answer from a short task title", () => {
  assert.equal(AUTO_TITLE_OUTPUT_SCHEMA.properties.title.maxLength, 10);
  assert.deepEqual(parseAutoTitleResponse(JSON.stringify({
    answer: "文件已经生成。",
    title: "高三家长会成绩分析报告",
  }), "请帮我制作一份家长会成绩分析报告"), {
    answer: "文件已经生成。",
    title: "高三家长会成绩分析报",
  });
  assert.deepEqual(parseAutoTitleResponse("普通完成回复", "请帮我检查这份成绩表"), {
    answer: "普通完成回复",
    title: "检查这份成绩表",
  });
  assert.equal(parseAutoTitleResponse('{"answer":"完成","title":"新任务"}', "整理生物复习资料").title, "整理生物复习资料");
  assert.equal(extractLeakedAutoTitleAnswer('{"answer":"已收到：asdf。未生成任何文件。","title":"输入测试"}'), "已收到：asdf。未生成任何文件。");
  assert.equal(extractLeakedAutoTitleAnswer('```json\n{"answer":"正常回复","title":"后续测试"}\n```'), "正常回复");
  assert.equal(extractLeakedAutoTitleAnswer('{"answer":"用户要求的 JSON","title":"标题","extra":true}'), null);
  assert.equal(extractLeakedAutoTitleAnswer('{"answer":"用户要求的 JSON","title":"这是一个明显超过十个字符的普通字段值"}'), null);
  assert.equal(extractLeakedAutoTitleAnswer('{"answer":"正常回复","title":"NAS 双出口抖动已停止"}', true), "正常回复");
});

test("transient upstream failures use bounded 15/45/120 retry policy", async () => {
  assert.equal(isRetryableUpstreamError("websocket closed by server before response.completed"), true);
  assert.equal(isRetryableUpstreamError("HTTP 503 server overload"), true);
  assert.equal(isRetryableUpstreamError("authentication failed"), false);
  assert.equal(isRetryableUpstreamError("permission denied"), false);

  let calls = 0;
  const notices: Array<{ attempt: number; delayMs: number }> = [];
  const value = await runWithTransientRetries(async () => {
    calls += 1;
    if (calls < 3) throw new Error("stream disconnected before completion");
    return "ok";
  }, {
    signal: new AbortController().signal,
    delaysMs: [0, 0, 0],
    onRetry: ({ attempt, delayMs }) => notices.push({ attempt, delayMs }),
  });
  assert.equal(value, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(notices, [{ attempt: 1, delayMs: 0 }, { attempt: 2, delayMs: 0 }]);

  let permanentCalls = 0;
  await assert.rejects(() => runWithTransientRetries(async () => {
    permanentCalls += 1;
    throw new Error("authentication failed");
  }, { signal: new AbortController().signal, delaysMs: [0, 0, 0] }), /authentication failed/);
  assert.equal(permanentCalls, 1);
});

test("upstream failures get actionable diagnostics while unknowns pass through", () => {
  const auth = describeUpstreamError("unexpected status 401 Unauthorized: Authentication Fails, Your api key: ****cd63 is invalid, url: https://api.deepseek.com/responses");
  assert.match(auth, /^上游认证失败/);
  assert.match(auth, /API Key 无效或已过期/);
  const model = describeUpstreamError("{\"error\":{\"message\":\"模型配置不存在: gpt-5.6-sol\",\"type\":\"invalid_request_error\"}}");
  assert.match(model, /^上游不识别所选模型/);
  const config = describeUpstreamError("failed to load configuration: failed to parse model_catalog_json path `/home/gyli/.codex/models_cache.json` as JSON");
  assert.match(config, /^Codex 配置加载失败/);
  assert.equal(describeUpstreamError("The agent got stuck"), "The agent got stuck");
});

test("path confinement rejects traversal", () => {
  const root = path.join(os.tmpdir(), "cww-root");
  assert.equal(resolveInside(root, "outputs/result.txt"), path.join(root, "outputs", "result.txt"));
  assert.equal(resolveInside(root, "outputs\\legacy.txt"), path.join(root, "outputs", "legacy.txt"));
  assert.equal(resolveInside(root, path.join(root, "outputs", "result.txt")), path.join(root, "outputs", "result.txt"));
  assert.equal(normalizeStoredRelativePath("outputs\\legacy.txt"), "outputs/legacy.txt");
  assert.throws(() => resolveInside(root, "../secret.txt"), /escapes workspace/);
  assert.throws(() => resolveInside(root, path.join(os.tmpdir(), "outside.txt")), /escapes workspace/);
  const safe = safeUploadName("../../bad:name?.pptx");
  assert.match(safe.diskName, /^[0-9a-f-]{36}\.pptx$/);
  assert.equal(safe.displayName, "bad_name_.pptx");
});

test("host working directory validation canonicalizes and rejects managed roots", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-host-working-dir-test-"));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const project = path.join(root, "projects", "alpha");
  const regularFile = path.join(root, "file.txt");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(tenantRoot, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(regularFile, "x", "utf8");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.equal(resolveHostWorkingDir(project, { dataRoot, tenantRoot }), fs.realpathSync(project));
  assert.throws(() => resolveHostWorkingDir("relative/project", { dataRoot, tenantRoot }), /绝对路径/);
  assert.throws(() => resolveHostWorkingDir(path.join(root, "missing"), { dataRoot, tenantRoot }), /不存在/);
  assert.throws(() => resolveHostWorkingDir(regularFile, { dataRoot, tenantRoot }), /目录/);
  assert.throws(() => resolveHostWorkingDir(dataRoot, { dataRoot, tenantRoot }), /租户或数据目录/);
  assert.throws(() => resolveHostWorkingDir(tenantRoot, { dataRoot, tenantRoot }), /租户或数据目录/);
  assert.throws(() => resolveHostWorkingDir(path.parse(root).root, { dataRoot, tenantRoot }), /根目录/);

  const stale = path.join(root, "deleted-project");
  assert.equal(resolveStoredWorkingDirInput(stale), stale);
  assert.throws(() => resolveStoredWorkingDirInput("relative"), /绝对路径/);
});

test("host path browser lists readable directories and rejects managed roots", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-host-path-browser-unit-test-"));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const workspaceRoot = path.join(root, "workspaces");
  const home = path.join(root, "home");
  const project = path.join(home, "project");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(tenantRoot, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "notes.md"), "# 输入\n", "utf8");
  fs.writeFileSync(path.join(dataRoot, "secret.txt"), "secret", "utf8");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const username = process.env.USER || process.env.LOGNAME || "root";
  const options = { dataRoot, tenantRoot, workspaceRoot, home, username };
  const homeListing = listHostDirectory(undefined, options);
  assert.equal(homeListing.path, fs.realpathSync(home));
  assert.ok(homeListing.entries.some((entry) => entry.name === "project" && entry.type === "dir"));

  const projectListing = listHostDirectory(project, options);
  assert.equal(projectListing.path, fs.realpathSync(project));
  assert.ok(projectListing.entries.some((entry) => entry.name === "notes.md" && entry.type === "file" && entry.size === Buffer.byteLength("# 输入\n")));

  assert.throws(() => listHostDirectory("relative/path", options), /绝对路径/);
  assert.throws(() => listHostDirectory(dataRoot, options), /租户或数据目录/);
  assert.throws(() => listHostDirectory(tenantRoot, options), /租户或数据目录/);
  assert.throws(() => listHostDirectory(workspaceRoot, options), /租户或数据目录/);
  assert.throws(() => listHostDirectory(path.join(project, "notes.md"), options), /不是目录/);

  assert.equal(resolveHostReadableFile(path.join(project, "notes.md"), options), fs.realpathSync(path.join(project, "notes.md")));
  assert.throws(() => resolveHostReadableFile(project, options), /普通文件/);
  assert.throws(() => resolveHostReadableFile(path.join(project, "missing.txt"), options), /不存在/);
  assert.throws(() => resolveHostReadableFile(path.join(dataRoot, "secret.txt"), options), /租户或数据目录/);
});

test("the owner tenant has a dedicated Unix identity and workers reject cross-tenant paths", () => {
  const identities = listTenantIdentities();
  assert.deepEqual(identities.map((identity) => identity.label), ["owner"]);
  assert.equal(new Set(identities.map((identity) => identity.uid)).size, identities.length);
  assert.equal(new Set(identities.map((identity) => identity.gid)).size, identities.length);
  const owner = tenantIdentityForUser(LEGACY_USER_ID)!;
  const jobId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const tenantRoot = path.join(os.tmpdir(), "cww-tenants", owner.userId);
  const workspace = path.join(tenantRoot, "conversations", conversationId);
  const request: TenantWorkerRunRequest = {
    jobId,
    userId: owner.userId,
    conversationId,
    projectRoot: process.cwd(),
    pythonRuntimeRoot: path.join(process.cwd(), "python-runtime"),
    tenantRoot,
    workspace,
    runtimeRoot: path.join(workspace, ".runtime", "jobs", jobId),
    codexHome: path.join(tenantRoot, "codex-home"),
    library: path.join(tenantRoot, "library"),
    codexThreadId: null,
    effectivePrompt: "test",
    imagePaths: [path.join(workspace, "uploads", "image.png")],
    selection: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
    sandboxMode: "workspace-write",
    networkAccessEnabled: false,
    webSearchMode: "cached",
    codexWindowsSandbox: "elevated",
    optionalCapabilities: DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
  };
  assert.doesNotThrow(() => validateTenantWorkerRequest(request, owner.userId, tenantRoot));
  const relayRequest: TenantWorkerRunRequest = {
    ...request,
    modelProvider: "chat-provider",
    modelAdapter: {
      kind: "codex-relay",
      executablePath: "/opt/codex-relay/bin/codex-relay",
      providerId: "chat-provider",
      providerName: "Chat Provider",
      upstreamBaseUrl: "https://chat.example.com/v1",
      apiKey: "sk-chat",
    },
  };
  assert.doesNotThrow(() => validateTenantWorkerRequest(relayRequest, owner.userId, tenantRoot));
  assert.throws(
    () => validateTenantWorkerRequest({ ...relayRequest, modelProvider: "other-provider" }, owner.userId, tenantRoot),
    /adapter provider mismatch/,
  );
  assert.throws(() => validateTenantWorkerRequest({ ...request, sandboxMode: "read-only" as never }, owner.userId, tenantRoot), /Invalid worker sandbox mode/);
  assert.throws(() => validateTenantWorkerRequest({ ...request, tenantRoot: path.join(os.tmpdir(), "other") }, owner.userId, tenantRoot), /path mismatch/);
  assert.throws(() => validateTenantWorkerRequest({ ...request, imagePaths: [path.join(tenantRoot, "..", "secret.png")] }, owner.userId, tenantRoot), /escapes workspace/);
  assert.throws(
    () => validateTenantWorkerRequest({ ...request, workingDir: process.cwd() }, owner.userId, tenantRoot),
    /requires host mode/,
  );
  assert.doesNotThrow(
    () => validateTenantWorkerRequest({ ...request, workingDir: process.cwd(), hostMode: true }, owner.userId, tenantRoot),
  );
  assert.throws(
    () => validateTenantWorkerRequest({ ...request, workingDir: "relative/project", hostMode: true }, owner.userId, tenantRoot),
    /Invalid worker working dir/,
  );
  assert.throws(
    () => validateTenantWorkerRequest({ ...request, workingDir: path.join(tenantRoot, "projects", "shared"), hostMode: true }, owner.userId, tenantRoot),
    /escapes tenant boundary/,
  );
  const executionSource = fs.readFileSync(path.join(process.cwd(), "server", "tenant-worker-execution.ts"), "utf8");
  const composeSource = fs.readFileSync(path.join(process.cwd(), "compose.yaml"), "utf8");
  assert.match(executionSource, /executablePath: process\.env\.CODEX_RUNTIME_PATH/);
  assert.match(executionSource, /runtimeWorkspaceRoots: hostMode \? \[request\.workingDir \?\? request\.workspace, request\.workspace, request\.library\] : undefined/);
  // The worker must never enable danger-full-access on its own; it may only
  // pass through a value that was validated and gated by the web app.
  assert.doesNotMatch(executionSource, /sandboxMode\s*=\s*"danger-full-access"|sandbox:\s*"danger-full-access"/);
  const appServerSource = fs.readFileSync(path.join(process.cwd(), "server", "app-server-turn.ts"), "utf8");
  assert.match(appServerSource, /"turn\/steer"/);
  assert.match(appServerSource, /expectedTurnId: this\.activeTurnId/);
  assert.match(appServerSource, /this\.request\("thread\/resume", \{ threadId: this\.options\.threadId, \.\.\.common, excludeTurns: true \}\)/);
  assert.match(appServerSource, /this\.request\("thread\/start", common\)/);
  assert.match(composeSource, /codex-runtime:\/opt\/codex-runtime/);
});

test("conversation workspaces stay concise while tenants receive the managed local spreadsheet skill", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-workspace-guidance-test-"));
  const conversationId = crypto.randomUUID();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = ensureWorkspace(root, conversationId);
  const agentsPath = path.join(workspace, "AGENTS.md");
  const initial = fs.readFileSync(agentsPath, "utf8");
  assert.doesNotMatch(initial, /artifact-tool|For local Excel work|Preserve the source workbook/);
  assert.match(initial, /`CWW_SHARED_PYTHON`/);
  assert.match(initial, /`CWW_JOB_RUNTIME`/);
  assert.match(initial, /`CWW_PYTHON_RUNNER`/);
  assert.match(initial, /Never expose absolute paths/);
  assert.match(initial, /Never read codex-home/);
  fs.appendFileSync(agentsPath, "\n- Keep this custom instruction.\n", "utf8");
  ensureWorkspace(root, conversationId);
  const updated = fs.readFileSync(agentsPath, "utf8");
  assert.match(updated, /Keep this custom instruction/);
  assert.equal(updated.match(/codex-web-managed-start/g)?.length, 1);
  const tenant = ensureTenant(path.join(root, "tenants"), LEGACY_USER_ID);
  const skillPath = path.join(tenant.codexHome, "skills", "local-spreadsheets", "SKILL.md");
  assert.equal(fs.existsSync(skillPath), true);
  assert.match(fs.readFileSync(skillPath, "utf8"), /openpyxl and pandas/);
});

test("agent turn context keeps only current intent, attachments, and conditional safety", () => {
  assert.equal(buildAgentTurnPrompt({ userPrompt: "  请整理这份文件  ", attachments: [] }), "请整理这份文件");
  const withFile = buildAgentTurnPrompt({
    userPrompt: "请汇总",
    attachments: [{ name: "成绩表.xlsx", path: "uploads/abc.xlsx" }],
  });
  assert.match(withFile, /^请汇总\n\n本轮附件：/);
  assert.match(withFile, /成绩表\.xlsx: uploads\/abc\.xlsx/);
  assert.match(withFile, /\$local-spreadsheets/);
  assert.doesNotMatch(withFile, /租户边界|Python 环境策略|绝对路径|answer,title|outputs 中只能/);
  const isolated = buildAgentTurnPrompt({ userPrompt: "检查脚本", attachments: [], isolationReason: "检测到脚本" });
  assert.match(isolated, /离线隔离/);
  assert.match(isolated, /不执行不受信任/);
  assert.equal(buildAgentSteerPrompt("改成蓝色", []), "实时调整当前任务：改成蓝色");
  assert.doesNotMatch(buildAgentTurnPrompt({ userPrompt: "普通任务", attachments: [] }), /Excel attachment rules/);
  const resumed = buildAgentTurnPrompt({ userPrompt: "继续", attachments: [], interruptedContext: `> **${USER_CANCELLED_TASK_MARKER}** retained` });
  assert.match(resumed, /<interrupted_task_context>[\s\S]*retained[\s\S]*<\/interrupted_task_context>/);
});

test("optional agent capabilities stay off until the conversation explicitly asks for them", () => {
  assert.deepEqual(detectOptionalAgentCapabilities(["summarize this file"]), DEFAULT_OPTIONAL_AGENT_CAPABILITIES);
  assert.deepEqual(detectOptionalAgentCapabilities(["请使用子代理并行处理", "enable Gmail connector"]), {
    apps: true, remotePlugin: true, goals: false, multiAgent: true,
  });
  const config = buildOptionalCapabilityConfig(DEFAULT_OPTIONAL_AGENT_CAPABILITIES) as { features: Record<string, boolean>; plugins: Record<string, { enabled: boolean }> };
  assert.equal(Object.values(config.features).every((enabled) => !enabled), true);
  assert.equal(config.plugins["spreadsheets@openai-primary-runtime"].enabled, false);
});

test("each job gets an isolated runtime directory without traversing stale siblings", (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cww-job-runtime-test-"));
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const staleMarker = path.join(workspace, ".runtime", "stale", "marker.txt");
  fs.mkdirSync(path.dirname(staleMarker), { recursive: true });
  fs.writeFileSync(staleMarker, "stale", "utf8");
  const jobId = crypto.randomUUID();
  const runtimeRoot = prepareJobRuntime(workspace, jobId);
  assert.equal(runtimeRoot, path.join(workspace, ".runtime", "jobs", jobId));
  for (const directory of ["uv-cache", "pip-cache", "tmp", "home", "xdg-cache", "xdg-config", "xdg-state", "xdg-runtime"]) {
    assert.equal(fs.existsSync(path.join(runtimeRoot, directory)), true);
  }
  const shellEnvironment = buildShellEnvironment({ uvPath: "uv", pythonPath: "python", runnerPath: "runner", ready: true }, runtimeRoot);
  assert.equal(shellEnvironment.HOME, path.join(runtimeRoot, "home"));
  assert.equal(shellEnvironment.TMPDIR, path.join(runtimeRoot, "tmp"));
  assert.equal(shellEnvironment.XDG_CONFIG_HOME, path.join(runtimeRoot, "xdg-config"));
  assert.equal(fs.readFileSync(staleMarker, "utf8"), "stale");
  cleanupJobRuntime(runtimeRoot);
  assert.equal(fs.existsSync(runtimeRoot), false);
  assert.throws(() => prepareJobRuntime(workspace, "../escape"), /Invalid job id/);
});

test("multipart UTF-8 filename mojibake is repaired without corrupting valid names", () => {
  const originalName = "高二下零诊成绩分析2024.xlsm";
  const latin1Decoded = Buffer.from(originalName, "utf8").toString("latin1");
  assert.equal(normalizeUploadFileName(latin1Decoded), originalName);
  assert.equal(normalizeUploadFileName(originalName), originalName);
  assert.equal(normalizeUploadFileName("café.xlsx"), "café.xlsx");
  assert.equal(safeUploadName(latin1Decoded).displayName, originalName);
});

test("database startup repairs previously stored mojibake upload names", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-name-repair-test-"));
  const conversationId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const originalName = "高二下零诊成绩分析2024.xlsm";
  const latin1Decoded = Buffer.from(originalName, "utf8").toString("latin1");
  const first = new AppDatabase(root);
  first.createConversation(conversationId, "name repair");
  first.addFile({
    id: fileId, conversation_id: conversationId, message_id: null, original_name: latin1Decoded,
    relative_path: path.join("uploads", `${fileId}.xlsm`), mime_type: "application/vnd.ms-excel.sheet.macroEnabled.12",
    size: 10, kind: "upload", created_at: new Date().toISOString(),
  });
  first.close();
  const reopened = new AppDatabase(root);
  context.after(() => { reopened.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(reopened.getFile(fileId)?.original_name, originalName);
  assert.equal(reopened.getFile(fileId)?.relative_path, `uploads/${fileId}.xlsm`);
});

test("production binding permits public bind only when explicitly containerized or host mode opts in", () => {
  const base = loadConfig({
    passwordHash: bcrypt.hashSync("password", 4),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  assert.doesNotThrow(() => assertProductionConfig({ ...base, host: "127.0.0.1", containerized: false }));
  assert.doesNotThrow(() => assertProductionConfig({ ...base, host: "0.0.0.0", containerized: true }));
  assert.doesNotThrow(() => assertProductionConfig({ ...base, host: "0.0.0.0", hostMode: true, allowHostPublicBind: true }));
  assert.throws(() => assertProductionConfig({ ...base, host: "0.0.0.0", containerized: false }), /explicitly allowed/);
  assert.throws(() => assertProductionConfig({ ...base, host: "0.0.0.0", hostMode: true, allowHostPublicBind: false }), /explicitly allowed/);
  assert.throws(() => assertProductionConfig({ ...base, host: "0.0.0.0", containerized: false, hostMode: false, allowHostPublicBind: true }), /explicitly allowed/);
});

test("plain HTTP responses do not force HTTPS upgrades or send HSTS", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-http-headers-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Headers-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const res = await request(instance.app).get("/codex-web/api/health");
  assert.equal(res.status, 200);
  const csp = String(res.headers["content-security-policy"] ?? "");
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  assert.equal(res.headers["strict-transport-security"], undefined);
});

test("agent options use the live catalog (image-capable and text-only) and default to Sol with extra-high reasoning", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-model-options-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "models_cache.json"), JSON.stringify({
    models: [
      {
        slug: "gpt-5.5", display_name: "GPT-5.5", description: "general", priority: 0,
        visibility: "list", input_modalities: ["text", "image"],
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "xhigh" }],
      },
      {
        slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", description: "frontier", priority: 1,
        visibility: "list", input_modalities: ["text", "image"],
        supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }],
      },
      {
        slug: "text-only", display_name: "Text only", priority: 2,
        visibility: "list", input_modalities: ["text"], supported_reasoning_levels: [{ effort: "high" }],
      },
      {
        slug: "hidden-model", display_name: "Hidden", priority: 3,
        visibility: "hide", input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "high" }],
      },
    ],
  }), "utf8");
  const options = loadAgentOptions(loadConfig({ codexHome: root, codexModel: undefined }));
  assert.deepEqual(options.models.map((model) => model.id), ["gpt-5.5", "gpt-5.6-sol", "text-only"]);
  assert.deepEqual(options.models[1].reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(options.reasoningEfforts.at(-1), { id: "max", label: "最大" });
  assert.deepEqual(options.defaults, { model: "gpt-5.6-sol", reasoningEffort: "xhigh", sandbox: "workspace-write" });
  assert.deepEqual(options.sandboxModes.map((mode) => mode.id), ["workspace-write"]);
  assert.deepEqual(resolveAgentSelection(options, "gpt-5.5", "high"), { model: "gpt-5.5", reasoningEffort: "high", sandbox: "workspace-write" });
  assert.deepEqual(resolveAgentSelection(options, "gpt-5.6-sol", "max"), { model: "gpt-5.6-sol", reasoningEffort: "max", sandbox: "workspace-write" });
  assert.deepEqual(repairAgentSelection(options, "retired-model", "high"), { model: "gpt-5.6-sol", reasoningEffort: "xhigh", sandbox: "workspace-write" });
  assert.deepEqual(repairAgentSelection(options, "gpt-5.5", "medium"), { model: "gpt-5.5", reasoningEffort: "xhigh", sandbox: "workspace-write" });
  assert.throws(() => resolveAgentSelection(options, "hidden-model", "high"), /当前不可用/);
  assert.throws(() => resolveAgentSelection(options, "gpt-5.6-sol", "ultra"), /不受该模型支持/);
  assert.throws(() => resolveAgentSelection(options, "gpt-5.5", "high", undefined, "danger-full-access"), /权限模式不可用/);
  fs.writeFileSync(path.join(root, "models_cache.json"), JSON.stringify({ models: [{
    slug: "gpt-5.7-sol", display_name: "GPT-5.7-Sol", priority: 0, visibility: "list",
    input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }],
  }, ...JSON.parse(fs.readFileSync(path.join(root, "models_cache.json"), "utf8")).models] }), "utf8");
  assert.deepEqual(loadAgentOptions(loadConfig({ codexHome: root })).defaults, { model: "gpt-5.7-sol", reasoningEffort: "xhigh", sandbox: "workspace-write" });
  const enabledOptions = loadAgentOptions(loadConfig({ codexHome: root, allowDangerFullAccess: true }));
  assert.deepEqual(enabledOptions.sandboxModes.map((mode) => mode.id), ["workspace-write", "danger-full-access"]);
  assert.deepEqual(resolveAgentSelection(enabledOptions, "gpt-5.7-sol", "xhigh", undefined, "danger-full-access"), { model: "gpt-5.7-sol", reasoningEffort: "xhigh", sandbox: "danger-full-access" });
  assert.deepEqual(repairAgentSelection(enabledOptions, "retired-model", "xhigh", "danger-full-access"), { model: "gpt-5.7-sol", reasoningEffort: "xhigh", sandbox: "danger-full-access" });
});

test("provider management is opt-in and disabled mode reads the user's Codex catalog", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-provider-management-toggle-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Provider-Toggle-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const codexHome = ensureTenant(tenantRoot, LEGACY_USER_ID).codexHome;
  fs.writeFileSync(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: [{
    slug: "local-model", display_name: "Local model", description: "user managed", visibility: "list",
    input_modalities: ["text"], supported_reasoning_levels: [{ effort: "high" }],
  }] }), "utf8");
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Provider-Toggle-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;
  assert.equal(login.body.providerManagementEnabled, false);
  assert.deepEqual((await agent.get("/codex-web/api/agent-options").expect(200)).body.models.map((model: { id: string }) => model.id), ["local-model"]);
  await agent.get("/codex-web/api/providers").expect(403);
  assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false);

  const enabled = await agent.put("/codex-web/api/user-settings/provider-management")
    .set("X-CSRF-Token", csrf).send({ enabled: true }).expect(200);
  assert.equal(enabled.body.providerManagementEnabled, true);
  assert.equal((await agent.get("/codex-web/api/auth/session").expect(200)).body.providerManagementEnabled, true);
  assert.deepEqual((await agent.get("/codex-web/api/providers").expect(200)).body.providers, []);

  const disabled = await agent.put("/codex-web/api/user-settings/provider-management")
    .set("X-CSRF-Token", csrf).send({ enabled: false }).expect(200);
  assert.equal(disabled.body.providerManagementEnabled, false);
  await agent.get("/codex-web/api/providers").expect(403);
});

test("legacy databases gain durable selections and preserve existing titles", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-agent-selection-db-test-"));
  let reopened: AppDatabase | undefined;
  context.after(() => { reopened?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const legacy = new DatabaseSync(path.join(root, "codex-web.sqlite"));
  legacy.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, codex_thread_id TEXT, status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO conversations(id,title,status,created_at,updated_at) VALUES('legacy','Legacy','idle','now','now');
  `);
  legacy.close();

  const first = new AppDatabase(root);
  assert.equal(first.getConversation("legacy")?.agent_model, null);
  assert.equal(first.getConversation("legacy")?.title_source, "legacy");
  assert.equal(first.getConversation("legacy")?.has_unread_result, 0);
  const freshId = crypto.randomUUID();
  first.createConversation(freshId, "新任务");
  assert.equal(first.getConversation(freshId)?.title_source, "default");
  first.updateConversation(freshId, { title: "用户命名", titleSource: "manual" });
  assert.equal(first.setAiConversationTitleIfDefault(freshId, "AI 标题"), false);
  assert.equal(first.getConversation(freshId)?.title, "用户命名");
  assert.equal(first.getConversation(freshId)?.title_source, "manual");
  first.setAgentSelectionPreference({ model: "gpt-5.6-terra", reasoningEffort: "high" });
  first.updateConversation("legacy", { agentSelection: { model: "gpt-5.6-luna", reasoningEffort: "low" } });
  first.close();

  reopened = new AppDatabase(root);
  assert.deepEqual(reopened.getAgentSelectionPreference(), { model: "gpt-5.6-terra", reasoningEffort: "high", provider: null, sandbox: "workspace-write" });
  assert.equal(reopened.getConversation("legacy")?.agent_model, "gpt-5.6-luna");
  assert.equal(reopened.getConversation("legacy")?.reasoning_effort, "low");
  assert.equal(reopened.getConversation("legacy")?.sandbox_mode, "workspace-write");
});

test("legacy task category orders reset once and remain available after a new manual order", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-task-category-order-migration-test-"));
  const settings = { customCategories: [], pinned: [], hidden: [], conversationOrders: { "auto:standalone": ["old-task"] } };
  try {
    const first = new AppDatabase(root, { username: "owner", passwordHash: "", displayName: "Owner" }, false);
    first.setTaskListCategorySettings(settings);
    first.close();

    const database = new DatabaseSync(path.join(root, "codex-web.sqlite"));
    database.prepare("DELETE FROM app_settings WHERE key=?").run("task_list_category_order_reset_v1");
    database.close();

    const migrated = new AppDatabase(root, { username: "owner", passwordHash: "", displayName: "Owner" }, false);
    assert.deepEqual(migrated.getTaskListCategorySettings().conversationOrders, {});
    migrated.setTaskListCategorySettings({ ...settings, conversationOrders: { "auto:standalone": ["new-manual-order"] } });
    migrated.close();

    const reopened = new AppDatabase(root, { username: "owner", passwordHash: "", displayName: "Owner" }, false);
    assert.deepEqual(reopened.getTaskListCategorySettings().conversationOrders, { "auto:standalone": ["new-manual-order"] });
    reopened.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("working directory favorites, defaults, and conversation overrides persist in settings", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-working-dir-db-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  assert.deepEqual(db.getFavoriteWorkingDirectories(), []);
  const favorite = { path: "/srv/projects/alpha", label: "Alpha", added_at: new Date().toISOString() };
  db.setFavoriteWorkingDirectories([favorite]);
  assert.deepEqual(db.getFavoriteWorkingDirectories(), [favorite]);
  assert.equal(db.getDefaultWorkingDir(), null);
  db.setDefaultWorkingDir(favorite.path);
  assert.equal(db.getDefaultWorkingDir(), favorite.path);
  db.setDefaultWorkingDir(null);
  assert.equal(db.getDefaultWorkingDir(), null);

  const conversationId = crypto.randomUUID();
  const stored = db.createConversation(conversationId, "工作目录", undefined, LEGACY_USER_ID, favorite.path);
  assert.equal(stored.working_dir, favorite.path);
  assert.equal(db.getConversation(conversationId)?.working_dir, favorite.path);
  db.updateConversation(conversationId, { workingDir: null });
  assert.equal(db.getConversation(conversationId)?.working_dir, null);
});

test("shared host working dirs serialize queued jobs across conversations", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-working-dir-queue-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const shared = path.join(root, "shared-project");
  fs.mkdirSync(shared, { recursive: true });
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  db.createConversation(first, "first", undefined, LEGACY_USER_ID, shared);
  db.createConversation(second, "second", undefined, LEGACY_USER_ID, shared);
  const runningJob = crypto.randomUUID();
  const queuedJob = crypto.randomUUID();
  db.createJob(runningJob, first);
  db.updateJob(runningJob, "running");
  db.createJob(queuedJob, second);
  assert.equal(db.getNextRunnableQueuedJob()?.id, undefined);
  assert.equal(db.getQueuePosition(queuedJob), 2);
  db.finishJob(runningJob, first, "completed");
  assert.equal(db.getNextRunnableQueuedJob()?.id, queuedJob);
  assert.equal(db.getQueuePosition(queuedJob), 1);
  db.finishJob(queuedJob, second, "completed");
  assert.equal(db.getNextRunnableQueuedJob(), undefined);
});

test("a job marked skip-queue can start while the shared working dir is busy", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-skip-queue-db-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const shared = path.join(root, "shared-project");
  fs.mkdirSync(shared, { recursive: true });
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  db.createConversation(first, "first", undefined, LEGACY_USER_ID, shared);
  db.createConversation(second, "second", undefined, LEGACY_USER_ID, shared);
  const runningJob = crypto.randomUUID();
  const queuedJob = crypto.randomUUID();
  db.createJob(runningJob, first);
  db.updateJob(runningJob, "running");
  db.createJob(queuedJob, second);
  assert.equal(db.getNextRunnableQueuedJob()?.id, undefined);
  assert.equal(db.markJobSkipQueue(queuedJob), true);
  assert.equal(db.getNextSkipQueueJob()?.id, queuedJob);
  const started = db.startJobImmediately(queuedJob);
  assert.equal(started?.id, queuedJob);
  assert.equal(started?.status, "running");
  assert.equal(started?.skip_queue, 1);
  assert.equal(db.getJob(runningJob)?.status, "running");
  assert.equal(db.getNextRunnableQueuedJob(), undefined);
});

test("only finished files under outputs are deliverables", () => {
  assert.equal(isDeliverablePath("outputs/ConditionType 统计结果.xlsx"), true);
  assert.equal(isDeliverablePath("outputs/reports/final.pdf"), true);
  assert.equal(isDeliverablePath("scratch/chart.png"), false);
  assert.equal(isDeliverablePath("outputs/chart.tmp"), false);
  assert.equal(isDeliverablePath("outputs/~$draft.xlsx"), false);
  assert.equal(isDeliverablePath("outputs/../secret.txt"), false);
  assert.equal(isDeliverablePath("deliverables/550e8400-e29b-41d4-a716-446655440000/final.xlsx"), true);
});

test("finished outputs are copied to immutable app storage and legacy rows migrate", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-persisted-output-test-"));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const conversationId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const workspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId);
  const legacyPath = "outputs/中文结果.txt";
  fs.writeFileSync(resolveInside(workspace, legacyPath), "result", "utf8");
  const db = new AppDatabase(dataRoot);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.createConversation(conversationId, "persist output");
  db.addFile({
    id: fileId, conversation_id: conversationId, message_id: null, original_name: "中文结果.txt",
    relative_path: legacyPath, mime_type: "text/plain", size: 6, kind: "output", created_at: new Date().toISOString(),
  });
  const migrated = migrateExistingOutputFiles(loadConfig({ dataRoot, tenantRoot }), db);
  assert.equal(migrated, 1);
  const storedPath = db.getFile(fileId)?.relative_path ?? "";
  assert.equal(isPersistedDeliverablePath(storedPath), true);
  assert.equal(fs.readFileSync(resolveInside(dataRoot, storedPath), "utf8"), "result");
  const anotherId = crypto.randomUUID();
  const copiedPath = await persistDeliverable(dataRoot, workspace, legacyPath, anotherId);
  assert.equal(fs.readFileSync(resolveInside(dataRoot, copiedPath), "utf8"), "result");
});

test("browser preview is limited to formats browsers can display directly", () => {
  const file = (mime_type: string) => ({ mime_type } as WorkFile);
  assert.equal(isBrowserPreviewable(file("image/png")), true);
  assert.equal(isBrowserPreviewable(file("application/pdf")), true);
  assert.equal(isBrowserPreviewable(file("text/plain")), true);
  assert.equal(isBrowserPreviewable(file("text/x-python")), true);
  assert.equal(isBrowserPreviewable(file("text/x-typescript")), true);
  assert.equal(isBrowserPreviewable(file("application/json")), true);
  assert.equal(isBrowserPreviewable(file("application/yaml")), true);
  assert.equal(isBrowserPreviewable(file("application/xml")), true);
  assert.equal(isBrowserPreviewable(file("application/toml")), true);
  assert.equal(isBrowserPreviewable(file("application/vnd.openxmlformats-officedocument.presentationml.presentation")), false);
  assert.equal(isBrowserPreviewable(file("application/octet-stream")), false);
});

test("in-page preview distinguishes Markdown, text, images, and PDFs with a text size cap", () => {
  const file = (mime_type: string, size = 10, original_name = "file.txt") => ({ mime_type, size, original_name, relative_path: `uploads/${original_name}` } as WorkFile);
  assert.equal(filePreviewKind(file("text/markdown")), "markdown");
  assert.equal(filePreviewKind(file("text/plain", 10, "report.md")), "markdown");
  assert.equal(filePreviewKind(file("application/octet-stream", 10, "guide.markdown")), "markdown");
  assert.equal(filePreviewKind(file("text/markdown; charset=utf-8")), "markdown");
  assert.equal(filePreviewKind(file("text/plain")), "text");
  assert.equal(filePreviewKind(file("text/csv")), "text");
  assert.equal(filePreviewKind(file("text/x-python")), "text");
  assert.equal(filePreviewKind(file("text/x-shellscript")), "text");
  assert.equal(filePreviewKind(file("application/json")), "text");
  assert.equal(filePreviewKind(file("application/yaml")), "text");
  assert.equal(filePreviewKind(file("application/toml")), "text");
  assert.equal(filePreviewKind(file("image/png")), "image");
  assert.equal(filePreviewKind(file("application/pdf")), "pdf");
  assert.equal(filePreviewKind(file("application/vnd.openxmlformats-officedocument.presentationml.presentation")), null);
  assert.equal(canPreviewInline(file("text/markdown")), true);
  assert.equal(canPreviewInline(file("text/x-python")), true);
  assert.equal(canPreviewInline(file("text/plain", FILE_PREVIEW_TEXT_LIMIT_BYTES + 1)), false);
  assert.equal(canPreviewInline(file("image/png", 100 * 1024 * 1024)), true);
});

test("output preview ordering keeps the latest previewed files first and selects small Markdown", () => {
  const files = [
    { id: "a", mime_type: "application/pdf", size: 10, original_name: "a.pdf", relative_path: "outputs/a.pdf" },
    { id: "b", mime_type: "text/plain", size: 10, original_name: "report.md", relative_path: "outputs/report.md" },
    { id: "c", mime_type: "application/octet-stream", size: 10, original_name: "data.bin", relative_path: "outputs/data.bin" },
  ] as WorkFile[];
  assert.deepEqual(orderPreviewedFiles(files, ["c", "b", "missing", "b"]).map((file) => file.id), ["c", "b", "a"]);
  assert.equal(firstMarkdownPreviewFile(files)?.id, "b");
  assert.equal(firstMarkdownPreviewFile([{ ...files[1], size: FILE_PREVIEW_TEXT_LIMIT_BYTES + 1 }]), null);
});

test("deliverable mime detection covers code and config files", () => {
  assert.equal(mimeTypeForPath("outputs/script.py"), "text/x-python");
  assert.equal(mimeTypeForPath("outputs/app.ts"), "text/x-typescript");
  assert.equal(mimeTypeForPath("outputs/main.go"), "text/x-go");
  assert.equal(mimeTypeForPath("outputs/schema.yaml"), "application/yaml");
  assert.equal(mimeTypeForPath("outputs/config.toml"), "application/toml");
  assert.equal(mimeTypeForPath("outputs/package.json"), "application/json");
  assert.equal(mimeTypeForPath("outputs/settings.xml"), "application/xml");
  assert.equal(mimeTypeForPath("outputs/deploy.sh"), "text/x-shellscript");
  assert.equal(mimeTypeForPath("outputs/.env"), "text/plain");
  assert.equal(mimeTypeForPath("outputs/.env.local"), "text/plain");
  assert.equal(mimeTypeForPath("outputs/Dockerfile"), "text/x-dockerfile");
  assert.equal(mimeTypeForPath("outputs/Makefile"), "text/x-makefile");
  assert.equal(mimeTypeForPath("outputs/data.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(mimeTypeForPath("outputs/unknown.bin"), "application/octet-stream");
});

test("output files are maintained in conversation details and open in a side-by-side preview", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const serverSource = fs.readFileSync(path.join(process.cwd(), "server", "app.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  const copyPathSource = fs.readFileSync(path.join(process.cwd(), "src", "copy-path.tsx"), "utf8");
  assert.match(apiSource, /outputFiles: WorkFile\[\];/);
  assert.match(apiSource, /host_path\?: string/);
  assert.match(serverSource, /outputFiles = db\.listFiles\(conversation\.id\)\.filter\(\(file\) => file\.kind === "output"\)\.map/);
  assert.match(serverSource, /outputFiles,/);
  assert.match(serverSource, /host_path:/);
  assert.match(appSource, /className=\{`chat-outputs \$\{expanded \? "expanded" : ""\}`\}/);
  assert.match(appSource, /function OutputFilesPanel/);
  assert.match(appSource, /firstMarkdownPreviewFile/);
  assert.match(appSource, /orderPreviewedFiles/);
  assert.match(appSource, /aria-expanded=\{expanded\}/);
  assert.match(appSource, /function FilePreviewPane/);
  assert.match(appSource, /className="file-preview-trigger"/);
  assert.match(copyPathSource, /function CopyPathButton/);
  assert.match(copyPathSource, /className=\{`copy-path-button/);
  assert.match(appSource, /className="file-path"/);
  assert.match(appSource, /className="chat-output-chip-wrap"/);
  assert.match(appSource, /className="unavailable-file-path"/);
  assert.match(appSource, /onPreview=\{onPreview\}/);
  assert.match(appSource, /ReactMarkdown remarkPlugins=\{\[remarkGfm, remarkMath\]\}/);
  assert.match(appSource, /rehypePlugins=\{\[\[rehypeKatex/);
  assert.ok(appSource.indexOf('<main className="workspace"') < appSource.indexOf("<FilePreviewPane"));
  assert.match(styles, /\.file-preview-pane \{/);
  assert.match(styles, /\.file-preview-pane \{[^}]*border-left:/);
  assert.match(styles, /\.chat-outputs \{/);
  assert.match(styles, /\.file-path-copy \{/);
  assert.match(styles, /\.chat-output-chip-wrap \{/);
  assert.match(styles, /\.unavailable-file-path \{/);
  assert.match(styles, /:root\[data-theme="dark"\] \.file-preview-pane/);
});

test("file:line references open a lazy-loading code preview", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const paneSource = fs.readFileSync(path.join(process.cwd(), "src", "code-snippet-pane.tsx"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(apiSource, /codeSnippet: \(conversationId: string/);
  assert.match(apiSource, /code-snippet\?path=/);
  assert.match(appSource, /className="code-snippet-trigger"/);
  assert.match(appSource, /parseCodexSnippetUrl/);
  assert.match(appSource, /parseSnippetHref/);
  assert.match(appSource, /parseFileRef/);
  assert.match(appSource, /onOpenSnippet=\{openCodeSnippet\}/);
  assert.match(appSource, /<CodeSnippetPane/);
  assert.match(paneSource, /function CodeSnippetPane/);
  assert.match(paneSource, /className="code-snippet-scroll"/);
  assert.match(paneSource, /loadMore\("above"\)/);
  assert.match(paneSource, /loadMore\("below"\)/);
  assert.match(paneSource, /data-line-number/);
  assert.match(paneSource, /anchorRef/);
  assert.match(paneSource, /hasLine/);
  assert.match(paneSource, /INITIAL_FROM_START_LINES/);
  assert.match(paneSource, /从头预览/);
  assert.match(styles, /\.code-snippet-lines \{/);
  assert.match(styles, /\.code-snippet-trigger \{/);
  assert.match(styles, /:root\[data-theme="dark"\] \.code-snippet-lines code/);
});

test("message list offers previous/next user message jump controls", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const jumpSource = fs.readFileSync(path.join(process.cwd(), "src", "message-jump.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(jumpSource, /findUserMessageJump/);
  assert.match(jumpSource, /findViewportAnchorMessageId/);
  assert.match(appSource, /className="message-jump-nav"/);
  assert.match(appSource, /onJumpToUserMessage/);
  assert.match(appSource, /jumpPendingRef/);
  assert.match(appSource, /historyLoadVersion/);
  assert.match(appSource, /JUMP_LOAD_PAGE_LIMIT/);
  assert.match(styles, /\.message-jump-nav \{/);
  assert.match(styles, /:root\[data-theme="dark"\] \.message-jump-nav button/);
});

test("output previews expose temporary unauthenticated share links", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const shareSource = fs.readFileSync(path.join(process.cwd(), "server", "share-link.ts"), "utf8");
  const serverSource = fs.readFileSync(path.join(process.cwd(), "server", "app.ts"), "utf8");
  const viteSource = fs.readFileSync(path.join(process.cwd(), "vite.config.ts"), "utf8");
  assert.match(apiSource, /createFileShare: \(id: string\)/);
  assert.match(apiSource, /files\/\$\{id\}\/share/);
  assert.match(appSource, /Share2/);
  assert.match(appSource, /shareable = file\.kind === "output" && isBrowserPreviewable/);
  assert.match(appSource, /api\.createFileShare/);
  assert.match(appSource, /复制分享链接/);
  assert.match(viteSource, /"\/codex-web\/share":/);
  assert.match(serverSource, /\/share\/:token\/download/);
  assert.match(serverSource, /renderShareMarkdown/);
  assert.match(shareSource, /createShareToken/);
  assert.match(shareSource, /parseShareToken/);
  assert.match(shareSource, /SHARE_LIFETIME_SECONDS/);
});

test("risky uploads and execution requests use offline isolation", () => {
  assert.deepEqual(assessTaskPolicy("整理表格", [{ original_name: "source.xlsx" }]), { isolated: false, networkAccessEnabled: true });
  const macro = assessTaskPolicy("看看这个文件", [{ original_name: "unknown.xlsm" }]);
  assert.equal(macro.isolated, true);
  assert.equal(macro.networkAccessEnabled, false);
  assert.equal(assessTaskPolicy("请分析这个恶意软件样本", []).isolated, true);
});

test("conversation archive API keeps history readable, blocks new turns, and restores the sidebar row", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-archive-api-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot,
    username: "owner",
    passwordHash: bcrypt.hashSync("Archive-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Archive-Password-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  const conversationId = created.body.conversation.id as string;
  const threadId = crypto.randomUUID();
  instance.db.updateConversation(conversationId, { codexThreadId: threadId });
  const codexHome = ensureTenant(tenantRoot, LEGACY_USER_ID).codexHome;
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "07", "24");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const rollout = path.join(sessionDirectory, `rollout-2026-07-24T00-00-00-${threadId}.jsonl`);
  fs.writeFileSync(rollout, "history", "utf8");

  assert.equal(codexThreadRolloutBytes(codexHome, threadId), 7);
  const archived = await agent.post(`/codex-web/api/conversations/${conversationId}/archive`).set("X-CSRF-Token", csrf).expect(200);
  assert.ok(archived.body.conversation.archived_at);
  assert.equal((await agent.get("/codex-web/api/conversations").expect(200)).body.conversations.length, 0);
  assert.equal((await agent.get("/codex-web/api/conversations/archived").expect(200)).body.conversations[0].id, conversationId);
  const detail = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.conversation.id, conversationId);
  assert.equal(detail.body.rolloutBytes, 7);
  await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", csrf).field("message", "不应发送").expect(409);

  const restored = await agent.post(`/codex-web/api/conversations/${conversationId}/restore`).set("X-CSRF-Token", csrf).expect(200);
  assert.equal(restored.body.conversation.archived_at, null);
  assert.equal(restored.body.conversation.working_dir, null);
  assert.equal((await agent.get("/codex-web/api/conversations").expect(200)).body.conversations[0].id, conversationId);
});

test("new tasks and persisted outputs avoid workspace initialization until needed", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-lazy-workspace-api-test-"));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot,
    tenantRoot,
    username: "owner",
    passwordHash: bcrypt.hashSync("Lazy-Workspace-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Lazy-Workspace-Password-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  const conversationId = created.body.conversation.id as string;
  const userId = instance.db.getConversation(conversationId)?.user_id ?? LEGACY_USER_ID;
  const workspace = path.join(tenantRoot, userId, "conversations", conversationId);
  assert.equal(fs.existsSync(workspace), false);

  const fileIds: string[] = [];
  const filePaths: string[] = [];
  const fileCount = 128;
  for (let index = 0; index < fileCount; index += 1) {
    const fileId = crypto.randomUUID();
    const relativePath = `deliverables/${fileId}/result-${index}.txt`;
    const absolute = resolveInside(dataRoot, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `result-${index}`, "utf8");
    instance.db.addFile({
      id: fileId,
      conversation_id: conversationId,
      message_id: null,
      original_name: `result-${index}.txt`,
      relative_path: relativePath,
      mime_type: "text/plain",
      size: `result-${index}`.length,
      kind: "output",
      created_at: new Date(Date.now() + index).toISOString(),
    });
    fileIds.push(fileId);
    filePaths.push(relativePath);
  }

  const detail = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.outputFiles.length, fileCount);
  assert.equal(fs.existsSync(workspace), false);

  const file = await agent.get(`/codex-web/api/files/${fileIds[0]}`).expect(200);
  assert.equal(file.text, "result-0");
  assert.equal(fs.existsSync(workspace), false);

  await agent.delete(`/codex-web/api/conversations/${conversationId}`).set("X-CSRF-Token", csrf).expect(204);
  assert.equal(fs.existsSync(workspace), false);
  for (const relativePath of filePaths) assert.equal(fs.existsSync(resolveInside(dataRoot, relativePath)), false);
  assert.equal(instance.db.getFile(fileIds[0])?.relative_path, filePaths[0]);
  assert.ok(instance.db.getConversation(conversationId)?.deleted_at);
});

test("quote-derived task creates an independent draft and sends a source-linked message", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-quote-derived-task-api-test-"));
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    username: "owner",
    passwordHash: bcrypt.hashSync("Derived-Task-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Derived-Task-Password-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;

  const source = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  const sourceId = source.body.conversation.id as string;
  const sourceMessageId = crypto.randomUUID();
  instance.db.addMessage({
    id: sourceMessageId,
    conversation_id: sourceId,
    role: "user",
    content: "原始任务内容",
    created_at: "2026-08-13T10:00:00.000Z",
  });

  const derived = await agent.post("/codex-web/api/conversations/from-source")
    .set("X-CSRF-Token", csrf)
    .send({ sourceConversationId: sourceId, sourceMessageId, excerpt: "选中的来源文本" })
    .expect(201);
  const derivedId = derived.body.conversation.id as string;
  assert.notEqual(derivedId, sourceId);
  assert.equal(derived.body.conversation.working_dir, null);
  assert.equal(derived.body.conversation.codex_thread_id, null);
  assert.equal(derived.body.composerDraft.content, "");
  assert.equal(derived.body.composerDraft.quote_excerpt, "选中的来源文本");
  assert.equal(derived.body.composerDraft.source_reference.sourceConversationId, sourceId);
  assert.equal(derived.body.composerDraft.source_reference.sourceMessageId, sourceMessageId);
  assert.equal(derived.body.composerDraft.source_reference.excerpt, "选中的来源文本");
  assert.equal(instance.db.listMessages(derivedId).length, 0);

  const sent = await agent.post(`/codex-web/api/conversations/${derivedId}/messages`)
    .set("X-CSRF-Token", csrf)
    .field("useComposerDraft", "true")
    .field("message", "根据这段内容继续处理")
    .expect(202);
  assert.ok(sent.body.job?.id);
  const messages = instance.db.listMessages(derivedId);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "根据这段内容继续处理");
  assert.equal(messages[0].quote_excerpt, "选中的来源文本");
  assert.equal(JSON.parse(messages[0].source_reference ?? "{}").sourceMessageId, sourceMessageId);

  const detail = await agent.get(`/codex-web/api/conversations/${derivedId}`).expect(200);
  assert.equal(detail.body.messages[0].source_reference.sourceConversationId, sourceId);
  assert.equal(detail.body.messages[0].source_reference.excerpt, "选中的来源文本");
});

test("side chat migration preserves legacy links and allows multiple threads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-side-chat-migration-test-"));
  const selection = { model: "test-model", reasoningEffort: "medium", sandbox: "workspace-write" as const };
  const first = new AppDatabase(root, undefined, false);
  const parent = first.createConversation(crypto.randomUUID(), "主任务", selection);
  const originalSide = first.createSideConversation(parent, crypto.randomUUID(), selection);
  first.close();

  const legacy = new DatabaseSync(path.join(root, "codex-web.sqlite"));
  legacy.exec("PRAGMA foreign_keys=OFF");
  legacy.exec(`
    ALTER TABLE conversation_side_chats RENAME TO conversation_side_chats_current;
    CREATE TABLE conversation_side_chats (
      parent_conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    INSERT INTO conversation_side_chats(parent_conversation_id,conversation_id,created_at)
    SELECT parent_conversation_id,conversation_id,created_at FROM conversation_side_chats_current;
    DROP TABLE conversation_side_chats_current;
  `);
  legacy.close();

  const migrated = new AppDatabase(root, undefined, false);
  const secondSide = migrated.createSideConversation(parent, crypto.randomUUID(), selection);
  assert.deepEqual(new Set(migrated.listSideConversations(LEGACY_USER_ID, parent.id).map((item) => item.id)), new Set([originalSide.id, secondSide.id]));
  const columns = migrated.sqlite.prepare("PRAGMA table_info(conversation_side_chats)").all() as Array<{ name: string; pk: number }>;
  assert.equal(columns.find((column) => column.name === "parent_conversation_id")?.pk, 0);
  assert.equal(columns.find((column) => column.name === "conversation_id")?.pk, 1);
  assert.ok(columns.some((column) => column.name === "last_opened_at"));
  migrated.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("side chat keeps an independent model and persists exact JSONL references", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-side-chat-api-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot,
    username: "owner",
    passwordHash: bcrypt.hashSync("Side-Chat-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Side-Chat-Password-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;

  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  const parentId = created.body.conversation.id as string;
  const parentSelection = created.body.agentSelection as { model: string; reasoningEffort: string; sandbox: string; provider?: string | null };
  const sourceMessageId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const sourceCreatedAt = "2026-08-31T08:00:01.000Z";
  const sourceContent = "第一段\n需要在侧边核对的语句\n最后一段";
  instance.db.updateConversation(parentId, { codexThreadId: threadId });
  instance.db.addMessage({
    id: sourceMessageId,
    conversation_id: parentId,
    role: "assistant",
    content: sourceContent,
    created_at: sourceCreatedAt,
  });
  const codexHome = ensureTenant(tenantRoot, LEGACY_USER_ID).codexHome;
  const rolloutDirectory = path.join(codexHome, "sessions", "2026", "08", "31");
  fs.mkdirSync(rolloutDirectory, { recursive: true });
  const rolloutPath = path.join(rolloutDirectory, `rollout-${threadId}.jsonl`);
  const metaLine = JSON.stringify({ timestamp: "2026-08-31T08:00:00.000Z", type: "session_meta", payload: { id: threadId } });
  const messageLine = JSON.stringify({
    timestamp: sourceCreatedAt,
    type: "response_item",
    payload: { id: "assistant-item", type: "message", role: "assistant", content: [{ type: "output_text", text: sourceContent }] },
  });
  fs.writeFileSync(rolloutPath, `${metaLine}\n${messageLine}\n`, "utf8");

  const sideCreated = await agent.post(`/codex-web/api/conversations/${parentId}/side-chat`).set("X-CSRF-Token", csrf).expect(201);
  const sideId = sideCreated.body.conversation.id as string;
  assert.notEqual(sideId, parentId);
  assert.equal(sideCreated.body.agentSelection.model, parentSelection.model);
  assert.deepEqual((await agent.get("/codex-web/api/conversations").expect(200)).body.conversations.map((item: { id: string }) => item.id), [parentId]);
  assert.equal((await agent.get(`/codex-web/api/conversations/${parentId}/side-chat`).expect(200)).body.conversation.id, sideId);

  const options = await agent.get("/codex-web/api/agent-options").expect(200);
  const alternateModel = options.body.models.find((model: { id: string }) => model.id !== parentSelection.model);
  assert.ok(alternateModel);
  const alternateEffort = alternateModel.reasoningEfforts[0] as string;
  await agent.put(`/codex-web/api/conversations/${sideId}/agent-selection`)
    .set("X-CSRF-Token", csrf)
    .send({ model: alternateModel.id, reasoningEffort: alternateEffort, sandbox: parentSelection.sandbox, provider: alternateModel.provider ?? null })
    .expect(200);
  assert.equal((await agent.get(`/codex-web/api/conversations/${sideId}`).expect(200)).body.agentSelection.model, alternateModel.id);
  assert.equal((await agent.get(`/codex-web/api/conversations/${parentId}`).expect(200)).body.agentSelection.model, parentSelection.model);

  const referenced = await agent.post(`/codex-web/api/conversations/${parentId}/side-chat/reference`)
    .set("X-CSRF-Token", csrf)
    .send({ sourceMessageId, excerpt: "需要在侧边核对的语句", content: "请检查这段判断" })
    .expect(200);
  assert.equal(referenced.body.conversation.id, sideId);
  assert.equal(referenced.body.reference.sourceMessageId, sourceMessageId);
  assert.deepEqual(referenced.body.reference.sourceLocation, {
    kind: "codex-rollout",
    threadId,
    path: `sessions/2026/08/31/rollout-${threadId}.jsonl`,
    line: 2,
    byteOffset: Buffer.byteLength(`${metaLine}\n`, "utf8"),
    recordType: "response_item",
    jsonPointer: "/payload/content/0/text",
    itemId: "assistant-item",
    textStart: 4,
    textEnd: 14,
  });
  assert.equal(referenced.body.composerDraft.source_reference.sourceLocation.line, 2);

  await agent.post(`/codex-web/api/conversations/${sideId}/messages`)
    .set("X-CSRF-Token", csrf)
    .field("message", "请检查这段判断")
    .field("quoteExcerpt", "需要在侧边核对的语句")
    .field("useComposerDraft", "true")
    .expect(202);
  const firstSideMessage = instance.db.listMessages(sideId)[0];
  assert.equal(JSON.parse(firstSideMessage.source_reference ?? "{}").sourceLocation.line, 2);

  const contextReferenced = await agent.post(`/codex-web/api/conversations/${parentId}/side-chat/context`)
    .set("X-CSRF-Token", csrf)
    .expect(200);
  assert.equal(contextReferenced.body.conversation.id, sideId);
  assert.equal(contextReferenced.body.reference.kind, "conversation-context");
  assert.equal(contextReferenced.body.reference.messageCount, 1);
  assert.match(contextReferenced.body.reference.excerpt, /Codex/);
  assert.equal(contextReferenced.body.composerDraft.source_reference.kind, "conversation-context");

  await agent.post(`/codex-web/api/conversations/${parentId}/side-chat/reference`)
    .set("X-CSRF-Token", csrf)
    .send({ sourceMessageId, excerpt: "需要在侧边核对的语句", content: "再检查一次" })
    .expect(200);
  const queued = await agent.post(`/codex-web/api/conversations/${sideId}/messages`)
    .set("X-CSRF-Token", csrf)
    .field("message", "再检查一次")
    .field("quoteExcerpt", "需要在侧边核对的语句")
    .field("useComposerDraft", "true")
    .expect(202);
  assert.equal(queued.body.pendingPrompt.source_reference.sourceLocation.line, 2);
  const sideDetail = await agent.get(`/codex-web/api/conversations/${sideId}`).expect(200);
  assert.equal(sideDetail.body.pendingPrompts[0].source_reference.sourceMessageId, sourceMessageId);

  await agent.post(`/codex-web/api/conversations/${sideId}/cancel`).set("X-CSRF-Token", csrf).expect(200);
  await agent.delete(`/codex-web/api/conversations/${sideId}/pending-prompts/${queued.body.pendingPrompt.id}`).set("X-CSRF-Token", csrf).expect(204);
  await agent.post(`/codex-web/api/conversations/${sideId}/archive`).set("X-CSRF-Token", csrf).expect(404);

  const secondSideCreated = await agent.post(`/codex-web/api/conversations/${parentId}/side-chats`).set("X-CSRF-Token", csrf).expect(201);
  const secondSideId = secondSideCreated.body.conversation.id as string;
  assert.notEqual(secondSideId, sideId);
  const sideHistory = await agent.get("/codex-web/api/side-chats").expect(200);
  assert.deepEqual(new Set(sideHistory.body.sideChats.map((item: { conversation: { id: string } }) => item.conversation.id)), new Set([sideId, secondSideId]));
  assert.ok(sideHistory.body.sideChats.every((item: { parentConversationId: string }) => item.parentConversationId === parentId));
  assert.equal((await agent.get(`/codex-web/api/conversations/${parentId}/side-chats`).expect(200)).body.sideChats.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await agent.post(`/codex-web/api/side-chats/${sideId}/open`).set("X-CSRF-Token", csrf).expect(200);
  assert.equal((await agent.get(`/codex-web/api/conversations/${parentId}/side-chat`).expect(200)).body.conversation.id, sideId);

  const selectedContext = await agent.post(`/codex-web/api/side-chats/${secondSideId}/context`)
    .set("X-CSRF-Token", csrf)
    .send({ sourceConversationId: parentId })
    .expect(200);
  assert.equal(selectedContext.body.conversation.id, secondSideId);
  assert.equal(selectedContext.body.reference.sourceConversationId, parentId);

  await agent.post(`/codex-web/api/conversations/${parentId}/archive`).set("X-CSRF-Token", csrf).expect(200);
  assert.ok(instance.db.getConversation(sideId)?.archived_at);
  assert.ok(instance.db.getConversation(secondSideId)?.archived_at);
  await agent.post(`/codex-web/api/conversations/${parentId}/restore`).set("X-CSRF-Token", csrf).expect(200);
  assert.equal(instance.db.getConversation(sideId)?.archived_at, null);
  assert.equal(instance.db.getConversation(secondSideId)?.archived_at, null);

  const parentWorkspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, parentId);
  const sideWorkspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, sideId);
  const secondSideWorkspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, secondSideId);
  await agent.delete(`/codex-web/api/conversations/${parentId}`).set("X-CSRF-Token", csrf).expect(204);
  assert.ok(instance.db.getConversation(parentId)?.deleted_at);
  assert.ok(instance.db.getConversation(sideId)?.deleted_at);
  assert.ok(instance.db.getConversation(secondSideId)?.deleted_at);
  assert.equal(fs.existsSync(parentWorkspace), false);
  assert.equal(fs.existsSync(sideWorkspace), false);
  assert.equal(fs.existsSync(secondSideWorkspace), false);
  assert.equal(fs.existsSync(rolloutPath), false);
});

test("host mode restore derives a missing working directory from the rollout and recategorizes", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-host-restore-working-dir-test-"));
  const project = path.join(root, "projects", "restored-project");
  fs.mkdirSync(project, { recursive: true });
  const canonicalProject = fs.realpathSync(project);
  const codexHome = path.join(root, "codex-home");
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    username: "no-such-system-user-zzz",
    passwordHash: bcrypt.hashSync("Restore-WorkingDir-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
    hostMode: true,
    codexHome,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "no-such-system-user-zzz", password: "Restore-WorkingDir-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  const conversationId = created.body.conversation.id as string;
  assert.equal(created.body.conversation.working_dir, null);
  const threadId = crypto.randomUUID();
  instance.db.updateConversation(conversationId, { codexThreadId: threadId });
  writeSyntheticCodexSession(codexHome, threadId, { cwd: project });

  await agent.post(`/codex-web/api/conversations/${conversationId}/archive`).set("X-CSRF-Token", csrf).expect(200);
  const restored = await agent.post(`/codex-web/api/conversations/${conversationId}/restore`).set("X-CSRF-Token", csrf).expect(200);
  assert.equal(restored.body.conversation.archived_at, null);
  assert.equal(restored.body.conversation.working_dir, canonicalProject);
  assert.equal(instance.db.getConversation(conversationId)?.working_dir, canonicalProject);
});

test("reload status API proxies the reloader state and reports unavailable", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-reload-status-api-test-"));
  const reloader = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      state: "waiting",
      busy: true,
      lastResult: { command: "idle-check", ok: true, finishedAt: "2026-08-12T00:00:00.000Z", idle: false, running: 1 },
    }));
  });
  await new Promise<void>((resolve) => reloader.listen(0, "127.0.0.1", resolve));
  const address = reloader.address();
  assert.ok(address && typeof address === "object");
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    username: "owner",
    passwordHash: bcrypt.hashSync("ReloadStatus-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
    reloaderStatusUrl: `http://127.0.0.1:${address.port}`,
  });
  context.after(() => {
    instance.db.close();
    reloader.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const agent = request.agent(instance.app);
  await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "ReloadStatus-Password-2026!" }).expect(200);

  const status = await agent.get("/codex-web/api/reload-status").expect(200);
  assert.equal(status.body.available, true);
  assert.equal(status.body.state, "waiting");
  assert.equal(status.body.lastResult.running, 1);

  await new Promise<void>((resolve) => reloader.close(() => resolve()));
  const unavailable = await agent.get("/codex-web/api/reload-status").expect(200);
  assert.equal(unavailable.body.available, false);
});

test("web UI surfaces reloader status and asks for a refresh after success", () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src", "api.ts"), "utf8");
  const styles = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
  assert.match(apiSource, /reloadStatus: \(\) => request<ReloadStatus>\("\/reload-status"\)/);
  assert.match(appSource, /服务已重启成功，请刷新页面以加载最新版本/);
  assert.match(appSource, /RELOAD_STATUS_POLL_MS/);
  assert.match(appSource, /window\.location\.reload\(\)/);
  assert.match(styles, /\.reload-banner/);
});

test("single-user login and CSRF protection", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot,
    username: "owner",
    passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);

  await agent.post("/codex-web/api/auth/login").send({ username: "wrong", password: "Correct-Horse-2026!" }).expect(401);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);
  assert.equal(login.body.authenticated, true);
  assert.ok(login.body.csrfToken);
  assert.equal(login.body.chatFontSize, CHAT_FONT_SIZE_DEFAULT);
  assert.equal(login.body.chatColumnWidth, CHAT_COLUMN_WIDTH_DEFAULT);
  await agent.put("/codex-web/api/user-settings/chat-font-size")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ chatFontSize: 19 }).expect(200, { chatFontSize: 19 });
  const restoredSession = await agent.get("/codex-web/api/auth/session").expect(200);
  assert.equal(restoredSession.body.chatFontSize, 19);
  await agent.put("/codex-web/api/user-settings/chat-font-size")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ chatFontSize: "large" }).expect(400);
  await agent.put("/codex-web/api/user-settings/chat-column-width")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ chatColumnWidth: 1080 }).expect(200, { chatColumnWidth: 1080 });
  const restoredSessionWidth = await agent.get("/codex-web/api/auth/session").expect(200);
  assert.equal(restoredSessionWidth.body.chatColumnWidth, 1080);
  await agent.put("/codex-web/api/user-settings/chat-column-width")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ chatColumnWidth: "huge" }).expect(400);

  const options = await agent.get("/codex-web/api/agent-options").expect(200);
  assert.equal(options.body.defaults.model, "gpt-5.6-sol");
  assert.equal(options.body.defaults.reasoningEffort, "xhigh");
  assert.equal(options.body.defaults.sandbox, "workspace-write");
  assert.deepEqual(options.body.sandboxModes.map((mode: { id: string }) => mode.id), ["workspace-write"]);
  assert.deepEqual(options.body.selection, { model: "gpt-5.6-sol", reasoningEffort: "xhigh", sandbox: "workspace-write" });
  assert.equal(options.body.codexConfigured, true);
  await agent.put("/codex-web/api/agent-selection")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ model: "gpt-5.6-sol", reasoningEffort: "xhigh", sandbox: "danger-full-access" }).expect(400);

  await agent.post("/codex-web/api/conversations").expect(403);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  assert.equal(created.body.conversation.title, "新任务");
  assert.equal(created.body.conversation.title_source, "default");
  assert.equal(created.body.conversation.has_unread_result, 0);
  assert.equal(created.body.conversation.working_dir, null);
  assert.deepEqual(created.body.agentSelection, { model: "gpt-5.6-sol", reasoningEffort: "xhigh", sandbox: "workspace-write" });
  const workingDirSettings = await agent.get("/codex-web/api/working-dirs").expect(200);
  assert.equal(workingDirSettings.body.settings.enabled, false);
  await agent.put("/codex-web/api/working-dirs/favorites")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ action: "add", path: process.cwd() }).expect(403);
  await agent.post("/codex-web/api/conversations")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ workingDir: process.cwd() }).expect(403);
  await agent.put(`/codex-web/api/conversations/${created.body.conversation.id}/agent-selection`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ model: "gpt-5.6-luna", reasoningEffort: "low" }).expect(200);
  const second = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  assert.deepEqual(second.body.agentSelection, { model: "gpt-5.6-luna", reasoningEffort: "low", sandbox: "workspace-write" });
  const unreadJobId = crypto.randomUUID();
  instance.db.createJob(unreadJobId, created.body.conversation.id);
  instance.db.finishJob(unreadJobId, created.body.conversation.id, "completed");
  assert.equal((await agent.get("/codex-web/api/conversations").expect(200)).body.conversations.find((row: { id: string }) => row.id === created.body.conversation.id).has_unread_result, 1);
  await agent.post(`/codex-web/api/conversations/${created.body.conversation.id}/seen`).expect(403);
  const seen = await agent.post(`/codex-web/api/conversations/${created.body.conversation.id}/seen`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(seen.body.conversation.has_unread_result, 0);
  const renamed = await agent.patch(`/codex-web/api/conversations/${second.body.conversation.id}`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ title: "我的自定义标题" }).expect(200);
  assert.equal(renamed.body.conversation.title_source, "manual");
  assert.equal(instance.db.setAiConversationTitleIfDefault(second.body.conversation.id, "AI 不应覆盖"), false);
  assert.equal(instance.db.getConversation(second.body.conversation.id)?.title, "我的自定义标题");
  await agent.put(`/codex-web/api/conversations/${second.body.conversation.id}/agent-selection`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ model: "gpt-5.6-terra", reasoningEffort: "high" }).expect(200);
  const firstDetail = await agent.get(`/codex-web/api/conversations/${created.body.conversation.id}`).expect(200);
  assert.deepEqual(firstDetail.body.agentSelection, { model: "gpt-5.6-luna", reasoningEffort: "low", sandbox: "workspace-write" });

  const codexHome = ensureTenant(tenantRoot, LEGACY_USER_ID).codexHome;
  fs.writeFileSync(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: [{
    slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", description: "frontier", priority: 0,
    visibility: "list", input_modalities: ["text", "image"],
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "xhigh" }],
  }] }), "utf8");
  const repaired = await agent.get(`/codex-web/api/conversations/${created.body.conversation.id}`).expect(200);
  assert.deepEqual(repaired.body.agentSelection, { model: "gpt-5.6-sol", reasoningEffort: "xhigh", sandbox: "workspace-write" });
  assert.equal(instance.db.getConversation(created.body.conversation.id)?.agent_model, "gpt-5.6-sol");
  await agent.get("/codex-web/api/conversations").expect(200);

  const fileId = crypto.randomUUID();
  const originalName = "高三生物复习大纲与冲刺指南.pptx";
  const relativePath = path.join("outputs", originalName);
  const absolutePath = path.join(ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, created.body.conversation.id), relativePath);
  fs.writeFileSync(absolutePath, Buffer.from("pptx-test"));
  instance.db.addFile({
    id: fileId, conversation_id: created.body.conversation.id, message_id: null,
    original_name: originalName, relative_path: relativePath,
    mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: 9, kind: "output", created_at: new Date().toISOString(),
  });
  const detailWithOutput = await agent.get(`/codex-web/api/conversations/${created.body.conversation.id}`).expect(200);
  assert.equal(detailWithOutput.body.outputFiles.length, 1);
  assert.equal(detailWithOutput.body.outputFiles[0].original_name, originalName);
  assert.equal(detailWithOutput.body.outputFiles[0].host_path, absolutePath);
  const download = await agent.get(`/codex-web/api/files/${fileId}?download=1`).expect(200);
  assert.equal(download.headers["cache-control"], "private, no-store");
  assert.match(download.headers["content-disposition"], /^attachment; filename="download\.pptx"; filename\*=UTF-8''/);
  assert.match(download.headers["content-disposition"], /%E9%AB%98%E4%B8%89%E7%94%9F%E7%89%A9/);

  await agent.post(`/codex-web/api/conversations/${created.body.conversation.id}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "请制作一份很长很长的家长会成绩分析演示文稿").expect(202);
  assert.equal(instance.db.getConversation(created.body.conversation.id)?.title, "新任务");
  assert.equal(instance.db.getConversation(created.body.conversation.id)?.title_source, "default");
});

test("danger-full-access is only available after the admin opt-in and persists per conversation", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-danger-access-api-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    username: "owner",
    passwordHash: bcrypt.hashSync("Danger-Full-Access-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
    allowDangerFullAccess: true,
  });
  context.after(() => instance.db.close());
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Danger-Full-Access-2026!" }).expect(200);

  const options = await agent.get("/codex-web/api/agent-options").expect(200);
  assert.deepEqual(options.body.sandboxModes.map((mode: { id: string }) => mode.id), ["workspace-write", "danger-full-access"]);
  assert.equal(options.body.defaults.sandbox, "workspace-write");

  const saved = await agent.put("/codex-web/api/agent-selection")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ model: "gpt-5.6-sol", reasoningEffort: "xhigh", sandbox: "danger-full-access" }).expect(200);
  assert.deepEqual(saved.body.selection, { model: "gpt-5.6-sol", reasoningEffort: "xhigh", sandbox: "danger-full-access" });

  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  assert.deepEqual(created.body.agentSelection, { model: "gpt-5.6-sol", reasoningEffort: "xhigh", sandbox: "danger-full-access" });
  assert.equal(instance.db.getConversation(created.body.conversation.id)?.sandbox_mode, "danger-full-access");

  const downgraded = await agent.put(`/codex-web/api/conversations/${created.body.conversation.id}/agent-selection`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ model: "gpt-5.6-sol", reasoningEffort: "xhigh", sandbox: "workspace-write" }).expect(200);
  assert.equal(downgraded.body.selection.sandbox, "workspace-write");
  assert.equal(instance.db.getConversation(created.body.conversation.id)?.sandbox_mode, "workspace-write");
});

test("message attachments and composer drafts expose host paths for copyable display", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-file-host-path-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id;
  const userId = instance.db.getConversation(conversationId)?.user_id ?? LEGACY_USER_ID;
  const workspace = ensureTenant(tenantRoot, userId).conversations;
  const messageId = crypto.randomUUID();
  instance.db.addMessage({ id: messageId, conversation_id: conversationId, role: "user", content: "任务", created_at: new Date().toISOString() });
  const uploadId = crypto.randomUUID();
  instance.db.addFile({
    id: uploadId, conversation_id: conversationId, message_id: messageId,
    original_name: "source.pdf", relative_path: path.posix.join("uploads", `${uploadId}.pdf`),
    mime_type: "application/pdf", size: 12, kind: "upload", created_at: new Date().toISOString(),
  });
  const detail = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  const messageFile = detail.body.messages.find((message: { id: string }) => message.id === messageId)?.files[0];
  assert.ok(messageFile);
  assert.equal(messageFile.host_path, path.join(workspace, conversationId, "uploads", `${uploadId}.pdf`));

  const draftUpload = await agent.post(`/codex-web/api/conversations/${conversationId}/draft/files`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .attach("files", Buffer.from("draft"), { filename: "draft.txt", contentType: "text/plain" })
    .expect(201);
  assert.equal(draftUpload.body.composerDraft.files.length, 1);
  assert.ok(draftUpload.body.composerDraft.files[0].host_path.startsWith(path.join(workspace, conversationId, "uploads")));
  assert.ok(draftUpload.body.composerDraft.files[0].host_path.endsWith(".txt"));
});

test("code snippet API returns bounded line windows and rejects unsafe paths", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-code-snippet-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id;
  const userId = instance.db.getConversation(conversationId)?.user_id ?? LEGACY_USER_ID;
  const workspace = ensureTenantWorkspace(tenantRoot, userId, conversationId);
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "demo.py"), Array.from({ length: 90 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
  const base = `/codex-web/api/conversations/${conversationId}/code-snippet`;

  const middle = await agent.get(`${base}?path=${encodeURIComponent("src/demo.py")}&line=50&before=10&after=10`).expect(200);
  assert.equal(middle.body.totalLines, 90);
  assert.equal(middle.body.start, 40);
  assert.equal(middle.body.end, 60);
  assert.equal(middle.body.lines.length, 21);
  assert.equal(middle.body.lines[10], "line 50");
  assert.equal(middle.body.path, "src/demo.py");

  const top = await agent.get(`${base}?path=${encodeURIComponent("src/demo.py")}&line=1&before=20&after=0`).expect(200);
  assert.equal(top.body.start, 1);
  assert.equal(top.body.end, 1);
  const bottom = await agent.get(`${base}?path=${encodeURIComponent("src/demo.py")}&line=90&before=0&after=20`).expect(200);
  assert.equal(bottom.body.start, 90);
  assert.equal(bottom.body.end, 90);
  const lazy = await agent.get(`${base}?path=${encodeURIComponent("src/demo.py")}&line=61&before=0&after=10`).expect(200);
  assert.equal(lazy.body.start, 61);
  assert.equal(lazy.body.end, 71);
  assert.equal(lazy.body.lines[0], "line 61");

  await agent.get(`${base}?path=${encodeURIComponent("src/demo.py")}&line=1&before=1000`).expect(400);
  await agent.get(`${base}?path=${encodeURIComponent("../../etc/passwd")}&line=1`).expect(404);
  await agent.get(`${base}?path=${encodeURIComponent("/etc/passwd")}&line=1`).expect(404);
  await agent.get(`${base}?path=${encodeURIComponent("src/missing.py")}&line=1`).expect(404);
  fs.writeFileSync(path.join(workspace, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
  await agent.get(`${base}?path=${encodeURIComponent("bin.dat")}&line=1`).expect(400);

  const registeredId = crypto.randomUUID();
  fs.writeFileSync(path.join(workspace, "uploads", "a.py"), "x = 1\n");
  instance.db.addFile({
    id: registeredId, conversation_id: conversationId, message_id: null,
    original_name: "a.py", relative_path: "uploads/a.py",
    mime_type: "text/x-python", size: 7, kind: "upload", created_at: new Date().toISOString(),
  });
  const registered = await agent.get(`${base}?path=${encodeURIComponent("a.py")}&line=1&before=0&after=0`).expect(200);
  assert.equal(registered.body.originalName, "a.py");
  assert.equal(registered.body.totalLines, 1);

  await agent.post(`/codex-web/api/conversations/${conversationId}/archive`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  await agent.get(`${base}?path=${encodeURIComponent("src/demo.py")}&line=50`).expect(200);
});

test("code snippet API resolves absolute paths inside the host working directory", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-code-snippet-absolute-test-"));
  const tenantRoot = path.join(root, "tenants");
  const workingDir = path.join(root, "project");
  fs.mkdirSync(path.join(workingDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(workingDir, "src", "demo.py"), Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    hostMode: true, codexHome: path.join(root, "codex-home"),
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id;
  instance.db.updateConversation(conversationId, { workingDir });
  const base = `/codex-web/api/conversations/${conversationId}/code-snippet`;

  const inside = await agent.get(`${base}?path=${encodeURIComponent(path.join(workingDir, "src", "demo.py"))}&line=20&before=2&after=2`).expect(200);
  assert.equal(inside.body.totalLines, 40);
  assert.equal(inside.body.lines[2], "line 20");

  const outside = path.join(root, "outside.py");
  fs.writeFileSync(outside, "x = 1\n");
  await agent.get(`${base}?path=${encodeURIComponent(outside)}&line=1`).expect(404);
});

test("output files can be shared as temporary unauthenticated preview links", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-share-link-test-"));
  const tenantRoot = path.join(root, "tenants");
  const secret = "test-share-secret-that-is-longer-than-thirty-two-chars";
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: secret,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id;
  const userId = instance.db.getConversation(conversationId)?.user_id ?? LEGACY_USER_ID;
  const workspace = ensureTenantWorkspace(tenantRoot, userId, conversationId);
  const now = new Date().toISOString();

  const markdownId = crypto.randomUUID();
  fs.writeFileSync(path.join(workspace, "outputs", "report.md"), "# 报告\n\nhello 中文\n");
  instance.db.addFile({
    id: markdownId, conversation_id: conversationId, message_id: null,
    original_name: "report.md", relative_path: "outputs/report.md",
    mime_type: "text/markdown", size: 15, kind: "output", created_at: now,
  });
  const imageId = crypto.randomUUID();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(path.join(workspace, "outputs", "chart.png"), png);
  instance.db.addFile({
    id: imageId, conversation_id: conversationId, message_id: null,
    original_name: "chart.png", relative_path: "outputs/chart.png",
    mime_type: "image/png", size: png.length, kind: "output", created_at: now,
  });
  const uploadId = crypto.randomUUID();
  fs.writeFileSync(path.join(workspace, "uploads", "note.txt"), "private upload");
  instance.db.addFile({
    id: uploadId, conversation_id: conversationId, message_id: null,
    original_name: "note.txt", relative_path: "uploads/note.txt",
    mime_type: "text/plain", size: 14, kind: "upload", created_at: now,
  });
  const xlsxId = crypto.randomUUID();
  fs.writeFileSync(path.join(workspace, "outputs", "data.xlsx"), "xlsx-bytes");
  instance.db.addFile({
    id: xlsxId, conversation_id: conversationId, message_id: null,
    original_name: "data.xlsx", relative_path: "outputs/data.xlsx",
    mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 10, kind: "output", created_at: now,
  });
  const bigTextId = crypto.randomUUID();
  fs.writeFileSync(path.join(workspace, "outputs", "big.txt"), Buffer.concat([Buffer.from("# big text\n"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)]));
  instance.db.addFile({
    id: bigTextId, conversation_id: conversationId, message_id: null,
    original_name: "big.txt", relative_path: "outputs/big.txt",
    mime_type: "text/plain", size: 2 * 1024 * 1024 + 11, kind: "output", created_at: now,
  });
  const binaryTextId = crypto.randomUUID();
  fs.writeFileSync(path.join(workspace, "outputs", "binary.txt"), Buffer.from([0x68, 0x69, 0x00, 0x0a]));
  instance.db.addFile({
    id: binaryTextId, conversation_id: conversationId, message_id: null,
    original_name: "binary.txt", relative_path: "outputs/binary.txt",
    mime_type: "text/plain", size: 4, kind: "output", created_at: now,
  });
  const pythonId = crypto.randomUUID();
  fs.writeFileSync(path.join(workspace, "outputs", "script.py"), "def main():\n    print('hi')\n");
  instance.db.addFile({
    id: pythonId, conversation_id: conversationId, message_id: null,
    original_name: "script.py", relative_path: "outputs/script.py",
    mime_type: "text/x-python", size: 29, kind: "output", created_at: now,
  });
  const yamlId = crypto.randomUUID();
  fs.writeFileSync(path.join(workspace, "outputs", "config.yaml"), "name: demo\nversion: 1\n");
  instance.db.addFile({
    id: yamlId, conversation_id: conversationId, message_id: null,
    original_name: "config.yaml", relative_path: "outputs/config.yaml",
    mime_type: "application/yaml", size: 21, kind: "output", created_at: now,
  });

  const share = await agent.post(`/codex-web/api/files/${markdownId}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.match(share.body.url, /^\/codex-web\/share\/[A-Za-z0-9_-]+$/);
  assert.ok(Number.isFinite(Date.parse(share.body.expiresAt)));
  const guest = request.agent(instance.app);
  const page = await guest.get(share.body.url).expect(200);
  assert.match(page.text, /分享预览/);
  assert.match(page.text, /report\.md/);
  assert.match(page.text, /<h1>报告<\/h1>/);
  assert.match(page.text, /<p>hello 中文<\/p>/);
  assert.doesNotMatch(page.text, /<pre class="text">/);
  assert.match(page.text, />下载</);
  await guest.get(`${share.body.url}/content`).expect(404);
  const markdownDownload = await guest.get(`${share.body.url}/download`).expect(200);
  assert.match(markdownDownload.headers["content-disposition"] ?? "", /attachment/);
  assert.equal(markdownDownload.text, "# 报告\n\nhello 中文\n");

  const bigShare = await agent.post(`/codex-web/api/files/${bigTextId}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  const bigPage = await guest.get(bigShare.body.url).expect(200);
  assert.match(bigPage.text, /# big text/);
  assert.match(bigPage.text, /仅展示前/);

  const binaryShare = await agent.post(`/codex-web/api/files/${binaryTextId}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  const binaryPage = await guest.get(binaryShare.body.url).expect(200);
  assert.match(binaryPage.text, /文件包含二进制数据/);
  assert.doesNotMatch(binaryPage.text, /<pre class="text">/);

  const pythonShare = await agent.post(`/codex-web/api/files/${pythonId}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  const pythonPage = await guest.get(pythonShare.body.url).expect(200);
  assert.match(pythonPage.text, /<pre class="text">/);
  assert.match(pythonPage.text, /def main\(\)/);
  assert.match(pythonPage.text, /print\(&#39;hi&#39;\)/);
  const yamlShare = await agent.post(`/codex-web/api/files/${yamlId}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  const yamlPage = await guest.get(yamlShare.body.url).expect(200);
  assert.match(yamlPage.text, /<pre class="text">/);
  assert.match(yamlPage.text, /name: demo/);

  const imageShare = await agent.post(`/codex-web/api/files/${imageId}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  const imageContent = await guest.get(`${imageShare.body.url}/content`).expect(200);
  assert.equal(imageContent.headers["content-type"], "image/png");
  assert.deepEqual(imageContent.body, png);
  const imageDownload = await guest.get(`${imageShare.body.url}/download`).expect(200);
  assert.equal(imageDownload.headers["content-type"], "image/png");
  assert.deepEqual(imageDownload.body, png);
  assert.match(imageDownload.headers["content-disposition"] ?? "", /attachment/);

  await agent.post(`/codex-web/api/files/${uploadId}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(404);
  await agent.post(`/codex-web/api/files/${xlsxId}/share`).set("X-CSRF-Token", login.body.csrfToken).expect(400);
  const shareToken = share.body.url.split("/").at(-1)!;
  const tamperedToken = shareToken.slice(0, 8) + (shareToken[8] === "A" ? "B" : "A") + shareToken.slice(9);
  await guest.get(`/codex-web/share/${tamperedToken}`).expect(404);
  await guest.get(`/codex-web/share/${tamperedToken}/download`).expect(404);
  const expiredToken = createShareToken(secret, markdownId, Math.floor(Date.now() / 1000) - 60);
  await guest.get(`/codex-web/share/${expiredToken}`).expect(404);
  await guest.get(`/codex-web/share/${expiredToken}/download`).expect(404);
});

test("output file download endpoint inlines text-based code and config files", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-inline-mime-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id;
  const userId = instance.db.getConversation(conversationId)?.user_id ?? LEGACY_USER_ID;
  const workspace = ensureTenantWorkspace(tenantRoot, userId, conversationId);
  const now = new Date().toISOString();

  const pythonId = crypto.randomUUID();
  fs.writeFileSync(path.join(workspace, "outputs", "script.py"), "print('hi')\n");
  instance.db.addFile({
    id: pythonId, conversation_id: conversationId, message_id: null,
    original_name: "script.py", relative_path: "outputs/script.py",
    mime_type: "text/x-python", size: 12, kind: "output", created_at: now,
  });
  const jsonId = crypto.randomUUID();
  fs.writeFileSync(path.join(workspace, "outputs", "config.json"), "{\"a\": 1}\n");
  instance.db.addFile({
    id: jsonId, conversation_id: conversationId, message_id: null,
    original_name: "config.json", relative_path: "outputs/config.json",
    mime_type: "application/json", size: 9, kind: "output", created_at: now,
  });
  const xlsxId = crypto.randomUUID();
  fs.writeFileSync(path.join(workspace, "outputs", "data.xlsx"), "xlsx-bytes");
  instance.db.addFile({
    id: xlsxId, conversation_id: conversationId, message_id: null,
    original_name: "data.xlsx", relative_path: "outputs/data.xlsx",
    mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 10, kind: "output", created_at: now,
  });

  const python = await agent.get(`/codex-web/api/files/${pythonId}`).expect(200);
  assert.equal(python.headers["content-type"], "text/x-python");
  assert.match(python.headers["content-disposition"] ?? "", /inline/);
  const json = await agent.get(`/codex-web/api/files/${jsonId}`).expect(200);
  assert.equal(json.headers["content-type"], "application/json");
  assert.match(json.headers["content-disposition"] ?? "", /inline/);
  const xlsx = await agent.get(`/codex-web/api/files/${xlsxId}`).expect(200);
  assert.match(xlsx.headers["content-disposition"] ?? "", /attachment/);
  const pythonDownload = await agent.get(`/codex-web/api/files/${pythonId}?download=1`).expect(200);
  assert.match(pythonDownload.headers["content-disposition"] ?? "", /attachment/);
});

test("host mode reports unconfigured tenants and blocks task sends until ~/.codex exists", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-host-mode-api-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot,
    username: "no-such-system-user-zzz",
    passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
    hostMode: true,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "no-such-system-user-zzz", password: "Correct-Horse-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;

  const options = await agent.get("/codex-web/api/agent-options").expect(200);
  assert.equal(options.body.codexConfigured, false);
  assert.match(options.body.codexConfigHint, /系统账户/);

  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  await agent.post(`/codex-web/api/conversations/${created.body.conversation.id}/messages`)
    .set("X-CSRF-Token", csrf).field("message", "hello").expect(409);
});

test("host mode persists favorite working directories and applies them to new conversations", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-host-working-dir-api-test-"));
  const username = process.env.USER || process.env.LOGNAME || "root";
  assert.ok(resolveSystemUser(username), `expected the current machine user ${username} to resolve`);
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    username,
    passwordHash: bcrypt.hashSync("WorkingDir-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
    hostMode: true,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username, password: "WorkingDir-Password-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;

  const settings = await agent.get("/codex-web/api/working-dirs").expect(200);
  assert.equal(settings.body.settings.enabled, true);

  const project = path.join(root, "projects", "web-project");
  fs.mkdirSync(project, { recursive: true });
  const canonicalProject = fs.realpathSync(project);
  const added = await agent.put("/codex-web/api/working-dirs/favorites")
    .set("X-CSRF-Token", csrf)
    .send({ action: "add", path: project, label: "Web 项目" }).expect(200);
  assert.equal(added.body.settings.favorites.length, 1);
  assert.equal(added.body.settings.favorites[0].path, canonicalProject);
  assert.equal(added.body.settings.favorites[0].label, "Web 项目");

  const stale = path.join(root, "projects", "stale");
  fs.mkdirSync(stale, { recursive: true });
  await agent.put("/codex-web/api/working-dirs/favorites")
    .set("X-CSRF-Token", csrf)
    .send({ action: "add", path: stale }).expect(200);
  fs.rmSync(stale, { recursive: true, force: true });
  const removedStale = await agent.put("/codex-web/api/working-dirs/favorites")
    .set("X-CSRF-Token", csrf)
    .send({ action: "remove", path: stale }).expect(200);
  assert.equal(removedStale.body.settings.favorites.length, 1);

  await agent.put("/codex-web/api/working-dirs/default")
    .set("X-CSRF-Token", csrf)
    .send({ path: project }).expect(200);
  const defaulted = await agent.get("/codex-web/api/working-dirs").expect(200);
  assert.equal(defaulted.body.settings.defaultWorkingDir, canonicalProject);

  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  assert.equal(created.body.conversation.working_dir, canonicalProject);
  const custom = await agent.post("/codex-web/api/conversations")
    .set("X-CSRF-Token", csrf)
    .send({ workingDir: project }).expect(201);
  assert.equal(custom.body.conversation.working_dir, canonicalProject);
  await agent.post("/codex-web/api/conversations")
    .set("X-CSRF-Token", csrf)
    .send({ workingDir: "relative/project" }).expect(400);

  await agent.put(`/codex-web/api/conversations/${created.body.conversation.id}/working-dir`)
    .set("X-CSRF-Token", csrf)
    .send({ workingDir: null }).expect(200);
  assert.equal(
    (await agent.get(`/codex-web/api/conversations/${created.body.conversation.id}`).expect(200)).body.conversation.working_dir,
    null,
  );

  const blocker = await agent.post("/codex-web/api/conversations")
    .set("X-CSRF-Token", csrf)
    .send({ workingDir: project }).expect(201);
  const blockerJob = crypto.randomUUID();
  instance.db.createJob(blockerJob, blocker.body.conversation.id);
  instance.db.updateJob(blockerJob, "running");
  instance.db.updateConversation(blocker.body.conversation.id, { status: "running" });
  const busy = await agent.put(`/codex-web/api/conversations/${created.body.conversation.id}/working-dir`)
    .set("X-CSRF-Token", csrf)
    .send({ workingDir: project }).expect(409);
  assert.equal(busy.body.code, "working-dir-busy");
  assert.equal(
    (await agent.get(`/codex-web/api/conversations/${created.body.conversation.id}`).expect(200)).body.conversation.working_dir,
    null,
  );

  await agent.put(`/codex-web/api/conversations/${created.body.conversation.id}/working-dir`)
    .set("X-CSRF-Token", csrf)
    .send({ workingDir: project, confirm: true }).expect(200);
  assert.equal(
    (await agent.get(`/codex-web/api/conversations/${created.body.conversation.id}`).expect(200)).body.conversation.working_dir,
    canonicalProject,
  );
  instance.db.finishJob(blockerJob, blocker.body.conversation.id, "completed");

  await agent.put(`/codex-web/api/conversations/${created.body.conversation.id}/working-dir`)
    .set("X-CSRF-Token", csrf)
    .send({ workingDir: null }).expect(200);
  assert.equal(
    (await agent.get(`/codex-web/api/conversations/${created.body.conversation.id}`).expect(200)).body.conversation.working_dir,
    null,
  );

  await agent.put(`/codex-web/api/conversations/${created.body.conversation.id}/working-dir`)
    .set("X-CSRF-Token", csrf)
    .send({ workingDir: project }).expect(200);
  assert.equal(
    (await agent.get(`/codex-web/api/conversations/${created.body.conversation.id}`).expect(200)).body.conversation.working_dir,
    canonicalProject,
  );

  await agent.put("/codex-web/api/working-dirs/default")
    .set("X-CSRF-Token", csrf)
    .send({ path: null }).expect(200);
  const clearedDefault = await agent.get("/codex-web/api/working-dirs").expect(200);
  assert.equal(clearedDefault.body.settings.defaultWorkingDir, null);
});

test("host mode exposes the path browser and attaches files selected by host path", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-host-path-browser-api-test-"));
  const username = process.env.USER || process.env.LOGNAME || "root";
  assert.ok(resolveSystemUser(username), `expected the current machine user ${username} to resolve`);
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    username,
    passwordHash: bcrypt.hashSync("HostPath-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
    hostMode: true,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username, password: "HostPath-Password-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;

  const project = path.join(root, "projects", "host-files");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "input.md"), "# 输入\n", "utf8");
  const source = fs.realpathSync(path.join(project, "input.md"));

  const browsing = await agent.get(`/codex-web/api/path-browser?path=${encodeURIComponent(project)}`).expect(200);
  assert.equal(browsing.body.listing.path, fs.realpathSync(project));
  assert.ok(browsing.body.listing.entries.some((entry: { name: string; type: string }) => entry.name === "input.md" && entry.type === "file"));

  await agent.get(`/codex-web/api/path-browser?path=${encodeURIComponent(path.join(root, "data"))}`).expect(400);
  await agent.get("/codex-web/api/path-browser?path=relative/path").expect(400);

  const hostTreeConversation = await agent.post("/codex-web/api/conversations")
    .set("X-CSRF-Token", csrf)
    .send({ workingDir: project })
    .expect(201);
  const hostTreeId = hostTreeConversation.body.conversation.id as string;
  const hostRoots = await agent.get(`/codex-web/api/conversations/${hostTreeId}/file-tree`).expect(200);
  assert.deepEqual(hostRoots.body.roots.map((root: { id: string }) => root.id), ["working-dir", "workspace", "library"]);
  assert.equal(hostRoots.body.roots[0].path, fs.realpathSync(project));
  const hostListing = await agent.get(`/codex-web/api/conversations/${hostTreeId}/file-tree?root=working-dir&path=`).expect(200);
  assert.ok(hostListing.body.listing.entries.some((entry: { name: string }) => entry.name === "input.md"));
  const hostPreview = await agent.get(`/codex-web/api/conversations/${hostTreeId}/file-tree/preview?root=working-dir&path=${encodeURIComponent("input.md")}`).expect(200);
  assert.equal(hostPreview.body.content, "# 输入\n");

  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  const conversationId = created.body.conversation.id;
  const attached = await agent.post(`/codex-web/api/conversations/${conversationId}/draft/files/from-host`)
    .set("X-CSRF-Token", csrf)
    .send({ paths: [source] }).expect(201);
  assert.equal(attached.body.composerDraft.files.length, 1);
  assert.equal(attached.body.composerDraft.files[0].original_name, "input.md");

  const detail = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  const row = detail.body.composerDraft.files[0];
  const userId = instance.db.getConversation(conversationId)?.user_id;
  assert.ok(userId);
  const workspace = ensureTenantWorkspace(instance.config.tenantRoot, userId, conversationId);
  assert.equal(fs.existsSync(resolveInside(workspace, row.relative_path)), true);
  assert.equal(fs.readFileSync(resolveInside(workspace, row.relative_path), "utf8"), "# 输入\n");

  await agent.post(`/codex-web/api/conversations/${conversationId}/draft/files/from-host`)
    .set("X-CSRF-Token", csrf)
    .send({ paths: [path.join(project, "missing.txt")] }).expect(400);
  await agent.post(`/codex-web/api/conversations/${conversationId}/draft/files/from-host`)
    .set("X-CSRF-Token", csrf)
    .send({ paths: [project] }).expect(400);
  await agent.post(`/codex-web/api/conversations/${conversationId}/draft/files/from-host`)
    .set("X-CSRF-Token", csrf)
    .send({ paths: [path.join(root, "data", "secret.txt")] }).expect(400);
});

test("path browsing and host-path attachments stay disabled outside host mode", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-path-browser-gated-test-"));
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    username: "owner",
    passwordHash: bcrypt.hashSync("PathBrowser-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
    hostMode: false,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "PathBrowser-Password-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;

  await agent.get("/codex-web/api/path-browser").expect(403);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  await agent.post(`/codex-web/api/conversations/${created.body.conversation.id}/draft/files/from-host`)
    .set("X-CSRF-Token", csrf)
    .send({ paths: ["/tmp/whatever.txt"] }).expect(403);
});

test("host mode reorders favorite working directories from the manage dialog", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-working-dir-reorder-test-"));
  const username = process.env.USER || process.env.LOGNAME || "root";
  assert.ok(resolveSystemUser(username), `expected the current machine user ${username} to resolve`);
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    username,
    passwordHash: bcrypt.hashSync("WorkingDir-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
    hostMode: true,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username, password: "WorkingDir-Password-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;

  const paths = ["alpha", "beta", "gamma"].map((name) => {
    const dir = path.join(root, "projects", name);
    fs.mkdirSync(dir, { recursive: true });
    return { raw: dir, canonical: fs.realpathSync(dir) };
  });
  const [alpha, beta, gamma] = paths.map((item) => item.canonical);
  for (const item of paths) {
    await agent.put("/codex-web/api/working-dirs/favorites")
      .set("X-CSRF-Token", csrf)
      .send({ action: "add", path: item.raw }).expect(200);
  }
  const initial = await agent.get("/codex-web/api/working-dirs").expect(200);
  // Newly added favorites go to the front: gamma, beta, alpha.
  assert.deepEqual(initial.body.settings.favorites.map((favorite: { path: string }) => favorite.path), [gamma, beta, alpha]);

  // Move the first favorite down and the last favorite up.
  const movedDown = await agent.put("/codex-web/api/working-dirs/favorites")
    .set("X-CSRF-Token", csrf)
    .send({ action: "move", path: gamma, direction: "down" }).expect(200);
  assert.deepEqual(movedDown.body.settings.favorites.map((favorite: { path: string }) => favorite.path), [beta, gamma, alpha]);
  const movedUp = await agent.put("/codex-web/api/working-dirs/favorites")
    .set("X-CSRF-Token", csrf)
    .send({ action: "move", path: alpha, direction: "up" }).expect(200);
  assert.deepEqual(movedUp.body.settings.favorites.map((favorite: { path: string }) => favorite.path), [beta, alpha, gamma]);

  await agent.put("/codex-web/api/working-dirs/favorites")
    .set("X-CSRF-Token", csrf)
    .send({ action: "move", path: beta, direction: "up" }).expect(400);
  await agent.put("/codex-web/api/working-dirs/favorites")
    .set("X-CSRF-Token", csrf)
    .send({ action: "move", path: gamma, direction: "down" }).expect(400);
  await agent.put("/codex-web/api/working-dirs/favorites")
    .set("X-CSRF-Token", csrf)
    .send({ action: "move", path: alpha, direction: "sideways" }).expect(400);
  await agent.put("/codex-web/api/working-dirs/favorites")
    .set("X-CSRF-Token", csrf)
    .send({ action: "move", path: "/srv/not-favorited", direction: "up" }).expect(404);
  const finalOrder = await agent.get("/codex-web/api/working-dirs").expect(200);
  assert.deepEqual(finalOrder.body.settings.favorites.map((favorite: { path: string }) => favorite.path), [beta, alpha, gamma]);
});

test("task list categories persist custom grouping, directory assignment, and pin order", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-task-categories-api-test-"));
  const username = process.env.USER || process.env.LOGNAME || "root";
  assert.ok(resolveSystemUser(username), `expected the current machine user ${username} to resolve`);
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    username,
    passwordHash: bcrypt.hashSync("TaskCategories-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
    queueAutoStart: false,
    hostMode: true,
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username, password: "TaskCategories-Password-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;

  const project = path.join(root, "projects", "categorized-project");
  fs.mkdirSync(project, { recursive: true });
  const canonicalProject = fs.realpathSync(project);
  await agent.put("/codex-web/api/working-dirs/favorites")
    .set("X-CSRF-Token", csrf)
    .send({ action: "add", path: project, label: "Categorized" }).expect(200);
  await agent.post("/codex-web/api/conversations")
    .set("X-CSRF-Token", csrf)
    .send({ workingDir: project }).expect(201);

  const initial = await agent.get("/codex-web/api/task-categories").expect(200);
  assert.deepEqual(initial.body.settings, { customCategories: [], pinned: [], hidden: [], conversationOrders: {} });

  const created = await agent.post("/codex-web/api/task-categories/custom")
    .set("X-CSRF-Token", csrf)
    .send({ name: "归档项目" }).expect(200);
  const customId = created.body.settings.customCategories[0].id as string;
  assert.equal(created.body.settings.customCategories[0].name, "归档项目");

  await agent.post("/codex-web/api/task-categories/custom")
    .set("X-CSRF-Token", csrf)
    .send({ name: "归档项目" }).expect(400);

  const assigned = await agent.put("/codex-web/api/task-categories/dirs")
    .set("X-CSRF-Token", csrf)
    .send({ dir: project, categoryId: customId }).expect(200);
  assert.deepEqual(assigned.body.settings.customCategories[0].assignedDirs, [canonicalProject]);

  const renamed = await agent.patch(`/codex-web/api/task-categories/custom/${customId}`)
    .set("X-CSRF-Token", csrf)
    .send({ name: "重点项目" }).expect(200);
  assert.equal(renamed.body.settings.customCategories[0].name, "重点项目");

  const pinned = await agent.put("/codex-web/api/task-categories/pins")
    .set("X-CSRF-Token", csrf)
    .send({ keys: [`custom:${customId}`, "auto:standalone", "unknown:key"] }).expect(200);
  assert.deepEqual(pinned.body.settings.pinned, [`custom:${customId}`, "auto:standalone"]);

  const hidden = await agent.put("/codex-web/api/task-categories/hidden")
    .set("X-CSRF-Token", csrf)
    .send({ keys: [`custom:${customId}`, "auto:standalone", "auto:standalone", "unknown:key"] }).expect(200);
  assert.deepEqual(hidden.body.settings.hidden, [`custom:${customId}`, "auto:standalone"]);

  const unassigned = await agent.put("/codex-web/api/task-categories/dirs")
    .set("X-CSRF-Token", csrf)
    .send({ dir: project, categoryId: null }).expect(200);
  assert.deepEqual(unassigned.body.settings.customCategories[0].assignedDirs, []);

  const restored = await agent.put("/codex-web/api/task-categories/hidden")
    .set("X-CSRF-Token", csrf)
    .send({ keys: [] }).expect(200);
  assert.deepEqual(restored.body.settings.hidden, []);

  await agent.put("/codex-web/api/task-categories/hidden")
    .set("X-CSRF-Token", csrf)
    .send({ keys: [`custom:${customId}`] }).expect(200);
  await agent.put("/codex-web/api/task-categories/conversation-order")
    .set("X-CSRF-Token", csrf)
    .send({ categoryKey: `custom:${customId}`, conversationIds: ["fake-conversation"] }).expect(200);
  const deleted = await agent.delete(`/codex-web/api/task-categories/custom/${customId}`)
    .set("X-CSRF-Token", csrf)
    .expect(200);
  assert.equal(deleted.body.settings.customCategories.length, 0);
  assert.deepEqual(deleted.body.settings.pinned, ["auto:standalone"]);
  assert.deepEqual(deleted.body.settings.hidden, []);
  assert.equal(deleted.body.settings.conversationOrders[`custom:${customId}`], undefined);

  const hiddenDirKey = `auto:dir:${encodeURIComponent(canonicalProject)}`;
  const hiddenDir = await agent.put("/codex-web/api/task-categories/hidden")
    .set("X-CSRF-Token", csrf)
    .send({ keys: [hiddenDirKey] }).expect(200);
  assert.deepEqual(hiddenDir.body.settings.hidden, [hiddenDirKey]);
  await agent.put("/codex-web/api/working-dirs/favorites")
    .set("X-CSRF-Token", csrf)
    .send({ action: "remove", path: project }).expect(200);
  const afterFavoriteRemoved = await agent.get("/codex-web/api/task-categories").expect(200);
  assert.deepEqual(afterFavoriteRemoved.body.settings.hidden, []);

  await agent.put("/codex-web/api/working-dirs/favorites")
    .set("X-CSRF-Token", csrf)
    .send({ action: "add", path: project, label: "Categorized" }).expect(200);
  const conversationId = (await agent.get("/codex-web/api/conversations").expect(200)).body.conversations[0].id as string;
  const ordered = await agent.put("/codex-web/api/task-categories/conversation-order")
    .set("X-CSRF-Token", csrf)
    .send({ categoryKey: hiddenDirKey, conversationIds: [conversationId, conversationId, "unknown"] }).expect(200);
  // 未知 id 会保留在设置中（前端渲染时忽略），重复 id 去重。
  assert.deepEqual(ordered.body.settings.conversationOrders[hiddenDirKey], [conversationId, "unknown"]);

  const cleared = await agent.put("/codex-web/api/task-categories/conversation-order")
    .set("X-CSRF-Token", csrf)
    .send({ categoryKey: hiddenDirKey, conversationIds: [] }).expect(200);
  assert.equal(cleared.body.settings.conversationOrders[hiddenDirKey], undefined);

  await agent.put("/codex-web/api/task-categories/conversation-order")
    .set("X-CSRF-Token", csrf)
    .send({ categoryKey: "not:a:key", conversationIds: [] }).expect(400);
  await agent.put("/codex-web/api/task-categories/conversation-order")
    .set("X-CSRF-Token", csrf)
    .send({ categoryKey: hiddenDirKey, conversationIds: "nope" }).expect(400);
});

test("quoted selections stay outside the visible message body and survive the pending queue", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-message-quote-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "pp", passwordHash: bcrypt.hashSync("Quote-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "pp", password: "Quote-Password-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;

  await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "这和上一段有什么关系？")
    .field("quoteExcerpt", "  被引用的第一行\r\n被引用的第二行  ")
    .expect(202);
  let detail = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.messages[0].content, "这和上一段有什么关系？");
  assert.equal(detail.body.messages[0].quote_excerpt, "被引用的第一行\n被引用的第二行");
  assert.doesNotMatch(detail.body.messages[0].content, /请结合以下引用|被引用的第一行/);

  const queued = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "")
    .field("quoteExcerpt", "只引用、不写正文")
    .expect(202);
  assert.equal(queued.body.pendingPrompt.content, "");
  assert.equal(queued.body.pendingPrompt.quote_excerpt, "只引用、不写正文");

  const pendingId = queued.body.pendingPrompt.id as string;
  await agent.post(`/codex-web/api/conversations/${conversationId}/pending-prompts/${pendingId}/edit`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  await agent.post(`/codex-web/api/conversations/${conversationId}/pending-prompts/${pendingId}/restore`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  const materialized = instance.db.materializePendingPrompt(pendingId, crypto.randomUUID(), crypto.randomUUID());
  assert.ok(materialized?.message_id);
  const quotedMessage = instance.db.getMessage(materialized!.message_id!);
  assert.equal(quotedMessage?.content, "");
  assert.equal(quotedMessage?.quote_excerpt, "只引用、不写正文");
  detail = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.messages.at(-1).quote_excerpt, "只引用、不写正文");
});

test("conversation stop cancels every active job and deletion preserves audit rows while removing physical state", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-soft-delete-test-"));
  const dataRoot = path.join(root, "data");
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot, tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;
  const messageId = crypto.randomUUID();
  const queuedJobId = crypto.randomUUID();
  const runningJobId = crypto.randomUUID();
  const now = new Date().toISOString();
  instance.db.addMessage({ id: messageId, conversation_id: conversationId, role: "user", content: "keep for audit", created_at: now });
  instance.db.createJob(queuedJobId, conversationId, messageId);
  instance.db.createJob(runningJobId, conversationId, messageId);
  instance.db.updateJob(runningJobId, "running");
  instance.db.updateConversation(conversationId, { status: "running" });
  instance.db.appendEvent(runningJobId, "progress", { kind: "update", label: "stage update", detail: "finished environment inspection" });
  instance.db.appendEvent(runningJobId, "progress", { kind: "command", label: "configuration checked", detail: "private command omitted" });

  await agent.post(`/codex-web/api/conversations/${conversationId}/cancel`).set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(instance.db.getJob(queuedJobId)?.status, "cancelled");
  assert.equal(instance.db.getJob(runningJobId)?.status, "cancelled");
  assert.equal(instance.db.getConversationForUser(conversationId, LEGACY_USER_ID)?.id, conversationId);
  const stoppedSummary = instance.db.listMessages(conversationId).at(-1)!;
  assert.equal(stoppedSummary.role, "assistant");
  assert.match(stoppedSummary.content, new RegExp(USER_CANCELLED_TASK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(stoppedSummary.content, /finished environment inspection/);
  assert.match(stoppedSummary.content, /configuration checked/);
  assert.doesNotMatch(stoppedSummary.content, /private command/);
  assert.equal(latestUserCancellationContext(instance.db.listMessages(conversationId)), stoppedSummary.content);

  const deletionJobId = crypto.randomUUID();
  instance.db.createJob(deletionJobId, conversationId, messageId);
  instance.db.updateJob(deletionJobId, "running");
  instance.db.updateConversation(conversationId, { status: "running" });
  const workspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId);
  fs.writeFileSync(path.join(workspace, "uploads", "input.txt"), "physical input", "utf8");
  const pending = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "draft that must never be promoted during deletion")
    .attach("files", Buffer.from("draft input"), { filename: "draft.txt", contentType: "text/plain" })
    .expect(202);
  const pendingFile = pending.body.pendingPrompt.files[0] as { relative_path: string };
  const pendingAbsolute = path.join(workspace, ...pendingFile.relative_path.split("/"));
  assert.equal(fs.existsSync(pendingAbsolute), true);
  const fileId = crypto.randomUUID();
  const storedPath = path.posix.join("deliverables", fileId, "result.txt");
  const storedAbsolute = path.join(dataRoot, ...storedPath.split("/"));
  fs.mkdirSync(path.dirname(storedAbsolute), { recursive: true });
  fs.writeFileSync(storedAbsolute, "physical result", "utf8");
  instance.db.addFile({
    id: fileId, conversation_id: conversationId, message_id: messageId,
    original_name: "result.txt", relative_path: storedPath, mime_type: "text/plain",
    size: 15, kind: "output", created_at: now,
  });
  const threadId = crypto.randomUUID();
  instance.db.updateConversation(conversationId, { codexThreadId: threadId });
  const sessionFile = path.join(ensureTenant(tenantRoot, LEGACY_USER_ID).codexHome, "sessions", "2026", "07", "19", `rollout-${threadId}.jsonl`);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, "thread state", "utf8");

  await agent.delete(`/codex-web/api/conversations/${conversationId}`).set("X-CSRF-Token", login.body.csrfToken).expect(204);
  const retained = instance.db.getConversation(conversationId);
  assert.ok(retained?.deleted_at);
  assert.equal(instance.db.listConversations(LEGACY_USER_ID).some((row) => row.id === conversationId), false);
  assert.equal(instance.db.listMessages(conversationId).length, 2);
  assert.equal(instance.db.listFiles(conversationId).length, 1);
  assert.equal(instance.db.getJob(deletionJobId)?.status, "cancelled");
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 0);
  assert.equal(instance.db.listPendingPrompts(conversationId, "editing").length, 0);
  assert.ok(instance.db.listEvents(runningJobId).some((event) => JSON.parse(event.payload).detail === "finished environment inspection"));
  assert.equal(fs.existsSync(workspace), false);
  assert.equal(fs.existsSync(pendingAbsolute), false);
  assert.equal(fs.existsSync(storedAbsolute), false);
  assert.equal(fs.existsSync(sessionFile), false);
  await instance.pumpQueue();
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["keep for audit", stoppedSummary.content]);
  await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(404);
  await agent.get(`/codex-web/api/files/${fileId}`).expect(404);
  await agent.get(`/codex-web/api/jobs/${deletionJobId}/events`).expect(404);
});

function writeSyntheticCodexSession(codexHome: string, threadId: string, options: { dir?: string; message?: string; finalReply?: string; timestamp?: string; cwd?: string } = {}): string {
  const directory = path.join(codexHome, options.dir ?? "sessions", "2026", "04", "20");
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `rollout-2026-04-20T19-01-08-${threadId}.jsonl`);
  const timestamp = options.timestamp ?? "2026-04-20T11:01:20.633Z";
  const assistantTimestamp = new Date(new Date(timestamp).getTime() + 60_000).toISOString();
  const lines = [
    JSON.stringify({
      timestamp,
      type: "session_meta",
      payload: { id: threadId, timestamp: "2026-04-20T11:01:08.567Z", cwd: options.cwd ?? "/home/test/project", originator: "codex_cli", cli_version: "0.107.0" },
    }),
    JSON.stringify({
      timestamp,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /home/test/project\n\n- Follow the repo conventions." }] },
    }),
    JSON.stringify({ timestamp, type: "event_msg", payload: { type: "user_message", message: options.message ?? "请检查这个项目", images: [], text_elements: [] } }),
    JSON.stringify({
      timestamp,
      type: "turn_context",
      payload: { turn_id: "turn-1", model: "gpt-5.4", collaboration_mode: { mode: "default", settings: { model: "gpt-5.4", reasoning_effort: "high" } } },
    }),
    JSON.stringify({ timestamp: assistantTimestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "中间回复" }] } }),
    JSON.stringify({ timestamp: assistantTimestamp, type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: options.finalReply ?? "**最终回复**：项目已检查。" } }),
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

test("session importer discovers Codex rollouts, derives titles, and skips already imported threads", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-session-importer-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex-home");
  const threadId = crypto.randomUUID();
  writeSyntheticCodexSession(codexHome, threadId, { dir: "archived_sessions" });
  // A legacy rollout with only response_item user records must skip the injected
  // AGENTS.md context and use the real prompt as the title source.
  const legacyThreadId = crypto.randomUUID();
  const legacyFile = path.join(codexHome, "sessions", "2025", "01", "02", `rollout-2025-01-02T10-00-00-${legacyThreadId}.jsonl`);
  fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
  fs.writeFileSync(legacyFile, [
    JSON.stringify({ timestamp: "2025-01-02T10:00:00.000Z", type: "session_meta", payload: { id: legacyThreadId, timestamp: "2025-01-02T10:00:00.000Z", cwd: "/tmp", originator: "codex_cli" } }),
    JSON.stringify({ timestamp: "2025-01-02T10:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /tmp" }] } }),
    JSON.stringify({ timestamp: "2025-01-02T10:00:02.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "旧版会话的真实问题" }] } }),
    JSON.stringify({ timestamp: "2025-01-02T10:00:03.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "旧版回复" }] } }),
  ].join("\n"), "utf8");

  assert.equal(deriveImportedTitle("  第一条用户消息  "), "第一条用户消息");
  assert.equal(deriveImportedTitle("   "), "导入的历史会话");
  const discovered = await discoverImportableSessions(codexHome, new Set());
  assert.equal(discovered.length, 2);
  const imported = discovered.find((session) => session.threadId === threadId);
  const legacy = discovered.find((session) => session.threadId === legacyThreadId);
  assert.ok(imported && legacy);
  assert.equal(imported.model, "gpt-5.4");
  assert.equal(imported.title, "请检查这个项目");
  assert.equal(legacy.title, "旧版会话的真实问题");
  assert.equal((await discoverImportableSessions(codexHome, new Set([threadId]))).length, 1);
  assert.equal((await discoverImportableSessions(codexHome, new Set([threadId, legacyThreadId]))).length, 0);
});

test("session importer deduplicates the same thread across sessions and archived sessions", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-session-importer-dedup-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex-home");
  const threadId = crypto.randomUUID();
  writeSyntheticCodexSession(codexHome, threadId, { dir: "sessions", timestamp: "2026-04-20T11:00:00.000Z" });
  writeSyntheticCodexSession(codexHome, threadId, { dir: "archived_sessions", timestamp: "2026-04-21T09:00:00.000Z" });

  const discovered = await discoverImportableSessions(codexHome, new Set());
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].threadId, threadId);
  assert.equal(discovered[0].updatedAt, "2026-04-21T09:01:00.000Z");
});

test("readCodexThreadWorkingDir reads the recorded cwd and returns null for missing threads", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-read-thread-cwd-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex-home");
  const threadId = crypto.randomUUID();
  writeSyntheticCodexSession(codexHome, threadId, { cwd: "/srv/recorded-project" });

  assert.equal(await readCodexThreadWorkingDir(codexHome, threadId), "/srv/recorded-project");
  assert.equal(await readCodexThreadWorkingDir(codexHome, crypto.randomUUID()), null);
});

test("session importer persists a provided working directory and falls back to null on normalization failure", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-import-working-dir-test-"));
  const db = new AppDatabase(path.join(root, "data"));
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const codexHome = path.join(root, "codex-home");
  const threadId = crypto.randomUUID();
  writeSyntheticCodexSession(codexHome, threadId);

  const imported = await importSessionThread(db, codexHome, threadId, LEGACY_USER_ID, "/srv/imported-project");
  assert.equal(imported?.working_dir, "/srv/imported-project");
  assert.equal(db.getConversation(imported!.id)?.working_dir, "/srv/imported-project");

  assert.equal(normalizeImportedWorkingDir("/srv/project", (raw) => raw), "/srv/project");
  assert.equal(normalizeImportedWorkingDir(null, (raw) => raw), null);
  assert.equal(normalizeImportedWorkingDir(undefined, (raw) => raw), null);
  assert.equal(normalizeImportedWorkingDir("/gone", () => { throw new Error("missing"); }), null);
});

test("importable-sessions API discovers local Codex threads and imports them as conversations", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-import-api-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Import-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const codexHome = ensureTenant(tenantRoot, LEGACY_USER_ID).codexHome;
  const threadId = crypto.randomUUID();
  writeSyntheticCodexSession(codexHome, threadId);

  const browser = request.agent(instance.app);
  const login = await browser.post("/codex-web/api/auth/login").send({ username: "owner", password: "Import-Password-2026!" }).expect(200);

  const listed = await browser.get("/codex-web/api/conversations/importable-sessions").expect(200);
  assert.equal(listed.body.sessions.length, 1);
  assert.equal(listed.body.sessions[0].threadId, threadId);
  assert.equal(listed.body.sessions[0].model, "gpt-5.4");

  await browser.post("/codex-web/api/conversations/import-sessions")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ threadIds: ["not-a-uuid"] })
    .expect(400);

  const imported = await browser.post("/codex-web/api/conversations/import-sessions")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ threadIds: [threadId] })
    .expect(200);
  assert.equal(imported.body.conversations.length, 1);
  assert.deepEqual(imported.body.skipped, []);
  const conversationId = imported.body.conversations[0].id as string;
  assert.equal(instance.db.getConversation(conversationId)?.codex_thread_id, threadId);
  assert.equal(instance.db.getConversation(conversationId)?.working_dir, null);

  const detail = await browser.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.deepEqual(detail.body.messages.map((message: { role: string; content: string }) => [message.role, message.content]), [
    ["user", "请检查这个项目"],
    ["assistant", "**最终回复**：项目已检查。"],
  ]);

  const listedAgain = await browser.get("/codex-web/api/conversations/importable-sessions").expect(200);
  assert.deepEqual(listedAgain.body.sessions, []);
  const list = await browser.get("/codex-web/api/conversations").expect(200);
  assert.ok(list.body.conversations.some((conversation: { id: string }) => conversation.id === conversationId));

  const importedAgain = await browser.post("/codex-web/api/conversations/import-sessions")
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ threadIds: [threadId] })
    .expect(200);
  assert.deepEqual(importedAgain.body.conversations, []);
  assert.deepEqual(importedAgain.body.skipped, [threadId]);
});

test("web users have isolated conversations, files, jobs, settings, and tenant directories", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-multi-user-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Owner-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  const memberId = crypto.randomUUID();
  const now = new Date().toISOString();
  instance.db.createUser({
    id: memberId, username: "member", display_name: "朋友", password_hash: bcrypt.hashSync("Member-Password-2026!", 8),
    role: "member", status: "active", created_at: now, updated_at: now,
  });
  const memberTenant = ensureTenant(tenantRoot, memberId);
  const ownerTenant = ensureTenant(tenantRoot, LEGACY_USER_ID);
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  assert.notEqual(memberTenant.codexHome, ownerTenant.codexHome);
  assert.ok(fs.existsSync(path.join(memberTenant.library, "PROFILE.md")));
  assert.ok(fs.existsSync(path.join(memberTenant.library, "projects")));

  const owner = request.agent(instance.app);
  const member = request.agent(instance.app);
  const ownerLogin = await owner.post("/codex-web/api/auth/login").send({ username: "owner", password: "Owner-Password-2026!" }).expect(200);
  const memberLogin = await member.post("/codex-web/api/auth/login").send({ username: "member", password: "Member-Password-2026!" }).expect(200);
  assert.equal(ownerLogin.body.providerManagementEnabled, false);
  assert.equal(memberLogin.body.providerManagementEnabled, false);
  await owner.put("/codex-web/api/user-settings/provider-management")
    .set("X-CSRF-Token", ownerLogin.body.csrfToken)
    .send({ enabled: true })
    .expect(200);
  await member.put("/codex-web/api/user-settings/provider-management")
    .set("X-CSRF-Token", memberLogin.body.csrfToken)
    .send({ enabled: true })
    .expect(200);
  const ownerConversation = await owner.post("/codex-web/api/conversations").set("X-CSRF-Token", ownerLogin.body.csrfToken).expect(201);
  const memberConversation = await member.post("/codex-web/api/conversations").set("X-CSRF-Token", memberLogin.body.csrfToken).expect(201);

  const ownerProvider = await owner.post("/codex-web/api/providers")
    .set("X-CSRF-Token", ownerLogin.body.csrfToken)
    .send({ name: "Shared API", baseUrl: "https://owner.example.com/v1", apiKey: "sk-owner", autoReviewModelOverride: "gpt-5.6-terra" })
    .expect(201);
  assert.equal(ownerProvider.body.provider.id, "shared-api");
  assert.equal(ownerProvider.body.provider.autoReviewModelOverride, "gpt-5.6-terra");
  assert.deepEqual((await member.get("/codex-web/api/providers").expect(200)).body.providers, []);

  await owner.put("/codex-web/api/providers/shared-api")
    .set("X-CSRF-Token", ownerLogin.body.csrfToken)
    .send({ autoReviewModelOverride: null })
    .expect(200);
  assert.equal((await owner.get("/codex-web/api/providers").expect(200)).body.providers[0].autoReviewModelOverride, null);

  const memberProvider = await member.post("/codex-web/api/providers")
    .set("X-CSRF-Token", memberLogin.body.csrfToken)
    .send({ name: "Shared API", baseUrl: "https://member.example.com/v1", apiKey: "sk-member" })
    .expect(201);
  assert.equal(memberProvider.body.provider.id, "shared-api", "provider ids only need to be unique per user");
  assert.equal((await owner.get("/codex-web/api/providers").expect(200)).body.providers[0].baseUrl, "https://owner.example.com/v1");
  assert.equal((await member.get("/codex-web/api/providers").expect(200)).body.providers[0].baseUrl, "https://member.example.com/v1");

  const ownerModels = await owner.post("/codex-web/api/providers/shared-api/models")
    .set("X-CSRF-Token", ownerLogin.body.csrfToken)
    .send({ modelId: "owner-model", displayName: "Owner Model", reasoningEfforts: ["high"] })
    .expect(201);
  const ownerModelId = ownerModels.body.models[0].id as string;
  assert.deepEqual((await owner.get("/codex-web/api/agent-options").expect(200)).body.models.map((model: { id: string }) => model.id), ["owner-model"]);
  assert.ok(!(await member.get("/codex-web/api/agent-options").expect(200)).body.models.some((model: { id: string }) => model.id === "owner-model"));
  assert.deepEqual((await member.get("/codex-web/api/providers").expect(200)).body.models, []);
  await member.delete(`/codex-web/api/providers/shared-api/models/${ownerModelId}`)
    .set("X-CSRF-Token", memberLogin.body.csrfToken).expect(404);

  instance.db.updateConversation(ownerConversation.body.conversation.id, {
    agentSelection: { model: "owner-model", reasoningEffort: "high", provider: "shared-api" },
  });
  await member.delete("/codex-web/api/providers/shared-api")
    .set("X-CSRF-Token", memberLogin.body.csrfToken).expect(204);
  assert.equal((await owner.get("/codex-web/api/providers").expect(200)).body.providers.length, 1);
  assert.deepEqual((await member.get("/codex-web/api/providers").expect(200)).body.providers, []);

  const ownerList = await owner.get("/codex-web/api/conversations").expect(200);
  const memberList = await member.get("/codex-web/api/conversations").expect(200);
  assert.deepEqual(ownerList.body.conversations.map((row: { id: string }) => row.id), [ownerConversation.body.conversation.id]);
  assert.deepEqual(memberList.body.conversations.map((row: { id: string }) => row.id), [memberConversation.body.conversation.id]);
  await owner.get(`/codex-web/api/conversations/${memberConversation.body.conversation.id}`).expect(404);
  await member.get(`/codex-web/api/conversations/${ownerConversation.body.conversation.id}`).expect(404);
  await owner.post(`/codex-web/api/conversations/${memberConversation.body.conversation.id}/seen`)
    .set("X-CSRF-Token", ownerLogin.body.csrfToken).expect(404);

  instance.db.setAgentSelectionPreference({ model: "gpt-5.6-terra", reasoningEffort: "high" }, memberId);
  assert.notDeepEqual(instance.db.getAgentSelectionPreference(LEGACY_USER_ID), instance.db.getAgentSelectionPreference(memberId));
  await member.put("/codex-web/api/user-settings/chat-font-size")
    .set("X-CSRF-Token", memberLogin.body.csrfToken).send({ chatFontSize: 20 }).expect(200);
  assert.equal(instance.db.getChatFontSize(memberId), 20);
  assert.equal(instance.db.getChatFontSize(LEGACY_USER_ID), CHAT_FONT_SIZE_DEFAULT);
  assert.equal((await owner.get("/codex-web/api/auth/session").expect(200)).body.chatFontSize, CHAT_FONT_SIZE_DEFAULT);
  assert.equal((await member.get("/codex-web/api/auth/session").expect(200)).body.chatFontSize, 20);
  await member.put("/codex-web/api/user-settings/chat-column-width")
    .set("X-CSRF-Token", memberLogin.body.csrfToken).send({ chatColumnWidth: 1120 }).expect(200);
  assert.equal(instance.db.getChatColumnWidth(memberId), 1120);
  assert.equal(instance.db.getChatColumnWidth(LEGACY_USER_ID), CHAT_COLUMN_WIDTH_DEFAULT);
  assert.equal((await owner.get("/codex-web/api/auth/session").expect(200)).body.chatColumnWidth, CHAT_COLUMN_WIDTH_DEFAULT);
  assert.equal((await member.get("/codex-web/api/auth/session").expect(200)).body.chatColumnWidth, 1120);

  const memberMessageId = crypto.randomUUID();
  instance.db.addMessage({ id: memberMessageId, conversation_id: memberConversation.body.conversation.id, role: "user", content: "private", created_at: now });
  const memberFileId = crypto.randomUUID();
  const memberWorkspace = ensureTenantWorkspace(tenantRoot, memberId, memberConversation.body.conversation.id);
  fs.writeFileSync(path.join(memberWorkspace, "uploads", "private.txt"), "private", "utf8");
  instance.db.addFile({
    id: memberFileId, conversation_id: memberConversation.body.conversation.id, message_id: memberMessageId,
    original_name: "private.txt", relative_path: "uploads/private.txt", mime_type: "text/plain", size: 7, kind: "upload", created_at: now,
  });
  await owner.get(`/codex-web/api/files/${memberFileId}`).expect(404);
  await member.get(`/codex-web/api/files/${memberFileId}`).expect(200);

  const memberJobId = crypto.randomUUID();
  instance.db.createJob(memberJobId, memberConversation.body.conversation.id, memberMessageId, { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  await owner.get(`/codex-web/api/jobs/${memberJobId}/events`).expect(404);
  await owner.post(`/codex-web/api/jobs/${memberJobId}/cancel`).set("X-CSRF-Token", ownerLogin.body.csrfToken).expect(404);
  await member.post(`/codex-web/api/jobs/${memberJobId}/cancel`).set("X-CSRF-Token", memberLogin.body.csrfToken).expect(200);
});

test("composer drafts and attachments survive browser sessions and are consumed atomically", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-composer-draft-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Draft-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const firstBrowser = request.agent(instance.app);
  const firstLogin = await firstBrowser.post("/codex-web/api/auth/login").send({ username: "owner", password: "Draft-Password-2026!" }).expect(200);
  const created = await firstBrowser.post("/codex-web/api/conversations").set("X-CSRF-Token", firstLogin.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;

  await firstBrowser.put(`/codex-web/api/conversations/${conversationId}/draft`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .send({ content: "unfinished draft", quoteExcerpt: "quoted context" }).expect(200);
  const uploaded = await firstBrowser.post(`/codex-web/api/conversations/${conversationId}/draft/files`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .attach("files", Buffer.from("draft attachment"), { filename: "draft.txt", contentType: "text/plain" })
    .expect(201);
  const draftFile = uploaded.body.composerDraft.files[0] as { id: string; relative_path: string };
  const uploadedPath = path.join(ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId), draftFile.relative_path);
  assert.equal(fs.existsSync(uploadedPath), true);

  const secondBrowser = request.agent(instance.app);
  const secondLogin = await secondBrowser.post("/codex-web/api/auth/login").send({ username: "owner", password: "Draft-Password-2026!" }).expect(200);
  let detail = await secondBrowser.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.composerDraft.content, "unfinished draft");
  assert.equal(detail.body.composerDraft.quote_excerpt, "quoted context");
  assert.deepEqual(detail.body.composerDraft.files.map((file: { original_name: string }) => file.original_name), ["draft.txt"]);

  await secondBrowser.put(`/codex-web/api/conversations/${conversationId}/draft`)
    .set("X-CSRF-Token", secondLogin.body.csrfToken)
    .send({ content: "continued on another device", quoteExcerpt: "" }).expect(200);
  detail = await firstBrowser.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.composerDraft.content, "continued on another device");

  await secondBrowser.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", secondLogin.body.csrfToken)
    .field("message", "continued on another device")
    .field("quoteExcerpt", "")
    .field("useComposerDraft", "true")
    .expect(202);
  assert.equal(instance.db.getComposerDraft(conversationId), undefined);
  const messages = instance.db.listMessages(conversationId);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, "continued on another device");
  assert.deepEqual(messages[0].files.map((file) => file.original_name), ["draft.txt"]);
  assert.equal(instance.db.getFile(draftFile.id)?.message_id, messages[0].id);
  assert.equal((await firstBrowser.get(`/codex-web/api/conversations/${conversationId}`).expect(200)).body.composerDraft, null);

  const clearable = await firstBrowser.post("/codex-web/api/conversations").set("X-CSRF-Token", firstLogin.body.csrfToken).expect(201);
  const clearableId = clearable.body.conversation.id as string;
  const clearUpload = await firstBrowser.post(`/codex-web/api/conversations/${clearableId}/draft/files`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .attach("files", Buffer.from("discard me"), { filename: "discard.txt", contentType: "text/plain" }).expect(201);
  const clearPath = path.join(ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, clearableId), clearUpload.body.composerDraft.files[0].relative_path);
  await firstBrowser.delete(`/codex-web/api/conversations/${clearableId}/draft`).set("X-CSRF-Token", firstLogin.body.csrfToken).expect(204);
  assert.equal(instance.db.getComposerDraft(clearableId), undefined);
  assert.equal(fs.existsSync(clearPath), false);
});

test("composer draft attachments are removable one by one with long display names", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-draft-file-delete-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Draft-Delete-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Draft-Delete-Password-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;

  const uploaded = await agent.post(`/codex-web/api/conversations/${conversationId}/draft/files`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .attach("files", Buffer.from("clipboard png bytes"), { filename: "clipboard-image-20260821-220916-1.png", contentType: "image/png" })
    .attach("files", Buffer.from("keep me"), { filename: "keep.txt", contentType: "text/plain" })
    .expect(201);
  const files = uploaded.body.composerDraft.files as Array<{ id: string; original_name: string; relative_path: string }>;
  assert.equal(files.length, 2);
  const workspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId);
  const target = files.find((file) => file.original_name.startsWith("clipboard-image"))!;
  const kept = files.find((file) => file.original_name === "keep.txt")!;
  const targetPath = path.join(workspace, target.relative_path);
  const keptPath = path.join(workspace, kept.relative_path);
  assert.equal(fs.existsSync(targetPath), true);
  assert.equal(fs.existsSync(keptPath), true);

  const removed = await agent.delete(`/codex-web/api/conversations/${conversationId}/draft/files/${target.id}`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .expect(200);
  assert.deepEqual(removed.body.composerDraft.files.map((file: { original_name: string }) => file.original_name), ["keep.txt"]);
  assert.equal(instance.db.getFile(target.id), undefined);
  assert.equal(instance.db.getFile(kept.id)?.composer_draft_id, conversationId);
  assert.equal(fs.existsSync(targetPath), false);
  assert.equal(fs.existsSync(keptPath), true);

  await agent.delete(`/codex-web/api/conversations/${conversationId}/draft/files/${kept.id}`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .expect(200);
  assert.equal(instance.db.getComposerDraft(conversationId), undefined);
  assert.equal(fs.existsSync(keptPath), false);
});

test("file-only submissions persist on the server and wait for a real instruction", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-awaiting-instruction-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Awaiting-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const firstBrowser = request.agent(instance.app);
  const firstLogin = await firstBrowser.post("/codex-web/api/auth/login").send({ username: "owner", password: "Awaiting-Password-2026!" }).expect(200);
  const created = await firstBrowser.post("/codex-web/api/conversations").set("X-CSRF-Token", firstLogin.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;

  const uploadedOnly = await firstBrowser.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", firstLogin.body.csrfToken)
    .field("message", "   ")
    .attach("files", Buffer.from("first image"), { filename: "first.png", contentType: "image/png" })
    .expect(202);
  assert.equal(uploadedOnly.body.needsInstruction, true);
  assert.match(uploadedOnly.body.guidance, /具体操作/);
  assert.equal(instance.db.listMessages(conversationId).length, 0);
  assert.equal(instance.db.listActiveJobsForConversation(conversationId).length, 0);
  assert.equal(instance.db.listQueuedJobs().length, 0);
  const awaitingId = uploadedOnly.body.pendingPrompt.id as string;
  let awaiting = instance.db.getPendingPrompt(awaitingId)!;
  assert.equal(awaiting.status, "editing");
  assert.equal(awaiting.content, "");
  assert.deepEqual(awaiting.files.map((file) => file.original_name), ["first.png"]);
  const workspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId);
  assert.equal(fs.existsSync(path.join(workspace, awaiting.files[0].relative_path)), true);

  // A new HTTP session represents a closed/reopened browser. The draft and
  // server-side upload must be recovered without any browser-local state.
  const reopenedBrowser = request.agent(instance.app);
  const reopenedLogin = await reopenedBrowser.post("/codex-web/api/auth/login").send({ username: "owner", password: "Awaiting-Password-2026!" }).expect(200);
  let detail = await reopenedBrowser.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.editingPrompt.id, awaitingId);
  assert.deepEqual(detail.body.editingPrompt.files.map((file: { original_name: string }) => file.original_name), ["first.png"]);
  await reopenedBrowser.post(`/codex-web/api/conversations/${conversationId}/pending-prompts/${awaitingId}/restore`)
    .set("X-CSRF-Token", reopenedLogin.body.csrfToken)
    .expect(409);
  assert.equal(instance.db.listQueuedJobs().length, 0);

  const moreFiles = await reopenedBrowser.put(`/codex-web/api/conversations/${conversationId}/pending-prompts/${awaitingId}`)
    .set("X-CSRF-Token", reopenedLogin.body.csrfToken)
    .field("message", " ")
    .field("removedFileIds", "[]")
    .attach("files", Buffer.from("second document"), { filename: "second.txt", contentType: "text/plain" })
    .expect(202);
  assert.equal(moreFiles.body.needsInstruction, true);
  assert.equal(instance.db.listQueuedJobs().length, 0);
  awaiting = instance.db.getPendingPrompt(awaitingId)!;
  assert.equal(awaiting.status, "editing");
  assert.deepEqual(awaiting.files.map((file) => file.original_name), ["first.png", "second.txt"]);

  await reopenedBrowser.put(`/codex-web/api/conversations/${conversationId}/pending-prompts/${awaitingId}`)
    .set("X-CSRF-Token", reopenedLogin.body.csrfToken)
    .field("message", "请把图片和文档整理成一份说明")
    .field("removedFileIds", "[]")
    .expect(200);
  assert.equal(instance.db.getPendingPrompt(awaitingId)?.status, "queued");
  assert.equal(instance.db.listMessages(conversationId).length, 0);

  let executed: { prompt: string; files: string[] } | undefined;
  instance.runner.run = async (jobId, id, prompt, uploads) => {
    executed = { prompt, files: uploads.map((file) => file.original_name) };
    instance.db.finishJob(jobId, id, "completed");
  };
  await instance.pumpQueue();
  for (let attempt = 0; attempt < 20 && !executed; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(executed, { prompt: "请把图片和文档整理成一份说明", files: ["first.png", "second.txt"] });
  assert.equal(instance.db.getPendingPrompt(awaitingId), undefined);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => ({ content: message.content, files: message.files.map((file) => file.original_name) })), [
    { content: "请把图片和文档整理成一份说明", files: ["first.png", "second.txt"] },
  ]);
  detail = await reopenedBrowser.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.editingPrompt, null);
  assert.equal(detail.body.pendingPrompts.length, 0);
});

test("later submissions stay out of chat as drafts and materialize one at a time", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-queue-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Queue-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Queue-Password-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id;
  const first = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`).set("X-CSRF-Token", login.body.csrfToken).send({ message: "first" }).expect(202);
  const second = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`).set("X-CSRF-Token", login.body.csrfToken).send({ message: "second" }).expect(202);
  const third = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`).set("X-CSRF-Token", login.body.csrfToken).send({ message: "third" }).expect(202);
  assert.equal(first.body.job.queuePosition, 1);
  assert.equal(second.body.queued, true);
  assert.equal(second.body.pendingPrompt.content, "second");
  assert.equal(instance.db.getJob(first.body.job.id)?.status, "queued");
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 2);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first"]);
  await agent.put(`/codex-web/api/conversations/${conversationId}/pending-prompts/order`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .send({ ids: [third.body.pendingPrompt.id, second.body.pendingPrompt.id] })
    .expect(200);

  const processed: string[] = [];
  const release = new Map<string, () => void>();
  instance.runner.run = async (jobId, id) => {
    processed.push(jobId);
    await new Promise<void>((resolve) => release.set(jobId, resolve));
    instance.db.finishJob(jobId, id, "completed");
  };
  await instance.pumpQueue();
  for (let attempt = 0; attempt < 10 && processed.length < 1; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(processed, [first.body.job.id]);
  assert.equal(instance.db.getJob(first.body.job.id)?.status, "running");
  release.get(first.body.job.id)!();
  for (let attempt = 0; attempt < 30 && processed.length < 2; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const thirdJobId = processed[1];
  assert.ok(thirdJobId);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first", "third"]);
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 1);
  release.get(thirdJobId)!();
  for (let attempt = 0; attempt < 30 && processed.length < 3; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const secondJobId = processed[2];
  assert.ok(secondJobId);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first", "third", "second"]);
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 0);
  release.get(secondJobId)!();
  for (let attempt = 0; attempt < 30 && instance.db.getJob(secondJobId)?.status !== "completed"; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(instance.db.getJob(first.body.job.id)?.status, "completed");
  assert.equal(instance.db.getJob(thirdJobId)?.status, "completed");
  assert.equal(instance.db.getJob(secondJobId)?.status, "completed");
});

test("pending drafts support reorder, steer, edit with attachments, and delete", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-pending-actions-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Pending-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Pending-Password-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id;
  const first = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "first" }).expect(202);
  const alpha = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).field("message", "alpha").attach("files", Buffer.from("old"), { filename: "old.txt", contentType: "text/plain" }).expect(202);
  const beta = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "beta" }).expect(202);
  const gamma = await agent.post(`/codex-web/api/conversations/${conversationId}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "gamma" }).expect(202);
  const alphaId = alpha.body.pendingPrompt.id as string;
  const betaId = beta.body.pendingPrompt.id as string;
  const gammaId = gamma.body.pendingPrompt.id as string;
  const oldFile = instance.db.getPendingPrompt(alphaId)!.files[0];
  const workspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId);
  assert.equal(fs.existsSync(path.join(workspace, oldFile.relative_path)), true);
  let detail = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.deepEqual(detail.body.messages.map((message: { content: string }) => message.content), ["first"]);
  assert.deepEqual(detail.body.pendingPrompts.map((prompt: { id: string }) => prompt.id), [alphaId, betaId, gammaId]);

  await agent.put(`/codex-web/api/conversations/${conversationId}/pending-prompts/order`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ ids: [gammaId, alphaId, betaId] }).expect(200);
  assert.deepEqual(instance.db.listPendingPrompts(conversationId).map((prompt) => prompt.id), [gammaId, alphaId, betaId]);

  const releases = new Map<string, () => void>();
  instance.runner.run = async (jobId, id) => {
    await new Promise<void>((resolve) => releases.set(jobId, resolve));
    instance.db.finishJob(jobId, id, "completed");
  };
  let steeredPrompt = "";
  instance.runner.steer = async (jobId, prompt) => {
    assert.equal(jobId, first.body.job.id);
    steeredPrompt = prompt;
    return crypto.randomUUID();
  };
  await instance.pumpQueue();
  for (let attempt = 0; attempt < 20 && !releases.has(first.body.job.id); attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  await agent.post(`/codex-web/api/conversations/${conversationId}/pending-prompts/${gammaId}/steer`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(steeredPrompt, "gamma");
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first", "gamma"]);

  await agent.delete(`/codex-web/api/conversations/${conversationId}/pending-prompts/${betaId}`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(204);
  await agent.post(`/codex-web/api/conversations/${conversationId}/pending-prompts/${alphaId}/edit`)
    .set("X-CSRF-Token", login.body.csrfToken).expect(200);
  assert.equal(instance.db.listPendingPrompts(conversationId).length, 0);
  assert.equal(instance.db.listPendingPrompts(conversationId, "editing")[0].id, alphaId);

  releases.get(first.body.job.id)!();
  for (let attempt = 0; attempt < 30 && instance.db.getJob(first.body.job.id)?.status !== "completed"; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(instance.db.listActiveJobsForConversation(conversationId).length, 0);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first", "gamma"]);

  await agent.put(`/codex-web/api/conversations/${conversationId}/pending-prompts/${alphaId}`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .field("message", "alpha edited")
    .field("removedFileIds", JSON.stringify([oldFile.id]))
    .attach("files", Buffer.from("new"), { filename: "new.txt", contentType: "text/plain" })
    .expect(200);
  assert.equal(instance.db.getFile(oldFile.id), undefined);
  assert.equal(fs.existsSync(path.join(workspace, oldFile.relative_path)), false);
  const updated = instance.db.getPendingPrompt(alphaId)!;
  assert.equal(updated.content, "alpha edited");
  assert.deepEqual(updated.files.map((file) => file.original_name), ["new.txt"]);

  await instance.pumpQueue();
  for (let attempt = 0; attempt < 30 && !instance.db.listActiveJobsForConversation(conversationId).some((job) => job.id !== first.body.job.id); attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  const editedJob = instance.db.listActiveJobsForConversation(conversationId)[0];
  assert.ok(editedJob);
  assert.deepEqual(instance.db.listMessages(conversationId).map((message) => message.content), ["first", "gamma", "alpha edited"]);
  for (let attempt = 0; attempt < 20 && !releases.has(editedJob.id); attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  releases.get(editedJob.id)!();
  for (let attempt = 0; attempt < 20 && instance.db.getJob(editedJob.id)?.status !== "completed"; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  detail = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(detail.body.pendingPrompts.length, 0);
  assert.equal(detail.body.editingPrompt, null);
});

test("nightly Codex maintenance gate prevents a new job from racing runtime promotion", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-update-gate-test-"));
  const dataRoot = path.join(root, "data");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot, tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Update-Gate-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Update-Gate-Password-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  fs.writeFileSync(path.join(dataRoot, ".codex-update-maintenance"), "test");
  const response = await agent.post(`/codex-web/api/conversations/${created.body.conversation.id}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "must not queue" }).expect(503);
  assert.match(response.body.error, /Codex/);
  assert.equal(instance.db.listQueuedJobs().length, 0);
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(dataRoot, ".codex-update-maintenance"), stale, stale);
  await agent.post(`/codex-web/api/conversations/${created.body.conversation.id}/messages`)
    .set("X-CSRF-Token", login.body.csrfToken).send({ message: "stale gate must recover" }).expect(202);
  assert.equal(instance.db.listQueuedJobs().length, 1);
});

test("account identity uses the signed-in display name for the label and avatar", () => {
  assert.deepEqual(resolveAccountIdentity({ username: "wh", displayName: "WH" }), { displayName: "WH", initials: "WH" });
  assert.deepEqual(resolveAccountIdentity({ username: "wenhao", displayName: "Wen Hao" }), { displayName: "Wen Hao", initials: "WH" });
  assert.deepEqual(resolveAccountIdentity({ username: "member", displayName: "文豪" }), { displayName: "文豪", initials: "文豪" });
});

test("different conversations start concurrently without global or per-user limits", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-parallel-conversations-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Parallel-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Parallel-Password-2026!" }).expect(200);
  const jobIds: string[] = [];
  for (const message of ["alpha", "beta", "gamma"]) {
    const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
    const submitted = await agent.post(`/codex-web/api/conversations/${created.body.conversation.id}/messages`)
      .set("X-CSRF-Token", login.body.csrfToken).send({ message }).expect(202);
    assert.equal(submitted.body.job.queuePosition, 1);
    jobIds.push(submitted.body.job.id);
  }

  const started: string[] = [];
  const release = new Map<string, () => void>();
  instance.runner.run = async (jobId, conversationId) => {
    started.push(jobId);
    await new Promise<void>((resolve) => release.set(jobId, resolve));
    instance.db.finishJob(jobId, conversationId, "completed");
  };
  await instance.pumpQueue();
  for (let attempt = 0; attempt < 10 && started.length < jobIds.length; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(started, jobIds);
  assert.deepEqual(jobIds.map((id) => instance.db.getJob(id)?.status), ["running", "running", "running"]);
  for (const id of jobIds) release.get(id)!();
  for (let attempt = 0; attempt < 10 && jobIds.some((id) => instance.db.getJob(id)?.status !== "completed"); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(jobIds.map((id) => instance.db.getJob(id)?.status), ["completed", "completed", "completed"]);
});

test("a queued job can skip the shared-directory queue and start immediately", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-skip-queue-api-test-"));
  const shared = path.join(root, "shared-project");
  fs.mkdirSync(shared, { recursive: true });
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Skip-Queue-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Skip-Queue-Password-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;
  const firstCreated = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  const secondCreated = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", csrf).expect(201);
  instance.db.updateConversation(firstCreated.body.conversation.id, { workingDir: shared });
  instance.db.updateConversation(secondCreated.body.conversation.id, { workingDir: shared });
  const first = await agent.post(`/codex-web/api/conversations/${firstCreated.body.conversation.id}/messages`)
    .set("X-CSRF-Token", csrf).send({ message: "first" }).expect(202);
  const second = await agent.post(`/codex-web/api/conversations/${secondCreated.body.conversation.id}/messages`)
    .set("X-CSRF-Token", csrf).send({ message: "second" }).expect(202);
  const firstId = first.body.job.id as string;
  const secondId = second.body.job.id as string;
  assert.equal(second.body.job.queuePosition, 2);

  const started: string[] = [];
  const release = new Map<string, () => void>();
  instance.runner.run = async (jobId, conversationId) => {
    started.push(jobId);
    await new Promise<void>((resolve) => release.set(jobId, resolve));
    instance.db.finishJob(jobId, conversationId, "completed");
  };
  await instance.pumpQueue();
  for (let attempt = 0; attempt < 20 && started.length < 1; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(started, [firstId]);
  assert.equal(instance.db.getJob(secondId)?.status, "queued");

  await agent.post(`/codex-web/api/jobs/${secondId}/skip-queue`).set("X-CSRF-Token", csrf).expect(200);
  for (let attempt = 0; attempt < 20 && !started.includes(secondId); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(started.includes(secondId));
  assert.equal(instance.db.getJob(secondId)?.status, "running");
  assert.equal(instance.db.getJob(secondId)?.skip_queue, 1);
  assert.equal(instance.db.getJob(firstId)?.status, "running");

  release.get(firstId)!();
  release.get(secondId)!();
  for (let attempt = 0; attempt < 20 && [firstId, secondId].some((id) => instance.db.getJob(id)?.status !== "completed"); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual([firstId, secondId].map((id) => instance.db.getJob(id)?.status), ["completed", "completed"]);
  assert.equal(instance.db.listQueuedJobs().length, 0);
});

test("database restart keeps queued work but interrupts a previously running job", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-durable-queue-test-"));
  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const queuedId = crypto.randomUUID();
  const runningId = crypto.randomUUID();
  const first = new AppDatabase(root);
  first.createConversation(conversationId, "durable queue");
  first.addMessage({ id: messageId, conversation_id: conversationId, role: "user", content: "resume later", created_at: new Date().toISOString() });
  first.createJob(queuedId, conversationId, messageId, { model: "gpt-5.6-sol", reasoningEffort: "high" });
  first.createJob(runningId, conversationId, messageId, { model: "gpt-5.6-sol", reasoningEffort: "high" });
  first.updateJob(runningId, "running");
  first.close();
  const reopened = new AppDatabase(root);
  context.after(() => { reopened.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(reopened.getJob(queuedId)?.status, "queued");
  assert.equal(reopened.getJob(runningId)?.status, "interrupted");
  assert.equal(reopened.getNextQueuedJob()?.id, queuedId);
});

test("file:line fragments parse into clickable code references without protocol false positives", () => {
  const file = { original_name: "demo.py", relative_path: "src/demo.py", host_path: "/home/owner/app/workspaces/abc/src/demo.py" };
  assert.deepEqual(parseFileRef("src/demo.py", [file]), { path: "src/demo.py" });
  assert.deepEqual(parseFileLine("src/demo.py:42", [file]), { path: "src/demo.py", line: 42 });
  assert.deepEqual(parseFileLine("`src/demo.py:7`", [file]), { path: "src/demo.py", line: 7 });
  assert.deepEqual(parseFileLine("sandbox:/mnt/data/report.py:12"), { path: "/mnt/data/report.py", line: 12 });
  assert.deepEqual(parseFileLine("D:\\work\\src\\a.py:3"), { path: "D:/work/src/a.py", line: 3 });
  assert.equal(parseFileLine("12:30"), null);
  assert.equal(parseFileLine("https://example.com:8080"), null);
  assert.equal(parseFileLine("README.md"), null);
  assert.deepEqual(parseSnippetHref("src/demo.py:42", [file]), { path: "src/demo.py", line: 42 });
  assert.deepEqual(parseSnippetHref("outputs/report.py"), { path: "outputs/report.py" });
  assert.equal(parseSnippetHref("https://example.com/a.py:9"), null);
  assert.equal(parseFileRef("https://example.com/a.py"), null);
  assert.equal(parseFileRef("chart.png", [{ original_name: "chart.png", relative_path: "outputs/chart.png", mime_type: "image/png" }]), null);
  assert.deepEqual(parseFileRef("report.py", [{ original_name: "report.py", relative_path: "outputs/report.py", mime_type: "text/x-python" }]), { path: "report.py" });
  assert.deepEqual(parseCodexSnippetUrl("codex-snippet://outputs%2Freport.py?line=9"), { path: "outputs/report.py", line: 9 });
  assert.equal(parseCodexSnippetUrl("https://example.com/a.py:9"), null);
});

test("message jump finds adjacent user messages and viewport anchors", () => {
  const messages = [
    { id: "a", role: "assistant" },
    { id: "b", role: "user" },
    { id: "c", role: "assistant" },
    { id: "d", role: "user" },
    { id: "e", role: "assistant" },
  ];
  assert.equal(findUserMessageJump(messages, "c", "previous"), "b");
  assert.equal(findUserMessageJump(messages, "c", "next"), "d");
  assert.equal(findUserMessageJump(messages, "a", "previous"), null);
  assert.equal(findUserMessageJump(messages, "e", "next"), null);
  assert.equal(findUserMessageJump(messages, "missing", "previous"), "d");
  assert.equal(findUserMessageJump(messages, "missing", "next"), "b");
  const rows = [
    { offsetTop: 0, dataset: { messageId: "a" } },
    { offsetTop: 100, dataset: { messageId: "b" } },
    { offsetTop: 200, dataset: { messageId: "c" } },
  ] as unknown as HTMLElement[];
  assert.equal(
    findViewportAnchorMessageId({ scrollTop: 0, clientHeight: 250, querySelectorAll: () => rows as unknown as NodeListOf<HTMLElement> }),
    "b",
  );
});

test("share tokens round-trip, reject tampering, and expire", () => {
  const secret = "test-share-secret-that-is-longer-than-thirty-two-chars";
  const fileId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expires = now + 3600;
  const token = createShareToken(secret, fileId, expires);
  assert.equal(SHARE_LIFETIME_SECONDS, 7 * 24 * 60 * 60);
  assert.deepEqual(parseShareToken(secret, token), { fileId, expires });
  const tampered = token.slice(0, 8) + (token[8] === "A" ? "B" : "A") + token.slice(9);
  assert.equal(parseShareToken(secret, tampered), null);
  assert.equal(parseShareToken("a-different-secret-".padEnd(40, "z"), token), null);
  assert.equal(parseShareToken(secret, createShareToken(secret, fileId, now - 60)), null);
  assert.equal(parseShareToken(secret, "not-a-token"), null);
});

test("message file links map only registered safe attachments", () => {
  const file: WorkFile = {
    id: "file-1",
    original_name: "ConditionType 统计结果.xlsx",
    relative_path: "outputs/ConditionType 统计结果.xlsx",
    mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 42,
    kind: "output",
  };
  const expected = "/codex-web/api/files/file-1?download=1";
  assert.equal(isLocalMarkdownUrl("sandbox:/mnt/data/ConditionType 统计结果.xlsx"), true);
  assert.deepEqual(resolveMessageFileLink("sandbox:/mnt/data/ConditionType%20%E7%BB%9F%E8%AE%A1%E7%BB%93%E6%9E%9C.xlsx", [file]), { kind: "download", href: expected });
  assert.deepEqual(resolveMessageFileLink("D:\\workspace\\codex-web\\workspaces\\abc\\outputs\\ConditionType%20%E7%BB%9F%E8%AE%A1%E7%BB%93%E6%9E%9C.xlsx", [file]), { kind: "download", href: expected });
  assert.deepEqual(resolveMessageFileLink("/home/owner/app/workspaces/abc/outputs/ConditionType%20%E7%BB%9F%E8%AE%A1%E7%BB%93%E6%9E%9C.xlsx", [file]), { kind: "download", href: expected });
  assert.deepEqual(resolveMessageFileLink("outputs/ConditionType 统计结果.xlsx", [file]), { kind: "download", href: expected });
  assert.deepEqual(resolveMessageFileLink("sandbox:/mnt/data/not-registered.xlsx", [file]), { kind: "unavailable" });
  assert.deepEqual(resolveMessageFileLink("D:\\secret\\not-registered.xlsx", [file]), { kind: "unavailable" });
  assert.deepEqual(resolveMessageFileLink("outputs/../secret.xlsx", [file]), { kind: "unavailable" });
  assert.deepEqual(resolveMessageFileLink("https://example.com/help", [file]), { kind: "regular", href: "https://example.com/help" });
  assert.equal(localPathText("sandbox:/mnt/data/ConditionType%20%E7%BB%9F%E8%AE%A1%E7%BB%93%E6%9E%9C.xlsx"), "/mnt/data/ConditionType 统计结果.xlsx");
  assert.equal(localPathText("D:\\workspace\\codex-web\\workspaces\\abc\\outputs\\a%20b.txt"), "D:/workspace/codex-web/workspaces/abc/outputs/a b.txt");
  assert.equal(localPathText("outputs/report.md"), "outputs/report.md");
  assert.equal(localPathText(undefined), "");
});

test("private file citations become safe readable references", () => {
  const file = {
    original_name: "24级6班物理成绩复盘.pptx",
    relative_path: "uploads/5466e122-8e9c-4b42-8912-2ce9c539eecf.pptx",
  };
  const raw = '已读完。 :codex-file-citation{path="/app/workspaces/conversation/uploads/5466e122-8e9c-4b42-8912-2ce9c539eecf.pptx" artifact_kind="presentation" slide_number="1"}';
  const safe = sanitizeAgentMarkdown(raw, [file]);
  assert.equal(safe, "已读完。 （引用：24级6班物理成绩复盘.pptx，第 1 页）");
  assert.doesNotMatch(safe, /codex-file-citation|\/app\/workspaces/);
  const lineSafe = sanitizeAgentMarkdown(
    ':codex-file-citation{path="/app/workspaces/conversation/outputs/report.py" line_number="42"}',
    [{ original_name: "report.py", relative_path: "outputs/report.py" }],
  );
  assert.equal(lineSafe, "[引用：report.py，第 42 行](codex-snippet://outputs%2Freport.py?line=42)");
  assert.doesNotMatch(lineSafe, /codex-file-citation|\/app\/workspaces/);
  assert.equal(
    sanitizeAgentMarkdown(':codex-file-citation{path="/tmp/unknown.pdf" artifact_kind="pdf" page_number="3"}'),
    "（引用：PDF，第 3 页）",
  );
});

test("conversation API sanitizes historical file citations without rewriting the database", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-citation-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);

  const conversationId = crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const diskName = `${crypto.randomUUID()}.pptx`;
  const raw = `结论。 :codex-file-citation{path="/app/workspaces/${conversationId}/uploads/${diskName}" artifact_kind="presentation" slide_number="2"}`;
  instance.db.createConversation(conversationId, "citation");
  instance.db.addMessage({ id: userMessageId, conversation_id: conversationId, role: "user", content: "读一下", created_at: new Date().toISOString() });
  instance.db.addFile({
    id: crypto.randomUUID(), conversation_id: conversationId, message_id: userMessageId,
    original_name: "班级复盘.pptx", relative_path: `uploads/${diskName}`,
    mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    size: 10, kind: "upload", created_at: new Date().toISOString(),
  });
  instance.db.addMessage({ id: assistantMessageId, conversation_id: conversationId, role: "assistant", content: raw, created_at: new Date().toISOString() });

  const response = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(response.body.messages.at(-1).content, "结论。 （引用：班级复盘.pptx，第 2 页）");
  assert.equal(instance.db.listMessages(conversationId).at(-1)?.content, raw);
});

test("AI-titled conversations hide repeated title envelopes without rewriting audit rows", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-title-envelope-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);

  const conversationId = crypto.randomUUID();
  const raw = '{"answer":"已确认：双出口抖动已经停止。\\n\\n连续检查均正常。","title":"NAS 双出口抖动已停止"}';
  instance.db.createConversation(conversationId, "新任务");
  assert.equal(instance.db.setAiConversationTitleIfDefault(conversationId, "会话测试"), true);
  instance.db.addMessage({ id: crypto.randomUUID(), conversation_id: conversationId, role: "assistant", content: raw, created_at: new Date().toISOString() });

  const response = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(response.body.messages[0].content, "已确认：双出口抖动已经停止。\n\n连续检查均正常。");
  assert.equal(instance.db.listMessages(conversationId)[0].content, raw);
});

test("selection and activity recovery reject stale conversations and deduplicate replay", () => {
  const conversations = [{ id: "valid", title: "Valid", status: "idle", created_at: "", updated_at: "" }] as Conversation[];
  assert.equal(chooseSelectedConversation("valid", conversations), "valid");
  assert.equal(chooseSelectedConversation("deleted", conversations), "valid");
  assert.equal(chooseSelectedConversation("deleted", []), null);
  assert.deepEqual(mergeJobEvents([{ seq: 1, type: "progress", label: "old" }], [
    { seq: 1, type: "progress", label: "new" },
    { seq: 2, type: "done" },
  ]).map((event) => [event.seq, event.label ?? event.type]), [[1, "new"], [2, "done"]]);
  assert.equal(isTerminalJob({ id: "j", conversation_id: "valid", status: "cancelled" }), true);
  assert.equal(isTerminalJob({ id: "j", conversation_id: "valid", status: "running" }), false);
});

test("activity recovery keeps five expired stage updates above the rolling event window", () => {
  const events = Array.from({ length: 62 }, (_, index) => {
    const seq = index + 1;
    return seq <= 6 || seq === 62
      ? { seq, type: "progress", kind: "update", label: "阶段反馈", detail: `阶段 ${seq}` }
      : { seq, type: "progress", kind: "command", label: `步骤 ${seq}`, detail: `command ${seq}` };
  });
  const retained = mergeJobEvents([], events);
  assert.deepEqual(retained.slice(0, 5).map((event) => event.seq), [2, 3, 4, 5, 6]);
  assert.deepEqual(retained.slice(5).map((event) => event.seq), Array.from({ length: 50 }, (_, index) => index + 13));
  assert.equal(retained.filter((event) => event.kind === "update").length, 6);
  assert.equal(retained.at(-1)?.seq, 62);
});

test("activity recovery keeps the task start and terminal events for long-running jobs", () => {
  const events = Array.from({ length: 120 }, (_, index) => {
    const seq = index + 1;
    if (seq === 1) return { seq, type: "status", status: "running", label: "Codex Web 正在处理", created_at: "2026-08-12T00:00:00.000Z" };
    if (seq === 120) return { seq, type: "done", status: "completed", created_at: "2026-08-12T00:10:00.000Z" };
    return { seq, type: "progress", kind: "command", label: `步骤 ${seq}`, created_at: "2026-08-12T00:00:01.000Z" };
  });
  const retained = mergeJobEvents([], events);
  const firstRunning = retained.find((event) => (event.type === "status" || event.kind === "status") && event.status === "running");
  const terminal = retained.findLast((event) => event.type === "done" || event.type === "failed");
  assert.equal(firstRunning?.seq, 1);
  assert.equal(terminal?.seq, 120);
  assert.equal(taskElapsedSeconds(retained), 600);
  assert.equal(retained.length, 51);
});

test("job finalization makes job and conversation terminal atomically", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-db-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
    const conversationId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    db.createConversation(conversationId, status);
    db.createJob(jobId, conversationId);
    db.updateJob(jobId, "running");
    db.updateConversation(conversationId, { status: "running" });
    db.appendEvent(jobId, "progress", { label: "saved step" });
    if (status === "completed") db.addMessage({ id: crypto.randomUUID(), conversation_id: conversationId, role: "assistant", content: "result", created_at: new Date().toISOString() });
    db.finishJob(jobId, conversationId, status, status === "failed" ? "boom" : null);
    assert.equal(db.getJob(jobId)?.status, status);
    assert.equal(db.getConversation(conversationId)?.status, "idle");
    assert.equal(db.getConversation(conversationId)?.has_unread_result, status === "completed" ? 1 : 0);
    assert.equal(db.getActiveJobForConversation(conversationId), undefined);
    assert.equal(db.listEvents(jobId).length, 1);
    if (status === "completed") assert.equal(db.listMessages(conversationId).at(-1)?.content, "result");
  }
});

test("job progress events refresh the job activity timestamp", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-job-activity-test-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversationId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  db.createConversation(conversationId, "activity");
  db.createJob(jobId, conversationId);
  db.sqlite.prepare("UPDATE jobs SET updated_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", jobId);
  db.appendEvent(jobId, "progress", { label: "still working" });
  assert.equal(db.getJob(jobId)?.updated_at, db.listEvents(jobId)[0].created_at);
  assert.notEqual(db.getJob(jobId)?.updated_at, "2000-01-01T00:00:00.000Z");
});

test("conversation history loads the newest page first and older pages on demand", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-message-pages-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);

  const conversationId = crypto.randomUUID();
  instance.db.createConversation(conversationId, "paged history");
  const ids = Array.from({ length: 65 }, (_, index) => `message-${String(index).padStart(3, "0")}`);
  ids.forEach((id, index) => instance.db.addMessage({
    id,
    conversation_id: conversationId,
    role: index % 2 ? "assistant" : "user",
    content: `message ${index}`,
    created_at: new Date(Date.UTC(2026, 6, 20, 0, 0, index)).toISOString(),
  }));

  const first = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.deepEqual(first.body.messages.map((message: { id: string }) => message.id), ids.slice(35));
  assert.deepEqual(first.body.messagePage, { hasMore: true, nextCursor: ids[35] });
  const second = await agent.get(`/codex-web/api/conversations/${conversationId}/messages?before=${ids[35]}`).expect(200);
  assert.deepEqual(second.body.messages.map((message: { id: string }) => message.id), ids.slice(5, 35));
  assert.deepEqual(second.body.messagePage, { hasMore: true, nextCursor: ids[5] });
  const third = await agent.get(`/codex-web/api/conversations/${conversationId}/messages?before=${ids[5]}`).expect(200);
  assert.deepEqual(third.body.messages.map((message: { id: string }) => message.id), ids.slice(0, 5));
  assert.deepEqual(third.body.messagePage, { hasMore: false, nextCursor: null });
  await agent.get(`/codex-web/api/conversations/${conversationId}/messages`).expect(400);
  await agent.get(`/codex-web/api/conversations/${conversationId}/messages?before=missing-message`).expect(400);
});

test("conversation detail restores running progress and terminal SSE replay", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-recovery-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);

  const conversationId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  instance.db.createConversation(conversationId, "recover me");
  instance.db.createJob(jobId, conversationId);
  instance.db.updateJob(jobId, "running");
  instance.db.updateConversation(conversationId, { status: "running" });
  instance.db.appendEvent(jobId, "status", { status: "running", label: "started" });
  instance.db.appendEvent(jobId, "progress", { label: "step two" });

  const running = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(running.body.activeJob.id, jobId);
  assert.equal(typeof running.body.activeJob.startedAt, "string");
  assert.equal(running.body.jobEvents.length, 2);
  assert.equal(running.body.jobEvents[1].label, "step two");

  instance.db.addMessage({ id: crypto.randomUUID(), conversation_id: conversationId, role: "assistant", content: "finished", created_at: new Date().toISOString() });
  instance.db.finishJob(jobId, conversationId, "completed");
  instance.db.appendEvent(jobId, "done", { status: "completed" });
  const terminal = await agent.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.equal(terminal.body.activeJob, null);
  assert.equal(terminal.body.latestJob.status, "completed");
  assert.equal(terminal.body.messages.at(-1).content, "finished");

  const replay = await agent.get(`/codex-web/api/jobs/${jobId}/events?after=1`).expect(200);
  assert.equal(replay.headers["x-accel-buffering"], "no");
  assert.doesNotMatch(replay.text, /id: 1\n/);
  assert.match(replay.text, /id: 2\n/);
  assert.match(replay.text, /id: 3\n/);
  assert.match(replay.text, /"created_at":"2026-/);
  await agent.get(`/codex-web/api/conversations/${crypto.randomUUID()}`).expect(404);
});

test("file tree API scopes listings to the conversation and serves safe previews", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-file-tree-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false, hostMode: false,
    username: "owner", passwordHash: bcrypt.hashSync("File-Tree-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "File-Tree-Password-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id as string;
  const userId = instance.db.getConversation(conversationId)?.user_id;
  assert.ok(userId);
  const workspace = ensureTenantWorkspace(tenantRoot, userId, conversationId);
  const library = ensureTenant(tenantRoot, userId).library;
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "README.md"), "# Workspace\n\nhello\n", "utf8");
  fs.writeFileSync(path.join(workspace, "src", "main.ts"), "export const answer = 42;\n", "utf8");
  fs.writeFileSync(path.join(workspace, ".env"), "TOKEN=must-not-be-listed\n", "utf8");
  fs.writeFileSync(path.join(library, "PROFILE.md"), "# Profile\n", "utf8");

  const roots = await agent.get(`/codex-web/api/conversations/${conversationId}/file-tree`).expect(200);
  assert.deepEqual(roots.body.roots.map((root: { id: string }) => root.id), ["workspace", "library"]);
  assert.equal(roots.body.roots.every((root: { available: boolean }) => root.available), true);

  const listing = await agent.get(`/codex-web/api/conversations/${conversationId}/file-tree?root=workspace&path=`).expect(200);
  const names = listing.body.listing.entries.map((entry: { name: string }) => entry.name);
  assert.ok(names.includes("README.md"));
  assert.ok(names.includes("src"));
  assert.equal(names.includes(".env"), false);
  assert.equal(names.includes(".runtime"), false);

  const nested = await agent.get(`/codex-web/api/conversations/${conversationId}/file-tree?root=workspace&path=${encodeURIComponent("src")}`).expect(200);
  assert.deepEqual(nested.body.listing.entries.map((entry: { name: string }) => entry.name), ["main.ts"]);

  const preview = await agent.get(`/codex-web/api/conversations/${conversationId}/file-tree/preview?root=workspace&path=${encodeURIComponent("src/main.ts")}`).expect(200);
  assert.equal(preview.body.mimeType, "text/x-typescript");
  assert.equal(preview.body.content, "export const answer = 42;\n");

  const download = await agent.get(`/codex-web/api/conversations/${conversationId}/file-tree/file?root=workspace&path=${encodeURIComponent("src/main.ts")}&download=1`).expect(200);
  assert.match(download.headers["content-type"], /text\/x-typescript/);
  assert.equal(download.text, "export const answer = 42;\n");

  await agent.get(`/codex-web/api/conversations/${conversationId}/file-tree/preview?root=workspace&path=${encodeURIComponent("../README.md")}`).expect(400);
  await agent.get(`/codex-web/api/conversations/${conversationId}/file-tree/preview?root=workspace&path=${encodeURIComponent(".env")}`).expect(400);
});
