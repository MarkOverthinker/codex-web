import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { ArrowUp, Bot, Copy, CornerUpLeft, LoaderCircle, Square, X } from "lucide-react";
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
} from "./api";
import { sanitizeAgentMarkdown } from "./agent-content";
import { formatSourceLocation } from "./message-source";
import { copyText } from "./copy-path";

export type SideChatReferenceRequest = {
  id: number;
  sourceMessageId: string;
  excerpt: string;
};

type SideChatPaneProps = {
  parentConversation: Conversation;
  agentOptions: AgentOptions | null;
  referenceRequest: SideChatReferenceRequest | null;
  onReferenceHandled: (requestId: number) => void;
  onClose: () => void;
  onError: (message: string) => void;
  onOpenSourceReference: (reference: MessageSourceReference) => void;
};

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function modelLabel(model: AgentModelOption): string {
  return model.providerName ? `${model.providerName} · ${model.label}` : model.label;
}

function sourceLocationText(reference: MessageSourceReference): string {
  return reference.sourceLocation
    ? `thread ${reference.sourceLocation.threadId} · ${formatSourceLocation(reference.sourceLocation)}`
    : "JSONL 位置不可用";
}

function SourceReferenceCard({ reference, onOpen, onClear }: {
  reference: MessageSourceReference;
  onOpen: () => void;
  onClear?: () => void;
}) {
  const location = sourceLocationText(reference);
  return <div className="side-chat-reference">
    <div className="side-chat-reference-heading"><CornerUpLeft size={14} /><strong>主对话引用</strong></div>
    <blockquote>{reference.excerpt}</blockquote>
    <div className="side-chat-reference-location">
      <button type="button" onClick={onOpen} title="跳转到主对话原消息">{reference.sourceConversationTitle}</button>
      <code title={location}>{location}</code>
      <button type="button" className="icon-button" onClick={() => void copyText(location)} aria-label="复制 JSONL 定位" title="复制 JSONL 定位"><Copy size={13} /></button>
      {onClear && <button type="button" className="icon-button" onClick={onClear} aria-label="移除引用" title="移除引用"><X size={13} /></button>}
    </div>
  </div>;
}

function SideMessage({ message, citationFiles, onOpenSourceReference }: { message: Message; citationFiles: Message["files"]; onOpenSourceReference: (reference: MessageSourceReference) => void }) {
  return <article className={`side-chat-message ${message.role}`}>
    <header><span>{message.role === "assistant" ? "Codex" : "你"}</span><time dateTime={message.created_at}>{DATE_FORMATTER.format(new Date(message.created_at))}</time></header>
    {message.source_reference && <SourceReferenceCard reference={message.source_reference} onOpen={() => onOpenSourceReference(message.source_reference!)} />}
    {message.role === "assistant"
      ? <div className="side-chat-markdown"><ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[[rehypeKatex, { throwOnError: false }], rehypeHighlight]}
          urlTransform={defaultUrlTransform}
        >{sanitizeAgentMarkdown(message.content, citationFiles)}</ReactMarkdown></div>
      : message.content && <p>{message.content}</p>}
  </article>;
}

export function SideChatPane({ parentConversation, agentOptions, referenceRequest, onReferenceHandled, onClose, onError, onOpenSourceReference }: SideChatPaneProps) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [input, setInput] = useState("");
  const [reference, setReference] = useState<MessageSourceReference | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [selectionSaving, setSelectionSaving] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef(input);
  const hydratedConversationRef = useRef<string | null>(null);
  inputRef.current = input;

  async function refresh(conversationId: string, hydrateDraft = false) {
    const next = await api.conversation(conversationId);
    setDetail(next);
    if (hydrateDraft || hydratedConversationRef.current !== conversationId) {
      hydratedConversationRef.current = conversationId;
      setInput(next.composerDraft?.content ?? "");
      setReference(next.composerDraft?.source_reference ?? null);
    }
    return next;
  }

  useEffect(() => {
    if (referenceRequest || hydratedConversationRef.current) return;
    let cancelled = false;
    setDetail(null); setInput(""); setReference(null); setLoading(true);
    void api.createSideChat(parentConversation.id)
      .then((result) => refresh(result.conversation.id, true))
      .catch((reason) => { if (!cancelled) onError(reason instanceof Error ? reason.message : "侧边聊天加载失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [parentConversation.id, referenceRequest?.id]);

  useEffect(() => {
    if (!referenceRequest) return;
    let cancelled = false;
    setLoading(true);
    void api.setSideChatReference(parentConversation.id, referenceRequest.sourceMessageId, referenceRequest.excerpt, inputRef.current)
      .then(async (result) => {
        if (cancelled) return;
        setReference(result.reference);
        await refresh(result.conversation.id, false);
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
  }, [parentConversation.id, referenceRequest?.id]);

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
        if (!cancelled) setDetail(next);
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
    if (!detail || submitting || (!input.trim() && !reference)) return;
    setSubmitting(true);
    try {
      await api.saveConversationDraft(detail.conversation.id, input, reference?.excerpt ?? "", reference);
      await api.sendMessage(detail.conversation.id, input, [], reference?.excerpt ?? "", true);
      setInput(""); setReference(null);
      await refresh(detail.conversation.id, false);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "侧边消息发送失败");
    } finally {
      setSubmitting(false);
    }
  }

  const busy = Boolean(detail?.activeJob || detail?.pendingPrompts.length);
  const citationFiles = detail ? [...detail.outputFiles, ...detail.messages.flatMap((message) => message.files)] : [];

  return <aside className="side-chat-pane" aria-label="侧边聊天">
    <header className="side-chat-header">
      <div><span>SECONDARY THREAD</span><strong><Bot size={16} />侧边聊天</strong></div>
      <button type="button" className="icon-button" onClick={onClose} aria-label="关闭侧边聊天"><X size={18} /></button>
    </header>
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
    <div ref={messagesRef} className="side-chat-messages">
      {loading && !detail ? <div className="side-chat-empty"><LoaderCircle className="spin" size={20} /><span>正在准备侧边线程…</span></div>
        : detail?.messages.length
          ? detail.messages.map((message) => <SideMessage key={message.id} message={message} citationFiles={citationFiles} onOpenSourceReference={onOpenSourceReference} />)
          : <div className="side-chat-empty"><Bot size={24} /><strong>独立上下文，随时追问</strong><span>选中主对话内容后点“侧边提问”，或直接输入问题。</span></div>}
      {busy && <div className="side-chat-running"><LoaderCircle className="spin" size={14} /><span>{detail?.activeJob?.status === "running" ? "正在处理" : "等待执行"}</span></div>}
    </div>
    <form className="side-chat-composer" onSubmit={submit}>
      {reference && <SourceReferenceCard reference={reference} onOpen={() => onOpenSourceReference(reference)} onClear={() => setReference(null)} />}
      <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={reference ? "基于这段引用继续提问…" : "在侧边线程中提问…"} rows={3} disabled={!detail || submitting} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
      }} />
      <div className="side-chat-composer-footer">
        <span>{busy ? `${detail?.pendingPrompts.length ?? 0} 条等待中` : "独立线程，不改变主对话"}</span>
        {detail?.activeJob
          ? <button type="button" className="side-chat-send stop" onClick={() => void api.cancelConversation(detail.conversation.id).then(() => refresh(detail.conversation.id, false))} title="停止"><Square size={14} /></button>
          : <button type="submit" className="side-chat-send" disabled={!detail || submitting || (!input.trim() && !reference)} title="发送">{submitting ? <LoaderCircle className="spin" size={15} /> : <ArrowUp size={16} />}</button>}
      </div>
    </form>
  </aside>;
}
