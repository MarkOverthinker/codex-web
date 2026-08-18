import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp, migrateUploadFileMimes } from "../server/app.js";
import { AppDatabase } from "../server/db.js";

test("uploaded markdown files are stored as text/markdown when the browser reports an unreliable mime", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-upload-mime-test-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false,
    username: "owner", passwordHash: bcrypt.hashSync("Correct-Horse-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Correct-Horse-2026!" }).expect(200);
  const created = await agent.post("/codex-web/api/conversations").set("X-CSRF-Token", login.body.csrfToken).expect(201);
  const conversationId = created.body.conversation.id;

  await agent.post(`/codex-web/api/conversations/${conversationId}/draft/files`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .attach("files", Buffer.from("# title\n"), { filename: "note.md", contentType: "text/plain" })
    .expect(201);
  await agent.post(`/codex-web/api/conversations/${conversationId}/draft/files`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .attach("files", Buffer.from("# guide\n"), { filename: "guide.markdown", contentType: "application/octet-stream" })
    .expect(201);
  await agent.post(`/codex-web/api/conversations/${conversationId}/draft/files`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .attach("files", Buffer.from("# exact\n"), { filename: "exact.md", contentType: "text/markdown" })
    .expect(201);
  await agent.post(`/codex-web/api/conversations/${conversationId}/draft/files`)
    .set("X-CSRF-Token", login.body.csrfToken)
    .attach("files", Buffer.from("plain\n"), { filename: "plain.txt", contentType: "text/plain" })
    .expect(201);

  const files = instance.db.listFiles(conversationId).filter((file) => file.kind === "upload");
  const byName = new Map(files.map((file) => [file.original_name, file.mime_type]));
  assert.equal(byName.get("note.md"), "text/markdown");
  assert.equal(byName.get("guide.markdown"), "text/markdown");
  assert.equal(byName.get("exact.md"), "text/markdown");
  assert.equal(byName.get("plain.txt"), "text/plain");
});

test("startup migration repairs legacy upload markdown mime types", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-upload-mime-migration-test-"));
  const db = new AppDatabase(path.join(root, "data"));
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversationId = crypto.randomUUID();
  db.createConversation(conversationId, "迁移测试");
  const now = new Date().toISOString();
  const rows = [
    { id: crypto.randomUUID(), original_name: "legacy.md", mime_type: "text/plain", expect: "text/markdown" },
    { id: crypto.randomUUID(), original_name: "legacy.markdown", mime_type: "application/octet-stream", expect: "text/markdown" },
    { id: crypto.randomUUID(), original_name: "exact.md", mime_type: "text/markdown", expect: "text/markdown" },
    { id: crypto.randomUUID(), original_name: "plain.txt", mime_type: "text/plain", expect: "text/plain" },
  ];
  for (const row of rows) {
    db.addFile({
      id: row.id, conversation_id: conversationId, message_id: null,
      original_name: row.original_name, relative_path: `uploads/${row.id}.${row.original_name.split(".").at(-1)}`,
      mime_type: row.mime_type, size: 8, kind: "upload", created_at: now,
    });
  }

  assert.equal(migrateUploadFileMimes(db), 2);
  for (const row of rows) {
    assert.equal(db.getFile(row.id)?.mime_type, row.expect);
  }
});
