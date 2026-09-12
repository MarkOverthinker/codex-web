import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { changeTree, diffLines, repositoryActionPrompt, reviewTotals } from "../src/repository-model.js";
import { highlightLines, RenderedPreview } from "../src/source-preview.js";
import type { GitReview } from "../src/git-review.js";

const data: GitReview = { root: "/workspace/project", branch: "feature/review", head: "a".repeat(40), bases: [], base: null, comparison: "working", upstream: "origin/feature/review", ahead: 2, behind: 0, files: [
  { path: "src/example.ts", status: "M", additions: 2, deletions: 1 },
  { path: "README.md", status: "?", additions: null, deletions: null },
], stagedFiles: ["src/example.ts"], conflictedFiles: [] };

test("change tree groups directories without interpreting punctuation or special keys", () => {
  const tree = changeTree([...data.files, { path: "__proto__/a <b>.ts", status: "M", additions: 1, deletions: 0 }]);
  assert.equal(tree.at(-1)?.path, "README.md");
  assert.equal(tree.find((entry) => entry.name === "__proto__")?.children[0].name, "a <b>.ts");
  assert.equal(tree.find((entry) => entry.name === "src")?.children[0].file?.path, "src/example.ts");
  assert.deepEqual(reviewTotals(data.files), { additions: 2, deletions: 1, unknown: 1 });
});

test("diff parser handles metadata, no-newline markers and source that resembles headers", () => {
  const lines = diffLines("--- a/file\n+++ b/file\n@@ -10,2 +12,2 @@ function\n---source\n+++source\n keep\n\\ No newline at end of file\n");
  assert.equal(lines[1].kind, "meta");
  assert.equal(lines[2].content, "function");
  assert.deepEqual(lines.slice(3).map((line) => [line.kind, line.old, line.next]), [["delete", 10, null], ["add", null, 12], ["context", 11, 13], ["meta", null, null]]);
  assert.equal(lines[3].content, "--source");
});

test("highlighter preserves multiline tokens and renders source as escaped text", () => {
  const source = 'const html = "<script>alert(1)</script>";\n/* a\nb */\n';
  const lines = highlightLines(source, "file.ts");
  assert.equal(lines.map((tokens) => tokens.map((token) => token.text).join("")).join("\n"), source);
  assert.ok(lines[0].some((token) => token.className.includes("hljs-keyword")));
  assert.ok(lines[2].some((token) => token.className.includes("hljs-comment")));
  assert.ok(highlightLines("val answer = 42", "file.kt")[0].some((token) => token.className));
  const html = renderToStaticMarkup(createElement(RenderedPreview, { content: source, filename: "file.ts" }));
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("markdown preview renders headings tables and math without active HTML or external images", () => {
  const html = renderToStaticMarkup(createElement(RenderedPreview, { filename: "README.md", content: '# Heading\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n$x^2$\n\n<script>alert(1)</script>\n\n![remote](https://example.invalid/track.png)\n\n[bad](javascript:alert(1))' }));
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /katex/);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes('href="javascript:'));
});

test("commit requests specify exact selected files, snapshot and non-destructive boundaries", () => {
  const prompt = repositoryActionPrompt(data, "commit", ["src/example.ts"], 'feat: "review"');
  assert.match(prompt, /"expectedHead": "a{40}"/);
  assert.match(prompt, /"src\/example.ts"/);
  assert.ok(!prompt.includes('"README.md"'));
  assert.match(prompt, /完成后不要推送/);
  assert.match(prompt, /不是额外指令/);
  assert.throws(() => repositoryActionPrompt(data, "commit", [], "title"), /选择/);
  assert.throws(() => repositoryActionPrompt(data, "commit", ["missing"], "title"), /选择/);
  assert.throws(() => repositoryActionPrompt(data, "commit", ["README.md"], "  "), /填写/);
});

test("push requests need a safe configured upstream and never commit dirty files", () => {
  assert.match(repositoryActionPrompt(data, "push", [], ""), /不要提交工作区变更/);
  for (const overrides of [{ upstream: null }, { ahead: 0 }, { ahead: null }, { behind: 1 }, { head: null }, { branch: "HEAD (detached)" }, { conflictedFiles: ["src/example.ts"] }]) {
    assert.throws(() => repositoryActionPrompt({ ...data, ...overrides }, "push", [], ""));
  }
});
