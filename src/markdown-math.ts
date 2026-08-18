/**
 * Normalize common LaTeX math delimiters into the `$...$` / `$$...$$` forms
 * understood by remark-math, so KaTeX can render formulas regardless of the
 * delimiter style the agent (or user) used.
 *
 * Supported forms:
 * - `\[ ... \]` -> `$$ ... $$` (display math)
 * - `\( ... \)` -> `$ ... $` (inline math)
 * - a line containing only `[` followed by content and a line containing only
 *   `]` -> `$$ ... $$` (bare-bracket display math)
 *
 * Fenced code blocks and inline code are left untouched so LaTeX-looking text
 * inside code stays readable as code.
 */

type Fence = { char: string; length: number };

type Segment = { code: boolean; lines: string[] };

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

function fenceInfo(line: string): Fence | null {
  const match = line.match(FENCE_PATTERN);
  return match ? { char: match[1][0], length: match[1].length } : null;
}

function closesFence(line: string, fence: Fence): boolean {
  const info = fenceInfo(line);
  return info !== null && info.char === fence.char && info.length >= fence.length;
}

function splitCodeSegments(markdown: string): Segment[] {
  const segments: Segment[] = [];
  let current: Segment = { code: false, lines: [] };
  let fence: Fence | null = null;

  for (const line of markdown.split("\n")) {
    if (fence) {
      current.lines.push(line);
      if (closesFence(line, fence)) {
        fence = null;
        segments.push(current);
        current = { code: false, lines: [] };
      }
    } else {
      const info = fenceInfo(line);
      if (info) {
        if (current.lines.length > 0) {
          segments.push(current);
          current = { code: true, lines: [] };
        }
        current.lines.push(line);
        fence = info;
      } else {
        current.lines.push(line);
      }
    }
  }

  if (current.lines.length > 0) segments.push(current);
  return segments;
}

function protectInlineCode(text: string): { text: string; parts: string[] } {
  const parts: string[] = [];
  const protectedText = text.replace(/`[^`\n]+`/g, (code) => {
    const index = parts.length;
    parts.push(code);
    return `\u0000codex-math-${index}\u0000`;
  });
  return { text: protectedText, parts };
}

function restoreInlineCode(text: string, parts: string[]): string {
  return text.replace(/\u0000codex-math-(\d+)\u0000/g, (_match, index: string) => parts[Number(index)]);
}

function convertEscapedDelimiters(text: string): string {
  const protectedInline = protectInlineCode(text);
  const converted = protectedInline.text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `$$\n${body.trim()}\n$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `$${body.trim()}$`);
  return restoreInlineCode(converted, protectedInline.parts);
}

function convertBareBracketBlocks(lines: string[]): string[] {
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index].trim() === "[") {
      const content: string[] = [];
      let cursor = index + 1;
      let found = false;

      while (cursor < lines.length) {
        if (lines[cursor].trim() === "]") {
          found = true;
          break;
        }
        if (lines[cursor].trim() === "") {
          break;
        }
        content.push(lines[cursor]);
        cursor += 1;
      }

      if (found && content.length > 0) {
        out.push("$$");
        out.push(...content);
        out.push("$$");
        index = cursor + 1;
        continue;
      }
    }
    out.push(lines[index]);
    index += 1;
  }

  return out;
}

function normalizeNonCodeSegment(lines: string[]): string[] {
  return convertBareBracketBlocks(convertEscapedDelimiters(lines.join("\n")).split("\n"));
}

export function normalizeMathDelimiters(markdown: string): string {
  return splitCodeSegments(markdown)
    .map((segment) => (segment.code ? segment.lines.join("\n") : normalizeNonCodeSegment(segment.lines).join("\n")))
    .join("\n");
}
