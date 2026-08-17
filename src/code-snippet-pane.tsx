import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { FileCode, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { api, type CodeSnippetWindow } from "./api";
import type { FileLineRef } from "./code-snippet";
import { CopyPathButton } from "./copy-path";

const INITIAL_BEFORE = 80;
const INITIAL_AFTER = 80;
const LOAD_MORE_LINES = 150;
const SCROLL_THRESHOLD = 48;

export function CodeSnippetPane({ conversationId, target, width, onResizeStart, onResizeKeyDown, onClose }: {
  conversationId: string;
  target: FileLineRef;
  width: number;
  onResizeStart: (event: PointerEvent<HTMLElement>) => void;
  onResizeKeyDown: (event: KeyboardEvent) => void;
  onClose: () => void;
}) {
  const [snippet, setSnippet] = useState<CodeSnippetWindow | null>(null);
  const [error, setError] = useState("");
  const [moreError, setMoreError] = useState("");
  const [loadingMore, setLoadingMore] = useState<"above" | "below" | null>(null);
  const [retry, setRetry] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const snippetRef = useRef<CodeSnippetWindow | null>(null);
  const loadingMoreRef = useRef<"above" | "below" | null>(null);
  const seqRef = useRef(0);
  const anchorRef = useRef<{ line: number; gap: number } | null>(null);
  snippetRef.current = snippet;

  useEffect(() => {
    const seq = ++seqRef.current;
    setSnippet(null);
    snippetRef.current = null;
    setError("");
    setMoreError("");
    setLoadingMore(null);
    loadingMoreRef.current = null;
    anchorRef.current = null;
    api.codeSnippet(conversationId, { path: target.path, line: target.line, before: INITIAL_BEFORE, after: INITIAL_AFTER })
      .then((data) => {
        if (seq !== seqRef.current) return;
        setSnippet(data);
        requestAnimationFrame(() => {
          const body = bodyRef.current;
          const row = body?.querySelector<HTMLElement>(`[data-line-number="${data.line}"]`);
          if (body && row) body.scrollTop = Math.max(0, row.offsetTop - body.clientHeight / 2);
        });
      })
      .catch((reason) => {
        if (seq !== seqRef.current) return;
        setError(reason instanceof Error ? reason.message : "代码预览加载失败");
      });
  }, [conversationId, target.path, target.line, retry]);

  function loadMore(direction: "above" | "below") {
    const current = snippetRef.current;
    if (!current || loadingMoreRef.current) return;
    if (direction === "above" && current.start <= 1) return;
    if (direction === "below" && current.end >= current.totalLines) return;
    const line = direction === "above" ? current.start - 1 : current.end + 1;
    const before = direction === "above" ? LOAD_MORE_LINES : 0;
    const after = direction === "below" ? LOAD_MORE_LINES : 0;
    if (direction === "above") {
      const body = bodyRef.current;
      if (body) {
        let anchorLine = current.start;
        let anchorGap = 0;
        for (const row of body.querySelectorAll<HTMLElement>("[data-line-number]")) {
          if (row.offsetTop >= body.scrollTop) {
            anchorLine = Number(row.dataset.lineNumber);
            anchorGap = row.offsetTop - body.scrollTop;
            break;
          }
        }
        anchorRef.current = { line: anchorLine, gap: anchorGap };
      }
    }
    loadingMoreRef.current = direction;
    setLoadingMore(direction);
    setMoreError("");
    const seq = seqRef.current;
    api.codeSnippet(conversationId, { path: target.path, line, before, after })
      .then((data) => {
        if (seq !== seqRef.current) return;
        setSnippet((previous) => {
          if (!previous) return data;
          if (direction === "above" && data.start < previous.start) return { ...data, lines: [...data.lines, ...previous.lines] };
          if (direction === "below" && data.end > previous.end) return { ...data, lines: [...previous.lines, ...data.lines] };
          return previous;
        });
        if (direction === "above") {
          requestAnimationFrame(() => {
            const anchor = anchorRef.current;
            const body = bodyRef.current;
            anchorRef.current = null;
            if (!anchor || !body) return;
            const row = body.querySelector<HTMLElement>(`[data-line-number="${anchor.line}"]`);
            if (row) body.scrollTop = Math.max(0, row.offsetTop - anchor.gap);
          });
        }
      })
      .catch((reason) => {
        if (seq !== seqRef.current) return;
        setMoreError(reason instanceof Error ? reason.message : "加载更多代码失败");
      })
      .finally(() => {
        if (seq !== seqRef.current) return;
        loadingMoreRef.current = null;
        setLoadingMore(null);
        requestAnimationFrame(() => {
          const body = bodyRef.current;
          if (!body) return;
          if (body.scrollTop <= SCROLL_THRESHOLD) loadMore("above");
          if (body.scrollHeight - body.scrollTop - body.clientHeight <= SCROLL_THRESHOLD) loadMore("below");
        });
      });
  }

  function handleScroll() {
    const body = bodyRef.current;
    if (!body) return;
    if (body.scrollTop <= SCROLL_THRESHOLD) loadMore("above");
    if (body.scrollHeight - body.scrollTop - body.clientHeight <= SCROLL_THRESHOLD) loadMore("below");
  }

  const title = snippet?.path ?? target.path;
  const fileName = snippet?.originalName ?? title.split(/[\\/]/).at(-1) ?? title;
  return <aside className="file-preview-pane code-snippet-pane" style={{ width }} aria-label={`代码预览 ${title}:${target.line}`}>
    <div
      className="file-preview-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整预览栏宽度"
      aria-valuemin={320}
      aria-valuemax={960}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={onResizeStart}
      onKeyDown={onResizeKeyDown}
    />
    <header>
      <FileCode size={19} />
      <span className="file-preview-title">
        <strong>{fileName}</strong>
        <small title={title}>{title} · 第 {target.line} 行</small>
      </span>
      <span className="file-preview-actions">
        <CopyPathButton value={title} className="file-preview-copy" />
        <button type="button" className="icon-button" aria-label="关闭" autoFocus onClick={onClose}><X size={18} /></button>
      </span>
    </header>
    {error
      ? <div className="file-preview-error"><TriangleAlert size={20} /><span>{error}</span><button type="button" className="code-snippet-retry" onClick={() => setRetry((value) => value + 1)}>重试</button></div>
      : !snippet
        ? <div className="file-preview-loading"><LoaderCircle className="spin" size={20} /><span>正在加载代码…</span></div>
        : <div className="code-snippet-scroll" ref={bodyRef} onScroll={handleScroll}>
            {snippet.start > 1 && <div className="code-snippet-more">{loadingMore === "above" ? <><LoaderCircle className="spin" size={13} /><span>正在加载上方代码…</span></> : <span>继续向上滚动加载更多</span>}</div>}
            <ol className="code-snippet-lines">
              {snippet.lines.map((text, index) => {
                const lineNumber = snippet.start + index;
                return <li key={lineNumber} data-line-number={lineNumber} className={lineNumber === snippet.line ? "current" : ""}>
                  <span className="code-snippet-line-number">{lineNumber}</span>
                  <code>{text || " "}</code>
                </li>;
              })}
            </ol>
            {snippet.end < snippet.totalLines && <div className="code-snippet-more">{loadingMore === "below" ? <><LoaderCircle className="spin" size={13} /><span>正在加载下方代码…</span></> : <span>继续向下滚动加载更多</span>}</div>}
            {moreError && <p className="code-snippet-more-error"><TriangleAlert size={12} />{moreError}</p>}
          </div>}
    {snippet && <footer className="code-snippet-status">第 {snippet.start}–{snippet.end} 行 · 共 {snippet.totalLines} 行{snippet.line >= snippet.start && snippet.line <= snippet.end ? ` · 定位 ${snippet.line} 行` : ""}</footer>}
  </aside>;
}
