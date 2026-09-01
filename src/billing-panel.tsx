import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BarChart3, DollarSign, LoaderCircle, RefreshCw, Save, X } from "lucide-react";
import { api, type AgentModelOption, type AgentProviderOption, type BillingModel, type BillingPricingRule, type BillingState } from "./api.js";

const BUILTIN_PROVIDER_ID = "__builtin__";

type Props = { open: boolean; onClose: () => void; providers: AgentProviderOption[]; builtinModels: AgentModelOption[] };

type Draft = {
  input: string;
  cached: string;
  cacheWrite: string;
  output: string;
  currency: string;
  peakEnabled: boolean;
  peakInput: string;
  peakCached: string;
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
    input: String(rule?.input_per_million ?? 0), cached: String(rule?.cached_input_per_million ?? 0),
    cacheWrite: String(rule?.cache_write_per_million ?? 0), output: String(rule?.output_per_million ?? 0), currency: rule?.currency ?? "USD",
    peakEnabled: Boolean(rule?.peak_enabled),
    peakInput: String(rule?.peak_input_per_million ?? 0), peakCached: String(rule?.peak_cached_input_per_million ?? 0),
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

export function BillingPanel({ open, onClose, providers, builtinModels }: Props) {
  const [days, setDays] = useState(30);
  const [state, setState] = useState<BillingState | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState("");
  const [syncingId, setSyncingId] = useState("");
  const [pricingUrl, setPricingUrl] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const allModels = useMemo(() => {
    const known = new Map<string, BillingModel>();
    for (const model of state?.models ?? []) known.set(`${model.providerId}:${model.modelId}`, model);
    for (const model of builtinModels) {
      const key = `${BUILTIN_PROVIDER_ID}:${model.id}`;
      if (!known.has(key)) known.set(key, { providerId: BUILTIN_PROVIDER_ID, providerName: "Codex 内置源", modelId: model.id, displayName: model.label });
    }
    return [...known.values()];
  }, [builtinModels, state?.models]);

  const sourceOptions = useMemo(() => [
    { id: BUILTIN_PROVIDER_ID, name: "Codex 内置源" },
    ...providers,
  ], [providers]);

  async function refresh(nextDays = days) {
    setLoading(true); setError("");
    try { setState(await api.billing(nextDays)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "加载计费统计失败"); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (!open) return;
    let active = true;
    void (async () => {
      await refresh();
      try {
        const result = await api.syncBillingPricing();
        if (!active) return;
        setState(result.billing);
        if (result.imported > 0) setNotice(`已自动同步 ${result.imported} 条远程费率。`);
      } catch {
      }
    })();
    return () => { active = false; };
  }, [open]);

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
      inputPerMillion: Number(draft.input), cachedInputPerMillion: Number(draft.cached), cacheWritePerMillion: Number(draft.cacheWrite), outputPerMillion: Number(draft.output), currency: draft.currency,
      peakEnabled: draft.peakEnabled, peakInputPerMillion: Number(draft.peakInput), peakCachedInputPerMillion: Number(draft.peakCached),
      peakCacheWritePerMillion: Number(draft.peakCacheWrite), peakOutputPerMillion: Number(draft.peakOutput), peakStart: draft.peakStart,
      peakEnd: draft.peakEnd, peakWeekdays: draft.peakWeekdays, timezone: draft.timezone,
    };
    if (![payload.inputPerMillion, payload.cachedInputPerMillion, payload.cacheWritePerMillion, payload.outputPerMillion].every((value) => Number.isFinite(value) && value >= 0)) {
      setError("费率必须是非负数字。"); return;
    }
    if (draft.peakEnabled && ![payload.peakInputPerMillion, payload.peakCachedInputPerMillion, payload.peakCacheWritePerMillion, payload.peakOutputPerMillion].every((value) => Number.isFinite(value) && value >= 0)) {
      setError("峰时费率必须是非负数字。"); return;
    }
    if (draft.peakEnabled && (draft.peakStart === draft.peakEnd || draft.peakWeekdays.length === 0 || !draft.timezone.trim())) {
      setError("峰时必须设置不同的起止时间、至少一个星期和有效时区。"); return;
    }
    const key = `${model.providerId}:${model.modelId}`;
    setSavingKey(key); setError(""); setNotice("");
    try { setState(await api.updateBillingRule(model.providerId, model.modelId, payload)); setNotice(`已保存 ${model.displayName} 的 token 费率。`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存费率失败"); }
    finally { setSavingKey(""); }
  }

  async function syncPricing(providerId: string) {
    setSyncingId(providerId); setError(""); setNotice("");
    try {
      const result = await api.syncBillingPricing(providerId, pricingUrl.trim() || undefined);
      setState(result.billing); setNotice(`已从远程接口导入 ${result.imported} 条费率。`); setPricingUrl("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "同步计费标准失败"); }
    finally { setSyncingId(""); }
  }

  if (!open) return null;
  const summary = state?.summary;
  return createPortal(<div className="billing-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="billing-panel" role="dialog" aria-modal="true" aria-label="API 调用计费统计">
      <header className="billing-header"><div><BarChart3 size={19} /><strong>API 调用计费统计</strong><small>用量来自每次完成的模型调用，费用是按费率规则计算的估算值</small></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>
      <div className="billing-toolbar"><label>统计范围<select value={days} onChange={(event) => { const value = Number(event.target.value); setDays(value); void refresh(value); }}><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option><option value="365">最近 1 年</option></select></label><button type="button" className="billing-refresh" disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? "spin" : ""} />刷新</button></div>
      {error && <div className="billing-message error" role="alert">{error}</div>}
      {notice && <div className="billing-message" role="status">{notice}</div>}
      {summary && <div className="billing-summary-grid"><div><span>调用次数</span><strong>{summary.calls.toLocaleString()}</strong></div><div><span>输入 Token</span><strong>{formatTokens(summary.inputTokens)}</strong></div><div><span>输出 Token</span><strong>{formatTokens(summary.outputTokens)}</strong></div><div><span>缓存命中率</span><strong>{percent(summary.cacheHitRate)}</strong></div><div className="billing-cost"><span>估算费用</span><strong><DollarSign size={16} />{formatCost(summary.estimatedCost, summary.currency)}</strong>{summary.unpricedCalls > 0 && <small>{summary.unpricedCalls} 次调用未配置费率</small>}</div></div>}
      {!state || loading ? <div className="billing-empty"><LoaderCircle size={20} className="spin" />正在加载统计…</div> : <>
        <div className="billing-section"><h3>按 API 源</h3><div className="billing-table-wrap"><table className="billing-table"><thead><tr><th>源</th><th>调用</th><th>输入 Token</th><th>输出 Token</th><th>缓存命中率</th><th>费用</th></tr></thead><tbody>{state.byProvider.length === 0 ? <tr><td colSpan={6} className="billing-empty-cell">暂无调用记录</td></tr> : state.byProvider.map((row) => <tr key={row.providerId}><td><strong>{row.providerName}</strong><small>{row.providerId === BUILTIN_PROVIDER_ID ? "默认源" : row.providerId}</small></td><td>{row.calls.toLocaleString()}</td><td>{formatTokens(row.inputTokens)}</td><td>{formatTokens(row.outputTokens)}</td><td>{percent(row.cacheHitRate)}</td><td>{formatCost(row.estimatedCost, row.currency)}</td></tr>)}</tbody></table></div></div>
        <div className="billing-section"><h3>按模型</h3><div className="billing-table-wrap"><table className="billing-table"><thead><tr><th>模型</th><th>源</th><th>调用</th><th>输入 / 输出</th><th>费用</th></tr></thead><tbody>{state.byModel.length === 0 ? <tr><td colSpan={5} className="billing-empty-cell">暂无调用记录</td></tr> : state.byModel.map((row) => <tr key={`${row.providerId}:${row.modelId}`}><td><strong>{row.modelId}</strong></td><td>{row.providerName}</td><td>{row.calls.toLocaleString()}</td><td>{formatTokens(row.inputTokens)} / {formatTokens(row.outputTokens)}</td><td>{formatCost(row.estimatedCost, row.currency)}</td></tr>)}</tbody></table></div></div>
        <div className="billing-section"><h3>Token 计费规则</h3><p className="billing-hint">单位为每 1,000,000 tokens；当前费率作为谷时费率。可选启用峰时费率，计费会按调用发生时间和所选时区自动切换。</p><div className="billing-sync"><input value={pricingUrl} onChange={(event) => setPricingUrl(event.target.value)} placeholder="可选：New API 计费 JSON 地址" /><div>{sourceOptions.filter((source) => source.id !== BUILTIN_PROVIDER_ID).map((source) => <button type="button" key={source.id} disabled={Boolean(syncingId)} onClick={() => void syncPricing(source.id)}>{syncingId === source.id ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}同步 {source.name}</button>)}</div></div><div className="billing-table-wrap"><table className="billing-table billing-rules-table"><thead><tr><th>源 / 模型</th><th>谷时输入</th><th>谷时缓存输入</th><th>谷时缓存写入</th><th>谷时输出</th><th>货币</th><th>峰时设置</th><th /></tr></thead><tbody>{allModels.length === 0 ? <tr><td colSpan={8} className="billing-empty-cell">还没有可配置的模型；调用一次或先导入模型目录。</td></tr> : allModels.map((model) => { const draft = draftForModel(model); const key = `${model.providerId}:${model.modelId}`; return <tr key={key}><td><strong>{model.displayName}</strong><small>{model.providerName} · {model.modelId}</small></td><td><input aria-label={`${model.displayName} 谷时输入费率`} value={draft.input} onChange={(event) => updateDraft(model, "input", event.target.value)} /></td><td><input aria-label={`${model.displayName} 谷时缓存输入费率`} value={draft.cached} onChange={(event) => updateDraft(model, "cached", event.target.value)} /></td><td><input aria-label={`${model.displayName} 谷时缓存写入费率`} value={draft.cacheWrite} onChange={(event) => updateDraft(model, "cacheWrite", event.target.value)} /></td><td><input aria-label={`${model.displayName} 谷时输出费率`} value={draft.output} onChange={(event) => updateDraft(model, "output", event.target.value)} /></td><td><input aria-label={`${model.displayName} 货币`} value={draft.currency} maxLength={3} onChange={(event) => updateDraft(model, "currency", event.target.value.toUpperCase())} /></td><td><details className="billing-peak-settings"><summary>{draft.peakEnabled ? `已启用 ${draft.peakStart}-${draft.peakEnd}` : "未启用"}</summary><label className="billing-checkbox"><input type="checkbox" checked={draft.peakEnabled} onChange={(event) => updateDraft(model, "peakEnabled", event.target.checked)} />启用峰时费率</label><div className="billing-peak-grid"><label>输入<input disabled={!draft.peakEnabled} aria-label={`${model.displayName} 峰时输入费率`} value={draft.peakInput} onChange={(event) => updateDraft(model, "peakInput", event.target.value)} /></label><label>缓存输入<input disabled={!draft.peakEnabled} aria-label={`${model.displayName} 峰时缓存输入费率`} value={draft.peakCached} onChange={(event) => updateDraft(model, "peakCached", event.target.value)} /></label><label>缓存写入<input disabled={!draft.peakEnabled} aria-label={`${model.displayName} 峰时缓存写入费率`} value={draft.peakCacheWrite} onChange={(event) => updateDraft(model, "peakCacheWrite", event.target.value)} /></label><label>输出<input disabled={!draft.peakEnabled} aria-label={`${model.displayName} 峰时输出费率`} value={draft.peakOutput} onChange={(event) => updateDraft(model, "peakOutput", event.target.value)} /></label></div><div className="billing-peak-row"><label>开始<input disabled={!draft.peakEnabled} type="time" value={draft.peakStart} onChange={(event) => updateDraft(model, "peakStart", event.target.value)} /></label><label>结束<input disabled={!draft.peakEnabled} type="time" value={draft.peakEnd} onChange={(event) => updateDraft(model, "peakEnd", event.target.value)} /></label><label>时区<input disabled={!draft.peakEnabled} value={draft.timezone} onChange={(event) => updateDraft(model, "timezone", event.target.value)} placeholder="Asia/Shanghai" /></label></div><div className="billing-weekdays"><span>星期</span>{WEEKDAYS.map((option) => <label key={option.value}><input type="checkbox" disabled={!draft.peakEnabled} checked={draft.peakWeekdays.includes(option.value)} onChange={() => updateDraft(model, "peakWeekdays", draft.peakWeekdays.includes(option.value) ? draft.peakWeekdays.filter((day) => day !== option.value) : [...draft.peakWeekdays, option.value].sort((left, right) => left - right))} />{option.label}</label>)}</div><small>结束时间早于开始时间时，表示跨午夜峰时段。</small></details></td><td><button type="button" className="billing-save" disabled={savingKey === key} onClick={() => void saveRule(model)}>{savingKey === key ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}保存</button></td></tr>; })}</tbody></table></div></div>
      </>}
    </section>
  </div>, document.body);
}
