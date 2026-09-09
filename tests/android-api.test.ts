import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { ensureTenantWorkspace } from "../server/paths.js";

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

test("native file tree and review endpoints serve real workspaces, previews and git diffs", async (context) => {
  const parent = path.join(process.cwd(), "tmp");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "native-files-test-"));
  const instance = createApp({
    projectRoot: root,
    dataRoot: path.join(root, "data"),
    tenantRoot: path.join(root, "tenants"),
    queueAutoStart: false,
    hostMode: false,
    tenantWorkerIsolation: false,
    username: "native-files",
    passwordHash: bcrypt.hashSync("Native-files-only-2026!", 8),
    sessionSecret: "native-files-test-session-secret-not-for-deployment",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const prefix = "/codex-web/api";
  const login = await agent.post(`${prefix}/auth/login`).send({ username: "native-files", password: "Native-files-only-2026!" }).expect(200);
  const csrf = login.body.csrfToken as string;
  const created = await agent.post(`${prefix}/conversations`).set("X-CSRF-Token", csrf).send({}).expect(201);
  const conversationId = created.body.conversation.id as string;
  const conversationPath = `${prefix}/conversations/${conversationId}`;
  const userId = instance.db.getConversation(conversationId)?.user_id;
  assert.ok(userId);
  const workspace = ensureTenantWorkspace(path.join(root, "tenants"), userId, conversationId);
  const longName = "设计方案-最终版-请以这一份为准-不要重复导出-版本V20260910.md";
  fs.mkdirSync(path.join(workspace, "docs"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "docs", "会议记录.txt"), "会议记录第一行\n", "utf8");
  fs.writeFileSync(path.join(workspace, ".env"), "TOKEN=must-not-be-listed\n", "utf8");

  const roots = await agent.get(`${conversationPath}/file-tree`).expect(200);
  assert.deepEqual(roots.body.roots.map((entry: { id: string }) => entry.id), ["workspace", "library"]);
  assert.equal(roots.body.roots.every((entry: { available: boolean }) => entry.available), true);
  const listing = await agent.get(`${conversationPath}/file-tree?root=workspace&path=`).expect(200);
  const names = listing.body.listing.entries.map((entry: { name: string }) => entry.name);
  assert.equal(names.includes("docs"), true);
  assert.equal(names.includes(".env"), false);
  assert.equal(listing.body.listing.parentPath, null);

  const nested = await agent.get(`${conversationPath}/file-tree?root=workspace&path=${encodeURIComponent("docs")}`).expect(200);
  assert.equal(nested.body.listing.parentPath, "");
  assert.deepEqual(nested.body.listing.entries.map((entry: { name: string }) => entry.name), ["会议记录.txt"]);

  // 租户工作区自动 git init（零提交）：Review 是成功结果而非失败，未跟踪文件按 ? 呈现
  const fresh = await agent.get(`${conversationPath}/review?scope=working`).expect(200);
  assert.equal(fresh.body.branch, "main");
  assert.ok(fresh.body.files.some((file: { path: string; status: string }) => file.path === "AGENTS.md" && file.status === "?"));

  // 真实 git 提交历史：工作区/暂存区/分支差异、增删统计与文件 patch
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=native-test@example.org", "-c", "user.name=native-test", ...args], { cwd: workspace, encoding: "utf8" });
  fs.writeFileSync(path.join(workspace, "README.md"), "# Workspace\n\n基础内容\n", "utf8");
  git("add", "AGENTS.md", ".gitignore", "README.md", "docs");
  git("commit", "-m", "init");
  git("checkout", "-b", "feature");
  fs.writeFileSync(path.join(workspace, "README.md"), "# Workspace\n\n修改后的内容\n", "utf8");
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "main.ts"), "export const answer = 42;\nexport const extra = 1;\n", "utf8");
  fs.writeFileSync(path.join(workspace, longName), "# 设计方案\n\n正文\n", "utf8");

  const working = await agent.get(`${conversationPath}/review?scope=working`).expect(200);
  assert.equal(working.body.branch, "feature");
  const untracked = working.body.files.find((file: { path: string }) => file.path === longName);
  assert.ok(untracked);
  assert.equal(untracked.status, "?");
  assert.equal(untracked.additions, null);

  git("add", "README.md", "src");
  git("commit", "-m", "feature changes");

  const staged = await agent.get(`${conversationPath}/review?scope=staged`).expect(200);
  assert.equal(staged.body.comparison, "HEAD 与暂存区");
  assert.deepEqual(staged.body.files, []);

  const branch = await agent.get(`${conversationPath}/review?scope=branch&base=refs/heads/main`).expect(200);
  assert.equal(branch.body.comparison, "main 的共同祖先 → HEAD（仅已提交）");
  const modified = branch.body.files.find((file: { path: string }) => file.path === "README.md");
  assert.deepEqual([modified.status, modified.additions, modified.deletions], ["M", 1, 1]);
  const added = branch.body.files.find((file: { path: string }) => file.path === "src/main.ts");
  assert.deepEqual([added.status, added.additions, added.deletions], ["A", 2, 0]);

  const patch = await agent.get(`${conversationPath}/review?scope=branch&base=refs/heads/main&file=${encodeURIComponent("src/main.ts")}`).expect(200);
  assert.match(patch.body.patch, /\+export const extra = 1;/);
  const untrackedPatch = await agent.get(`${conversationPath}/review?scope=working&file=${encodeURIComponent(longName)}`).expect(200);
  assert.match(untrackedPatch.body.patch, /\+# 设计方案/);

  const gone = await agent.get(`${conversationPath}/review?scope=working&file=${encodeURIComponent("no-such-file.ts")}`).expect(400);
  assert.equal(gone.body.error, "该文件已不在当前变更列表中，请刷新。");

  // 文件与目录不存在：文案准确且不泄漏服务器绝对路径
  const missingFile = await agent.get(`${conversationPath}/file-tree/preview?root=workspace&path=${encodeURIComponent("已删除.txt")}`).expect(400);
  assert.equal(missingFile.body.error, "文件或目录不存在，可能已被移动、重命名或删除。");
  const missingDir = await agent.get(`${conversationPath}/file-tree?root=workspace&path=${encodeURIComponent("missing-dir")}`).expect(400);
  assert.equal(missingDir.body.error, "文件或目录不存在，可能已被移动、重命名或删除。");
  const missingDownload = await agent.get(`${conversationPath}/file-tree/file?root=workspace&path=${encodeURIComponent("已删除.txt")}`).expect(400);
  assert.equal(missingDownload.body.error, "文件或目录不存在，可能已被移动、重命名或删除。");
  assert.doesNotMatch(missingFile.body.error, /native-files-test-/);
  assert.doesNotMatch(missingDir.body.error, /native-files-test-/);

  const preview = await agent.get(`${conversationPath}/file-tree/preview?root=workspace&path=${encodeURIComponent(longName)}`).expect(200);
  assert.equal(preview.body.mimeType, "text/markdown");
  assert.match(preview.body.content, /设计方案/);
  const sensitive = await agent.get(`${conversationPath}/file-tree?root=workspace&path=${encodeURIComponent(".env")}`).expect(400);
  assert.equal(sensitive.body.error, "该文件不允许通过文件浏览器访问。");
});
