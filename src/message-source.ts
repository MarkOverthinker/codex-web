import { z } from "zod";
import { ASK_AGENT_SELECTION_MAX_CHARS, normalizeAskAgentSelection } from "./ask-agent-selection.js";

export type MessageSourceLocation = {
  kind: "codex-rollout";
  threadId: string;
  path: string;
  line: number;
  byteOffset: number;
  recordType: "response_item" | "event_msg";
  jsonPointer: string;
  itemId: string | null;
  textStart: number;
  textEnd: number;
};

type MessageQuoteReference = {
  kind?: "message";
  sourceConversationId: string;
  sourceMessageId: string;
  sourceConversationTitle: string;
  sourceRole: "user" | "assistant";
  sourceCreatedAt: string;
  excerpt: string;
  sourceLocation?: MessageSourceLocation;
};

export type ConversationContextReference = {
  kind: "conversation-context";
  sourceConversationId: string;
  sourceConversationTitle: string;
  excerpt: string;
  messageCount: number;
};

export type MessageSourceReference = MessageQuoteReference | ConversationContextReference;

export const DERIVED_TASK_EXCERPT_MAX_CHARS = ASK_AGENT_SELECTION_MAX_CHARS;
export const CONVERSATION_CONTEXT_MAX_CHARS = 100_000;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sourceLocationSchema = z.object({
  kind: z.literal("codex-rollout"),
  threadId: z.string().regex(uuidPattern),
  path: z.string().min(1).max(500).refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes("..") && value.endsWith(".jsonl")),
  line: z.number().int().positive(),
  byteOffset: z.number().int().nonnegative(),
  recordType: z.enum(["response_item", "event_msg"]),
  jsonPointer: z.string().startsWith("/payload/").max(160),
  itemId: z.string().max(200).nullable(),
  textStart: z.number().int().nonnegative(),
  textEnd: z.number().int().positive(),
}).refine((value) => value.textEnd > value.textStart);

const sourceReferenceSchema = z.object({
  sourceConversationId: z.string().regex(uuidPattern),
  sourceMessageId: z.string().regex(uuidPattern),
  sourceConversationTitle: z.string().min(1).max(80),
  sourceRole: z.enum(["user", "assistant"]),
  sourceCreatedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  excerpt: z.string().min(1).max(DERIVED_TASK_EXCERPT_MAX_CHARS),
  sourceLocation: sourceLocationSchema.optional(),
});

const conversationContextReferenceSchema = z.object({
  kind: z.literal("conversation-context"),
  sourceConversationId: z.string().regex(uuidPattern),
  sourceConversationTitle: z.string().min(1).max(80),
  excerpt: z.string().min(1).max(CONVERSATION_CONTEXT_MAX_CHARS),
  messageCount: z.number().int().positive(),
});

export function normalizeSourceExcerpt(value: unknown): string {
  if (typeof value !== "string") return "";
  return normalizeAskAgentSelection(value).slice(0, DERIVED_TASK_EXCERPT_MAX_CHARS);
}

export function normalizeConversationContext(value: unknown): string {
  if (typeof value !== "string") return "";
  return normalizeAskAgentSelection(value).slice(0, CONVERSATION_CONTEXT_MAX_CHARS);
}

export function normalizeMessageSourceReference(value: unknown): MessageSourceReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = typeof record.sourceConversationTitle === "string"
    ? record.sourceConversationTitle.trim().replace(/\s+/g, " ").slice(0, 80) || "未命名任务"
    : "";
  if (record.kind === "conversation-context") {
    const contextCandidate = {
      kind: "conversation-context" as const,
      sourceConversationId: typeof record.sourceConversationId === "string" ? record.sourceConversationId : "",
      sourceConversationTitle: title,
      excerpt: normalizeConversationContext(record.excerpt),
      messageCount: typeof record.messageCount === "number" ? record.messageCount : Number.NaN,
    };
    const parsedContext = conversationContextReferenceSchema.safeParse(contextCandidate);
    return parsedContext.success ? parsedContext.data : null;
  }
  const candidate = {
    sourceConversationId: typeof record.sourceConversationId === "string" ? record.sourceConversationId : "",
    sourceMessageId: typeof record.sourceMessageId === "string" ? record.sourceMessageId : "",
    sourceConversationTitle: title,
    sourceRole: record.sourceRole === "assistant" ? "assistant" : "user",
    sourceCreatedAt: typeof record.sourceCreatedAt === "string" ? record.sourceCreatedAt : "",
    excerpt: normalizeSourceExcerpt(record.excerpt),
    ...(record.sourceLocation === undefined ? {} : { sourceLocation: record.sourceLocation }),
  };
  const parsed = sourceReferenceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function formatSourceLocation(location: MessageSourceLocation): string {
  const item = location.itemId ? ` · item ${location.itemId}` : "";
  return `${location.path}:${location.line} · byte ${location.byteOffset} · ${location.jsonPointer} · chars ${location.textStart}-${location.textEnd}${item}`;
}

export function buildConversationContextExcerpt(messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>): string {
  const context = messages.map((message) => `${message.role === "user" ? "用户" : "Codex"}：\n${message.content}`).join("\n\n---\n\n");
  const normalized = normalizeConversationContext(context);
  return context.length > CONVERSATION_CONTEXT_MAX_CHARS
    ? `${normalized.slice(0, CONVERSATION_CONTEXT_MAX_CHARS - 30).trimEnd()}\n\n…（上下文过长，已截断）`
    : normalized;
}

export function buildDerivedTaskPrompt(instruction: string, source: string | MessageSourceReference): string {
  const reference = typeof source === "string" ? null : normalizeMessageSourceReference(source);
  const task = instruction.trim() || "请根据该引用继续处理。";
  if (reference?.kind === "conversation-context") {
    return [
      "请基于以下主对话上下文执行我的任务：",
      "",
      reference.excerpt,
      "",
      `（以上包含主对话中的 ${reference.messageCount} 条消息。）`,
      "",
      "我的指令：",
      task,
    ].join("\n");
  }
  const raw = normalizeAskAgentSelection(typeof source === "string" ? source : reference?.excerpt ?? source.excerpt);
  const truncated = raw.length > DERIVED_TASK_EXCERPT_MAX_CHARS;
  const normalized = raw.slice(0, DERIVED_TASK_EXCERPT_MAX_CHARS);
  const quote = normalized.split("\n").map((line) => `> ${line}`).join("\n");
  return [
    "请基于以下引用执行我的任务：",
    "",
    quote,
    ...(truncated ? ["> …（引用内容过长，已截断）"] : []),
    ...(reference?.sourceLocation ? [
      "",
      "引用定位（Codex rollout JSONL）：",
      `- thread: ${reference.sourceLocation.threadId}`,
      `- record: ${formatSourceLocation(reference.sourceLocation)}`,
    ] : []),
    "",
    "我的指令：",
    task,
  ].join("\n");
}
