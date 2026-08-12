import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(React.createElement(
    ReactMarkdown,
    {
      remarkPlugins: [remarkGfm, remarkMath],
      rehypePlugins: [[rehypeKatex, { throwOnError: false }]],
    },
    markdown,
  ));
}

test("LaTeX math renders with KaTeX and malformed formulas stay readable", () => {
  const inline = renderMarkdown("勾股定理 $a^2+b^2=c^2$。");
  assert.match(inline, /class="katex/);
  assert.match(inline, /a\^2/);

  const display = renderMarkdown("$$\nx^2\n$$");
  assert.match(display, /katex-display/);

  const malformed = renderMarkdown("损坏公式 $\\frac{}$");
  assert.ok(malformed.includes("katex-error") || malformed.includes("$"));
});

test("plain text and GFM content keep rendering without KaTeX interference", () => {
  const html = renderMarkdown("价格 $5 和 **加粗**\n\n| a | b |\n| - | - |\n| 1 | 2 |");
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /价格 \$5 和/);
});
