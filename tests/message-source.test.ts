import assert from "node:assert/strict";
import test from "node:test";
import { ASK_AGENT_SELECTION_MAX_CHARS, buildAskAgentDraft, normalizeAskAgentSelection } from "../src/ask-agent-selection.js";
import { buildDerivedTaskPrompt, normalizeMessageSourceReference, normalizeSourceExcerpt } from "../src/message-source.js";

test("derived task prompt carries only the quoted excerpt and user instruction", () => {
  assert.equal(
    buildDerivedTaskPrompt("修复这段逻辑", "第一行\n第二行"),
    "请基于以下引用执行我的任务：\n\n> 第一行\n> 第二行\n\n我的指令：\n修复这段逻辑",
  );
  assert.equal(
    buildDerivedTaskPrompt("", "引用"),
    "请基于以下引用执行我的任务：\n\n> 引用\n\n我的指令：\n请根据该引用继续处理。",
  );
  const capped = buildDerivedTaskPrompt("继续", "很".repeat(ASK_AGENT_SELECTION_MAX_CHARS + 50));
  assert.match(capped, /引用内容过长，已截断/);
  assert.ok(capped.length < ASK_AGENT_SELECTION_MAX_CHARS + 160);
});

test("source reference normalization keeps a safe client-visible snapshot", () => {
  const normalized = normalizeSourceExcerpt("  第一行  \r\n\r\n\r\n第二行  \n");
  assert.equal(normalized, "第一行\n\n第二行");

  const reference = normalizeMessageSourceReference({
    sourceConversationId: "00000000-0000-4000-8000-000000000001",
    sourceMessageId: "11111111-1111-4111-8111-111111111111",
    sourceConversationTitle: " 来源任务 ",
    sourceRole: "assistant",
    sourceCreatedAt: "2026-08-13T10:00:00.000Z",
    excerpt: "引用内容",
  });
  assert.equal(reference?.sourceConversationTitle, "来源任务");
  assert.equal(reference?.excerpt, "引用内容");

  assert.equal(normalizeMessageSourceReference(null), null);
  assert.equal(normalizeMessageSourceReference({ sourceConversationId: "bad", excerpt: "x" }), null);
});

test("existing ask-agent draft builder remains unchanged for normal quotes", () => {
  assert.equal(
    buildAskAgentDraft("", "引用"),
    "请结合以下引用回答我的问题：\n\n> 引用\n\n请解释这段引用。",
  );
  assert.equal(normalizeAskAgentSelection("  a  \r\n\r\nb  "), "a\n\nb");
});
