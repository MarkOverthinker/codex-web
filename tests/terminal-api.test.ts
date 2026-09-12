import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import express from "express";
import { createApp } from "../server/app.js";
import { registerTerminalRoutes } from "../server/terminal-routes.js";
import type { TerminalCommand } from "../src/terminal-protocol.js";

test("terminal API requires login, CSRF, same origin, ownership and safe execution identity", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-terminal-api-"));
  const instance = createApp({
    projectRoot: process.cwd(), dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"),
    queueAutoStart: false, hostMode: false, tenantWorkerIsolation: false,
    username: "owner", passwordHash: bcrypt.hashSync("Terminal-Password-2026!", 8),
    sessionSecret: "test-session-secret-that-is-longer-than-thirty-two-characters",
  });
  context.after(() => { instance.beginShutdown(); instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const conversation = instance.db.createConversation(crypto.randomUUID(), "Terminal fixture");
  const endpoint = `/codex-web/api/conversations/${conversation.id}/terminal`;
  const terminalId = crypto.randomUUID();
  const size = { cols: 80, rows: 24 };
  await request(instance.app).post(endpoint).send(size).expect(401);
  await request(instance.app).get(`${endpoint}/${terminalId}?after=0`).expect(401);
  const agent = request.agent(instance.app);
  const login = await agent.post("/codex-web/api/auth/login").send({ username: "owner", password: "Terminal-Password-2026!" }).expect(200);
  const csrf = login.body.csrfToken;
  await agent.post(endpoint).send(size).expect(403);
  await agent.post(endpoint).set("X-CSRF-Token", csrf).set("Origin", "https://untrusted.example").send(size).expect(403);
  await agent.post(`${endpoint}/${terminalId}`).send({ action: "write", data: "ls\n" }).expect(403);
  await agent.delete(`${endpoint}/${terminalId}`).expect(403);
  const owner = instance.db.getUserByUsername("owner")!;
  const otherId = crypto.randomUUID();
  instance.db.createUser({ ...owner, id: otherId, username: "other", role: "member" });
  const other = instance.db.createConversation(crypto.randomUUID(), "Private", undefined, otherId);
  await agent.post(`/codex-web/api/conversations/${other.id}/terminal`).set("X-CSRF-Token", csrf).send(size).expect(404);
  await agent.get(`/codex-web/api/conversations/${other.id}/terminal/${terminalId}?after=0`).expect(404);
  await agent.post(endpoint).set("X-CSRF-Token", csrf).send({ cols: 9000, rows: 24 }).expect(400);
  await agent.get(`${endpoint}/${terminalId}?after[]=0`).expect(400);
  await agent.get(`${endpoint}/${terminalId}?after=-1`).expect(400);
  await agent.get(`${endpoint}/${terminalId}?after=0&waitMs=10001`).expect(400);
  await agent.get(`${endpoint}/${terminalId}?after=0&waitMs[]=100`).expect(400);
  await agent.post(`${endpoint}/${terminalId}`).set("X-CSRF-Token", csrf).send({ action: "open", ...size }).expect(400);
  await agent.post(`${endpoint}/${terminalId}`).set("X-CSRF-Token", csrf).send({ action: "close-task" }).expect(400);
  const unavailable = await agent.post(endpoint).set("X-CSRF-Token", csrf).send(size).expect(503);
  assert.match(unavailable.body.error, /隔离/);
  assert.equal(unavailable.headers["cache-control"], "no-store");
  instance.beginShutdown();
  await agent.post(endpoint).set("X-CSRF-Token", csrf).send(size).expect(503);
});

test("terminal routes forward only validated commands and server-derived context", async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.session = { user_id: "owner" }; next(); });
  const commands: TerminalCommand[] = [];
  const terminalId = crypto.randomUUID();
  const identity = { userId: "owner", conversationId: "task", cwd: "/workspace", home: "/home/tenant", uid: 11001, gid: 11001 };
  registerTerminalRoutes(app, {
    exists: (userId, conversationId) => userId === "owner" && conversationId === "task",
    context: () => identity, shuttingDown: () => false,
    execute: async (context, command) => { assert.equal(context, identity); commands.push(command); return { terminalId }; },
  });
  const endpoint = "/conversations/task/terminal";
  await request(app).post(endpoint).send({ cols: 80, rows: 24, uid: 0, cwd: "/etc", action: "write" }).expect(200);
  assert.deepEqual(commands[0], { action: "open", cols: 80, rows: 24 });
  await request(app).get(`${endpoint}/${terminalId}?after=0&waitMs=10000`).expect(200);
  assert.deepEqual(commands[1], { action: "read", terminalId, after: 0, waitMs: 10000 });
  await request(app).post(`${endpoint}/${terminalId}`).send({ action: "write", data: "pwd\r" }).expect(200);
  await request(app).post(`${endpoint}/${terminalId}`).send({ action: "resize", cols: 90, rows: 30 }).expect(200);
  await request(app).delete(`${endpoint}/${terminalId}`).expect(200);
  assert.deepEqual(commands.map((command) => command.action), ["open", "read", "write", "resize", "close"]);
});
