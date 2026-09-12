import { test, expect, type Page } from "@playwright/test";
import { setup } from "./fixtures";

const overview = {
  root: "/workspace/project", branch: "feature/repository", bases: ["refs/heads/main", "refs/remotes/origin/main"], base: "refs/remotes/origin/main",
  comparison: "HEAD 与工作区", head: "a".repeat(40), upstream: "origin/feature/repository", remotes: ["origin"], ahead: 2, behind: 0,
  stagedFiles: ["src/sidebar.tsx"], conflictedFiles: [], files: [
    { path: "src/sidebar.tsx", status: "M", additions: 18, deletions: 4 },
    { path: "src/styles.css", status: "M", additions: 32, deletions: 6 },
    { path: "docs/README.md", status: "M", additions: 12, deletions: 2 },
    { path: "tests/sidebar.test.ts", status: "?", additions: null, deletions: null },
  ],
};
const patch = `diff --git a/src/sidebar.tsx b/src/sidebar.tsx
index 1234567..2345678 100644
--- a/src/sidebar.tsx
+++ b/src/sidebar.tsx
@@ -1,8 +1,12 @@
 import { useState } from "react";
-import { File } from "lucide-react";
+import { File, Folder, GitBranch } from "lucide-react";
${" "}
 export function RepositorySidebar() {
+  const [filter, setFilter] = useState("");
+  const [selected, setSelected] = useState(null);
   return (
-    <div className="files">Files</div>
+    <aside className="repository-sidebar">
+      <GitBranch size={16} />
+      <h2>Repository changes</h2>
+      <input value={filter} onChange={onFilter} />
+    </aside>
   );
 }
@@ -46,4 +50,8 @@ function FileRow({ file })
   const name = file.path.split("/").at(-1);
-  return <span>{name}</span>;
+  return (
+    <button onClick={() => onSelect(file)}>
+      <File size={14} />
+      <span>{name}</span>
+      <span className="additions">+{file.additions}</span>
+    </button>
+  );
 }
`;
const markdown = "# Repository workspace\n\nReview code and documents in one place.\n\n## What changed\n\n| Feature | Status |\n| --- | --- |\n| Syntax highlighting | Ready |\n| File tree | Ready |\n\n- [x] Review selected files\n- [ ] Publish changes\n\nInline math: $x^2 + y^2$.\n\n```ts\nconst status = 'ready';\n```";

async function workspace(page: Page) {
  const errors = await setup(page);
  await page.route("**/codex-web/api/conversations/mobile-demo/review**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const file = query.get("file");
    const scope = query.get("scope");
    const files = scope === "staged" ? overview.files.slice(0, 1) : overview.files;
    await route.fulfill({ json: { ...overview, files, ...(file ? { patch: file.endsWith(".md") ? "@@ -1 +1 @@\n-# Old\n+# Repository workspace\n" : patch,
      preview: { content: file.endsWith(".md") ? markdown : `const version = "${scope}";\n`, revision: scope === "staged" ? "暂存区版本" : scope === "branch" ? "HEAD 已提交版本" : "工作区当前文件", truncated: false } } : {}) } });
  });
  await page.route("**/codex-web/api/conversations/mobile-demo/file-tree**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/preview")) return route.fulfill({ json: { mimeType: "text/typescript", content: "const rendered = true;\n" } });
    const roots = [{ id: "workspace", label: "工作区", path: "/workspace/project", available: true }];
    await route.fulfill({ json: { roots, ...(url.searchParams.has("root") ? { listing: { rootId: "workspace", path: "", parentPath: null, truncated: false, entries: [{ name: "example.ts", path: "example.ts", display_path: "/workspace/project/example.ts", type: "file", size: 24, mtime: null, mime_type: "text/plain", previewable: true }] } } : {}) } });
  });
  await page.reload();
  await expect(page.locator(".messages")).toContainText("检查结果");
  return errors;
}

async function openReview(page: Page) {
  if (await page.getByRole("button", { name: "会话工具", exact: true }).isVisible()) await page.getByRole("button", { name: "会话工具", exact: true }).click();
  await page.getByRole("button", { name: "查看 Git 分支变更", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "仓库工作区", exact: true })).toBeVisible();
  await expect(page.locator(".repository-code .hljs-keyword").first()).toBeVisible();
}

test("environment and change tree lead to highlighted diff and rendered document previews", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const errors = await workspace(page);
  await page.locator('summary[aria-label="环境信息"]').click();
  await expect(page.locator(".repository-environment-card")).toContainText("origin/feature/repository");
  await expect(page.locator(".repository-environment-card")).toContainText("4 个文件");
  await openReview(page);
  const pane = page.locator(".repository-pane");
  expect(await page.locator(".workspace").evaluate((element) => element.scrollLeft)).toBe(0);
  await expect(pane.locator(".repository-code-line.add").first()).toBeVisible();
  await expect(pane.locator(".repository-code-line.delete").first()).toBeVisible();
  if (process.env.REPOSITORY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.REPOSITORY_SCREENSHOT_DIR}/repository-review-desktop.png` });
  await pane.getByLabel("已查看", { exact: true }).check();
  await pane.getByLabel("筛选变更文件").fill("readme");
  await expect(pane.locator(".repository-tree-file")).toHaveCount(1);
  await pane.getByRole("button", { name: /README.md/ }).click();
  await pane.getByRole("button", { name: "预览", exact: true }).click();
  await expect(pane.getByRole("heading", { name: "Repository workspace" })).toBeVisible();
  await expect(pane.locator("table")).toBeVisible();
  await expect(pane.locator(".katex")).toHaveCount(1);
  if (process.env.REPOSITORY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.REPOSITORY_SCREENSHOT_DIR}/repository-markdown-desktop.png` });
  await pane.getByRole("button", { name: "源码", exact: true }).click();
  await expect(pane.locator(".source-line").first()).toContainText("# Repository workspace");
  await pane.getByRole("tab", { name: "全部文件" }).click();
  await pane.getByRole("button", { name: /example.ts/ }).click();
  await expect(pane.locator(".file-explorer-preview .hljs-keyword")).toContainText("const");
  await pane.getByRole("tab", { name: "审查变更" }).click();
  await expect(pane.getByLabel("筛选变更文件")).toHaveValue("readme");
  await expect(pane).toContainText("已查看 1");
  expect(errors).toEqual([]);
});

test("confirmed commit queues only selected paths and preserves the composer draft", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await workspace(page);
  const sent: string[] = [];
  await page.route("**/codex-web/api/conversations/mobile-demo/messages", async (route) => {
    if (route.request().method() === "POST") sent.push(route.request().postData() ?? "");
    await route.fulfill({ json: {} });
  });
  await page.locator(".composer textarea").fill("这是一份未发送的独立草稿");
  await openReview(page);
  const pane = page.locator(".repository-pane");
  await pane.getByRole("button", { name: "提交…", exact: true }).click();
  const form = pane.getByRole("form", { name: "确认提交范围" });
  await expect(form.getByRole("checkbox", { name: /src\/sidebar.tsx/ })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: /README.md/ })).not.toBeChecked();
  await form.getByLabel("提交说明").fill("feat: repository workspace");
  await form.getByRole("button", { name: "确认并交给 Codex" }).click();
  await expect(pane).toContainText("操作请求已加入 Codex 任务队列");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('"src/sidebar.tsx"');
  expect(sent[0]).not.toContain('"docs/README.md"');
  expect(sent[0]).not.toContain('name="useComposerDraft"');
  expect(sent[0]).toContain("完成后不要推送");
  await expect(page.locator(".composer textarea")).toHaveValue("这是一份未发送的独立草稿");
});

test("switching scopes loads the correct version and refresh retains the selected file", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await workspace(page);
  await openReview(page);
  const pane = page.locator(".repository-pane");
  await pane.getByLabel("变更范围").selectOption("staged");
  await pane.getByRole("button", { name: "预览", exact: true }).click();
  await expect(pane).toContainText("暂存区版本");
  await expect(pane.locator(".source-preview")).toContainText('"staged"');
  await pane.getByLabel("变更范围").selectOption("working");
  await pane.getByRole("button", { name: /README.md/ }).click();
  await expect(pane.getByRole("heading", { name: "Repository workspace" })).toBeVisible();
  await pane.getByRole("button", { name: "刷新变更" }).click();
  await expect(pane.locator(".repository-file-header")).toContainText("docs/README.md");
  await expect(pane.getByRole("heading", { name: "Repository workspace" })).toBeVisible();
});

for (const width of [390, 820]) test(`repository ${width}px: readable layout, dark theme and mobile back`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  const errors = await workspace(page);
  await openReview(page);
  await page.evaluate(() => document.documentElement.dataset.theme = "dark");
  const pane = page.locator(".repository-pane");
  await pane.getByRole("button", { name: "换行", exact: true }).click();
  await expect(pane.locator(".repository-diff-content")).toHaveClass(/wrapped/);
  if (process.env.REPOSITORY_SCREENSHOT_DIR && width === 390) await page.screenshot({ path: `${process.env.REPOSITORY_SCREENSHOT_DIR}/repository-review-mobile-dark.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => (window as unknown as { codexMobileBack: () => boolean }).codexMobileBack());
  await expect(pane).toBeHidden();
  await expect(page.locator(".shell")).not.toHaveAttribute("inert");
  expect(errors).toEqual([]);
});

test("non-Git directories keep file browsing available and report errors honestly", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await workspace(page);
  await page.route("**/codex-web/api/conversations/mobile-demo/review**", (route) => route.fulfill({ status: 400, json: { error: "当前工作目录不是可读取的 Git 仓库。" } }));
  await page.getByRole("button", { name: "查看 Git 分支变更", exact: true }).click();
  const pane = page.locator(".repository-pane");
  await expect(pane.getByRole("alert")).toContainText("不是可读取的 Git 仓库");
  await pane.getByRole("tab", { name: "全部文件" }).click();
  await expect(pane.getByRole("button", { name: /example.ts/ })).toBeVisible();
});

test("push confirmation is distinct from commit and reports queue failures without claiming success", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await workspace(page);
  let attempts = 0;
  let prompt = "";
  await page.route("**/codex-web/api/conversations/mobile-demo/messages", async (route) => {
    attempts += 1;
    prompt = route.request().postData() ?? "";
    await route.fulfill({ status: 503, json: { error: "执行器暂不可用" } });
  });
  await openReview(page);
  const pane = page.locator(".repository-pane");
  await pane.getByRole("button", { name: "推送…", exact: true }).click();
  const form = pane.getByRole("form", { name: "确认推送目标" });
  await expect(form).toContainText("origin/feature/repository · 2 个提交");
  await form.getByRole("button", { name: "确认并交给 Codex" }).click();
  await expect(form.getByRole("alert")).toContainText("执行器暂不可用");
  await expect(pane).not.toContainText("操作请求已加入");
  expect(prompt).toContain('"paths": []');
  expect(prompt).toContain("不要提交工作区变更");
  expect(attempts).toBe(1);
});

test("late file responses cannot overwrite a more recent selection", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await workspace(page);
  await page.route("**/codex-web/api/conversations/mobile-demo/review**", async (route) => {
    const file = new URL(route.request().url()).searchParams.get("file");
    if (file === "docs/README.md") await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ json: { ...overview, patch, preview: { content: file === "docs/README.md" ? "# Delayed document" : "const current = true;", revision: "工作区当前文件", truncated: false } } });
  });
  await openReview(page);
  const pane = page.locator(".repository-pane");
  await pane.getByRole("button", { name: "预览", exact: true }).click();
  await pane.getByRole("button", { name: /README.md/ }).click();
  await pane.getByRole("button", { name: /styles.css/ }).click();
  await expect(pane.locator(".source-preview")).toContainText("current");
  await page.waitForTimeout(650);
  await expect(pane.locator(".source-preview")).toContainText("current");
  await expect(pane).not.toContainText("Delayed document");
});

test("large diffs are incrementally rendered and hunks can be collapsed", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await workspace(page);
  await page.route("**/codex-web/api/conversations/mobile-demo/review**", (route) => route.fulfill({ json: { ...overview, patch: "@@ -0,0 +1,2500 @@\n" + Array.from({ length: 2500 }, (_, index) => `+const line${index} = ${index};`).join("\n") } }));
  await openReview(page);
  const pane = page.locator(".repository-pane");
  await expect(pane.locator(".repository-code-line")).toHaveCount(1199);
  await pane.getByRole("button", { name: /继续显示 1200 行/ }).click();
  await expect(pane.locator(".repository-code-line")).toHaveCount(2399);
  await pane.getByRole("button", { name: /折叠差异段/ }).click();
  await expect(pane.locator(".repository-code-line")).toHaveCount(0);
  await pane.getByRole("button", { name: /展开差异段/ }).click();
  await expect(pane.locator(".repository-code-line")).toHaveCount(2399);
});
