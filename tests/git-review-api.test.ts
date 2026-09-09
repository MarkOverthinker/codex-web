import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { ensureTenantWorkspace } from "../server/paths.js";

test("review API requires authentication, owns the conversation and validates its inputs", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-review-api-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    queueAutoStart: false, hostMode: false, tenantWorkerIsolation: false,
    username: "owner", passwordHash: bcrypt.hashSync("Review-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversation = instance.db.createConversation(crypto.randomUUID(), "Review fixture");
  const endpoint = `/codex-web/api/conversations/${conversation.id}/review`;
  await request(instance.app).get(endpoint).expect(401);
  const agent = request.agent(instance.app);
  await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Review-Password-2026!" }).expect(200);
  await agent.get(`/codex-web/api/conversations/${crypto.randomUUID()}/review`).expect(404);
  const owner = instance.db.getUserByUsername("owner")!;
  const otherId = crypto.randomUUID();
  instance.db.createUser({ ...owner, id: otherId, username: "other", role: "member" });
  const other = instance.db.createConversation(crypto.randomUUID(), "Private", undefined, otherId);
  await agent.get(`/codex-web/api/conversations/${other.id}/review`).expect(404);
  await agent.get(`${endpoint}?scope=invalid`).expect(400);
  await agent.get(`${endpoint}?file[]=invalid`).expect(400);
  const workspace = ensureTenantWorkspace(path.join(root, "tenants"), owner.id, conversation.id);
  fs.writeFileSync(path.join(workspace, "new.txt"), "review content\n");
  const result = await agent.get(endpoint).expect(200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.ok(result.body.files.some((file: { path: string }) => file.path === "new.txt"));
  const patch = await agent.get(`${endpoint}?file=new.txt`).expect(200);
  assert.match(patch.body.patch, /review content/);
  await agent.get(`${endpoint}?file=..%2Foutside`).expect(400);
  await agent.get(`${endpoint}?scope=branch&base=--output=bad`).expect(400);
});
