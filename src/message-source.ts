import { z } from "zod";
import { ASK_AGENT_SELECTION_MAX_CHARS, normalizeAskAgentSelection } from "./ask-agent-selection.js";

export type MessageSourceReference = {
  sourceConversationId: string;
  sourceMessageId: string;
  sourceConversationTitle: string;
  sourceRole: "user" | "assistant";
  sourceCreatedAt: string;
  excerpt: string;
};

export const DERIVED_TASK_EXCERPT_MAX_CHARS = ASK_AGENT_SELECTION_MAX_CHARS;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sourceReferenceSchema = z.object({
  sourceConversationId: z.string().regex(uuidPattern),
  sourceMessageId: z.string().regex(uuidPattern),
  sourceConversationTitle: z.string().min(1).max(80),
  sourceRole: z.enum(["user", "assistant"]),
  sourceCreatedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  excerpt: z.string().min(1).max(DERIVED_TASK_EXCERPT_MAX_CHARS),
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
  };
  const parsed = sourceReferenceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function buildDerivedTaskPrompt(instruction: string, excerpt: string): string {
  const raw = normalizeAskAgentSelection(excerpt);
  const truncated = raw.length > DERIVED_TASK_EXCERPT_MAX_CHARS;
  const normalized = raw.slice(0, DERIVED_TASK_EXCERPT_MAX_CHARS);
  const quote = normalized.split("\n").map((line) => `> ${line}`).join("\n");
  const task = instruction.trim() || "请根据该引用继续处理。";
  return [
    "请基于以下引用执行我的任务：",
    "",
    quote,
    ...(truncated ? ["> …（引用内容过长，已截断）"] : []),
    "",
    "我的指令：",
    task,
  ].join("\n");
}
