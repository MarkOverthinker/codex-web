import { useMemo } from "react";
import { common, createLowlight } from "lowlight";
import kotlin from "highlight.js/lib/languages/kotlin";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { normalizeMathDelimiters } from "./markdown-math.js";

const highlighter = createLowlight(common);
highlighter.register("kotlin", kotlin);
const languages: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", kts: "kotlin", rb: "ruby", sh: "bash", bash: "bash", json: "json", css: "css", html: "xml", svg: "xml", xml: "xml", yml: "yaml", yaml: "yaml", toml: "ini", md: "markdown", sql: "sql", c: "c", h: "c", cpp: "cpp" };
type Token = { text: string; className: string };
type SyntaxNode = { type: string; value?: string; properties?: { className?: (string | number)[] | string | number | boolean | null }; children?: SyntaxNode[] };

export function highlightLines(content: string, filename: string): Token[][] {
  const language = languages[filename.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!language || !highlighter.registered(language) || content.length > 256 * 1024) return content.split("\n").map((text) => [{ text, className: "" }]);
  const lines: Token[][] = [[]];
  const visit = (node: SyntaxNode, className: string) => {
    if (node.type === "text") {
      (node.value ?? "").split("\n").forEach((text, index) => {
        if (index) lines.push([]);
        if (text) lines.at(-1)!.push({ text, className });
      });
    } else {
      const classes = node.properties?.className;
      const nextClass = [className, Array.isArray(classes) ? classes.join(" ") : typeof classes === "string" ? classes : ""].filter(Boolean).join(" ");
      node.children?.forEach((child) => visit(child, nextClass));
    }
  };
  try { visit(highlighter.highlight(language, content), ""); }
  catch { return content.split("\n").map((text) => [{ text, className: "" }]); }
  return lines;
}

export function SourceTokens({ tokens }: { tokens: Token[] | undefined }) {
  return <>{tokens?.map((token, index) => <span key={index} className={token.className || undefined}>{token.text}</span>)}</>;
}

export function SourcePreview({ content, filename }: { content: string; filename: string }) {
  const limit = 4000;
  const characterLimit = 256 * 1024;
  const lines = useMemo(() => highlightLines(content.slice(0, characterLimit).split("\n", limit + 1).join("\n"), filename), [content, filename]);
  return <div className="source-preview">{(lines.length > limit || content.length > characterLimit) && <p className="review-notice">文件较长，最多渲染前 {limit} 行 / 256K 字符；下载可查看完整内容。</p>}<pre tabIndex={0} aria-label="语法高亮源码">{lines.slice(0, limit).map((tokens, index) => <div className="source-line" key={index}><span className="source-line-number" aria-hidden="true">{index + 1}</span><code><SourceTokens tokens={tokens} />{"\n"}</code></div>)}</pre></div>;
}

export function RenderedPreview({ content, filename, source = false }: { content: string; filename: string; source?: boolean }) {
  if (!source && /\.(md|markdown)$/i.test(filename)) return <div className="markdown repository-markdown">{content.length > 256 * 1024 && <p className="review-notice">文档较长，仅渲染前 256K 字符；下载可查看完整内容。</p>}<ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false }], rehypeHighlight]} components={{ img: ({ alt }) => <span className="repository-image-placeholder">图片：{alt || "外部图片不自动加载"}</span>, a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>{normalizeMathDelimiters(content.slice(0, 256 * 1024))}</ReactMarkdown></div>;
  return <SourcePreview content={content} filename={filename} />;
}
