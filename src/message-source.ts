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

export type MessageSourceReference = {
  sourceConversationId: string;
  sourceMessageId: string;
  sourceConversationTitle: string;
  sourceRole: "user" | "assistant";
  sourceCreatedAt: string;
  excerpt: string;
  sourceLocation?: MessageSourceLocation;
};

export const DERIVED_TASK_EXCERPT_MAX_CHARS = ASK_AGENT_SELECTION_MAX_CHARS;

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

export function normalizeSourceExcerpt(value: unknown): string {
  if (typeof value !== "string") return "";
  return normalizeAskAgentSelection(value).slice(0, DERIVED_TASK_EXCERPT_MAX_CHARS);
}

export function normalizeMessageSourceReference(value: unknown): MessageSourceReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = typeof record.sourceConversationTitle === "string"
    ? record.sourceConversationTitle.trim().replace(/\s+/g, " ").slice(0, 80) || "未命名任务"
    : "";
  const role = record.sourceRole === "assistant" ? "assistant" : "user";
  const candidate = {
    sourceConversationId: typeof record.sourceConversationId === "string" ? record.sourceConversationId : "",
    sourceMessageId: typeof record.sourceMessageId === "string" ? record.sourceMessageId : "",
    sourceConversationTitle: title,
    sourceRole: role,
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

export function buildDerivedTaskPrompt(instruction: string, source: string | MessageSourceReference): string {
  const reference = typeof source === "string" ? null : normalizeMessageSourceReference(source);
  const raw = normalizeAskAgentSelection(typeof source === "string" ? source : reference?.excerpt ?? source.excerpt);
  const truncated = raw.length > DERIVED_TASK_EXCERPT_MAX_CHARS;
  const normalized = raw.slice(0, DERIVED_TASK_EXCERPT_MAX_CHARS);
  const quote = normalized.split("\n").map((line) => `> ${line}`).join("\n");
  const task = instruction.trim() || "请根据该引用继续处理。";
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
