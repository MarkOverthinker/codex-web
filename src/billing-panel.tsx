import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BarChart3, CloudDownload, DollarSign, LoaderCircle, RefreshCw, RotateCcw, Save, X } from "lucide-react";
import { api, type AgentModelOption, type BillingModel, type BillingPricingRule, type BillingState } from "./api.js";
import { localBillingRange, type BillingRange } from "./billing-range.js";

const BUILTIN_PROVIDER_ID = "__builtin__";

type Props = { open: boolean; onClose: () => void; builtinModels: AgentModelOption[] };

type Draft = {
  input: string;
  cacheRead: string;
  cacheWrite: string;
  output: string;
  currency: string;
  peakEnabled: boolean;
  peakInput: string;
  peakCacheRead: string;
  peakCacheWrite: string;
  peakOutput: string;
  peakStart: string;
  peakEnd: string;
  peakWeekdays: number[];
  timezone: string;
};

const WEEKDAYS = [
  { value: 1, label: "一" }, { value: 2, label: "二" }, { value: 3, label: "三" },
  { value: 4, label: "四" }, { value: 5, label: "五" }, { value: 6, label: "六" }, { value: 7, label: "日" },
];

function timeFor(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || minutes < 0 || minutes > 1439) return "09:00";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function weekdaysFor(value: string | undefined): number[] {
  const weekdays = (value ?? "1,2,3,4,5").split(",").map(Number).filter((day) => WEEKDAYS.some((option) => option.value === day));
  return weekdays.length > 0 ? [...new Set(weekdays)] : [1, 2, 3, 4, 5];
}

function draftFor(rule: BillingPricingRule | undefined): Draft {
  return {
    input: String(rule?.input_per_million ?? 0), cacheRead: String(rule?.cached_input_per_million ?? 0),
    cacheWrite: String(rule?.cache_write_per_million ?? 0), output: String(rule?.output_per_million ?? 0), currency: rule?.currency ?? "USD",
    peakEnabled: Boolean(rule?.peak_enabled),
    peakInput: String(rule?.peak_input_per_million ?? 0), peakCacheRead: String(rule?.peak_cached_input_per_million ?? 0),
    peakCacheWrite: String(rule?.peak_cache_write_per_million ?? 0), peakOutput: String(rule?.peak_output_per_million ?? 0),
    peakStart: timeFor(rule?.peak_start_minute), peakEnd: timeFor(rule?.peak_end_minute),
    peakWeekdays: weekdaysFor(rule?.peak_weekdays), timezone: rule?.timezone ?? "Asia/Shanghai",
  };
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function formatCost(value: number | null, currency = "USD"): string {
  if (value === null) return "未计价";
  return `${currency} ${value.toFixed(4)}`;
}

function percent(value: number): string { return `${(value * 100).toFixed(1)}%`; }

export function BillingPanel({ open, onClose, builtinModels }: Props) {
  const [days, setDays] = useState(30);
  const [range, setRange] = useState<BillingRange>(30);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [startTime, setStartTime] = useState("00:00");
  const [endTime, setEndTime] = useState("23:59");
  const [showInactive, setShowInactive] = useState(false);
  const requestVersion = useRef(0);
  const [state, setState] = useState<BillingState | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncingUsage, setSyncingUsage] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const allModels = useMemo(() => {
    const known = new Map<string, BillingModel>();
    for (const model of state?.models ?? []) known.set(`${model.providerId}:${model.modelId}`, model);
    for (const model of builtinModels) {
      const key = `${BUILTIN_PROVIDER_ID}:${model.id}`;
      known.set(key, { providerId: BUILTIN_PROVIDER_ID, providerName: "Codex 内置源", modelId: model.id, displayName: model.label, enabled: true });
    }
    return [...known.values()];
  }, [builtinModels, state?.models]);
  const visibleModels = allModels.filter((model) => showInactive || model.enabled);
  const busy = loading || syncing || syncingUsage || recalculating || Boolean(savingKey);

  async function refresh(nextRange: BillingRange = range) {
    const version = ++requestVersion.current;
    setLoading(true); setError("");
    try {
      const result = await api.billing(nextRange);
      if (version === requestVersion.current) { setState(result); setRange(nextRange); }
    } catch (reason) {
      if (version === requestVersion.current) { setState(null); setError(reason instanceof Error ? reason.message : "加载计费统计失败"); }
    } finally { if (version === requestVersion.current) setLoading(false); }
  }

  async function syncUsage() {
    setSyncingUsage(true); setError(""); setNotice("");
    try {
      const result = await api.syncBillingUsage(range);
      setState(result.billing);
      setNotice(`本机用量同步完成：补记 ${result.result.inserted} 条，更新 ${result.result.updated} 条。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "同步本机用量失败");
    } finally { setSyncingUsage(false); }
  }

  function applyDateRange() {
    try { void refresh(localBillingRange(startDate, endDate, startTime, endTime)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "日期范围无效"); }
  }

  useEffect(() => {
    if (!open) return;
    void refresh();
    return () => { requestVersion.current += 1; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  function ruleFor(model: BillingModel): BillingPricingRule | undefined {
    return state?.rules.find((rule) => rule.provider_id === model.providerId && rule.model_id === model.modelId);
  }

  function draftForModel(model: BillingModel): Draft {
    const key = `${model.providerId}:${model.modelId}`;
    return drafts[key] ?? draftFor(ruleFor(model));
  }

  function updateDraft(model: BillingModel, field: keyof Draft, value: Draft[keyof Draft]) {
    const key = `${model.providerId}:${model.modelId}`;
    setDrafts((current) => ({ ...current, [key]: { ...draftForModel(model), [field]: value } }));
  }

  async function saveRule(model: BillingModel) {
    const draft = draftForModel(model);
    const payload = {
      inputPerMillion: Number(draft.input), cacheReadPerMillion: Number(draft.cacheRead), cacheWritePerMillion: Number(draft.cacheWrite), outputPerMillion: Number(draft.output), currency: draft.currency,
      peakEnabled: draft.peakEnabled, peakInputPerMillion: Number(draft.peakInput), peakCacheReadPerMillion: Number(draft.peakCacheRead),
      peakCacheWritePerMillion: Number(draft.peakCacheWrite), peakOutputPerMillion: Number(draft.peakOutput), peakStart: draft.peakStart,
      peakEnd: draft.peakEnd, peakWeekdays: draft.peakWeekdays, timezone: draft.timezone,
    };
    if (![payload.inputPerMillion, payload.cacheReadPerMillion, payload.cacheWritePerMillion, payload.outputPerMillion].every((value) => Number.isFinite(value) && value >= 0)) {
      setError("费率必须是非负数字。"); return;
    }
    if (draft.peakEnabled && ![payload.peakInputPerMillion, payload.peakCacheReadPerMillion, payload.peakCacheWritePerMillion, payload.peakOutputPerMillion].every((value) => Number.isFinite(value) && value >= 0)) {
      setError("峰时费率必须是非负数字。"); return;
    }
    if (draft.peakEnabled && (draft.peakStart === draft.peakEnd || draft.peakWeekdays.length === 0 || !draft.timezone.trim())) {
      setError("峰时必须设置不同的起止时间、至少一个星期和有效时区。"); return;
    }
    const key = `${model.providerId}:${model.modelId}`;
    setSavingKey(key); setError(""); setNotice("");
    try { setState(await api.updateBillingRule(model.providerId, model.modelId, payload, range)); setNotice(`已保存 ${model.displayName} 的 token 费率。`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存费率失败"); }
    finally { setSavingKey(""); }
  }

  async function recalculate() {
    if (!window.confirm("这会删除费率变更历史，并让当前费率应用到全部历史用量。确定继续吗？")) return;
    setRecalculating(true); setError(""); setNotice("");
    try { setState(await api.recalculateBilling(range)); setNotice("已按当前费率重算全部历史费用。"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "强制重算失败"); }
    finally { setRecalculating(false); }
  }

  async function syncPricing() {
    setSyncing(true); setError(""); setNotice("");
    try {
      const result = await api.syncBillingPricing(undefined, undefined, range);
      setState(result.billing);
      const failures = "results" in result ? result.results.filter((item) => item.error) : [];
      if (failures.length > 0) {
        setError(`远程费率已导入 ${result.imported} 条；${failures.length} 个源同步失败。`);
      } else {
        setNotice(`已同步 ${result.imported} 条远程费率。`);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "同步远程费率失败"); }
    finally { setSyncing(false); }
  }

  if (!open) return null;
  const summary = state?.summary;
  return createPortal(<div className="billing-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="billing-panel" role="dialog" aria-modal="true" aria-label="API 调用计费统计">
      <header className="billing-header"><div><BarChart3 size={19} /><strong>API 调用计费统计</strong><small>费用按调用时间对应的费率版本计算；修改费率不会改写已有历史</small></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>
      <div className="billing-toolbar"><label>统计范围<select disabled={busy} value={days} onChange={(event) => { const value = Number(event.target.value); setDays(value); if (value !== -1) void refresh(value); }}><option value="0">全部历史</option><option value="-1">自定义日期与时间</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option><option value="365">最近 1 年</option></select></label><div className="billing-actions"><button type="button" className="billing-refresh" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? "spin" : ""} />刷新</button><button type="button" className="billing-sync" disabled={busy} onClick={() => void syncUsage()}><RefreshCw size={14} className={syncingUsage ? "spin" : ""} />同步本机用量</button><button type="button" className="billing-sync" disabled={busy} onClick={() => void syncPricing()}><CloudDownload size={14} className={syncing ? "spin" : ""} />同步远程费率</button><button type="button" className="billing-recalculate" disabled={busy} onClick={() => void recalculate()}><RotateCcw size={14} className={recalculating ? "spin" : ""} />强制重算历史费用</button></div></div>
      {days === -1 && <div className="billing-date-range">
        <label>开始日期<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
        <label>开始时间<input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} /></label>
        <label>结束日期<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
        <label>结束时间<input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></label>
        <button type="button" className="billing-refresh" disabled={busy} onClick={applyDateRange}>应用筛选</button>
        <small>按本地时区 {Intl.DateTimeFormat().resolvedOptions().timeZone} 筛选，包含结束分钟；同一天可查询单日用量。</small>
      </div>}
      {state && <p className="billing-range-caption">当前统计：{typeof range === "number" && range === 0 ? "全部历史" : new Date(state.from).toLocaleString()} — {new Date(Date.parse(state.to) - 1).toLocaleString()}</p>}
      {error && <div className="billing-message error" role="alert">{error}</div>}
      {notice && <div className="billing-message" role="status">{notice}</div>}
      {summary && <div className="billing-summary-grid"><div><span>调用次数</span><strong>{summary.calls.toLocaleString()}</strong></div><div><span>总输入 Token</span><strong>{formatTokens(summary.inputTokens)}</strong></div><div><span>输出 Token</span><strong>{formatTokens(summary.outputTokens)}</strong></div><div><span>缓存命中率</span><strong>{percent(summary.cacheHitRate)}</strong></div><div className="billing-cost"><span>估算费用</span><strong><DollarSign size={16} />{formatCost(summary.estimatedCost, summary.currency)}</strong>{summary.unpricedCalls > 0 && <small>{summary.unpricedCalls} 次调用未配置费率</small>}</div></div>}
      {loading ? <div className="billing-empty"><LoaderCircle size={20} className="spin" />正在加载统计…</div> : !state ? <div className="billing-empty">暂无统计数据，请点击刷新重试。</div> : <>
        <div className="billing-section"><h3>按 API 源</h3><div className="billing-table-wrap"><table className="billing-table"><thead><tr><th>源</th><th>调用</th><th>输入 Token</th><th>输出 Token</th><th>缓存命中率</th><th>费用</th></tr></thead><tbody>{state.byProvider.length === 0 ? <tr><td colSpan={6} className="billing-empty-cell">暂无调用记录</td></tr> : state.byProvider.map((row) => <tr key={row.providerId}><td><strong>{row.providerName}</strong><small>{row.providerId === BUILTIN_PROVIDER_ID ? "默认源" : row.providerId}</small></td><td>{row.calls.toLocaleString()}</td><td>{formatTokens(row.inputTokens)}</td><td>{formatTokens(row.outputTokens)}</td><td>{percent(row.cacheHitRate)}</td><td>{formatCost(row.estimatedCost, row.currency)}</td></tr>)}</tbody></table></div></div>
        <div className="billing-section"><h3>按客户端来源</h3><div className="billing-table-wrap"><table className="billing-table"><thead><tr><th>客户端</th><th>采集方式</th><th>调用</th><th>输入 / 输出</th><th>费用</th></tr></thead><tbody>{(state.byClient ?? []).length === 0 ? <tr><td colSpan={5} className="billing-empty-cell">暂无调用记录</td></tr> : state.byClient.map((row) => <tr key={`${row.sourceKind}:${row.originator}`}><td><strong>{row.clientName}</strong><small>{row.originator}</small></td><td>{row.sourceKind === "web" ? "实时事件" : "rollout 补记"}</td><td>{row.calls.toLocaleString()}</td><td>{formatTokens(row.inputTokens)} / {formatTokens(row.outputTokens)}</td><td>{formatCost(row.estimatedCost, row.currency)}</td></tr>)}</tbody></table></div></div>
        <div className="billing-section"><h3>按模型</h3><div className="billing-table-wrap"><table className="billing-table"><thead><tr><th>模型</th><th>源</th><th>调用次数</th><th>输入 / 输出</th><th>缓存命中率</th><th>费用</th></tr></thead><tbody>{state.byModel.length === 0 ? <tr><td colSpan={6} className="billing-empty-cell">暂无调用记录</td></tr> : state.byModel.map((row) => <tr key={`${row.providerId}:${row.modelId}`}><td><strong>{row.modelId}</strong></td><td>{row.providerName}</td><td>{row.calls.toLocaleString()}</td><td>{formatTokens(row.inputTokens)} / {formatTokens(row.outputTokens)}</td><td>{percent(row.cacheHitRate)}</td><td>{formatCost(row.estimatedCost, row.currency)}</td></tr>)}</tbody></table></div></div>
        <details className="billing-section" open><summary>Token 计费规则（点击折叠）</summary><label className="billing-checkbox"><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />显示未启用模型（{allModels.filter((model) => !model.enabled).length}）</label><p className="billing-hint">默认仅显示已启用 API 源中可见模型的费率。隐藏不影响历史用量或费用；在 API 源与模型管理中可停用模型。</p><p className="billing-hint">单位为每 1,000,000 tokens，顺序为未缓存输入、输出、缓存写入、缓存读取；用量中的总输入会先扣除缓存写入和缓存读取，再按未缓存输入计费。当前费率作为谷时费率。可选启用峰时费率，计费会按调用发生时间和所选时区自动切换。</p><div className="billing-table-wrap"><table className="billing-table billing-rules-table"><thead><tr><th>源 / 模型</th><th>谷时输入（未缓存）</th><th>谷时输出</th><th>谷时缓存写入</th><th>谷时缓存读取</th><th>货币</th><th>峰时设置</th><th /></tr></thead><tbody>{visibleModels.length === 0 ? <tr><td colSpan={8} className="billing-empty-cell">没有已启用的模型；可显示未启用模型，或在 API 源与模型管理中启用模型。</td></tr> : visibleModels.map((model) => { const draft = draftForModel(model); const key = `${model.providerId}:${model.modelId}`; return <tr key={key}><td><strong>{model.displayName}</strong><small>{model.providerName} · {model.modelId}</small></td><td><input aria-label={`${model.displayName} 谷时输入费率（未缓存）`} value={draft.input} onChange={(event) => updateDraft(model, "input", event.target.value)} /></td><td><input aria-label={`${model.displayName} 谷时输出费率`} value={draft.output} onChange={(event) => updateDraft(model, "output", event.target.value)} /></td><td><input aria-label={`${model.displayName} 谷时缓存写入费率`} value={draft.cacheWrite} onChange={(event) => updateDraft(model, "cacheWrite", event.target.value)} /></td><td><input aria-label={`${model.displayName} 谷时缓存读取费率`} value={draft.cacheRead} onChange={(event) => updateDraft(model, "cacheRead", event.target.value)} /></td><td><input aria-label={`${model.displayName} 货币`} value={draft.currency} maxLength={3} onChange={(event) => updateDraft(model, "currency", event.target.value.toUpperCase())} /></td><td><details className="billing-peak-settings"><summary>{draft.peakEnabled ? `已启用 ${draft.peakStart}-${draft.peakEnd}` : "未启用"}</summary><label className="billing-checkbox"><input type="checkbox" checked={draft.peakEnabled} onChange={(event) => updateDraft(model, "peakEnabled", event.target.checked)} />启用峰时费率</label><div className="billing-peak-grid"><label>输入（未缓存）<input disabled={!draft.peakEnabled} aria-label={`${model.displayName} 峰时输入费率（未缓存）`} value={draft.peakInput} onChange={(event) => updateDraft(model, "peakInput", event.target.value)} /></label><label>输出<input disabled={!draft.peakEnabled} aria-label={`${model.displayName} 峰时输出费率`} value={draft.peakOutput} onChange={(event) => updateDraft(model, "peakOutput", event.target.value)} /></label><label>缓存写入<input disabled={!draft.peakEnabled} aria-label={`${model.displayName} 峰时缓存写入费率`} value={draft.peakCacheWrite} onChange={(event) => updateDraft(model, "peakCacheWrite", event.target.value)} /></label><label>缓存读取<input disabled={!draft.peakEnabled} aria-label={`${model.displayName} 峰时缓存读取费率`} value={draft.peakCacheRead} onChange={(event) => updateDraft(model, "peakCacheRead", event.target.value)} /></label></div><div className="billing-peak-row"><label>开始<input disabled={!draft.peakEnabled} type="time" value={draft.peakStart} onChange={(event) => updateDraft(model, "peakStart", event.target.value)} /></label><label>结束<input disabled={!draft.peakEnabled} type="time" value={draft.peakEnd} onChange={(event) => updateDraft(model, "peakEnd", event.target.value)} /></label><label>时区<input disabled={!draft.peakEnabled} value={draft.timezone} onChange={(event) => updateDraft(model, "timezone", event.target.value)} placeholder="Asia/Shanghai" /></label></div><div className="billing-weekdays"><span>星期</span>{WEEKDAYS.map((option) => <label key={option.value}><input type="checkbox" disabled={!draft.peakEnabled} checked={draft.peakWeekdays.includes(option.value)} onChange={() => updateDraft(model, "peakWeekdays", draft.peakWeekdays.includes(option.value) ? draft.peakWeekdays.filter((day) => day !== option.value) : [...draft.peakWeekdays, option.value].sort((left, right) => left - right))} />{option.label}</label>)}</div><small>结束时间早于开始时间时，表示跨午夜峰时段。</small></details></td><td><button type="button" className="billing-save" disabled={busy} onClick={() => void saveRule(model)}>{savingKey === key ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存</button></td></tr>; })}</tbody></table></div></details>
      </>}
    </section>
  </div>, document.body);
}
