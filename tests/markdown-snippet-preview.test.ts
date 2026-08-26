import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { LEGACY_USER_ID } from "../server/db.js";
import { ensureTenantWorkspace } from "../server/paths.js";
import { isMarkdownSnippetPath, parseSnippetHref } from "../src/code-snippet.js";

test("code snippet API returns the full file content when full=1", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-markdown-snippet-test-"));
  const tenantRoot = path.join(root, "tenants");
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot, queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id;
  const workspace = ensureTenantWorkspace(tenantRoot, LEGACY_USER_ID, conversationId);
  const markdown = Array.from({ length: 1200 }, (_, index) => index === 0 ? "# 标题" : `第 ${index + 1} 行`).join("\n") + "\n";
  fs.writeFileSync(path.join(workspace, "uploads", "notes.md"), markdown);
  const base = `/codex-web/api/conversations/${conversationId}/code-snippet`;

  const full = await agent.get(`${base}?path=${encodeURIComponent("uploads/notes.md")}&line=1&full=1`).expect(200);
  assert.equal(full.body.totalLines, 1200);
  assert.equal(full.body.start, 1);
  assert.equal(full.body.end, 1200);
  assert.deepEqual(full.body.lines, []);
  assert.equal(full.body.content, markdown);

  const windowed = await agent.get(`${base}?path=${encodeURIComponent("uploads/notes.md")}&line=1`).expect(200);
  assert.equal(windowed.body.content, undefined);
  assert.ok(windowed.body.lines.length < 1200);
});

test("markdown local paths render as full Markdown preview even with a line number", () => {
  assert.equal(isMarkdownSnippetPath("notes.md"), true);
  assert.equal(isMarkdownSnippetPath("docs/guide.markdown"), true);
  assert.equal(isMarkdownSnippetPath("notes.md", 12), true);
  assert.equal(isMarkdownSnippetPath("notes.txt"), false);
  const ref = parseSnippetHref("sandbox:/app/workspaces/uploads/notes.md");
  assert.deepEqual(ref, { path: "/app/workspaces/uploads/notes.md" });
});
