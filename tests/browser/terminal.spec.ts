import { expect, test, type Page } from "@playwright/test";
import { setup } from "./fixtures";

async function terminalFixture(page: Page) {
  const errors = await setup(page);
  const commands: Record<string, unknown>[] = [];
  let closed = false;
  let opens = 0;
  let reads = 0;
  let rejectReads = false;
  await page.route("**/codex-web/api/conversations/mobile-demo/terminal**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "DELETE") { closed = true; return route.fulfill({ json: { ok: true } }); }
    if (request.method() === "POST") {
      const data = request.postDataJSON();
      if (!url.pathname.endsWith("/demo-terminal")) { opens++; return route.fulfill({ json: { terminalId: "demo-terminal" } }); }
      commands.push(data);
      return route.fulfill({ json: { ok: true } });
    }
    reads++;
    if (rejectReads) return route.fulfill({ status: 503, json: { error: "测试连接已断开" } });
    const output = "终端已就绪\r\n$ ";
    return route.fulfill({ json: { terminalId: "demo-terminal", data: url.searchParams.get("after") === "0" ? output : "", cursor: output.length, truncated: false, exited: false, exitCode: null } });
  });
  if (await page.getByRole("button", { name: "会话工具", exact: true }).isVisible()) await page.getByRole("button", { name: "会话工具", exact: true }).click();
  await page.getByRole("button", { name: "打开任务终端", exact: true }).click();
  return { errors, commands, closed: () => closed, opens: () => opens, reads: () => reads, disconnect: (value: boolean) => { rejectReads = value; } };
}

for (const viewport of [{ width: 1600, height: 1000 }, { width: 390, height: 844 }]) {
  test(`terminal starts explicitly, accepts keys and survives panel collapse at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixture = await terminalFixture(page);
    const pane = page.getByRole("region", { name: "任务终端" });
    await expect(pane.getByText("未连接", { exact: true })).toBeVisible();
    expect(fixture.opens()).toBe(0);
    await pane.getByRole("button", { name: "启动终端", exact: true }).click();
    await expect(pane.getByRole("status")).toHaveText("已连接");
    await expect.poll(fixture.reads).toBeGreaterThan(0);
    await pane.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("pwd"); await page.keyboard.press("Enter");
    await expect.poll(() => fixture.commands.filter((command) => command.action === "write").map((command) => command.data).join("")).toBe("pwd\r");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("complementary", { name: "仓库工作区", exact: true })).toBeVisible();
    await pane.getByRole("button", { name: "Ctrl+C", exact: true }).click();
    await pane.getByRole("button", { name: "Tab", exact: true }).click();
    await expect.poll(() => fixture.commands.filter((command) => command.action === "write").map((command) => command.data).join("")).toContain("\u0003\t");
    await expect.poll(() => fixture.commands.some((command) => command.action === "resize")).toBe(true);
    if (process.env.TERMINAL_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.TERMINAL_SCREENSHOT_DIR}/terminal-${viewport.width}.png` });
    const box = await pane.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(viewport.width);
    await page.getByRole("button", { name: "关闭仓库工作区", exact: true }).click();
    expect(fixture.closed()).toBe(false);
    if (await page.getByRole("button", { name: "会话工具", exact: true }).isVisible()) await page.getByRole("button", { name: "会话工具", exact: true }).click();
    await page.getByRole("button", { name: "打开任务终端", exact: true }).click();
    await pane.getByRole("button", { name: "启动终端", exact: true }).click();
    await expect(pane.getByRole("status")).toHaveText("已连接");
    await pane.getByRole("button", { name: "关闭终端", exact: true }).click();
    await expect(pane.getByRole("status")).toHaveText("已关闭");
    expect(fixture.closed()).toBe(true);
    expect(fixture.errors).toEqual([]);
  });
}

test("terminal reports failed reads, reconnects without duplicating input, and navigates three tabs", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const fixture = await terminalFixture(page);
  const pane = page.getByRole("region", { name: "任务终端" });
  await pane.getByRole("button", { name: "启动终端", exact: true }).click();
  await expect(pane.getByRole("status")).toHaveText("已连接");
  fixture.disconnect(true);
  await expect(pane.getByRole("alert")).toHaveText("测试连接已断开");
  fixture.disconnect(false);
  await pane.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(pane.getByRole("status")).toHaveText("已连接");
  expect(fixture.opens()).toBe(2);
  await page.getByRole("tab", { name: "终端", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "全部文件", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "终端", exact: true })).toBeFocused();
  await expect(pane).toBeVisible();
  expect(fixture.errors).toEqual([]);
});
