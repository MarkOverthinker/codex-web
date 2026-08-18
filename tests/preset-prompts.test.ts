import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { buildAgentSteerPrompt, buildAgentTurnPrompt, buildPresetPromptsBlock } from "../server/agent-context.js";
import { createApp } from "../server/app.js";
import { AppDatabase, LEGACY_USER_ID, MAX_CONVERSATION_PRESET_PROMPTS } from "../server/db.js";

function tempRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cww-preset-prompts-${label}-`));
}

test("buildAgentTurnPrompt appends enabled preset prompts after the user prompt", () => {
  const prompt = buildAgentTurnPrompt({
    userPrompt: "处理这个文件",
    attachments: [],
    presetPrompts: [{ name: "中文回复", content: "始终使用中文回答" }, { name: "分步执行", content: "先分析再执行" }],
  });
  assert.ok(prompt.startsWith("处理这个文件"));
  assert.match(prompt, /用户启用了以下预设规则，请遵守/);
  assert.match(prompt, /【预设：中文回复】\n始终使用中文回答/);
  assert.match(prompt, /【预设：分步执行】\n先分析再执行/);
  assert.ok(prompt.indexOf("【预设：中文回复】") < prompt.indexOf("【预设：分步执行】"));
});

test("buildAgentTurnPrompt stays unchanged without preset prompts", () => {
  const withPresets = buildAgentTurnPrompt({ userPrompt: "任务", attachments: [], presetPrompts: [{ name: "规则", content: "内容" }] });
  const withoutPresets = buildAgentTurnPrompt({ userPrompt: "任务", attachments: [] });
  assert.match(withoutPresets, /^任务$/);
  assert.doesNotMatch(withoutPresets, /预设规则/);
  assert.ok(withPresets.length > withoutPresets.length);
});

test("buildAgentSteerPrompt appends preset prompts", () => {
  const prompt = buildAgentSteerPrompt("继续", [], [{ name: "规则", content: "保持格式" }]);
  assert.match(prompt, /实时调整当前任务：继续/);
  assert.match(prompt, /【预设：规则】\n保持格式/);
});

test("preset prompts persist per user and cascade on deletion", () => {
  const root = tempRoot("db");
  const db = new AppDatabase(root, { username: "owner", passwordHash: "$2b$10$invalid", displayName: "Owner" }, false);
  try {
    const ownerId = LEGACY_USER_ID;
    const memberId = "11111111-1111-4111-8111-111111111111";
    const presetId = "22222222-2222-4222-8222-222222222222";
    db.createUser({
      id: memberId, username: "member", display_name: "Member", password_hash: "$2b$10$invalid",
      role: "member", status: "active", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    db.createPresetPrompt(ownerId, presetId, "中文回复", "始终使用中文回答");
    assert.equal(db.listPresetPrompts(ownerId).length, 1);
    assert.equal(db.listPresetPrompts(memberId).length, 0);
    assert.equal(db.getPresetPrompt(memberId, presetId), undefined);

    const conversationId = "33333333-3333-4333-8333-333333333333";
    db.createConversation(conversationId, "测试任务", undefined, ownerId);
    assert.deepEqual(db.setConversationPresetPrompts(conversationId, ownerId, [presetId]), [presetId]);
    assert.deepEqual(db.getConversationPresetPromptIds(conversationId), [presetId]);
    assert.deepEqual(db.listEnabledPresetPrompts(conversationId).map((preset) => preset.name), ["中文回复"]);

    assert.equal(db.setConversationPresetPrompts(conversationId, memberId, [presetId]), null);
    assert.equal(db.setConversationPresetPrompts(conversationId, ownerId, ["missing-preset"]), null);
    const tooMany = Array.from({ length: MAX_CONVERSATION_PRESET_PROMPTS + 1 }, (_, index) => `id-${index}`);
    assert.equal(db.setConversationPresetPrompts(conversationId, ownerId, tooMany), null);

    assert.equal(db.deletePresetPrompt(ownerId, presetId), true);
    assert.deepEqual(db.getConversationPresetPromptIds(conversationId), []);
    assert.deepEqual(db.listEnabledPresetPrompts(conversationId), []);
    assert.equal(db.deletePresetPrompt(ownerId, presetId), false);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preset prompt API enforces auth, validation, conversation binding and user isolation", async (context) => {
  const root = tempRoot("api");
  const ownerPassword = "Preset-Owner-2026!";
  const memberPassword = "Preset-Member-2026!";
  const instance = createApp({
    projectRoot: process.cwd(),
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    queueAutoStart: false,
    username: "owner",
    passwordHash: bcrypt.hashSync(ownerPassword, 8),
    sessionSecret: "test-preset-session-secret-that-is-longer-than-thirty-two",
  });
  instance.db.createUser({
    id: crypto.randomUUID(), username: "member", display_name: "Member",
    password_hash: bcrypt.hashSync(memberPassword, 8), role: "member", status: "active",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const anonymous = request.agent(instance.app);
  await anonymous.get("/codex-web/api/preset-prompts").expect(401);
  await anonymous.post("/codex-web/api/preset-prompts").send({ name: "x", content: "y" }).expect(401);

  const owner = request.agent(instance.app);
  const ownerLogin = await owner.post("/codex-web/api/auth/login").send({ username: "owner", password: ownerPassword }).expect(200);
  const ownerCsrf = ownerLogin.body.csrfToken as string;

  const member = request.agent(instance.app);
  const memberLogin = await member.post("/codex-web/api/auth/login").send({ username: "member", password: memberPassword }).expect(200);
  const memberCsrf = memberLogin.body.csrfToken as string;

  const empty = await owner.get("/codex-web/api/preset-prompts").expect(200);
  assert.deepEqual(empty.body.presetPrompts, []);

  await owner.post("/codex-web/api/preset-prompts").set("X-CSRF-Token", ownerCsrf).send({ name: "", content: "内容" }).expect(400);
  await owner.post("/codex-web/api/preset-prompts").set("X-CSRF-Token", ownerCsrf).send({ name: "规则", content: "x".repeat(10_001) }).expect(400);

  const created = await owner.post("/codex-web/api/preset-prompts").set("X-CSRF-Token", ownerCsrf)
    .send({ name: "中文回复", content: "始终使用中文回答" }).expect(201);
  const presetId = created.body.presetPrompt.id as string;
  assert.equal(created.body.presetPrompt.name, "中文回复");

  const updated = await owner.put(`/codex-web/api/preset-prompts/${presetId}`).set("X-CSRF-Token", ownerCsrf)
    .send({ content: "始终使用中文回答，并给出完整步骤" }).expect(200);
  assert.match(updated.body.presetPrompt.content, /完整步骤/);
  await owner.put("/codex-web/api/preset-prompts/missing").set("X-CSRF-Token", ownerCsrf)
    .send({ name: "新名字" }).expect(404);

  const memberCreated = await member.post("/codex-web/api/preset-prompts").set("X-CSRF-Token", memberCsrf)
    .send({ name: "成员规则", content: "只属于成员" }).expect(201);
  const memberPresetId = memberCreated.body.presetPrompt.id as string;
  await member.put(`/codex-web/api/preset-prompts/${presetId}`).set("X-CSRF-Token", memberCsrf).send({ name: "越权" }).expect(404);
  await member.delete(`/codex-web/api/preset-prompts/${presetId}`).set("X-CSRF-Token", memberCsrf).expect(404);
  const ownerList = await owner.get("/codex-web/api/preset-prompts").expect(200);
  assert.deepEqual(ownerList.body.presetPrompts.map((preset: { id: string }) => preset.id), [presetId]);
  const memberList = await member.get("/codex-web/api/preset-prompts").expect(200);
  assert.deepEqual(memberList.body.presetPrompts.map((preset: { id: string }) => preset.id), [memberPresetId]);

  const conversation = await owner.post("/codex-web/api/conversations").set("X-CSRF-Token", ownerCsrf).send({}).expect(201);
  const conversationId = conversation.body.conversation.id as string;
  const bound = await owner.put(`/codex-web/api/conversations/${conversationId}/preset-prompts`).set("X-CSRF-Token", ownerCsrf)
    .send({ presetPromptIds: [presetId] }).expect(200);
  assert.deepEqual(bound.body.enabledPresetPromptIds, [presetId]);
  const detail = await owner.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.deepEqual(detail.body.enabledPresetPromptIds, [presetId]);

  await member.put(`/codex-web/api/conversations/${conversationId}/preset-prompts`).set("X-CSRF-Token", memberCsrf)
    .send({ presetPromptIds: [presetId] }).expect(404);
  await owner.put(`/codex-web/api/conversations/${conversationId}/preset-prompts`).set("X-CSRF-Token", ownerCsrf)
    .send({ presetPromptIds: [memberPresetId] }).expect(400);
  await owner.put(`/codex-web/api/conversations/${conversationId}/preset-prompts`).set("X-CSRF-Token", ownerCsrf)
    .send({ presetPromptIds: Array.from({ length: MAX_CONVERSATION_PRESET_PROMPTS + 1 }, (_, index) => `id-${index}`) }).expect(400);

  await owner.delete(`/codex-web/api/preset-prompts/${presetId}`).set("X-CSRF-Token", ownerCsrf).expect(204);
  const detailAfterDelete = await owner.get(`/codex-web/api/conversations/${conversationId}`).expect(200);
  assert.deepEqual(detailAfterDelete.body.enabledPresetPromptIds, []);
  await owner.delete(`/codex-web/api/preset-prompts/${presetId}`).set("X-CSRF-Token", ownerCsrf).expect(404);
});

test("preset prompts block renders each preset with its name", () => {
  const block = buildPresetPromptsBlock([{ name: "规则一", content: "内容一" }, { name: "规则二", content: "内容二" }]);
  assert.match(block, /用户启用了以下预设规则，请遵守/);
  assert.match(block, /【预设：规则一】\n内容一/);
  assert.match(block, /【预设：规则二】\n内容二/);
});
