import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Eye, EyeOff, LoaderCircle, Pencil, Plus, Settings2, Trash2, X } from "lucide-react";
import { api, type Provider, type ProviderModel, type ProviderState } from "./api.js";

type ProviderDraft = {
  name: string;
  baseUrl: string;
  apiKey: string;
  modelsFile: string;
  autoReviewModelOverride: string;
  wireApi: Provider["wireApi"];
  requiresOpenaiAuth: boolean;
  enabled: boolean;
};

type ModelDraft = {
  modelId: string;
  displayName: string;
  modelContextWindow: string;
  autoCompactTokenLimit: string;
  description: string;
  reasoningEfforts: string;
  inputModalities: string;
  priority: string;
  visible: boolean;
};

const emptyProviderDraft: ProviderDraft = {
  name: "",
  baseUrl: "",
  apiKey: "",
  modelsFile: "",
  autoReviewModelOverride: "",
  wireApi: "responses",
  requiresOpenaiAuth: false,
  enabled: true,
};

const emptyModelDraft: ModelDraft = {
  modelId: "",
  displayName: "",
  description: "",
  reasoningEfforts: "low, medium, high, xhigh",
  inputModalities: "text, image",
  priority: "0",
  visible: true,
  modelContextWindow: "1000000",
  autoCompactTokenLimit: "900000",
};

function providerDraft(provider: Provider): ProviderDraft {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: "",
    modelsFile: provider.modelsFile ?? "",
    autoReviewModelOverride: provider.autoReviewModelOverride ?? "",
    wireApi: provider.wireApi,
    requiresOpenaiAuth: provider.requiresOpenaiAuth,
    enabled: provider.enabled,
  };
}

function modelDraft(model: ProviderModel): ModelDraft {
  return {
    modelId: model.modelId,
    displayName: model.displayName,
    description: model.description,
    modelContextWindow: String(model.modelContextWindow),
    autoCompactTokenLimit: String(model.autoCompactTokenLimit),
    reasoningEfforts: model.reasoningEfforts.join(", "),
    inputModalities: model.inputModalities.join(", "),
    priority: String(model.priority),
    visible: model.visible,
  };
}

function splitList(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

export function ProviderManagerDialog({ open, onClose, onChanged }: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [state, setState] = useState<ProviderState | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingProvider, setEditingProvider] = useState<Provider | "new" | null>(null);
  const [providerDraftState, setProviderDraftState] = useState<ProviderDraft>(emptyProviderDraft);
  const [editingModel, setEditingModel] = useState<{ providerId: string; model: ProviderModel | null } | null>(null);
  const [modelDraftState, setModelDraftState] = useState<ModelDraft>(emptyModelDraft);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(""); setNotice("");
    setLoading(true);
    void api.providers().then((value) => {
      setState(value);
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : "加载 API 源失败");
    }).finally(() => setLoading(false));
  }, [open]);

  async function refresh() {
    const value = await api.providers();
    setState(value);
    return value;
  }

  async function saveProvider() {
    if (!editingProvider) return;
    setSaving(true); setError(""); setNotice("");
    const payload = {
      name: providerDraftState.name,
      baseUrl: providerDraftState.baseUrl,
      modelsFile: providerDraftState.modelsFile,
      autoReviewModelOverride: providerDraftState.autoReviewModelOverride.trim() || null,
      wireApi: providerDraftState.wireApi,
      requiresOpenaiAuth: providerDraftState.requiresOpenaiAuth,
      enabled: providerDraftState.enabled,
      ...(providerDraftState.apiKey ? { apiKey: providerDraftState.apiKey } : {}),
    };
    try {
      if (editingProvider === "new") {
        await api.createProvider(payload);
        setNotice("源已添加，模型目录与 Codex 配置已重新生成。");
      } else {
        await api.updateProvider(editingProvider.id, payload);
        setNotice("源已更新，模型目录与 Codex 配置已重新生成。");
      }
      await refresh();
      setEditingProvider(null);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存源失败");
    } finally {
      setSaving(false);
    }
  }

  async function toggleProviderEnabled(provider: Provider) {
    setBusyProviderId(provider.id); setError("");
    try {
      await api.updateProvider(provider.id, { enabled: !provider.enabled });
      const value = await refresh();
      onChanged();
      setNotice(value.providers.find((item) => item.id === provider.id)?.enabled ? `已启用 ${provider.name}` : `已禁用 ${provider.name}，其模型已从目录移除。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "切换源状态失败");
    } finally {
      setBusyProviderId(null);
    }
  }

  async function importConfig() {
    setSaving(true); setError(""); setNotice("");
    try {
      const value = await api.importProviderConfig();
      setState(value);
      setNotice("已从 config.toml 导入源；请为每个源设置模型文件并导入模型。");
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导入配置失败");
    } finally {
      setSaving(false);
    }
  }

  async function importModels(provider: Provider) {
    setBusyProviderId(provider.id); setError(""); setNotice("");
    try {
      await api.importProviderModels(provider.id);
      await refresh();
      onChanged();
      setNotice(`已从 ${provider.modelsFile ?? "现有模型目录"} 导入模型到 ${provider.name}。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导入模型失败");
    } finally {
      setBusyProviderId(null);
    }
  }

  async function saveModel() {
    if (!editingModel) return;
    setSaving(true); setError(""); setNotice("");
    const payload = {
      modelId: modelDraftState.modelId,
      displayName: modelDraftState.displayName,
      description: modelDraftState.description,
      reasoningEfforts: splitList(modelDraftState.reasoningEfforts),
      inputModalities: splitList(modelDraftState.inputModalities),
      priority: Number(modelDraftState.priority) || 0,
      modelContextWindow: Number(modelDraftState.modelContextWindow) || null,
      autoCompactTokenLimit: Number(modelDraftState.autoCompactTokenLimit) || null,
      visible: modelDraftState.visible,
    };
    try {
      if (editingModel.model) {
        await api.updateProviderModel(editingModel.providerId, editingModel.model.id, payload);
        setNotice("模型已更新。");
      } else {
        await api.createProviderModel(editingModel.providerId, payload);
        setNotice("模型已添加。");
      }
      await refresh();
      setEditingModel(null);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存模型失败");
    } finally {
      setSaving(false);
    }
  }

  async function deleteModel(provider: Provider, model: ProviderModel) {
    if (!window.confirm(`确定从“${provider.name}”删除模型 ${model.modelId}？`)) return;
    setBusyProviderId(provider.id); setError("");
    try {
      await api.deleteProviderModel(provider.id, model.id);
      await refresh();
      onChanged();
      setNotice(`已删除模型 ${model.modelId}。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除模型失败");
    } finally {
      setBusyProviderId(null);
    }
  }

  async function deleteProvider(provider: Provider) {
    if (!window.confirm(`确定删除源“${provider.name}”？删除前会检查是否仍被会话或任务使用。`)) return;
    setBusyProviderId(provider.id); setError("");
    try {
      await api.deleteProvider(provider.id);
      await refresh();
      onChanged();
      setNotice(`已删除源 ${provider.name}。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除源失败");
    } finally {
      setBusyProviderId(null);
    }
  }

  if (!open) return null;
  const providers = state?.providers ?? [];
  const models = state?.models ?? [];

  return createPortal(<div className="provider-manager-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="provider-manager" role="dialog" aria-modal="true" aria-label="API 源管理">
      <header><div><Settings2 size={19} /><strong>API 源管理</strong></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>
      <p className="provider-manager-hint">模型列表直接展示为“源 · 模型”。只有已启用源中可见的模型会写入 Codex 模型目录，隐藏模型不会出现在任务菜单中。</p>
      <div className="provider-manager-toolbar">
        <button type="button" className="primary-button" onClick={() => { setEditingProvider("new"); setProviderDraftState(emptyProviderDraft); setError(""); }}>
          <Plus size={15} />添加源
        </button>
        <button type="button" className="provider-manager-import-config" disabled={saving} onClick={() => void importConfig()}>
          <Download size={15} />从 config.toml 导入
        </button>
      </div>
      {error && <div className="provider-manager-error" role="alert">{error}</div>}
      {notice && <div className="provider-manager-notice" role="status">{notice}</div>}
      {loading ? <div className="provider-manager-empty"><LoaderCircle className="spin" size={18} /><span>正在加载源…</span></div>
        : providers.length === 0
          ? <div className="provider-manager-empty"><Settings2 size={18} /><span>还没有 API 源。可以先“从 config.toml 导入”，或手动添加源。</span></div>
          : <div className="provider-manager-list">
              {providers.map((provider) => {
                const providerModels = models.filter((model) => model.providerId === provider.id);
                return <div className="provider-card" key={provider.id}>
                  <div className="provider-card-header">
                    <div className="provider-card-copy">
                      <strong>{provider.name}</strong>
                      <small title={provider.baseUrl}>{provider.baseUrl}</small>
                      <small>{provider.wireApi}{provider.requiresOpenaiAuth ? " · 官方 OAuth" : ""}{provider.apiKeyHint ? ` · ${provider.apiKeyHint}` : ""}{provider.modelsFile ? ` · 模型文件 ${provider.modelsFile}` : ""}{provider.autoReviewModelOverride ? ` · 审核模型 ${provider.autoReviewModelOverride}` : ""}</small>
                    </div>
                    <label className="provider-enabled-toggle">
                      <input type="checkbox" checked={provider.enabled} disabled={busyProviderId === provider.id} onChange={() => void toggleProviderEnabled(provider)} />
                      启用
                    </label>
                    <button type="button" className="icon-button" aria-label={`编辑 ${provider.name}`} title="编辑源" onClick={() => { setEditingProvider(provider); setProviderDraftState(providerDraft(provider)); setError(""); }}>
                      <Pencil size={15} />
                    </button>
                    <button type="button" className="icon-button danger" aria-label={`删除 ${provider.name}`} title="删除源" disabled={busyProviderId === provider.id} onClick={() => void deleteProvider(provider)}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <div className="provider-models">
                    {providerModels.map((model) => (
                      <div className="provider-model-row" key={model.id}>
                        <label className="provider-model-visible">
                          <input type="checkbox" checked={model.visible} disabled={busyProviderId === provider.id}
                            onChange={(event) => void api.updateProviderModel(provider.id, model.id, { visible: event.target.checked }).then(async () => { await refresh(); onChanged(); setNotice(event.target.checked ? `模型 ${model.modelId} 已进入可选列表。` : `模型 ${model.modelId} 已隐藏，不再出现在任务菜单。`); }).catch((reason) => setError(reason instanceof Error ? reason.message : "更新模型失败"))} />
                          <span className="provider-model-copy"><strong>{model.displayName || model.modelId}</strong><small>{model.modelId}{model.slug !== model.modelId ? ` · 目录别名 ${model.slug}` : ""} · {model.reasoningEfforts.join(", ")}</small></span>
                        </label>
                        <button type="button" className="icon-button" aria-label={`编辑模型 ${model.modelId}`} title="编辑模型" onClick={() => { setEditingModel({ providerId: provider.id, model }); setModelDraftState(modelDraft(model)); setError(""); }}>
                          <Pencil size={14} />
                        </button>
                        <button type="button" className="icon-button danger" aria-label={`删除模型 ${model.modelId}`} title="删除模型" disabled={busyProviderId === provider.id} onClick={() => void deleteModel(provider, model)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                    {providerModels.length === 0 && <div className="provider-models-empty">还没有模型；点击下方“添加模型”或从模型文件导入。</div>}
                    <div className="provider-models-actions">
                      <button type="button" onClick={() => { setEditingModel({ providerId: provider.id, model: null }); setModelDraftState(emptyModelDraft); setError(""); }}><Plus size={14} />添加模型</button>
                      <button type="button" disabled={busyProviderId === provider.id} onClick={() => void importModels(provider)}><Download size={14} />从模型文件导入</button>
                    </div>
                  </div>
                </div>;
              })}
            </div>}
      <footer className="provider-manager-footer">
        <small>源配置与模型目录由服务端生成：config.toml 写入全部启用源，models_cache.json 只含可见模型。</small>
        <button type="button" className="provider-manager-close" onClick={onClose}>完成</button>
      </footer>
    </section>

    {editingProvider && createPortal(<div className="provider-form-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEditingProvider(null); }}>
      <section className="provider-form" role="dialog" aria-modal="true" aria-label={editingProvider === "new" ? "添加 API 源" : `编辑源 ${editingProvider.name}`}>
        <header><div><Settings2 size={18} /><strong>{editingProvider === "new" ? "添加 API 源" : `编辑源 ${editingProvider.name}`}</strong></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setEditingProvider(null)}><X size={17} /></button></header>
        <div className="provider-form-fields">
          <label><span>名称</span><input value={providerDraftState.name} onChange={(event) => setProviderDraftState((current) => ({ ...current, name: event.target.value }))} placeholder="例如 deepseek" /></label>
          <label><span>Base URL</span><input value={providerDraftState.baseUrl} onChange={(event) => setProviderDraftState((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" /></label>
          <label><span>API Key{providerDraftState.apiKey ? "（已填，保存将覆盖）" : editingProvider !== "new" ? "（留空保持不变）" : providerDraftState.requiresOpenaiAuth ? "（可选）" : ""}</span><input type="password" value={providerDraftState.apiKey} onChange={(event) => setProviderDraftState((current) => ({ ...current, apiKey: event.target.value }))} placeholder={providerDraftState.requiresOpenaiAuth ? "留空则使用官方 OAuth 登录" : providerDraftState.wireApi === "chat" ? "上游无鉴权时可留空" : editingProvider !== "new" ? "留空保持不变" : "粘贴 API Key"} /></label>
          <label><span>模型文件（codex-home 内文件名）</span><input value={providerDraftState.modelsFile} onChange={(event) => setProviderDraftState((current) => ({ ...current, modelsFile: event.target.value }))} placeholder="models.json 或 sssaicodeapi-models.json" /></label>
          <label><span>自动审核模型覆盖（auto_review_model_override）</span><input value={providerDraftState.autoReviewModelOverride} onChange={(event) => setProviderDraftState((current) => ({ ...current, autoReviewModelOverride: event.target.value }))} placeholder="留空则使用该模型默认的自动审核模型" /></label>
          <label><span>协议</span>
            <select value={providerDraftState.wireApi} onChange={(event) => setProviderDraftState((current) => {
              const wireApi = event.target.value as Provider["wireApi"];
              return { ...current, wireApi, requiresOpenaiAuth: wireApi === "responses" ? current.requiresOpenaiAuth : false };
            })}>
              <option value="responses">Responses（原生支持）</option>
              <option value="chat">Chat Completions（内置 codex-relay）</option>
              <option value="anthropic">Anthropic（需代理，尚未内置）</option>
            </select>
          </label>
          {providerDraftState.wireApi === "chat" && <small className="provider-form-hint">任务运行时会在 tenant worker 内启动临时 relay，将 Codex Responses 请求转换为上游 `/chat/completions`。上游模型必须正确支持流式响应和结构化 `tool_calls`。</small>}
          <label className="provider-form-check"><input type="checkbox" checked={providerDraftState.requiresOpenaiAuth} disabled={providerDraftState.wireApi !== "responses"} onChange={(event) => setProviderDraftState((current) => ({ ...current, requiresOpenaiAuth: event.target.checked }))} /><span>使用官方 OAuth 登录（仅原生 Responses）</span></label>
          <label className="provider-form-check"><input type="checkbox" checked={providerDraftState.enabled} onChange={(event) => setProviderDraftState((current) => ({ ...current, enabled: event.target.checked }))} /><span>启用此源</span></label>
        </div>
        <footer>
          <button type="button" className="provider-manager-close" onClick={() => setEditingProvider(null)}>取消</button>
          <button type="button" className="primary-button" disabled={saving || !providerDraftState.name.trim() || !providerDraftState.baseUrl.trim()} onClick={() => void saveProvider()}>
            {saving ? <><LoaderCircle className="spin" size={15} />保存中…</> : "保存"}
          </button>
        </footer>
      </section>
    </div>, document.body)}

    {editingModel && createPortal(<div className="provider-form-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setEditingModel(null); }}>
      <section className="provider-form" role="dialog" aria-modal="true" aria-label={editingModel.model ? `编辑模型 ${editingModel.model.modelId}` : "添加模型"}>
        <header><div><Settings2 size={18} /><strong>{editingModel.model ? `编辑模型 ${editingModel.model.modelId}` : "添加模型"}</strong></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setEditingModel(null)}><X size={17} /></button></header>
        <div className="provider-form-fields">
          <label><span>模型 ID（上游模型名）</span><input value={modelDraftState.modelId} onChange={(event) => setModelDraftState((current) => ({ ...current, modelId: event.target.value }))} placeholder="gpt-5.6-sol" /></label>
          <label><span>显示名称</span><input value={modelDraftState.displayName} onChange={(event) => setModelDraftState((current) => ({ ...current, displayName: event.target.value }))} placeholder="默认与模型 ID 相同" /></label>
          <label><span>说明</span><input value={modelDraftState.description} onChange={(event) => setModelDraftState((current) => ({ ...current, description: event.target.value }))} placeholder="可选" /></label>
          <label><span>思考深度（逗号分隔）</span><input value={modelDraftState.reasoningEfforts} onChange={(event) => setModelDraftState((current) => ({ ...current, reasoningEfforts: event.target.value }))} /></label>
          <label><span>输入模态（逗号分隔）</span><input value={modelDraftState.inputModalities} onChange={(event) => setModelDraftState((current) => ({ ...current, inputModalities: event.target.value }))} /></label>
          <label><span>上下文窗口（tokens）</span><input type="number" min={1} value={modelDraftState.modelContextWindow} onChange={(event) => setModelDraftState((current) => ({ ...current, modelContextWindow: event.target.value }))} placeholder="默认 1000000" /></label>
          <label><span>自动压缩阈值（tokens）</span><input type="number" min={1} value={modelDraftState.autoCompactTokenLimit} onChange={(event) => setModelDraftState((current) => ({ ...current, autoCompactTokenLimit: event.target.value }))} placeholder="默认 900000" /></label>
          <label><span>优先级（数字，越小越靠前）</span><input type="number" min={0} value={modelDraftState.priority} onChange={(event) => setModelDraftState((current) => ({ ...current, priority: event.target.value }))} /></label>
          <label className="provider-form-check"><input type="checkbox" checked={modelDraftState.visible} onChange={(event) => setModelDraftState((current) => ({ ...current, visible: event.target.checked }))} /><span>在模型菜单中可见</span></label>
        </div>
        <footer>
          <button type="button" className="provider-manager-close" onClick={() => setEditingModel(null)}>取消</button>
          <button type="button" className="primary-button" disabled={saving || !modelDraftState.modelId.trim()} onClick={() => void saveModel()}>
            {saving ? <><LoaderCircle className="spin" size={15} />保存中…</> : "保存"}
          </button>
        </footer>
      </section>
    </div>, document.body)}
  </div>, document.body);
}
