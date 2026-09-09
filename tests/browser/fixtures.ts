import { expect, type Page } from "@playwright/test";

const conversation = { id: "mobile-demo", title: "检查项目与整理交付文件", title_source: "manual", status: "idle", has_unread_result: 0, has_pending_work: 0, rollout_bytes: 0, archived_at: null, created_at: "2026-09-01T08:00:00Z", updated_at: "2026-09-01T08:00:00Z", working_dir: null };
const selection = { model: "demo-model", reasoningEffort: "medium", sandbox: "workspace-write" };

export async function setup(page: Page, groupedModels = false, voiceEnabled = false) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("codex-web:selected-conversation", "mobile-demo"));
  const detail = {
    conversation, agentSelection: selection, outputFiles: [], pendingPrompts: [], editingPrompt: null,
    composerDraft: null as null | Record<string, unknown>, enabledPresetPromptIds: [], activeJob: null,
    latestJob: null, jobEvents: [], rolloutBytes: 0, contextUsage: { usedTokens: 1200, contextWindow: 128000, updatedAt: null },
    messagePage: { hasMore: false, nextCursor: null },
    messages: [
      { id: "user-demo", role: "user", content: "检查这个项目，整理结果，并保留现有功能。", files: [], can_edit: true, can_fork: true, created_at: "2026-09-01T08:00:00Z" },
      { id: "assistant-demo", role: "assistant", content: "## 检查结果\n\n已保留会话、任务队列和附件。\n\n- 主界面专注于对话\n- 工具按需展开\n- 文件在单独页面预览\n\n```ts\nconst status = 'ready';\n```", files: [], created_at: "2026-09-01T08:01:00Z" },
    ],
  };
  const sideDetail = { ...detail, conversation: { ...conversation, id: "side-demo" }, messages: [] };
  await page.route("**/codex-web/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/codex-web/api", "");
    let body: unknown;
    if (path === "/auth/session") body = { authenticated: true, username: "demo", csrfToken: "test-only", voiceEnabled, voiceModels: voiceEnabled ? [{ id: "sensevoice-small-int8", label: "SenseVoiceSmall INT8", local: true }, { id: "qwen3-asr-0.6b", label: "Qwen3-ASR-0.6B", local: true }] : [], canChangeUsername: true };
    else if (path === "/agent-options") body = { providers: groupedModels ? [{ id: "demo-source", name: "测试 API 源" }] : [], models: [{ id: "demo-model", label: "Demo Model", description: "测试模型", reasoningEfforts: ["medium", "high"], ...(groupedModels ? { provider: "demo-source", providerName: "测试 API 源" } : {}) }], reasoningEfforts: [{ id: "medium", label: "标准" }, { id: "high", label: "深入" }], sandboxModes: [{ id: "workspace-write", label: "工作区写入", description: "限制写入范围" }, { id: "danger-full-access", label: "完全访问", description: "跳过沙箱" }], selection, defaults: selection };
    else if (path === "/conversations") body = { conversations: [conversation] };
    else if (path === "/conversations/mobile-demo") body = detail;
    else if (path === "/conversations/side-demo") body = sideDetail;
    else if (path === "/conversations/mobile-demo/side-chats" && route.request().method() === "POST") body = { conversation: sideDetail.conversation, agentSelection: selection };
    else if (path === "/side-chats" || path.endsWith("/side-chats")) body = { sideChats: [] };
    else if (path === "/working-dirs") body = { settings: { enabled: true, favorites: [], defaultWorkingDir: null } };
    else if (path === "/task-categories") body = { settings: { customCategories: [], pinned: [], hidden: [], conversationOrders: {} } };
    else if (path === "/preset-prompts") body = { presetPrompts: [] };
    else if (path === "/reload-status") body = { available: false };
    else if (path.endsWith("/review")) body = { root: "/workspace", branch: "main", bases: ["main"], base: null, comparison: "工作区", files: [] };
    else if (path.endsWith("/messages") && route.request().method() === "POST") { detail.composerDraft = null; body = {}; }
    else if (path.endsWith("/draft") && route.request().method() === "PUT") {
      detail.composerDraft = { ...route.request().postDataJSON(), conversation_id: conversation.id, files: [], created_at: conversation.created_at, updated_at: conversation.updated_at };
      body = { composerDraft: detail.composerDraft };
    } else if (path.endsWith("/agent-selection")) body = { selection };
    else if (path.endsWith("/read")) body = { ok: true };
    else {
      await route.fulfill({ status: 404, json: { error: `测试未提供 ${path}` } });
      return;
    }
    await route.fulfill({ json: body });
  });
  await page.goto("/codex-web/");
  await expect(page.locator(".messages")).toContainText("检查结果");
  return errors;
}
