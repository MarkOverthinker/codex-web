import { expect, test } from "@playwright/test";
import { setup } from "./fixtures";

for (const width of [390, 1280]) test(`billing filters dates and inactive rates at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const errors = await setup(page);
  const requests: URL[] = [];
  const state = {
    rangeDays: 30, from: "2026-08-12T00:00:00.000Z", to: "2026-09-11T00:00:00.000Z",
    summary: { calls: 2, inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0, cacheHitRate: 0, estimatedCost: 0, currency: "USD", unpricedCalls: 2 },
    byProvider: [], byModel: [], rules: [],
    byClient: [{ sourceKind: "rollout", originator: "codex-tui", clientName: "Codex CLI", calls: 1, inputTokens: 50, outputTokens: 25, estimatedCost: null, currency: "USD" }],
    models: [
      { providerId: "source", providerName: "Source", modelId: "active", displayName: "Active Model", enabled: true },
      { providerId: "source", providerName: "Source", modelId: "inactive", displayName: "Inactive Model", enabled: false },
    ],
  };
  await page.route("**/codex-web/api/billing**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const result = { ...state, from: url.searchParams.get("from") ?? state.from, to: url.searchParams.get("to") ?? state.to };
    await route.fulfill({ json: url.pathname.endsWith("sync-pricing")
      ? { imported: 0, results: [], billing: result }
      : url.pathname.endsWith("sync-usage")
        ? { result: { filesScanned: 1, inserted: 1, updated: 0, unchanged: 0 }, billing: result }
        : result });
  });
  if (width < 768) await page.getByRole("button", { name: "会话工具", exact: true }).click();
  await page.getByRole("button", { name: "查看 API 计费统计", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "API 调用计费统计" });
  await expect(panel.getByLabel("Active Model 谷时输出费率")).toBeVisible();
  await expect(panel.getByLabel("Inactive Model 谷时输出费率")).toHaveCount(0);
  await expect(panel.getByText("Codex CLI", { exact: true })).toBeVisible();
  await panel.getByLabel(/显示未启用模型/).check();
  await expect(panel.getByLabel("Inactive Model 谷时输出费率")).toBeVisible();
  await panel.getByLabel(/显示未启用模型/).uncheck();
  await panel.getByText("Token 计费规则（点击折叠）", { exact: true }).click();
  await expect(panel.getByLabel("Active Model 谷时输出费率")).toBeHidden();
  await panel.getByText("Token 计费规则（点击折叠）", { exact: true }).click();
  await panel.getByLabel("统计范围").selectOption("-1");
  await panel.getByLabel("开始日期").fill("2026-08-01");
  await panel.getByLabel("结束日期").fill("2026-08-01");
  await panel.getByLabel("开始时间").fill("09:30");
  await panel.getByLabel("结束时间").fill("10:30");
  await panel.getByRole("button", { name: "应用筛选", exact: true }).click();
  await expect(panel.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  const applied = requests.at(-1)!.searchParams;
  expect(applied.get("from")).toBeTruthy();
  expect(Date.parse(applied.get("to")!) - Date.parse(applied.get("from")!)).toBe(61 * 60_000);
  await panel.locator(".billing-rules-table tbody tr").filter({ hasText: "Active Model" }).getByRole("button", { name: "保存", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("已保存");
  expect(requests.at(-1)!.searchParams.toString()).toBe(applied.toString());
  await panel.getByRole("button", { name: "同步远程费率", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("已同步");
  expect(requests.at(-1)!.searchParams.toString()).toBe(applied.toString());
  await panel.getByRole("button", { name: "同步本机用量", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("补记 1 条");
  expect(requests.at(-1)!.searchParams.toString()).toBe(applied.toString());
  await panel.getByLabel("开始日期").fill("2026-08-02");
  const count = requests.length;
  await panel.getByRole("button", { name: "应用筛选", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("不能早于");
  expect(requests).toHaveLength(count);
  await panel.getByLabel("统计范围").selectOption("0");
  await expect(panel.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  expect(requests.at(-1)!.searchParams.get("days")).toBe("0");
  expect(errors).toEqual([]);
});
