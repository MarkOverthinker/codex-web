import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { CalendarClock, History, Plus, X } from "lucide-react";
import { api, type AgentOptions, type WorkingDirSettings } from "./api";
import type { Automation, AutomationInput, AutomationRun } from "./automation-types";

const statusLabels: Record<string, string> = { queued: "排队中", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断", skipped: "已跳过", unavailable: "会话已删除" };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试。";
const displayDate = (date: string, timeZone?: string) => new Date(date).toLocaleString("zh-CN", { timeZone, hour12: false });

function taskInput(task: Automation): AutomationInput {
  return { name: task.name, prompt: task.prompt, workingDir: task.workingDir, time: task.time, timeZone: task.timeZone,
    model: task.model, reasoningEffort: task.reasoningEffort, sandbox: task.sandbox, enabled: task.enabled };
}

export function AutomationsPage({ options, workingDirs, onClose, onOpenConversation }: {
  options: AgentOptions | null;
  workingDirs: WorkingDirSettings | null;
  onClose(): void;
  onOpenConversation(id: string): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"manage" | "runs">("manage");
  const [tasks, setTasks] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [filter, setFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{ id?: string; input: AutomationInput } | null>(null);

  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    const timer = window.setInterval(() => setRefresh((value) => value + 1), 15_000);
    return () => { window.clearInterval(timer); element?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);

  useEffect(() => {
    let disposed = false;
    void api.automations().then((result) => { if (!disposed) setTasks(result.automations); })
      .catch((failure) => { if (!disposed) setError(errorMessage(failure)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [refresh]);

  useEffect(() => {
    if (tab !== "runs") return;
    let disposed = false;
    setRunsLoading(true);
    void api.automationRuns(filter || undefined, offset).then((result) => { if (!disposed) setRuns(result.runs); })
      .catch((failure) => { if (!disposed) setError(errorMessage(failure)); })
      .finally(() => { if (!disposed) setRunsLoading(false); });
    return () => { disposed = true; };
  }, [tab, filter, offset, refresh]);

  async function perform(operation: () => Promise<unknown>, message: string) {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); setNotice(message); setRefresh((value) => value + 1); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  function create() {
    if (!options) return;
    const selection = options.selection ?? options.defaults;
    setEditor({ input: { name: "", prompt: "", workingDir: workingDirs?.enabled ? workingDirs.defaultWorkingDir : null,
      time: "09:00", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", model: selection.model,
      reasoningEffort: selection.reasoningEffort, sandbox: "workspace-write", enabled: true } });
    setError(""); setNotice("");
  }

  function update(input: Partial<AutomationInput>) {
    setEditor((current) => current ? { ...current, input: { ...current.input, ...input } } : null);
  }

  function viewRuns(id = "") { setFilter(id); setOffset(0); setTab("runs"); setEditor(null); }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    if (editor.input.sandbox === "danger-full-access" && !window.confirm("该自动任务将每日以完全访问权限执行固定提示词，可读写系统账户可访问的文件。确认保存？")) return;
    void perform(async () => { await api.saveAutomation(editor.input, editor.id); setEditor(null); }, "自动任务已保存。");
  }

  const selectedModel = options?.models.find((model) => model.id === editor?.input.model);
  return createPortal(<dialog ref={dialog} className="automations-page" aria-label="自动任务" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="automations-header"><div><CalendarClock size={22} /><h1>自动任务</h1></div><button type="button" className="icon-button" aria-label="关闭自动任务" onClick={onClose}><X size={20} /></button></header>
    <nav className="automations-tabs" aria-label="自动任务页面">
      <button type="button" aria-current={tab === "manage" ? "page" : undefined} onClick={() => setTab("manage")}><CalendarClock size={16} />任务管理</button>
      <button type="button" aria-current={tab === "runs" ? "page" : undefined} onClick={() => viewRuns()}><History size={16} />运行记录</button>
    </nav>
    <div className="automations-content">
      {error && <p className="automation-error" role="alert">{error}</p>}
      {notice && <p className="automation-notice" role="status">{notice}</p>}
      {tab === "manage" ? <>
        <div className="automations-toolbar"><div><h2>每日定时执行</h2><p>每次新建独立会话，并发送固定提示词。无需保持浏览器在线。</p></div>
          <button type="button" className="primary-button" disabled={!options || busy} onClick={create}><Plus size={16} />新建自动任务</button></div>
        <p className="automation-help">服务必须在线。停机恢复只补跑一次；上次尚未结束则跳过本次；暂停期间不补跑。夏令时跳过不存在的时刻，重复时刻只运行一次。</p>
        {editor && <form className="automation-editor" onSubmit={save}>
          <h3>{editor.id ? "编辑自动任务" : "新建自动任务"}</h3>
          <fieldset disabled={busy}>
            <div className="automation-fields">
              <label>任务名称<input required maxLength={100} value={editor.input.name} onChange={(event) => update({ name: event.target.value })} /></label>
              <label>运行路径<input disabled={!workingDirs?.enabled} list="automation-working-dirs" value={editor.input.workingDir ?? ""} placeholder={workingDirs?.enabled ? "留空使用独立会话工作区" : "当前部署使用独立会话工作区"} onChange={(event) => update({ workingDir: event.target.value || null })} /><datalist id="automation-working-dirs">{workingDirs?.favorites.map((favorite) => <option key={favorite.path} value={favorite.path}>{favorite.label}</option>)}</datalist></label>
              <label>每天运行时间<input required type="time" value={editor.input.time} onChange={(event) => update({ time: event.target.value })} /></label>
              <label>时区<input required aria-label="时区" aria-describedby="automation-timezone-help" value={editor.input.timeZone} placeholder="Asia/Shanghai" onChange={(event) => update({ timeZone: event.target.value })} /><small id="automation-timezone-help">例如 Asia/Shanghai、Asia/Hong_Kong 或 UTC</small></label>
              <label>模型<select required value={editor.input.model} onChange={(event) => {
                const model = options?.models.find((candidate) => candidate.id === event.target.value);
                update({ model: event.target.value, reasoningEffort: model?.reasoningEfforts.some((effort) => effort === editor.input.reasoningEffort) ? editor.input.reasoningEffort : model?.reasoningEfforts[0] ?? "medium" });
              }}>{!selectedModel && <option value={editor.input.model}>{editor.input.model}（不可用）</option>}{options?.models.map((model) => <option key={model.id} value={model.id}>{model.providerName ? `${model.providerName} / ` : ""}{model.label}</option>)}</select></label>
              <label>思考强度<select required value={editor.input.reasoningEffort} onChange={(event) => update({ reasoningEffort: event.target.value })}>
                {!selectedModel?.reasoningEfforts.some((effort) => effort === editor.input.reasoningEffort) && <option value={editor.input.reasoningEffort}>{editor.input.reasoningEffort}（不可用）</option>}
                {selectedModel?.reasoningEfforts.map((effort) => <option key={effort} value={effort}>{options?.reasoningEfforts.find((option) => option.id === effort)?.label ?? effort}</option>)}
              </select></label>
              <label>权限模式<select value={editor.input.sandbox} onChange={(event) => update({ sandbox: event.target.value as AutomationInput["sandbox"] })}>{options?.sandboxModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</select></label>
              <label className="automation-checkbox"><input type="checkbox" checked={editor.input.enabled} onChange={(event) => update({ enabled: event.target.checked })} />启用每日调度</label>
            </div>
            <label>固定提示词<textarea required rows={7} maxLength={100000} value={editor.input.prompt} onChange={(event) => update({ prompt: event.target.value })} placeholder="描述每天需要执行的任务及交付要求…" /></label>
            <div className="automation-actions"><button type="submit" className="primary-button">{busy ? "保存中…" : "保存任务"}</button><button type="button" className="secondary-button" onClick={() => setEditor(null)}>取消编辑</button></div>
          </fieldset>
        </form>}
        {loading ? <p role="status">正在加载自动任务…</p> : tasks.length === 0 ? <div className="automation-empty">尚未配置自动任务。创建任务后，每日运行记录会显示在这里。</div> : <div className="automation-list">{tasks.map((task) => <article className="automation-card" key={task.id}>
          <div className="automation-card-heading"><h3>{task.name}</h3><span className={`automation-status ${task.enabled ? "completed" : "skipped"}`}>{task.enabled ? "已启用" : "已暂停"}</span></div>
          <p>每天 {task.time} · {task.timeZone}</p><p className="automation-meta">{task.model} · {task.reasoningEffort} · {task.sandbox === "workspace-write" ? "工作区写入" : "完全访问"}</p>
          <p className="automation-meta">运行路径：{task.workingDir || "独立会话工作区"}</p>
          <p className="automation-meta">下次运行：{task.enabled ? `${displayDate(task.nextRunAt, task.timeZone)}（${task.timeZone}）` : "暂停期间不运行"}</p>
          <p className="automation-prompt">{task.prompt}</p>
          <div className="automation-actions">
            <button type="button" disabled={busy} onClick={() => { setEditor({ id: task.id, input: taskInput(task) }); dialog.current?.querySelector(".automations-content")?.scrollTo({ top: 0 }); }}>编辑</button>
            <button type="button" disabled={busy} onClick={() => void perform(() => api.enableAutomation(task.id, !task.enabled), task.enabled ? "自动任务已暂停。" : "自动任务已启用。")}>{task.enabled ? "暂停" : "启用"}</button>
            <button type="button" disabled={busy} onClick={() => void perform(async () => { await api.runAutomation(task.id); viewRuns(task.id); }, "触发请求已处理，请查看运行记录中的实际状态。")}>立即运行</button>
            <button type="button" onClick={() => viewRuns(task.id)}>查看记录</button>
            <button type="button" disabled={busy} onClick={() => { if (window.confirm(`删除自动任务“${task.name}”？已有会话和运行记录会保留，已开始的任务不会停止。`)) void perform(async () => { await api.deleteAutomation(task.id); if (editor?.id === task.id) setEditor(null); }, "自动任务已删除，运行记录已保留。"); }}>删除</button>
          </div>
        </article>)}</div>}
      </> : <>
        <div className="automations-toolbar"><div><h2>运行记录</h2><p>每 15 秒刷新；打开会话可查看输出、文件和执行过程。</p></div><label>筛选任务<select value={filter} onChange={(event) => { setFilter(event.target.value); setOffset(0); }}><option value="">全部任务（含已删除）</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select></label></div>
        {runsLoading && <p role="status">正在刷新运行记录…</p>}
        {!runsLoading && runs.length === 0 && <div className="automation-empty">暂无运行记录。</div>}
        <div className="automation-list">{runs.map((run) => <article key={run.id} className="automation-card">
          <div className="automation-card-heading"><h3>{run.name}</h3><span className={`automation-status ${run.status}`}>{statusLabels[run.status] ?? run.status}</span></div>
          <p>{run.trigger === "manual" ? "手动运行" : "定时运行"} · {displayDate(run.createdAt)}</p>
          <p className="automation-meta">计划时间：{displayDate(run.scheduledAt, run.snapshot.timeZone)}（{run.snapshot.timeZone}）</p>
          {run.error && <p className="automation-error">{run.error}</p>}
          <details><summary>查看本次配置和提示词</summary><p className="automation-meta">{run.snapshot.workingDir || "独立会话工作区"} · {run.snapshot.model} · {run.snapshot.reasoningEffort} · {run.snapshot.sandbox}</p><pre className="automation-run-prompt">{run.snapshot.prompt}</pre></details>
          {run.conversationId && <div className="automation-actions"><button type="button" onClick={() => onOpenConversation(run.conversationId!)}>打开任务会话</button></div>}
        </article>)}</div>
        <div className="automation-pagination"><button type="button" disabled={offset === 0 || runsLoading} onClick={() => setOffset((value) => Math.max(0, value - 50))}>上一页</button><span>第 {offset / 50 + 1} 页</span><button type="button" disabled={runs.length < 50 || runsLoading} onClick={() => setOffset((value) => value + 50)}>下一页</button></div>
      </>}
    </div>
  </dialog>, document.body);
}
