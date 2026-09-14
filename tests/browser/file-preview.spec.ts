import { expect, test } from "@playwright/test";
import { setup } from "./fixtures";

test("an output file replaces an open source preview immediately", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await setup(page, false, false, {
    assistantContent: "## 检查结果\n\n检查源码 `src/example.ts:1`，并打开输出文件。",
    outputFiles: [{
      id: "output-result",
      original_name: "result.txt",
      relative_path: "outputs/result.txt",
      mime_type: "text/plain",
      size: 14,
      kind: "output",
    }],
    fileContents: { "output-result": "preview result" },
    codeSnippet: {
      path: "src/example.ts",
      originalName: "example.ts",
      line: 1,
      start: 1,
      end: 1,
      totalLines: 1,
      lines: ["export const example = true;"],
    },
  });

  await page.locator(".code-snippet-trigger").click();
  await expect(page.locator(".code-snippet-pane")).toBeVisible();
  await expect(page.locator(".code-snippet-pane")).toContainText("export const example");

  await page.locator(".chat-outputs-toggle").click();
  await page.getByRole("button", { name: /result\.txt/ }).dispatchEvent("click");

  await expect(page.locator(".code-snippet-pane")).toHaveCount(0);
  const outputPreview = page.getByRole("complementary", { name: "预览 result.txt", exact: true });
  await expect(outputPreview).toBeVisible();
  await expect(outputPreview).toContainText("preview result");
  expect(errors).toEqual([]);
});
