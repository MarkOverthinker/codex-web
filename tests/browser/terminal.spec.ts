import { expect, test, type Page, type Route } from "@playwright/test";
import { setup } from "./fixtures";

async function terminalFixture(page: Page, openDelay = 0) {
  const errors = await setup(page);
  const commands: Record<string, unknown>[] = [];
  const reads: number[] = [];
  let opens = 0;
  let closes = 0;
  let output = "终端已就绪\r\n$ ";
  let failWrite = false;
  let failRead = false;
  const waiting = new Set<{ route: Route; after: number; timer: ReturnType<typeof setTimeout> }>();
  const reply = (entry: { route: Route; after: number; timer: ReturnType<typeof setTimeout> }, failed = false) => {
    clearTimeout(entry.timer); waiting.delete(entry);
    void entry.route.fulfill(failed ? { status: 503, json: { error: "测试连接中断" } } : { json: { terminalId: "demo-terminal", data: output.slice(entry.after), cursor: output.length, truncated: false, exited: false, exitCode: null } }).catch(() => {});
  };
  page.on("close", () => { for (const entry of waiting) clearTimeout(entry.timer); waiting.clear(); });
  await page.route("**/codex-web/api/conversations/mobile-demo/terminal**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "DELETE") { closes++; return route.fulfill({ json: { ok: true } }); }
    if (request.method() === "POST") {
      const data = request.postDataJSON();
      if (!url.pathname.endsWith("/demo-terminal")) {
        opens++;
        if (openDelay) await new Promise((resolve) => setTimeout(resolve, openDelay));
        return route.fulfill({ json: { terminalId: "demo-terminal" } });
      }
      commands.push(data);
      if (data.action === "write") {
        if (failWrite) { failWrite = false; return route.fulfill({ status: 503, json: { error: "输入响应丢失" } }); }
        output += data.data;
        for (const entry of waiting) reply(entry);
      }
      return route.fulfill({ json: { ok: true } });
    }
    expect(url.searchParams.get("waitMs")).toBe("10000");
    reads.push(Number(url.searchParams.get("after")));
    const after = Number(url.searchParams.get("after"));
    const entry = { route, after, timer: setTimeout(() => reply(entry), 10000) };
    waiting.add(entry);
    if (failRead) { failRead = false; reply(entry, true); }
    else if (after < output.length) reply(entry);
  });
  const open = async () => {
    if (await page.getByRole("button", { name: "会话工具", exact: true }).isVisible()) await page.getByRole("button", { name: "会话工具", exact: true }).click();
    await page.getByRole("button", { name: "打开任务终端", exact: true }).click();
  };
  await open();
  return { errors, commands, reads, open, opens: () => opens, closes: () => closes,
    disconnect: () => { const entry = [...waiting][0]; if (entry) reply(entry, true); else failRead = true; },
    failWrite: () => { failWrite = true; },
  };
}

for (const viewport of [{ width: 1600, height: 1000 }, { width: 390, height: 844 }]) {
  test(`terminal docks below chat, auto-connects and retains its shell at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixture = await terminalFixture(page, 150);
    const dock = page.getByRole("complementary", { name: "任务终端", exact: true });
    await expect(dock).toBeVisible();
    await expect(dock.getByRole("status")).toHaveText("已连接");
    await expect(dock.getByRole("button")).toHaveCount(1);
    expect(fixture.opens()).toBe(1);
    await expect(dock.locator(".xterm-helper-textarea")).toBeFocused();
    await page.keyboard.type("pwd"); await page.keyboard.press("Enter");
    await expect.poll(() => fixture.commands.filter((command) => command.action === "write").map((command) => command.data).join("")).toBe("pwd\r");
    await page.keyboard.press("Escape"); await expect(dock).toBeVisible();
    await page.keyboard.press("Control+c"); await page.keyboard.press("Tab");
    await expect.poll(() => fixture.commands.filter((command) => command.action === "write").map((command) => command.data).join("")).toContain("\u0003\t");
    await expect.poll(() => fixture.commands.some((command) => command.action === "resize")).toBe(true);
    const box = await dock.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.height).toBeLessThanOrEqual(viewport.height / 2);
    const chat = await page.locator(".workspace").boundingBox();
    expect(chat!.y + chat!.height).toBeLessThanOrEqual(box!.y + 1);
    expect(Math.abs(chat!.x - box!.x)).toBeLessThan(2);
    expect(Math.abs(chat!.width - box!.width)).toBeLessThan(2);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    const composer = page.locator(".workspace .composer textarea");
    await composer.fill("终端展开时仍可编辑任务");
    await expect(composer).toHaveValue("终端展开时仍可编辑任务");
    const composerBox = await composer.boundingBox();
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(box!.y);
    expect(composerBox!.y).toBeGreaterThanOrEqual(chat!.y);
    if (process.env.TERMINAL_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.TERMINAL_SCREENSHOT_DIR}/terminal-dock-${viewport.width}.png` });
    await dock.getByRole("button", { name: "关闭终端栏", exact: true }).click();
    await expect(dock).toHaveCount(0);
    expect(fixture.closes()).toBe(0);
    await fixture.open();
    await expect(dock.getByRole("status")).toHaveText("已连接");
    expect(fixture.opens()).toBe(2);
    if (viewport.width < 600) {
      await page.getByRole("button", { name: "打开任务列表", exact: true }).click();
      await expect(page.locator(".sidebar.open")).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { codexMobileBack(): boolean }).codexMobileBack())).toBe(true);
      await expect(page.locator(".sidebar.open")).toHaveCount(0);
      await expect(dock).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { codexMobileBack(): boolean }).codexMobileBack())).toBe(true);
      await expect(dock).toHaveCount(0);
      expect(fixture.closes()).toBe(0);
    }
    expect(fixture.errors).toEqual([]);
  });
}

test("terminal reconnects automatically with the same output cursor and no replayed input", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const fixture = await terminalFixture(page);
  const dock = page.getByRole("complementary", { name: "任务终端", exact: true });
  await expect(dock.getByRole("status")).toHaveText("已连接");
  await expect.poll(() => fixture.reads.length).toBeGreaterThan(1);
  const cursor = fixture.reads.at(-1)!;
  fixture.disconnect();
  await expect.poll(fixture.opens).toBe(2);
  await expect(dock.getByRole("status")).toHaveText("已连接");
  expect(fixture.reads.filter((after) => after === 0)).toHaveLength(1);
  expect(fixture.reads.at(-1)).toBe(cursor);
  fixture.failWrite();
  await page.keyboard.type("x");
  await expect.poll(fixture.opens).toBe(3);
  await expect(dock.getByRole("status")).toHaveText("已连接");
  await expect(dock.getByRole("alert")).toContainText("未自动重发");
  expect(fixture.commands.filter((command) => command.action === "write")).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});
