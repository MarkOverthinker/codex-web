import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { ArrowUp, Bot, Copy, CornerUpLeft, GitFork, LoaderCircle, Plus, Quote, Square, X } from "lucide-react";
import {
  api,
  type AgentModelOption,
  type AgentOptions,
  type AgentSelection,
  type Conversation,
  type ConversationDetail,
  type Message,
  type MessageSourceReference,
  type ReasoningEffort,
  type SideChatSummary,
} from "./api";
import { sanitizeAgentMarkdown } from "./agent-content";
import { formatSourceLocation } from "./message-source";
import { copyText } from "./copy-path";

export type SideChatReferenceRequest = {
  id: number;
  sourceConversation: Conversation;
  sourceMessageId: string;
  excerpt: string;
};

export type SideChatForkRequest = {
  id: number;
  sourceConversation: Conversation;
  sourceMessageId: string;
};

type SideChatPaneProps = {
  currentConversation: Conversation;
  agentOptions: AgentOptions | null;
  referenceRequest: SideChatReferenceRequest | null;
  forkRequest: SideChatForkRequest | null;
  onForkHandled: (requestId: number) => void;
  onReferenceHandled: (requestId: number) => void;
  onClose: () => void;
  onError: (message: string) => void;
  onOpenSourceReference: (reference: MessageSourceReference) => void;
  width: number;
  widthMin: number;
  widthMax: number;
  onResizeStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
};

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function modelLabel(model: AgentModelOption): string {
  return model.providerName ? `${model.providerName} · ${model.label}` : model.label;
}

function sourceLocationText(reference: Extract<MessageSourceReference, { sourceMessageId: string }>): string {
  return reference.sourceLocation
    ? `thread ${reference.sourceLocation.threadId} · ${formatSourceLocation(reference.sourceLocation)}`
    : "JSONL 位置不可用";
}

function SourceReferenceCard({ reference, onOpen, onClear }: {
  reference: MessageSourceReference;
  onOpen?: () => void;
  onClear?: () => void;
}) {
  const isContext = reference.kind === "conversation-context";
  const location = isContext ? `${reference.sourceConversationTitle} · ${reference.messageCount} 条消息` : sourceLocationText(reference);
  return <div className={`side-chat-reference${isContext ? " context" : ""}`}>
    <div className="side-chat-reference-heading"><CornerUpLeft size={14} /><strong>{isContext ? "主对话上下文" : "主对话引用"}</strong></div>
    <blockquote>{reference.excerpt}</blockquote>
    <div className="side-chat-reference-location">
      {onOpen ? <button type="button" onClick={onOpen} title="跳转到主对话原消息">{reference.sourceConversationTitle}</button> : <span>{reference.sourceConversationTitle}</span>}
      <code title={location}>{location}</code>
      {!isContext && <button type="button" className="icon-button" onClick={() => void copyText(location)} aria-label="复制 JSONL 定位" title="复制 JSONL 定位"><Copy size={13} /></button>}
      {onClear && <button type="button" className="icon-button" onClick={onClear} aria-label="移除引用" title="移除引用"><X size={13} /></button>}
    </div>
  </div>;
}

function SideMessage({ message, citationFiles, onOpenSourceReference }: { message: Message; citationFiles: Message["files"]; onOpenSourceReference: (reference: MessageSourceReference) => void }) {
  return <article className={`side-chat-message ${message.role}`}>
    <header><span>{message.role === "assistant" ? "Codex" : "你"}</span><time dateTime={message.created_at}>{DATE_FORMATTER.format(new Date(message.created_at))}</time></header>
    {message.source_reference && <SourceReferenceCard reference={message.source_reference} onOpen={message.source_reference.kind === "conversation-context" ? undefined : () => onOpenSourceReference(message.source_reference!)} />}
    {message.role === "assistant"
      ? <div className="side-chat-markdown"><ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[[rehypeKatex, { throwOnError: false }], rehypeHighlight]}
          urlTransform={defaultUrlTransform}
        >{sanitizeAgentMarkdown(message.content, citationFiles)}</ReactMarkdown></div>
      : message.content && <p>{message.content}</p>}
  </article>;
}

export function SideChatPane({ currentConversation, agentOptions, referenceRequest, forkRequest, onReferenceHandled, onForkHandled, onClose, onError, onOpenSourceReference, width, widthMin, widthMax, onResizeStart, onResizeKeyDown }: SideChatPaneProps) {
  const [history, setHistory] = useState<SideChatSummary[]>([]);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [input, setInput] = useState("");
  const [reference, setReference] = useState<MessageSourceReference | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [contextSaving, setContextSaving] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef(input);
  const detailRef = useRef(detail);
  const historyRef = useRef(history);
  const initialParentIdRef = useRef(currentConversation.id);
  inputRef.current = input;
  detailRef.current = detail;
  historyRef.current = history;

  async function refresh(conversationId: string, hydrateDraft = false) {
    const next = await api.conversation(conversationId);
    setDetail(next);
    detailRef.current = next;
    if (hydrateDraft) {
      setInput(next.composerDraft?.content ?? "");
      setReference(next.composerDraft?.source_reference ?? null);
    }
    return next;
  }

  async function refreshHistory() {
    const result = await api.sideChats();
    setHistory(result.sideChats);
    historyRef.current = result.sideChats;
    return result.sideChats;
  }

  async function persistCurrentDraft() {
    const current = detailRef.current;
    if (!current) return;
    await api.saveConversationDraft(current.conversation.id, inputRef.current, reference?.excerpt ?? "", reference, true).catch(() => undefined);
  }

  async function openSideConversation(conversationId: string) {
    if (detailRef.current?.conversation.id === conversationId) return detailRef.current;
    setLoading(true);
    try {
      await persistCurrentDraft();
      await api.openSideChat(conversationId);
      const next = await refresh(conversationId, true);
      await refreshHistory();
      return next;
    } finally {
      setLoading(false);
    }
  }

  async function createSideConversation(parent: Conversation, hydrateDraft = true) {
    if (parent.archived_at) throw new Error("已归档任务不能新建侧边对话。");
    setLoading(true);
    try {
      await persistCurrentDraft();
      const result = await api.createNewSideChat(parent.id);
      const next = await refresh(result.conversation.id, hydrateDraft);
      await refreshHistory();
      return next;
    } finally {
      setLoading(false);
    }
  }

  async function forkSideConversation(source: Conversation, sourceMessageId: string) {
    if (source.archived_at) throw new Error("已归档任务不能 Fork 到侧边聊天。");
    setLoading(true);
    try {
      await persistCurrentDraft();
      const result = await api.forkSideChat(source.id, sourceMessageId);
      const next = await refresh(result.conversation.id, true);
      await refreshHistory();
      window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".side-chat-composer textarea")?.focus(), 0);
      return next;
    } finally {
      setLoading(false);
    }
  }

  async function ensureActiveSideConversation(source: Conversation) {
    if (detailRef.current) return detailRef.current;
    const preferred = historyRef.current.find((item) => item.parentConversationId === source.id);
    return preferred ? openSideConversation(preferred.conversation.id) : createSideConversation(source, false);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api.sideChats()
      .then(async (result) => {
        if (cancelled) return;
        setHistory(result.sideChats);
        historyRef.current = result.sideChats;
        const preferred = result.sideChats.find((item) => item.parentConversationId === initialParentIdRef.current);
        if (preferred) {
          await api.openSideChat(preferred.conversation.id);
          if (!cancelled) await refresh(preferred.conversation.id, true);
        }
      })
      .catch((reason) => { if (!cancelled) onError(reason instanceof Error ? reason.message : "侧边聊天加载失败"); })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setInitialized(true);
        }
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!initialized || !referenceRequest) return;
    let cancelled = false;
    setLoading(true);
    void ensureActiveSideConversation(referenceRequest.sourceConversation)
      .then((target) => api.setSelectedSideChatReference(target.conversation.id, referenceRequest.sourceConversation.id, referenceRequest.sourceMessageId, referenceRequest.excerpt, inputRef.current))
      .then(async (result) => {
        if (cancelled) return;
        setReference(result.reference);
        await refresh(result.conversation.id, false);
        await refreshHistory();
        window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".side-chat-composer textarea")?.focus(), 0);
      })
      .catch((reason) => { if (!cancelled) onError(reason instanceof Error ? reason.message : "引用到侧边聊天失败"); })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          onReferenceHandled(referenceRequest.id);
        }
      });
    return () => { cancelled = true; };
  }, [initialized, referenceRequest?.id]);

  useEffect(() => {
    if (!initialized || !forkRequest) return;
    let cancelled = false;
    void forkSideConversation(forkRequest.sourceConversation, forkRequest.sourceMessageId)
      .catch((reason) => { if (!cancelled) onError(reason instanceof Error ? reason.message : "Fork 到侧边聊天失败"); })
      .finally(() => {
        if (!cancelled) onForkHandled(forkRequest.id);
      });
    return () => { cancelled = true; };
  }, [initialized, forkRequest?.id]);


  useEffect(() => {
    const conversationId = detail?.conversation.id;
    if (!conversationId) return;
    const timer = window.setTimeout(() => {
      void api.saveConversationDraft(conversationId, input, reference?.excerpt ?? "", reference, true).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [detail?.conversation.id, input, reference]);

  useEffect(() => {
    const conversationId = detail?.conversation.id;
    if (!conversationId) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api.conversation(conversationId).then((next) => {
        if (!cancelled) {
          setDetail(next);
          detailRef.current = next;
        }
      }).catch(() => undefined);
    }, detail.activeJob || detail.pendingPrompts.length > 0 ? 1_200 : 4_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [detail?.conversation.id, detail?.activeJob?.id, detail?.pendingPrompts.length]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detail?.messages.length, detail?.activeJob?.id]);

  const selectedModel = detail?.agentSelection.model ?? "";
  const selectedModelOption = agentOptions?.models.find((model) => model.id === selectedModel);
  const effortOptions = useMemo(() => {
    const allowed = selectedModelOption?.reasoningEfforts ?? [];
    return (agentOptions?.reasoningEfforts ?? []).filter((option) => allowed.includes(option.id));
  }, [agentOptions, selectedModelOption]);
  const modelGroups = useMemo(() => {
    const models = agentOptions?.models ?? [];
    const providers = agentOptions?.providers ?? [];
    const groups = providers.map((provider) => ({
      ...provider,
      models: models.filter((model) => model.provider === provider.id),
    })).filter((group) => group.models.length > 0);
    const unassigned = models.filter((model) => !model.provider || !providers.some((provider) => provider.id === model.provider));
    if (unassigned.length > 0) groups.push({ id: "__unassigned__", name: "其他模型", models: unassigned });
    return groups;
  }, [agentOptions]);

  async function saveSelection(selection: AgentSelection) {
    if (!detail || selectionSaving) return;
    const previous = detail.agentSelection;
    setDetail({ ...detail, agentSelection: selection });
    setSelectionSaving(true);
    try {
      const result = await api.updateAgentSelection(selection, detail.conversation.id);
      setDetail((current) => current ? { ...current, agentSelection: result.selection } : current);
    } catch (reason) {
      setDetail((current) => current ? { ...current, agentSelection: previous } : current);
      onError(reason instanceof Error ? reason.message : "侧边聊天模型保存失败");
    } finally {
      setSelectionSaving(false);
    }
  }

  async function citeConversationContext() {
    if (contextSaving || currentConversation.archived_at) return;
    setContextSaving(true);
    try {
      const target = await ensureActiveSideConversation(currentConversation);
      const result = await api.setSelectedSideChatContext(target.conversation.id, currentConversation.id);
      setReference(result.reference);
      await refresh(result.conversation.id, false);
      await refreshHistory();
      window.setTimeout(() => document.querySelector<HTMLTextAreaElement>(".side-chat-composer textarea")?.focus(), 0);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "主对话上下文引用失败");
    } finally {
      setContextSaving(false);
    }
  }

  function changeModel(modelId: string) {
    if (!detail || !agentOptions) return;
    const model = agentOptions.models.find((candidate) => candidate.id === modelId);
    if (!model) return;
    const effort = model.reasoningEfforts.includes(detail.agentSelection.reasoningEffort)
      ? detail.agentSelection.reasoningEffort
      : model.reasoningEfforts.includes(agentOptions.defaults.reasoningEffort)
        ? agentOptions.defaults.reasoningEffort
        : model.reasoningEfforts.at(-1) ?? agentOptions.defaults.reasoningEffort;
    void saveSelection({ model: model.id, reasoningEffort: effort, sandbox: detail.agentSelection.sandbox, ...(model.provider ? { provider: model.provider } : {}) });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting || (!input.trim() && !reference)) return;
    setSubmitting(true);
    try {
      const target = await ensureActiveSideConversation(currentConversation);
      await api.saveConversationDraft(target.conversation.id, input, reference?.excerpt ?? "", reference);
      await api.sendMessage(target.conversation.id, input, [], reference?.excerpt ?? "", true);
      setInput(""); setReference(null);
      await refresh(target.conversation.id, false);
      await refreshHistory();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "侧边消息发送失败");
    } finally {
      setSubmitting(false);
    }
  }

  const busy = Boolean(detail?.activeJob || detail?.pendingPrompts.length);
  const citationFiles = detail ? [...detail.outputFiles, ...detail.messages.flatMap((message) => message.files)] : [];
  const activeSummary = history.find((item) => item.conversation.id === detail?.conversation.id);
  const canCreateForCurrent = !currentConversation.archived_at;

  return <aside className="side-chat-pane" style={{ width }} aria-label="侧边聊天">
    <div
      className="side-chat-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整侧边聊天宽度"
      aria-valuemin={widthMin}
      aria-valuemax={widthMax}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={onResizeStart}
      onKeyDown={onResizeKeyDown}
    />
    <header className="side-chat-header">
      <div><span>SECONDARY THREAD</span><strong><Bot size={16} />侧边聊天</strong><small>{activeSummary ? `来源任务：${activeSummary.parentConversationTitle}` : `当前任务：${currentConversation.title}`}</small></div>
      <button type="button" className="icon-button" onClick={onClose} aria-label="关闭侧边聊天"><X size={18} /></button>
    </header>
    <div className="side-chat-thread-picker">
      <label><span>历史侧边对话</span><select value={detail?.conversation.id ?? ""} disabled={loading} onChange={(event) => {
        if (!event.target.value) return;
        void openSideConversation(event.target.value).catch((reason) => onError(reason instanceof Error ? reason.message : "侧边对话加载失败"));
      }}>
        <option value="">当前任务尚无侧边对话</option>
        {history.map((item) => <option key={item.conversation.id} value={item.conversation.id}>{item.parentConversationTitle} · {DATE_FORMATTER.format(new Date(item.lastOpenedAt))}</option>)}
      </select></label>
      <button type="button" onClick={() => void createSideConversation(currentConversation).catch((reason) => onError(reason instanceof Error ? reason.message : "新建侧边聊天失败"))} disabled={!canCreateForCurrent || loading} title="为当前任务新建侧边对话"><Plus size={14} />新建</button>
    </div>
    <div className="side-chat-settings">
      <label><span>模型</span><select value={selectedModel} disabled={!detail || selectionSaving || !agentOptions} onChange={(event) => changeModel(event.target.value)}>
        {modelGroups.map((provider) => <optgroup key={provider.id} label={provider.name}>
          {provider.models.map((model) => <option key={`${model.provider ?? "default"}:${model.id}`} value={model.id}>{modelLabel(model)}</option>)}
        </optgroup>)}
      </select></label>
      <label><span>思考</span><select value={detail?.agentSelection.reasoningEffort ?? ""} disabled={!detail || selectionSaving || effortOptions.length === 0} onChange={(event) => {
        if (!detail) return;
        void saveSelection({ ...detail.agentSelection, reasoningEffort: event.target.value as ReasoningEffort });
      }}>
        {effortOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select></label>
    </div>
    {detail?.conversation.fork_source_message_id && <div className="side-chat-fork-banner"><GitFork size={13} /><span>已从主对话指定位置 Fork；首次发送时创建独立线程。</span></div>}
    <div ref={messagesRef} className="side-chat-messages">
      {loading && !detail ? <div className="side-chat-empty"><LoaderCircle className="spin" size={20} /><span>正在加载侧边对话…</span></div>
        : detail?.messages.length
          ? detail.messages.map((message) => <SideMessage key={message.id} message={message} citationFiles={citationFiles} onOpenSourceReference={onOpenSourceReference} />)
          : <div className="side-chat-empty"><Bot size={24} /><strong>{detail ? "独立上下文，随时追问" : "当前任务还没有侧边对话"}</strong><span>{detail ? "可继续当前历史，或从上方切换、新建其他侧边对话。" : "直接输入、引用当前主对话，或点击“新建”开始。"}</span></div>}
      {busy && <div className="side-chat-running"><LoaderCircle className="spin" size={14} /><span>{detail?.activeJob?.status === "running" ? "正在处理" : "等待执行"}</span></div>}
    </div>
    <form className="side-chat-composer" onSubmit={submit}>
      <div className="side-chat-context-actions">
        <button type="button" onClick={() => void citeConversationContext()} disabled={!canCreateForCurrent || contextSaving || submitting} title="引用当前主对话中的全部用户和 Codex 消息"><Quote size={13} />{contextSaving ? "正在整理主对话…" : "引用当前主对话上下文"}</button>
      </div>
      {reference && <SourceReferenceCard reference={reference} onOpen={reference.kind === "conversation-context" ? undefined : () => onOpenSourceReference(reference)} onClear={() => setReference(null)} />}
      <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={reference ? "基于这段引用继续提问…" : "在侧边线程中提问…"} rows={3} disabled={submitting || (!detail && !canCreateForCurrent)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
      }} />
      <div className="side-chat-composer-footer">
        <span>{busy ? `${detail?.pendingPrompts.length ?? 0} 条等待中` : detail ? "独立线程，不随主任务切换" : "发送时自动创建侧边对话"}</span>
        {detail?.activeJob
          ? <button type="button" className="side-chat-send stop" onClick={() => void api.cancelConversation(detail.conversation.id).then(() => refresh(detail.conversation.id, false))} title="停止"><Square size={14} /></button>
          : <button type="submit" className="side-chat-send" disabled={submitting || (!detail && !canCreateForCurrent) || (!input.trim() && !reference)} title="发送">{submitting ? <LoaderCircle className="spin" size={15} /> : <ArrowUp size={16} />}</button>}
      </div>
    </form>
  </aside>;
}
