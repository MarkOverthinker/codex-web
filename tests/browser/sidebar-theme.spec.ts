import { expect, test, type Locator } from "@playwright/test";
import { setup } from "./fixtures";

async function expectDarkBackground(locator: Locator) {
  await expect.poll(() => locator.evaluate((element) => {
    const channels = getComputedStyle(element).backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    return channels.length === 3 && Math.max(...channels) < 100;
  })).toBe(true);
}

test("sidebar collapses from its own header and preserves width and state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await setup(page);
  const sidebar = page.locator("#primary-sidebar");
  const resizer = sidebar.getByRole("separator");
  await resizer.focus();
  await resizer.press("Home");
  await expect(sidebar).toHaveCSS("width", "220px");
  const collapse = sidebar.getByRole("button", { name: "收起侧栏", exact: true });
  await expect(collapse).toBeVisible();
  const sidebarBounds = await sidebar.boundingBox();
  const collapseBounds = await collapse.boundingBox();
  expect(collapseBounds!.x + collapseBounds!.width).toBeLessThanOrEqual(sidebarBounds!.x + sidebarBounds!.width);
  await resizer.press("ArrowRight");
  const expandedWidth = await resizer.getAttribute("aria-valuenow");
  await expect(sidebar).toHaveCSS("width", `${expandedWidth}px`);
  const workspace = page.locator(".workspace");
  const expandedWorkspace = await workspace.boundingBox();
  await collapse.focus();
  await collapse.press("Enter");
  await expect(sidebar).toBeHidden();
  await expect(sidebar).toHaveCSS("width", "0px");
  const restore = page.getByRole("button", { name: "展开侧栏", exact: true });
  await expect(restore).toBeFocused();
  await expect(restore).toHaveAttribute("aria-expanded", "false");
  expect((await workspace.boundingBox())!.width).toBeGreaterThan(expandedWorkspace!.width);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("codex-web:sidebar-collapsed"))).toBe("true");
  await page.reload();
  await expect(sidebar).toBeHidden();
  await restore.click();
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveCSS("width", `${expandedWidth}px`);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("codex-web:sidebar-collapsed"))).toBe("false");
  await page.reload();
  await expect(sidebar).toBeVisible();
  await page.getByRole("button", { name: "隐藏侧栏", exact: true }).click();
  await expect(sidebar).toBeHidden();
  expect(errors).toEqual([]);
});

test("desktop collapsed preference does not prevent opening the mobile drawer", async ({ page }) => {
  await page.setViewportSize({ width: 901, height: 900 });
  const errors = await setup(page);
  await page.locator("#primary-sidebar").getByRole("button", { name: "收起侧栏", exact: true }).click();
  await expect(page.locator("#primary-sidebar")).toHaveCSS("width", "0px");
  await page.setViewportSize({ width: 900, height: 900 });
  await page.getByRole("button", { name: "打开任务列表", exact: true }).click();
  await expect(page.locator(".sidebar.open")).toBeVisible();
  await expect(page.getByRole("button", { name: "收起侧栏", exact: true })).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#primary-sidebar")).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("button", { name: "展开侧栏", exact: true })).toBeVisible();
  await expect(page.locator("#primary-sidebar")).toBeHidden();
  expect(errors).toEqual([]);
});

for (const width of [1440, 390]) test(`permission control follows dark theme at ${width}px, including full access`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("codex-web:theme", "system"));
  const errors = await setup(page);
  await page.route("**/codex-web/api/conversations/mobile-demo/agent-selection", (route) => route.fulfill({ json: { selection: route.request().postDataJSON() } }));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  if (width < 901) await page.getByRole("button", { name: "任务选项", exact: true }).click();
  const permission = page.getByRole("button", { name: "权限", exact: true });
  await expectDarkBackground(permission);
  await permission.click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("option", { name: "完全访问 跳过沙箱" }).click();
  await expect(permission).toContainText("完全访问");
  await expectDarkBackground(permission);
  await expect(permission.locator(".setting-value")).toHaveCSS("color", "rgb(255, 156, 165)");
  await permission.hover();
  await expectDarkBackground(permission);
  await permission.click();
  await expectDarkBackground(permission);
  const selected = page.getByRole("option", { name: "完全访问 跳过沙箱" });
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await expect(selected).toHaveCSS("color", "rgb(255, 156, 165)");
  await expectDarkBackground(selected);
  await expectDarkBackground(page.locator(".setting-menu.permission .setting-menu-panel"));
  await selected.click();
  await page.mouse.move(0, 0);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(permission).toHaveCSS("background-color", "rgb(255, 244, 244)");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectDarkBackground(permission);
  await permission.click();
  await page.getByRole("option", { name: "工作区写入 限制写入范围" }).click();
  await expect(permission).toContainText("工作区写入");
  await expect(permission.locator(".setting-value")).toHaveCSS("color", "rgb(236, 236, 241)");
  await expectDarkBackground(permission);
  expect(errors).toEqual([]);
});
