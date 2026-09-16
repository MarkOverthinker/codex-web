import { test, expect } from "@playwright/test";
import { setup } from "./fixtures";
import type { Automation, AutomationRun } from "../../src/automation-types";

for (const mobile of [false, true]) {
  test(`automations manage, run history and conversation navigation (${mobile ? "mobile" : "desktop"})`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const errors = await setup(page);
    let tasks: Automation[] = [];
    const runs: AutomationRun[] = [];
    await page.route("**/codex-web/api/automations**", async (route) => {
      const method = route.request().method();
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith("/run")) {
        const task = tasks[0];
        runs.push({ id: "run-1", automationId: task.id, name: task.name, trigger: "manual", scheduledAt: "2026-09-16T01:00:00Z",
          createdAt: "2026-09-16T01:00:00Z", conversationId: "mobile-demo", jobId: "job-1", status: "completed", error: null, snapshot: task });
        await route.fulfill({ status: 202, json: { runId: "run-1" } });
      } else if (method === "GET") await route.fulfill({ json: { automations: tasks } });
      else if (method === "POST") {
        expect(route.request().headers()["x-csrf-token"]).toBe("test-only");
        const task = { ...route.request().postDataJSON(), id: "automation-1", nextRunAt: "2026-09-17T01:00:00Z", createdAt: "2026-09-16T00:00:00Z", updatedAt: "2026-09-16T00:00:00Z" };
        tasks.push(task);
        await route.fulfill({ status: 201, json: { automation: task } });
      } else if (method === "PUT" || method === "PATCH") {
        tasks[0] = { ...tasks[0], ...route.request().postDataJSON() };
        await route.fulfill({ json: { automation: tasks[0] } });
      } else if (method === "DELETE") { tasks = []; await route.fulfill({ status: 204 }); }
    });
    await page.route("**/codex-web/api/automation-runs**", (route) => route.fulfill({ json: { runs } }));
    if (mobile) await page.getByRole("button", { name: "打开任务列表", exact: true }).click();
    await page.getByRole("button", { name: "自动任务", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "自动任务", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("尚未配置自动任务");
    await dialog.getByRole("button", { name: "新建自动任务", exact: true }).click();
    await dialog.getByLabel("任务名称", { exact: true }).fill("每日项目检查");
    await dialog.getByLabel("运行路径", { exact: true }).fill("/workspace/project");
    await dialog.getByLabel("每天运行时间").fill("09:30");
    await dialog.getByLabel("时区", { exact: true }).fill("Asia/Shanghai");
    await dialog.getByLabel("思考强度").selectOption("high");
    await dialog.getByLabel("固定提示词").fill("检查项目并生成日报。");
    await dialog.getByRole("button", { name: "保存任务", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "每日项目检查" })).toBeVisible();
    expect(tasks[0]).toMatchObject({ time: "09:30", timeZone: "Asia/Shanghai", model: "demo-model", reasoningEffort: "high", workingDir: "/workspace/project", prompt: "检查项目并生成日报。" });
    await dialog.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(dialog).toContainText("已暂停");
    await dialog.getByRole("button", { name: "启用", exact: true }).click();
    await expect(dialog).toContainText("已启用");
    await dialog.getByRole("button", { name: "编辑", exact: true }).click();
    await dialog.getByLabel("固定提示词").fill("检查项目并生成简明日报。");
    await dialog.getByRole("button", { name: "保存任务", exact: true }).click();
    await expect(dialog).toContainText("检查项目并生成简明日报。");
    await dialog.getByRole("button", { name: "立即运行", exact: true }).click();
    await expect(dialog).toContainText("已完成");
    await dialog.getByText("查看本次配置和提示词").click();
    await expect(dialog).toContainText("检查项目并生成简明日报。");
    const bounds = await dialog.boundingBox();
    expect(bounds!.width).toBeLessThanOrEqual(mobile ? 390 : 1280);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("automation-history.png") });
    await dialog.getByRole("button", { name: "打开任务会话", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(".messages")).toContainText("检查结果");
    if (mobile) await page.getByRole("button", { name: "打开任务列表", exact: true }).click();
    await page.getByRole("button", { name: "自动任务", exact: true }).click();
    page.once("dialog", (confirmation) => confirmation.accept());
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await expect(dialog).toContainText("尚未配置自动任务");
    await dialog.getByRole("button", { name: "运行记录", exact: true }).click();
    await expect(dialog).toContainText("已完成");
    await dialog.getByRole("button", { name: "关闭自动任务" }).click();
    await expect(dialog).not.toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("automation API errors remain visible and do not discard editor input", async ({ page }) => {
  await setup(page);
  await page.route("**/codex-web/api/automations", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 400, json: { error: "所选模型当前不可用，请刷新页面后重试。" } })
    : route.fulfill({ json: { automations: [] } }));
  await page.getByRole("button", { name: "自动任务", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "自动任务", exact: true });
  await dialog.getByRole("button", { name: "新建自动任务", exact: true }).click();
  await dialog.getByLabel("任务名称", { exact: true }).fill("保留输入");
  await dialog.getByLabel("固定提示词").fill("不要丢失输入。");
  await dialog.getByRole("button", { name: "保存任务", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("模型当前不可用");
  await expect(dialog.getByLabel("固定提示词")).toHaveValue("不要丢失输入。");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});
