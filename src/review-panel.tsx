import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitBranch, RefreshCw, X } from "lucide-react";
import { api } from "./api.js";
import type { GitReview, ReviewScope } from "./git-review.js";

export function diffLines(patch: string) {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  return patch.split("\n").map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; }
    if (text === "@@ 新文件 @@") { oldLine = 0; newLine = 1; inHunk = true; }
    const kind = text.startsWith("@@") ? "hunk" : inHunk && text.startsWith("+") ? "add" : inHunk && text.startsWith("-") ? "delete" : "context";
    const content = inHunk && /^[ +\-]/.test(text) && !hunk;
    return { text, kind, old: content && kind !== "add" ? oldLine++ : null, next: content && kind !== "delete" ? newLine++ : null };
  });
}

export function ReviewButton({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return <><button type="button" className={`chat-tool-trigger ${open ? "active" : ""}`} onClick={() => setOpen(true)} aria-label="查看 Git 分支变更" title="查看 Git 分支变更"><GitBranch size={16} /><span>Review</span></button>
    {open && <ReviewPanel conversationId={conversationId} onClose={close} />}</>;
}

function ReviewPanel({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const [scope, setScope] = useState<ReviewScope>("working");
  const [base, setBase] = useState("");
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<GitReview | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState<GitReview | null>(null);
  const [error, setError] = useState("");
  const [patchError, setPatchError] = useState("");
  const [loading, setLoading] = useState(true);
  const [patchLoading, setPatchLoading] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); onClose(); }
      if (event.key === "Tab") {
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("keydown", keydown, true); previous?.focus(); };
  }, [onClose]);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setSelected(null); setPatch(null);
    void api.review(conversationId, scope, base || undefined).then((result) => {
      if (!active) return;
      setData(result); setSelected(result.files[0]?.path ?? null);
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "读取变更失败。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [conversationId, scope, base, revision]);
  useEffect(() => {
    if (selected === null || loading) return;
    let active = true;
    setPatch(null); setPatchLoading(true); setPatchError("");
    void api.review(conversationId, scope, base || undefined, selected).then((result) => { if (active) setPatch(result); })
      .catch((reason: unknown) => { if (active) setPatchError(reason instanceof Error ? reason.message : "读取 diff 失败。"); })
      .finally(() => { if (active) setPatchLoading(false); });
    return () => { active = false; };
  }, [conversationId, scope, base, selected, loading, revision]);
  return createPortal(<div className="review-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="review-dialog" role="dialog" aria-modal="true" aria-label="Git Review 分支变更" tabIndex={-1}>
      <header className="review-header"><div><strong><GitBranch size={18} /> Review · {data?.branch ?? "分支变更"}</strong><small title={data?.root}>{data?.root ?? "当前会话工作目录"}</small></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭 Review"><X size={20} /></button></header>
      <div className="review-toolbar"><label>范围 <select value={scope} onChange={(event) => setScope(event.target.value as ReviewScope)}><option value="working">未提交变更（全部）</option><option value="staged">仅已暂存</option><option value="branch">分支已提交变更</option></select></label>
        {scope === "branch" && <label>基准 <select value={base || data?.base || ""} onChange={(event) => setBase(event.target.value)}><option value="">自动选择</option>{data?.bases.map((ref) => <option key={ref} value={ref}>{ref.replace(/^refs\/(heads|remotes)\//, "")}</option>)}</select></label>}
        <button type="button" className="chat-tool-trigger" aria-label="刷新变更" disabled={loading} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={15} /><span>刷新</span></button><span className="review-readonly">只读 · 不修改仓库</span></div>
      <p className="review-summary">{data?.comparison ?? "读取当前工作目录的 Git 变更"}{data && ` · ${data.files.length} 个文件 · +${data.files.reduce((sum, file) => sum + (file.additions ?? 0), 0)} −${data.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)}（不含未跟踪/二进制统计）`}</p>
      {error ? <p className="review-notice" role="alert">{error}</p> : loading ? <p className="review-notice" role="status">正在读取变更…</p> : !data?.files.length ? <p className="review-notice">此范围内没有变更。</p> : <div className="review-body">
        <nav className="review-files" aria-label="变更文件">{data.files.map((file) => <button type="button" key={file.path} className={selected === file.path ? "selected" : ""} onClick={() => setSelected(file.path)} title={file.path} aria-pressed={selected === file.path}><span className="review-status">{file.status}</span><span className="review-filename">{file.path}</span><small>{file.additions === null ? (file.status === "?" ? "未跟踪" : "二进制") : `+${file.additions} −${file.deletions}`}</small></button>)}</nav>
        <section className="review-diff" aria-label="文件差异"><div className="review-diff-title">{selected}</div>{patchLoading ? <p className="review-notice" role="status">正在读取 diff…</p> : patchError ? <p className="review-notice" role="alert">{patchError}</p> : <>
          {patch?.truncated && <p className="review-notice">文件较大，仅展示前 256 KiB。</p>}
          <pre tabIndex={0}>{diffLines(patch?.patch || "该文件没有可显示的文本差异。").map((line, index) => <div key={index} className={`review-line ${line.kind}`}><span className="review-line-number" aria-hidden="true">{line.old}</span><span className="review-line-number" aria-hidden="true">{line.next}</span><code>{line.text || " "}</code></div>)}</pre>
        </>}</section>
      </div>}
    </div>
  </div>, document.body);
}
