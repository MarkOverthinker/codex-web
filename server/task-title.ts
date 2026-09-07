export const TASK_TITLE_MAX_LENGTH = 10;

const TASK_TITLE_INPUT_MAX_LENGTH = 4_000;

export function buildTaskTitlePrompt(content: string, attachmentNames: string[] = []): string {
  const task = content.trim().slice(0, TASK_TITLE_INPUT_MAX_LENGTH) || "请处理本轮附件。";
  const attachments = attachmentNames
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 12);
  return [
    "请根据下面的用户任务生成一个简短任务标题。",
    `只输出标题文本，不要输出 Markdown、引号或解释；标题最多 ${TASK_TITLE_MAX_LENGTH} 个字符。`,
    "",
    "<user_task>",
    task,
    "</user_task>",
    ...(attachments.length > 0 ? ["", "附件名称：", ...attachments.map((name) => `- ${name}`)] : []),
  ].join("\n");
}

export function normalizeTaskTitle(raw: string, fallback: string): string {
  const firstLine = raw
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  const clean = firstLine
    .replace(/^(?:标题|任务标题)\s*[:：]\s*/u, "")
    .replace(/^[`'"“”‘’《》【】\[\]()（）]+|[`'"“”‘’《》【】\[\]()（）。！？!?，,；;：:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const fallbackTitle = fallback
    .replace(/\s+/g, " ")
    .replace(/^(?:请|麻烦|能否|可以)?(?:帮我|给我)?(?:一下)?/u, "")
    .trim() || "任务处理";
  const candidate = clean && clean !== "新任务" ? clean : fallbackTitle;
  return Array.from(candidate).slice(0, TASK_TITLE_MAX_LENGTH).join("");
}
