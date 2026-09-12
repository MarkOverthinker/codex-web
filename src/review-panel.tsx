import { useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, File, FileDiff, Folder, FolderTree, GitBranch, GitCommitHorizontal, Globe, LoaderCircle, Maximize2, Minimize2, RefreshCw, Search, SquareTerminal, X } from "lucide-react";
import { api } from "./api.js";
import type { GitReview, ReviewFile, ReviewScope } from "./git-review.js";
import { TerminalPane } from "./terminal-pane.js";
import { FileExplorerPane } from "./file-explorer-pane.js";
import { changeTree, diffLines, repositoryActionPrompt, reviewTotals, type ChangeTree, type RepositoryAction, type RepositoryTab } from "./repository-model.js";
import { highlightLines, RenderedPreview, SourceTokens } from "./source-preview.js";

export { diffLines } from "./repository-model.js";

function ChangeCounts({ files }: { files: ReviewFile[] }) {
  const totals = reviewTotals(files);
  return <span className="repository-counts"><span className="repository-add">+{totals.additions.toLocaleString()}</span><span className="repository-delete">−{totals.deletions.toLocaleString()}</span></span>;
}

export function ReviewButton({ conversationId, revision, open, onOpen }: { conversationId: string; revision: string; open: boolean; onOpen: (tab: RepositoryTab) => void }) {
  const [data, setData] = useState<GitReview | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void api.review(conversationId, "working", undefined, undefined, controller.signal).then((result) => { if (!controller.signal.aborted) setData(result); }).catch((reason: unknown) => {
      if (!controller.signal.aborted) { setData(null); setError(reason instanceof Error ? reason.message : "无法读取仓库"); }
    });
    return () => controller.abort();
  }, [conversationId, revision, refresh, open]);
  useEffect(() => {
    const focus = () => setRefresh((value) => value + 1);
    const outside = (event: PointerEvent) => { if (details.current && !details.current.contains(event.target as Node)) details.current.open = false; };
    window.addEventListener("focus", focus);
    document.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("focus", focus); document.removeEventListener("pointerdown", outside); };
  }, []);
  const show = (tab: RepositoryTab) => { if (details.current) details.current.open = false; onOpen(tab); };
  return <div className="repository-tools">
    <button type="button" className="chat-tool-trigger" onClick={() => show("terminal")} aria-label="打开任务终端" title="打开任务终端"><SquareTerminal size={16} /><span>终端</span></button>
    <button type="button" className={`chat-tool-trigger ${open ? "active" : ""}`} onClick={() => show("changes")} aria-label="查看 Git 分支变更" title="打开仓库审查"><FileDiff size={16} /><span>变更{data ? ` ${data.files.length}` : ""}</span>{data && <ChangeCounts files={data.files} />}</button>
    <details className="repository-environment" ref={details} onKeyDown={(event) => { if (event.key === "Escape" && details.current?.open) { event.preventDefault(); event.stopPropagation(); details.current.open = false; details.current.querySelector("summary")?.focus(); } }}>
      <summary className="chat-tool-trigger" aria-label="环境信息"><GitBranch size={15} /><span>{data?.branch ?? "环境"}</span><ChevronDown size={12} /></summary>
      <div className="repository-environment-card">
        <header><strong>环境信息</strong><button className="icon-button" type="button" aria-label="刷新环境信息" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} /></button></header>
        {error ? <p className="repository-muted" role="status">{error}</p> : !data ? <p role="status">正在读取环境…</p> : <>
          <button type="button" onClick={() => show("changes")}><FileDiff size={16} /><span>变更 <small>{data.files.length} 个文件</small></span><ChangeCounts files={data.files} /></button>
          <div><Globe size={16} /><span>远程</span><strong>{data.remotes?.join(", ") || "未配置"}</strong></div>
          <div><GitBranch size={16} /><span>当前分支</span><strong>{data.branch}</strong></div>
          <p className="repository-upstream">{data.upstream ? `${data.branch} → ${data.upstream} · ↑${data.ahead ?? "?"} ↓${data.behind ?? "?"}` : "未配置上游分支"}</p>
          <button type="button" onClick={() => show("changes")}><GitCommitHorizontal size={16} /><span>提交或推送…</span><ChevronRight size={14} /></button>
          <small className="repository-muted">远端状态来自本地跟踪引用，未自动 fetch。</small>
        </>}
        <footer><button type="button" onClick={() => show("files")}><FolderTree size={16} /><span>浏览全部文件</span><ChevronRight size={14} /></button>{data && <small title={data.root}>{data.root}</small>}</footer>
      </div>
    </details>
  </div>;
}

type RepositoryPaneProps = ComponentProps<typeof FileExplorerPane> & {
  tab: RepositoryTab;
  onTabChange: (tab: RepositoryTab) => void;
  revision: string;
  busy: boolean;
  onAction: (prompt: string) => Promise<void>;
};

export function RepositoryPane({ tab, onTabChange, revision, busy, onAction, ...props }: RepositoryPaneProps) {
  const [expanded, setExpanded] = useState(false);
  const [visited, setVisited] = useState<Set<RepositoryTab>>(new Set([tab]));
  useEffect(() => { setVisited((current) => new Set(current).add(tab)); }, [tab]);
  const pane = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    pane.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <aside ref={pane} tabIndex={-1} className={`repository-pane ${expanded ? "expanded" : ""}`} style={{ width: props.width }} aria-label="仓库工作区" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); props.onClose(); } }}>
    {!expanded && <div className="file-explorer-resizer" role="separator" aria-label="调整仓库栏宽度" aria-orientation="vertical" aria-valuemin={340} aria-valuemax={1120} aria-valuenow={Math.round(props.width)} tabIndex={0} onPointerDown={props.onResizeStart} onKeyDown={props.onResizeKeyDown} />}
    <header className="repository-header"><div className="repository-tabs" role="tablist" aria-label="仓库视图" onKeyDown={(event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs: RepositoryTab[] = ["changes", "files", "terminal"];
      const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[2] : tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : 2)) % tabs.length];
      onTabChange(next);
      pane.current?.querySelector<HTMLButtonElement>(`#repository-tab-${next}`)?.focus();
    }}>
      {(["changes", "files", "terminal"] as const).map((value) => <button key={value} id={`repository-tab-${value}`} role="tab" aria-controls={`repository-view-${value}`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} type="button" onClick={() => onTabChange(value)}>{value === "changes" ? <FileDiff size={16} /> : value === "files" ? <FolderTree size={16} /> : <SquareTerminal size={16} />}{value === "changes" ? "审查变更" : value === "files" ? "全部文件" : "终端"}</button>)}
    </div><div className="repository-header-actions"><button type="button" className="icon-button repository-expand" aria-label={expanded ? "还原仓库工作区" : "展开仓库工作区"} onClick={() => setExpanded((value) => !value)}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button><button type="button" className="icon-button" onClick={props.onClose} aria-label="关闭仓库工作区"><X size={18} /></button></div></header>
    <div id="repository-view-changes" className="repository-view" role="tabpanel" aria-labelledby="repository-tab-changes" hidden={tab !== "changes"}>{visited.has("changes") && <ReviewPanel conversationId={props.conversationId} revision={revision} busy={busy} onAction={onAction} />}</div>
    <div id="repository-view-files" className="repository-view" role="tabpanel" aria-labelledby="repository-tab-files" hidden={tab !== "files"}>{visited.has("files") && <FileExplorerPane {...props} embedded />}</div>
    <div id="repository-view-terminal" className="repository-view" role="tabpanel" aria-labelledby="repository-tab-terminal" hidden={tab !== "terminal"}>{visited.has("terminal") && <TerminalPane key={props.conversationId} conversationId={props.conversationId} active={tab === "terminal"} />}</div>
  </aside>;
}

function ReviewPanel({ conversationId, revision, busy, onAction }: { conversationId: string; revision: string; busy: boolean; onAction: (prompt: string) => Promise<void> }) {
  const [scope, setScope] = useState<ReviewScope>("working");
  const [base, setBase] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<GitReview | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState<GitReview | null>(null);
  const [error, setError] = useState("");
  const [patchError, setPatchError] = useState("");
  const [loading, setLoading] = useState(true);
  const [patchLoading, setPatchLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<"diff" | "preview" | "source">("diff");
  const [wrapped, setWrapped] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<RepositoryAction | null>(null);
  const [actionData, setActionData] = useState<GitReview | null>(null);
  const [actionError, setActionError] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setReviewed(new Set()); setAction(null);
    void api.review(conversationId, scope, base || undefined, undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setData(result); setSelected((current) => result.files.some((file) => file.path === current) ? current : result.files[0]?.path ?? null);
    }).catch((reason: unknown) => { if (!controller.signal.aborted) { setData(null); setError(reason instanceof Error ? reason.message : "读取变更失败。"); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [conversationId, scope, base, refresh, revision]);
  useEffect(() => {
    if (selected === null || loading || !data) { setPatch(null); return; }
    const controller = new AbortController();
    setPatch(null); setPatchLoading(true); setPatchError("");
    void api.review(conversationId, scope, base || undefined, selected, controller.signal).then((result) => { if (!controller.signal.aborted) setPatch(result); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setPatchError(reason instanceof Error ? reason.message : "读取差异失败。"); })
      .finally(() => { if (!controller.signal.aborted) setPatchLoading(false); });
    return () => controller.abort();
  }, [conversationId, scope, base, selected, loading, data]);
  const visibleFiles = useMemo(() => data?.files.filter((file) => file.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [], [data, filter]);
  const tree = useMemo(() => changeTree(visibleFiles), [visibleFiles]);
  const position = visibleFiles.findIndex((file) => file.path === selected);
  const currentFile = data?.files.find((file) => file.path === selected);
  const changeScope = (value: ReviewScope) => { setScope(value); setSelected(null); setPatch(null); };
  const showAction = async (value: RepositoryAction) => {
    setActionLoading(true); setActionError(""); setNotice("");
    try { const result = await api.review(conversationId, "working"); setActionData(result); setAction(value); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : "读取操作范围失败。"); }
    finally { setActionLoading(false); }
  };
  const renderTree = (nodes: ChangeTree[], depth = 0) => nodes.map((node) => node.file ? <button key={node.path} type="button" className={`repository-tree-file ${selected === node.path ? "selected" : ""}`} style={{ "--tree-depth": depth } as CSSProperties} aria-pressed={selected === node.path} title={node.path} onClick={() => setSelected(node.path)}>
    <File size={14} /><span className="repository-tree-name">{node.name}</span><span className="repository-file-status" aria-label={`状态 ${node.file.status}`}>{node.file.status === "?" ? "U" : node.file.status}</span>{reviewed.has(node.path) ? <Check size={13} className="repository-add" /> : <small>{node.file.additions === null ? "—" : `+${node.file.additions} −${node.file.deletions}`}</small>}
  </button> : <div key={node.path}><button type="button" className="repository-tree-folder" style={{ "--tree-depth": depth } as CSSProperties} aria-expanded={filter ? true : !collapsed.has(node.path)} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(node.path)) next.delete(node.path); else next.add(node.path); return next; })}>{!filter && collapsed.has(node.path) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<Folder size={14} /><span>{node.name}</span></button>{(filter || !collapsed.has(node.path)) && renderTree(node.children, depth + 1)}</div>);
  return <section className="repository-review" aria-label="Git Review 分支变更">
    <div className="repository-toolbar"><label className="repository-scope"><GitBranch size={15} /><select aria-label="变更范围" value={scope} onChange={(event) => changeScope(event.target.value as ReviewScope)}><option value="working">未提交变更</option><option value="staged">已暂存变更</option><option value="branch">分支变更</option></select></label>{data && <ChangeCounts files={data.files} />}<span className="repository-toolbar-spacer" /><button type="button" className="icon-button" aria-label="刷新变更" disabled={loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={15} /></button>
      <button type="button" className="repository-action-button" disabled={busy || !data || loading || actionLoading} onClick={() => void showAction("commit")}><GitCommitHorizontal size={15} />提交…</button><button type="button" className="repository-action-button" disabled={busy || !data?.upstream || loading || actionLoading} onClick={() => void showAction("push")}><ArrowUp size={15} />推送…</button></div>
    <div className="repository-comparison"><span title={data?.root}>{data?.branch ?? "当前工作目录"}</span><span>→</span>{scope === "branch" ? <select aria-label="基准分支" value={base || data?.base || ""} onChange={(event) => { setBase(event.target.value); setSelected(null); }}><option value="">自动选择基准</option>{data?.bases.map((ref) => <option key={ref} value={ref}>{ref.replace(/^refs\/(heads|remotes)\//, "")}</option>)}</select> : <span>{scope === "staged" ? "暂存区" : data?.upstream ?? "工作区"}</span>}{data?.upstream && <small title="本地远端跟踪引用；尚未 fetch"><ArrowUp size={11} />{data.ahead ?? "?"}<ArrowDown size={11} />{data.behind ?? "?"}</small>}</div>
    {busy && <p className="repository-inline-notice">当前有任务运行或等待执行；完成后才可提交/推送。</p>}
    {actionError && <p className="repository-inline-notice" role="alert">{actionError}</p>}{notice && <p className="repository-inline-notice" role="status">{notice}</p>}
    {action && actionData && <RepositoryActionForm key={`${action}:${actionData.head}`} action={action} data={actionData} busy={busy} onCancel={() => setAction(null)} onConfirm={async (prompt) => { await onAction(prompt); setAction(null); setNotice("操作请求已加入 Codex 任务队列；执行结果请查看对话，入队不表示已提交或已推送。"); }} />}
    {error ? <div className="repository-empty" role="alert"><GitBranch size={28} /><strong>无法读取 Git 仓库</strong><p>{error}</p><p>非 Git 目录仍可通过「全部文件」浏览。</p></div> : loading ? <div className="repository-empty" role="status"><LoaderCircle size={24} className="spin" />正在读取变更…</div> : !data?.files.length ? <div className="repository-empty"><Check size={30} /><strong>此范围没有变更</strong><p>可切换范围，或在「全部文件」中查看项目。</p></div> : <>
      <div className="repository-review-summary"><span>{data.files.length} 个文件 · 已查看 {reviewed.size}{reviewTotals(data.files).unknown > 0 && <small> · {reviewTotals(data.files).unknown} 个未跟踪/二进制文件未计入行数</small>}</span><span>按文件加载</span></div>
      <div className="repository-review-body"><section className="repository-diff" aria-label="文件差异"><header className="repository-file-header"><File size={15} /><span title={selected ?? ""}>{selected}</span>{currentFile && <ChangeCounts files={[currentFile]} />}</header>
        <div className="repository-file-toolbar"><div className="repository-view-options" aria-label="预览方式">{(["diff", "preview", "source"] as const).map((value) => <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)}>{value === "diff" ? "差异" : value === "preview" ? "预览" : "源码"}</button>)}</div><button type="button" className="repository-text-button" aria-pressed={wrapped} onClick={() => setWrapped((value) => !value)}>换行</button><label><input type="checkbox" checked={selected !== null && reviewed.has(selected)} disabled={patchLoading || !patch || Boolean(patchError)} onChange={(event) => { if (selected === null) return; setReviewed((current) => { const next = new Set(current); if (event.target.checked) next.add(selected); else next.delete(selected); return next; }); }} />已查看</label></div>
        <div className={`repository-diff-content ${wrapped ? "wrapped" : ""}`} key={`${selected}:${view}`}>
          {patchLoading ? <p className="review-notice" role="status">正在读取文件…</p> : patchError ? <p className="review-notice" role="alert">{patchError}</p> : view === "diff" ? <>{patch?.truncated && <p className="repository-inline-notice">差异超过 256 KiB，仅显示开头部分。</p>}<DiffView filename={selected ?? ""} patch={patch?.patch ?? ""} /></> : <>
            <p className="repository-preview-label">{patch?.preview?.revision ?? "此版本的文件内容"}{patch?.preview?.truncated && " · 仅前 256 KiB"}</p>
            {patch?.preview?.content != null ? <RenderedPreview content={patch.preview.content} filename={selected ?? ""} source={view === "source"} /> : <p className="review-notice">{patch?.preview?.reason ?? "此文件无法提供文本预览，请在全部文件中查看图片、PDF 或下载。"}</p>}
          </>}
        </div>
      </section><nav className="repository-change-tree" aria-label="变更文件"><label className="repository-filter"><Search size={14} /><input aria-label="筛选变更文件" placeholder="筛选文件…" value={filter} onChange={(event) => setFilter(event.target.value)} /></label><div className="repository-file-navigation"><span>{position < 0 ? "—" : position + 1} / {visibleFiles.length}</span><button type="button" className="icon-button" aria-label="上一个变更文件" disabled={position <= 0} onClick={() => setSelected(visibleFiles[position - 1].path)}><ChevronLeft size={15} /></button><button type="button" className="icon-button" aria-label="下一个变更文件" disabled={position >= visibleFiles.length - 1} onClick={() => setSelected(visibleFiles[position + 1].path)}><ChevronRight size={15} /></button></div><div className="repository-tree-scroll">{renderTree(tree)}{!visibleFiles.length && <p className="review-notice">没有匹配文件。</p>}</div></nav></div>
    </>}
  </section>;
}

function DiffView({ filename, patch }: { filename: string; patch: string }) {
  const [limit, setLimit] = useState(1200);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const lines = useMemo(() => diffLines(patch), [patch]);
  const tokens = useMemo(() => highlightLines(lines.map((line) => line.kind === "meta" || line.kind === "hunk" ? "" : line.content).join("\n"), filename), [lines, filename]);
  useEffect(() => { setLimit(1200); setHidden(new Set()); }, [filename, patch]);
  if (!patch) return <p className="review-notice">该文件没有可显示的文本差异。</p>;
  let hunkIndex = -1;
  let previousNewLine = 0;
  return <><pre className="repository-code" tabIndex={0} aria-label="语法高亮差异">{lines.slice(0, limit).map((line, index) => {
    if (line.kind === "hunk") {
      hunkIndex = index;
      const start = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line.text);
      const skipped = start ? Math.max(0, Number(start[1]) - previousNewLine - 1) : 0;
      const label = start ? `${skipped ? `省略 ${skipped} 行未改动内容 · ` : ""}第 ${start[1]} 行${line.content ? ` · ${line.content}` : ""}` : "新文件";
      return <button className="repository-hunk" type="button" key={index} aria-label={`${hidden.has(index) ? "展开" : "折叠"}差异段：${label}`} aria-expanded={!hidden.has(index)} onClick={() => setHidden((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}>{hidden.has(index) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>{label}{hidden.has(index) ? " · 展开差异段" : ""}</span></button>;
    }
    if (line.next !== null) previousNewLine = line.next;
    if (hidden.has(hunkIndex)) return null;
    if (line.kind === "meta") return /^diff --git |^index |^--- |^\+\+\+ /.test(line.text) ? null : <div key={index} className="repository-diff-meta">{line.text}</div>;
    return <div key={index} className={`repository-code-line ${line.kind}`}><span className="repository-line-number" aria-hidden="true">{line.old}</span><span className="repository-line-number" aria-hidden="true">{line.next}</span><span className="repository-line-sign" aria-hidden="true">{line.kind === "add" ? "+" : line.kind === "delete" ? "−" : " "}</span><code><SourceTokens tokens={tokens[index]} />{"\n"}</code></div>;
  })}</pre>{lines.length > limit && <button className="repository-more" type="button" onClick={() => setLimit((value) => value + 1200)}>继续显示 1200 行（剩余 {lines.length - limit} 行）</button>}</>;
}

function RepositoryActionForm({ action, data, busy, onCancel, onConfirm }: { action: RepositoryAction; data: GitReview; busy: boolean; onCancel: () => void; onConfirm: (prompt: string) => Promise<void> }) {
  const [paths, setPaths] = useState<Set<string>>(new Set(data.stagedFiles?.filter((filename) => data.files.some((file) => file.path === filename)) ?? []));
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { form.current?.focus(); }, []);
  const blocked = data.conflictedFiles?.length ? "请先解决合并冲突。" : data.branch.startsWith("HEAD (detached)") ? "分离 HEAD 不支持快捷操作。" : action === "push" && (!data.upstream || !data.ahead || data.behind) ? "推送需要配置上游、有待推送提交且不落后于上游；请先在对话中处理同步。" : "";
  return <form className="repository-action-form" ref={form} tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); if (!submitting) onCancel(); } }} aria-label={action === "commit" ? "确认提交范围" : "确认推送目标"} onSubmit={(event) => {
    event.preventDefault(); if (submitting || busy || blocked) return;
    setError("");
    try {
      const prompt = repositoryActionPrompt(data, action, [...paths], message);
      setSubmitting(true);
      void onConfirm(prompt).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "任务入队失败，请重试。")).finally(() => setSubmitting(false));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "请检查操作参数。"); }
  }}>
    <header><strong>{action === "commit" ? "提交选定文件" : "推送已提交变更"}</strong><button type="button" className="icon-button" onClick={onCancel} disabled={submitting} aria-label="取消 Git 操作"><X size={16} /></button></header>
    <p>{data.branch} {action === "push" ? `→ ${data.upstream ?? "未配置上游"} · ${data.ahead ?? 0} 个提交` : `· 已选择 ${paths.size} / ${data.files.length} 个文件`}</p>
    {action === "commit" && <><label>提交说明<input aria-label="提交说明" placeholder="描述这次变更的目的" maxLength={2000} value={message} onChange={(event) => setMessage(event.target.value)} disabled={submitting} /></label><div className="repository-commit-files">{data.files.map((file) => <label key={file.path}><input type="checkbox" checked={paths.has(file.path)} disabled={submitting} onChange={(event) => setPaths((current) => { const next = new Set(current); if (event.target.checked) next.add(file.path); else next.delete(file.path); return next; })} /><span>{file.path}</span><small>{file.status}</small></label>)}</div></>}
    <p className="repository-muted">交给当前 Codex 任务执行，沿用账户身份、沙箱与审批。{action === "commit" ? "默认只勾选已暂存文件；按文件提交当前整体改动（含未暂存部分），不是按差异块提交；不会自动推送。" : "不会提交工作区文件或强制推送。"}</p>
    {(blocked || error) && <p role="alert">{blocked || error}</p>}
    <footer><button type="button" className="repository-text-button" onClick={onCancel} disabled={submitting}>取消</button><button type="submit" className="repository-action-button" disabled={Boolean(blocked) || busy || submitting || (action === "commit" && (!paths.size || !message.trim()))}>{submitting ? "正在加入队列…" : "确认并交给 Codex"}</button></footer>
  </form>;
}
