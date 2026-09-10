import { expect, test } from "@playwright/test";
import { setup } from "./fixtures";

for (const width of [390, 1280]) {
  test(`subagent panel survives refresh at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/conversations/mobile-demo"));
    const errors = await setup(page);
    const detail = await (await responsePromise).json();
    detail.jobEvents = [
      { seq: 1, kind: "subagent", subagentTool: "spawnAgent", subagentStatus: "completed", agentThreadIds: ["child-thread"], agentPrompt: "检查 API 路由" },
      { seq: 2, kind: "subagent", agentStates: { "child-thread": "completed", "second-thread": "errored" } },
    ];
    await page.route("**/api/conversations/mobile-demo", (route) => route.fulfill({ json: detail }));
    await page.reload();
    const panel = page.getByRole("region", { name: "子代理状态" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("2 个 · 0 运行中 · 1 已完成");
    await panel.locator("summary").first().click();
    await expect(panel).toContainText("检查 API 路由");
    await expect(panel).toContainText("出错");
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.reload();
    await expect(panel).toContainText("1 已完成");
    await panel.locator("summary").first().click();
    await panel.screenshot({ path: testInfo.outputPath("subagents-completed.png") });
    detail.activeJob = { id: "running-job", status: "running", startedAt: new Date().toISOString() };
    detail.latestJob = detail.activeJob;
    detail.jobEvents = [detail.jobEvents[0]];
    await page.route("**/api/jobs/running-job/events**", (route) => route.fulfill({ contentType: "text/event-stream", body: "" }));
    await page.reload();
    await expect(panel).toContainText("1 个 · 1 运行中 · 0 已完成");
    await expect(page.locator(".activity-card").getByRole("region", { name: "子代理状态" })).toBeVisible();
    await panel.screenshot({ path: testInfo.outputPath("subagents-running.png") });
    expect(errors).toEqual([]);
  });
}
