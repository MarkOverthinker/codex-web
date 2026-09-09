import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";

for (const key of ["HOST_MODE", "CONTAINERIZED", "TENANT_WORKER_ISOLATION", "ALLOW_DANGER_FULL_ACCESS"]) delete process.env[key];

test("native Android protocol uses cookie plus CSRF and preserves server drafts, files and queues", async (context) => {
  const parent = path.join(process.cwd(), "tmp");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "native-api-test-"));
  const instance = createApp({
    projectRoot: root,
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    queueAutoStart: false,
    hostMode: false,
    username: "native-test",
    passwordHash: bcrypt.hashSync("Native-test-only-2026!", 8),
    sessionSecret: "native-test-only-session-secret-not-for-deployment",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const prefix = "/codex-web/api";
  const login = await agent.post(`${prefix}/auth/login`).send({ username: "native-test", password: "Native-test-only-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;
  await agent.post(`${prefix}/conversations`).send({}).expect(403);
  const created = await agent.post(`${prefix}/conversations`).set("X-CSRF-Token", csrf).send({}).expect(201);
  assert.equal(created.body.conversation.latest_job_status, null);
  const conversationPath = `${prefix}/conversations/${created.body.conversation.id}`;
  const draft = { content: "检查这个文件\n保留换行", quoteExcerpt: "引用", sourceReference: null };
  await agent.put(`${conversationPath}/draft`).set("X-CSRF-Token", csrf).send(draft).expect(200);
  const upload = await agent.post(`${conversationPath}/draft/files`).set("X-CSRF-Token", csrf)
    .attach("files", Buffer.from("native attachment"), "input.txt").expect(201);
  const fileId = upload.body.composerDraft.files[0].id;
  const detail = await agent.get(conversationPath).expect(200);
  assert.equal(detail.body.composerDraft.content, draft.content);
  assert.equal(detail.body.composerDraft.files[0].id, fileId);
  const send = await agent.post(`${conversationPath}/messages`).set("X-CSRF-Token", csrf)
    .field("message", draft.content).field("quoteExcerpt", draft.quoteExcerpt).field("useComposerDraft", "true").expect(202);
  assert.ok(send.body.job || send.body.pendingPrompt);
  const queuedList = await agent.get(`${prefix}/conversations`).expect(200);
  assert.equal(queuedList.body.conversations[0].latest_job_status, "queued");
  const next = await agent.post(`${conversationPath}/messages`).set("X-CSRF-Token", csrf)
    .field("message", "第二条排队指令").field("useComposerDraft", "true").expect(202);
  assert.ok(next.body.pendingPrompt);
  const promptId = next.body.pendingPrompt.id;
  await agent.post(`${conversationPath}/pending-prompts/${promptId}/edit`).set("X-CSRF-Token", csrf).expect(200);
  await agent.put(`${conversationPath}/pending-prompts/${promptId}`).set("X-CSRF-Token", csrf)
    .field("message", "编辑后的队列指令").field("removedFileIds", "[]").field("sourceReference", "null")
    .attach("files", Buffer.from("added while editing"), "new-attachment.txt").expect(200);
  const afterEdit = await agent.get(conversationPath).expect(200);
  assert.equal(afterEdit.body.pendingPrompts[0].content, "编辑后的队列指令");
  assert.equal(afterEdit.body.pendingPrompts[0].files[0].original_name, "new-attachment.txt");
  assert.equal(afterEdit.body.messages[0].files[0].id, fileId);
  assert.equal(afterEdit.body.composerDraft, null);
  const file = await agent.get(`${prefix}/files/${fileId}`).expect(200);
  assert.equal(file.text, "native attachment");
  const side = await agent.post(`${conversationPath}/side-chats`).set("X-CSRF-Token", csrf).expect(201);
  await agent.post(`${prefix}/side-chats/${side.body.conversation.id}/open`).set("X-CSRF-Token", csrf).expect(200);
  await agent.delete(`${conversationPath}/pending-prompts/${promptId}`).set("X-CSRF-Token", csrf).expect(204);
  const latestJob = instance.db.getLatestJobForConversation(created.body.conversation.id);
  assert.ok(latestJob);
  instance.db.finishJob(latestJob.id, created.body.conversation.id, "completed");
  const finishedList = await agent.get(`${prefix}/conversations`).expect(200);
  assert.equal(finishedList.body.conversations[0].latest_job_status, "completed");
  assert.equal(finishedList.body.conversations[0].has_pending_work, 0);
  await agent.post(`${prefix}/auth/logout`).set("X-CSRF-Token", csrf).expect(200);
  await agent.get(conversationPath).expect(401);
});
