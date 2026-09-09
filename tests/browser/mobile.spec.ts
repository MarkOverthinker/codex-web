import { test, expect, type Page } from "@playwright/test";

const conversation = { id: "mobile-demo", title: "检查项目与整理交付文件", title_source: "manual", status: "idle", has_unread_result: 0, has_pending_work: 0, rollout_bytes: 0, archived_at: null, created_at: "2026-09-01T08:00:00Z", updated_at: "2026-09-01T08:00:00Z", working_dir: null };
const selection = { model: "demo-model", reasoningEffort: "medium", sandbox: "workspace-write" };

async function setup(page: Page, groupedModels = false) {
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
  await page.route("**/codex-web/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/codex-web/api", "");
    let body: unknown;
    if (path === "/auth/session") body = { authenticated: true, username: "demo", csrfToken: "test-only", voiceEnabled: false, canChangeUsername: true };
    else if (path === "/agent-options") body = { providers: groupedModels ? [{ id: "demo-source", name: "测试 API 源" }] : [], models: [{ id: "demo-model", label: "Demo Model", description: "测试模型", reasoningEfforts: ["medium", "high"], ...(groupedModels ? { provider: "demo-source", providerName: "测试 API 源" } : {}) }], reasoningEfforts: [{ id: "medium", label: "标准" }, { id: "high", label: "深入" }], sandboxModes: [{ id: "workspace-write", label: "工作区写入", description: "限制写入范围" }, { id: "danger-full-access", label: "完全访问", description: "跳过沙箱" }], selection, defaults: selection };
    else if (path === "/conversations") body = { conversations: [conversation] };
    else if (path === "/conversations/mobile-demo") body = detail;
    else if (path === "/working-dirs") body = { settings: { enabled: true, favorites: [], defaultWorkingDir: null } };
    else if (path === "/task-categories") body = { settings: { customCategories: [], pinned: [], hidden: [], conversationOrders: {} } };
    else if (path === "/preset-prompts") body = { presetPrompts: [] };
    else if (path === "/reload-status") body = { available: false };
    else if (path.endsWith("/review")) body = { root: "/workspace", branch: "main", bases: ["main"], base: null, comparison: "工作区", files: [] };
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

for (const width of [360, 390, 430]) {
  test(`mobile ${width}px: tools remain reachable without crowding the composer`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors = await setup(page);
    await expect(page.locator(".chat-header")).toBeHidden();
    await expect(page.getByRole("button", { name: "添加文件", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "模型", exact: true })).toBeHidden();
    if (width === 390 && process.env.MOBILE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.MOBILE_SCREENSHOT_DIR}/mobile-chat.png` });
    const input = page.locator(".composer textarea");
    await input.fill("第一行");
    await input.press("Enter");
    await input.pressSequentially("第二行");
    await expect(input).toHaveValue("第一行\n第二行");
    await page.getByRole("button", { name: "任务选项", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "任务选项", exact: true });
    await expect(sheet.getByRole("button", { name: "模型", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "权限", exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "预设 Prompt", exact: true })).toBeVisible();
    if (width === 390 && process.env.MOBILE_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.MOBILE_SCREENSHOT_DIR}/mobile-options.png` });
    await sheet.getByRole("button", { name: "思考", exact: true }).click();
    await expect(sheet.getByRole("option", { name: "深入" })).toBeVisible();
    await page.evaluate(() => (window as unknown as { codexMobileBack: () => boolean }).codexMobileBack());
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("option", { name: "深入" })).toBeHidden();
    await page.evaluate(() => (window as unknown as { codexMobileBack: () => boolean }).codexMobileBack());
    await expect(sheet).toBeHidden();
    await expect(input).toHaveValue("第一行\n第二行");
    await page.getByRole("button", { name: "会话工具", exact: true }).click();
    const tools = page.getByRole("dialog", { name: "会话工具", exact: true });
    for (const name of ["打开文件浏览器", "查看 Git 分支变更", "查看 API 计费统计", "目录"]) await expect(tools.getByRole("button", { name, exact: true })).toBeVisible();
    await tools.getByRole("button", { name: "查看 Git 分支变更" }).click();
    await expect(tools).toBeHidden();
    await expect(page.locator(".review-dialog")).toBeVisible();
    await page.evaluate(() => (window as unknown as { codexMobileBack: () => boolean }).codexMobileBack());
    await expect(page.locator(".review-dialog")).toBeHidden();
    await expect(page.locator(".shell")).not.toHaveAttribute("inert");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("keyboard-sized viewport keeps input and send action on screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.locator(".composer textarea").fill("保留这份草稿");
  await page.setViewportSize({ width: 390, height: 420 });
  const send = page.getByRole("button", { name: "发送", exact: true });
  await expect(send).toBeVisible();
  const bounds = await send.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(420);
  await page.getByRole("button", { name: "打开任务列表" }).click();
  await expect(page.locator(".sidebar.open")).toBeVisible();
  await page.evaluate(() => (window as unknown as { codexMobileBack: () => boolean }).codexMobileBack());
  await expect(page.locator(".sidebar.open")).toHaveCount(0);
  await expect(page.locator(".composer textarea")).toHaveValue("保留这份草稿");
});

test("desktop retains inline controls and existing layout", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = await setup(page);
  await expect(page.locator(".desktop-header")).toBeVisible();
  await expect(page.locator(".mobile-header")).toBeHidden();
  await expect(page.locator(".composer").getByRole("button", { name: "模型", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 API 计费统计" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("landscape and breakpoint changes preserve the draft and keep the mobile tools reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const input = page.locator(".composer textarea");
  await input.fill("旋转前的草稿");
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.getByRole("button", { name: "会话工具", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "任务选项", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "任务选项", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("旋转前的草稿");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".composer").getByRole("button", { name: "模型", exact: true })).toBeVisible();
  await expect(input).toHaveValue("旋转前的草稿");
  await expect(page.locator(".shell")).not.toHaveAttribute("inert");
});

test("grouped provider models stay inside the phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const errors = await setup(page, true);
  await page.getByRole("button", { name: "任务选项", exact: true }).click();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  const group = page.getByRole("button", { name: "测试 API 源 1 个模型" });
  await group.click();
  const model = page.getByRole("option", { name: "Demo Model 测试模型" });
  await expect(model).toBeVisible();
  const bounds = await model.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
  await model.click();
  await page.getByRole("button", { name: "关闭任务选项" }).click();
  expect(errors).toEqual([]);
});

test("dark theme and personal settings keep focus and navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("codex-web:theme", "system"));
  await page.emulateMedia({ colorScheme: "dark" });
  await setup(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "任务选项", exact: true }).click();
  await expect(page.locator(".shell")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "任务选项", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "打开任务列表" }).click();
  await page.locator(".account-profile").click();
  await expect(page.getByRole("button", { name: "API 调用计费统计" })).toBeVisible();
  await expect(page.getByRole("button", { name: "预设 Prompt 管理" })).toBeVisible();
  await page.evaluate(() => (window as unknown as { codexMobileBack: () => boolean }).codexMobileBack());
  await expect(page.locator(".account-settings")).toBeHidden();
  await expect(page.locator(".sidebar.open")).toBeVisible();
  await page.evaluate(() => (window as unknown as { codexMobileBack: () => boolean }).codexMobileBack());
  await expect(page.locator(".workspace")).not.toHaveAttribute("inert");
});

test("touch-only source selection opens on the first tap and back closes one layer", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await setup(page, true);
    await page.getByRole("button", { name: "任务选项", exact: true }).tap();
    await page.getByRole("button", { name: "模型", exact: true }).tap();
    const provider = page.getByRole("button", { name: "测试 API 源 1 个模型" });
    await provider.tap();
    await expect(provider).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("option", { name: "Demo Model 测试模型" })).toBeVisible();
    await page.evaluate(() => (window as unknown as { codexMobileBack: () => boolean }).codexMobileBack());
    await expect(provider).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("option", { name: "Demo Model 测试模型" })).toBeHidden();
    await expect(page.getByRole("dialog", { name: "任务选项", exact: true })).toBeVisible();
  } finally { await context.close(); }
});
