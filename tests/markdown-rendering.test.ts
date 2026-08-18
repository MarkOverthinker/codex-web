import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { normalizeMathDelimiters } from "../src/markdown-math";

function renderMarkdown(markdown: string): string {
  return renderToStaticMarkup(React.createElement(
    ReactMarkdown,
    {
      remarkPlugins: [remarkGfm, remarkMath],
      rehypePlugins: [[rehypeKatex, { throwOnError: false }], rehypeHighlight],
    },
    normalizeMathDelimiters(markdown),
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

test("LaTeX bracket math delimiters render as KaTeX", () => {
  const escapedDisplay = renderMarkdown("公式如下：\n\n\\[\nq_t=\\frac{v_t}{A_d}.\n\\]\n\n结束。");
  assert.match(escapedDisplay, /katex-display/);
  assert.match(escapedDisplay, /mfrac/);

  const escapedInline = renderMarkdown("由公式 \\(\\lambda=\\frac{k_2}{k_1}\\) 可得");
  assert.match(escapedInline, /class="katex"/);
  assert.match(escapedInline, /mfrac/);

  const bareBrackets = renderMarkdown("流量公式：\n\n[\nq_t=\\frac{v_t}{A_d}.\n]\n\n结束。");
  assert.match(bareBrackets, /katex-display/);
  assert.match(bareBrackets, /mfrac/);
});

test("math normalization leaves code blocks and inline code untouched", () => {
  const fenced = renderMarkdown("```tex\n\\[\nx^2\n\\]\n```");
  assert.ok(!fenced.includes("katex-display"));
  assert.match(fenced, /x\^2/);

  const inlineCode = renderMarkdown("行内代码 `\\(x^2\\)` 不渲染公式");
  assert.ok(!inlineCode.includes('class="katex"'));
  assert.match(inlineCode, /<code>/);
});

test("code blocks get syntax highlighting while unknown languages stay readable", () => {
  const highlighted = renderMarkdown("```js\nconst total = items.length;\n```");
  assert.match(highlighted, /class="hljs language-js"/);
  assert.match(highlighted, /hljs-keyword/);
  assert.match(highlighted, /hljs-property/);

  const unknown = renderMarkdown("```no-such-language\nplain text\n```");
  assert.match(unknown, /<code/);
  assert.match(unknown, /plain text/);

  const bare = renderMarkdown("```\nno language\n```");
  assert.match(bare, /no language/);
});
