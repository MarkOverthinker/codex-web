import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";

test("automation APIs enforce auth, CSRF, user ownership, validation and history", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automation-api-"));
  const password = "Automation-Test-Password!";
  const instance = createApp({ projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    queueAutoStart: false, hostMode: false, username: "owner", passwordHash: bcrypt.hashSync(password, 4),
    sessionSecret: "automation-tests-session-secret-longer-than-thirty-two" });
  const memberId = crypto.randomUUID();
  instance.db.createUser({ id: memberId, username: "member", display_name: "Member", password_hash: bcrypt.hashSync(password, 4),
    role: "member", status: "active", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  context.after(() => { instance.beginShutdown(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const owner = request.agent(instance.app);
  const member = request.agent(instance.app);
  const prefix = "/codex-web/api";
  await owner.get(`${prefix}/automations`).expect(401);
  await owner.get(`${prefix}/automation-runs`).expect(401);
  const ownerLogin = await owner.post(`${prefix}/auth/login`).send({ username: "owner", password }).expect(200);
  const memberLogin = await member.post(`${prefix}/auth/login`).send({ username: "member", password }).expect(200);
  const ownerCsrf = ownerLogin.body.csrfToken;
  const memberCsrf = memberLogin.body.csrfToken;
  const options = (await owner.get(`${prefix}/agent-options`).expect(200)).body;
  const input = { name: "Daily task", prompt: "Produce a report", workingDir: null, time: "09:00", timeZone: "UTC",
    model: options.defaults.model, reasoningEffort: options.defaults.reasoningEffort, sandbox: "workspace-write", enabled: true };
  await owner.post(`${prefix}/automations`).send(input).expect(403);
  for (const change of [{ time: "25:00" }, { timeZone: "bad-zone" }, { prompt: "" }, { model: "missing-model" }, { reasoningEffort: "invalid" }, { workingDir: "/workspace" }]) {
    await owner.post(`${prefix}/automations`).set("X-CSRF-Token", ownerCsrf).send({ ...input, ...change }).expect(400);
  }
  const created = await owner.post(`${prefix}/automations`).set("X-CSRF-Token", ownerCsrf).send(input).expect(201);
  const task = created.body.automation;
  assert.equal((await member.get(`${prefix}/automations`).expect(200)).body.automations.length, 0);
  await member.put(`${prefix}/automations/${task.id}`).set("X-CSRF-Token", memberCsrf).send(input).expect(404);
  await member.patch(`${prefix}/automations/${task.id}`).set("X-CSRF-Token", memberCsrf).send({ enabled: false }).expect(404);
  await member.post(`${prefix}/automations/${task.id}/run`).set("X-CSRF-Token", memberCsrf).send({}).expect(404);
  await member.delete(`${prefix}/automations/${task.id}`).set("X-CSRF-Token", memberCsrf).expect(404);
  await owner.patch(`${prefix}/automations/${task.id}`).set("X-CSRF-Token", ownerCsrf).send({ enabled: false, name: "bad" }).expect(400);
  await owner.patch(`${prefix}/automations/${task.id}`).set("X-CSRF-Token", ownerCsrf).send({ enabled: false }).expect(200);
  await owner.post(`${prefix}/automations/${task.id}/run`).set("X-CSRF-Token", ownerCsrf).send({}).expect(202);
  const history = (await owner.get(`${prefix}/automation-runs`).expect(200)).body.runs;
  assert.equal(history.length, 1);
  assert.equal(history[0].status, "queued");
  assert.equal(history[0].snapshot.prompt, input.prompt);
  await owner.get(`${prefix}/conversations/${history[0].conversationId}`).expect(200);
  await member.get(`${prefix}/conversations/${history[0].conversationId}`).expect(404);
  assert.deepEqual((await member.get(`${prefix}/automation-runs?automationId=${task.id}`).expect(200)).body.runs, []);
  await owner.get(`${prefix}/automation-runs?offset=-1`).expect(400);
  await owner.get(`${prefix}/automation-runs?offset=bad`).expect(400);
  await owner.get(`${prefix}/automation-runs?automationId[x]=bad`).expect(400);
  assert.equal((await owner.get(`${prefix}/automation-runs?offset=50`).expect(200)).body.runs.length, 0);
  await owner.put(`${prefix}/automations/${task.id}`).set("X-CSRF-Token", ownerCsrf).send({ ...input, name: "Renamed" }).expect(200);
  await owner.delete(`${prefix}/automations/${task.id}`).set("X-CSRF-Token", ownerCsrf).expect(204);
  assert.equal((await owner.get(`${prefix}/automations`).expect(200)).body.automations.length, 0);
  assert.equal((await owner.get(`${prefix}/automation-runs`).expect(200)).body.runs[0].name, "Daily task");
  instance.beginShutdown();
});
