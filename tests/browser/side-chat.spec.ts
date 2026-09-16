import { expect, test } from "@playwright/test";
import { setup } from "./fixtures";

test("queued side chat can skip the queue and refresh to running", async ({ page }) => {
  const errors = await setup(page);
  const conversation = {
    id: "side-demo", title: "侧边排队任务", title_source: "manual", status: "idle", has_unread_result: 0,
    has_pending_work: 1, rollout_bytes: 0, archived_at: null, created_at: "2026-09-01T08:00:00Z",
    updated_at: "2026-09-01T08:01:00Z", working_dir: "/workspace",
  };
  let jobStatus = "queued";
  let skipRequests = 0;
  const detail = () => ({
    conversation,
    agentSelection: { model: "demo-model", reasoningEffort: "medium", sandbox: "workspace-write" },
    messages: [], outputFiles: [], messagePage: { hasMore: false, nextCursor: null }, pendingPrompts: [], editingPrompt: null,
    composerDraft: null, enabledPresetPromptIds: [], activeJob: { id: "side-job", status: jobStatus, conversation_id: conversation.id, queuePosition: jobStatus === "queued" ? 2 : 0 },
    latestJob: null, jobEvents: [], rolloutBytes: 0, contextUsage: { usedTokens: 0, contextWindow: 128000, updatedAt: null },
  });
  await page.route("**/codex-web/api/side-chats", (route) => route.fulfill({ json: { sideChats: [{
    conversation, parentConversationId: "mobile-demo", parentConversationTitle: "检查项目与整理交付文件",
    createdAt: conversation.created_at, lastOpenedAt: conversation.updated_at,
  }] } }));
  await page.route("**/codex-web/api/side-chats/side-demo/open", (route) => route.fulfill({ json: { conversation } }));
  await page.route("**/codex-web/api/conversations/side-demo", (route) => route.fulfill({ json: detail() }));
  await page.route("**/codex-web/api/jobs/side-job/skip-queue", (route) => {
    skipRequests += 1;
    jobStatus = "running";
    return route.fulfill({ json: { ok: true, job: detail().activeJob } });
  });
  page.once("dialog", (dialog) => dialog.accept());

  await page.getByTitle("打开侧边聊天", { exact: true }).click();
  const side = page.getByRole("complementary", { name: "侧边聊天", exact: true });
  const skip = side.getByRole("button", { name: "跳过排队直接执行", exact: true });
  await expect(skip).toBeVisible();
  await skip.click();
  await expect.poll(() => skipRequests).toBe(1);
  await expect(side.getByText("正在处理", { exact: true })).toBeVisible();
  await expect(skip).toHaveCount(0);
  expect(errors).toEqual([]);
});
