import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Pencil, Plus, Settings2, Trash2, X } from "lucide-react";
import { api, type PresetPrompt } from "./api.js";

const NAME_MAX = 50;
const CONTENT_MAX = 10_000;
const DEFAULT_ENABLED_MAX = 20;

export function PresetPromptManagerDialog({ open, onClose, onChanged }: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [presetPrompts, setPresetPrompts] = useState<PresetPrompt[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<PresetPrompt | "new" | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [defaultEnabled, setDefaultEnabled] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEditing(null); setError(""); setNotice(""); setLoading(true);
    void api.presetPrompts().then(({ presetPrompts: value }) => {
      setPresetPrompts(value);
    }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : "加载预设 Prompt 失败");
    }).finally(() => setLoading(false));
  }, [open]);

  async function refresh() {
    const value = await api.presetPrompts();
    setPresetPrompts(value.presetPrompts);
    return value.presetPrompts;
  }

  function beginCreate() {
    setEditing("new"); setName(""); setContent(""); setDefaultEnabled(false); setError(""); setNotice("");
  }

  function beginEdit(preset: PresetPrompt) {
    setEditing(preset); setName(preset.name); setContent(preset.content); setDefaultEnabled(preset.defaultEnabled); setError(""); setNotice("");
  }

  async function save() {
    if (!editing || saving) return;
    const trimmedName = name.trim();
    const trimmedContent = content.trim();
    if (!trimmedName) { setError("请输入预设名称。"); return; }
    if (trimmedName.length > NAME_MAX) { setError(`预设名称不能超过 ${NAME_MAX} 个字符。`); return; }
    if (!trimmedContent) { setError("请输入预设内容。"); return; }
    if (trimmedContent.length > CONTENT_MAX) { setError(`预设内容不能超过 ${CONTENT_MAX} 个字符。`); return; }
    setSaving(true); setError(""); setNotice("");
    try {
      if (editing === "new") {
        await api.createPresetPrompt(trimmedName, trimmedContent, defaultEnabled);
        setNotice("预设已添加。");
      } else {
        await api.updatePresetPrompt(editing.id, { name: trimmedName, content: trimmedContent, defaultEnabled });
        setNotice("预设已更新。");
      }
      await refresh();
      setEditing(null);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存预设失败");
    } finally {
      setSaving(false);
    }
  }

  async function toggleDefault(preset: PresetPrompt, enabled: boolean) {
    if (saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      await api.updatePresetPrompt(preset.id, { defaultEnabled: enabled });
      await refresh();
      setNotice(enabled ? `已设置“${preset.name}”默认打开。` : `已设置“${preset.name}”默认关闭。`);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存默认启用状态失败");
    } finally {
      setSaving(false);
    }
  }

  async function remove(preset: PresetPrompt) {
    if (!window.confirm(`确定删除预设“${preset.name}”？删除后所有对话都会停止使用它。`)) return;
    setSaving(true); setError(""); setNotice("");
    try {
      await api.deletePresetPrompt(preset.id);
      await refresh();
      setNotice(`已删除预设 ${preset.name}。`);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除预设失败");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;
  const items = presetPrompts ?? [];
  const defaultEnabledCount = items.filter((preset) => preset.defaultEnabled).length;
  const defaultLimitReached = (enabled: boolean) => !enabled && defaultEnabledCount >= DEFAULT_ENABLED_MAX;

  return createPortal(<div className="preset-manager-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="preset-manager" role="dialog" aria-modal="true" aria-label="预设 Prompt 管理">
      <header><div><Settings2 size={19} /><strong>预设 Prompt 管理</strong></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>
      <p className="preset-manager-hint">预设 Prompt 保存在当前账户下；在对话框下方的预设列表中勾选后，会随每次任务自动附加给 Agent。设为“默认打开”的预设会在新建对话时自动勾选，已有对话不受影响。</p>
      <div className="preset-manager-toolbar">
        <button type="button" className="primary-button" onClick={beginCreate} disabled={saving || items.length >= 100}>
          <Plus size={15} />添加预设
        </button>
        {items.length >= 100 && <small className="preset-manager-limit">最多 100 条</small>}
      </div>
      {error && <div className="preset-manager-error" role="alert">{error}</div>}
      {notice && <div className="preset-manager-notice" role="status">{notice}</div>}
      {loading ? <div className="preset-manager-empty"><LoaderCircle className="spin" size={18} /><span>正在加载预设…</span></div>
        : items.length === 0 && !editing
          ? <div className="preset-manager-empty"><Settings2 size={18} /><span>还没有预设 Prompt，点击“添加预设”创建第一条。</span></div>
          : <div className="preset-manager-list">
              {editing && <div className="preset-editor">
                <div className="preset-editor-heading">{editing === "new" ? <><Plus size={14} /><strong>新建预设</strong></> : <><Pencil size={14} /><strong>编辑预设</strong></>}</div>
                <label>名称
                  <input value={name} maxLength={NAME_MAX} autoFocus placeholder="例如：中文回复、严谨步骤" disabled={saving} onChange={(event) => setName(event.target.value)} />
                </label>
                <label>内容
                  <textarea value={content} rows={6} maxLength={CONTENT_MAX} placeholder="输入每次发送任务时都要附带的规则…" disabled={saving} onChange={(event) => setContent(event.target.value)} />
                </label>
                <label className="preset-editor-default">
                  <input type="checkbox" checked={defaultEnabled} disabled={saving || defaultLimitReached(defaultEnabled)} title={defaultLimitReached(defaultEnabled) ? `默认打开的预设最多 ${DEFAULT_ENABLED_MAX} 条` : "新建对话时自动启用这条预设"} onChange={(event) => setDefaultEnabled(event.currentTarget.checked)} />
                  默认打开（新建对话时自动启用）
                </label>
                <div className="preset-editor-actions">
                  <button type="button" className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}保存</button>
                  <button type="button" className="preset-editor-cancel" disabled={saving} onClick={() => { setEditing(null); setError(""); }}>取消</button>
                </div>
              </div>}
              {items.map((preset) => (
                <div className="preset-manager-row" key={preset.id}>
                  <span className="preset-manager-copy">
                    <strong>{preset.name}</strong>
                    <small title={preset.content}>{preset.content.length > 140 ? `${preset.content.slice(0, 140)}…` : preset.content}</small>
                  </span>
                  <label className="preset-manager-default-toggle">
                    <input type="checkbox" checked={preset.defaultEnabled} disabled={saving || defaultLimitReached(preset.defaultEnabled)} title={defaultLimitReached(preset.defaultEnabled) ? `默认打开的预设最多 ${DEFAULT_ENABLED_MAX} 条` : "默认打开（新建对话时自动启用）"} onChange={(event) => void toggleDefault(preset, event.currentTarget.checked)} />
                    默认打开
                  </label>
                  <span className="preset-manager-actions">
                    <button type="button" title="编辑" aria-label={`编辑 ${preset.name}`} disabled={saving} onClick={() => beginEdit(preset)}><Pencil size={14} /></button>
                    <button type="button" className="danger" title="删除" aria-label={`删除 ${preset.name}`} disabled={saving} onClick={() => void remove(preset)}><Trash2 size={14} /></button>
                  </span>
                </div>
              ))}
            </div>}
      <footer className="preset-manager-footer"><small>默认打开数量上限为每个账户 20 条；删除预设会同步从所有对话移除。</small><button type="button" className="preset-manager-close" onClick={onClose}>关闭</button></footer>
    </section>
  </div>, document.body);
}
