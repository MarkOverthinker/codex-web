import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import request from "supertest";
import { createApp } from "../server/app.js";
import { BUILTIN_PROVIDER_ID } from "../server/billing.js";
import { tenantPaths } from "../server/paths.js";

test("billing API validates ranges before mutations and retains them across saves, sync and reprice", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "billing-api-"));
  const instance = createApp({ projectRoot: root, dataRoot: path.join(root, "data"), tenantRoot: path.join(root, "tenants"), queueAutoStart: false, hostMode: false, username: "billing-test", passwordHash: bcrypt.hashSync("billing-test-password", 4), sessionSecret: "billing-test-session-secret" });
  context.after(() => { instance.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const agent = request.agent(instance.app);
  const prefix = "/codex-web/api";
  await agent.get(`${prefix}/billing`).expect(401);
  const login = await agent.post(`${prefix}/auth/login`).send({ username: "billing-test", password: "billing-test-password" }).expect(200);
  const csrf = login.body.csrfToken as string;
  const user = instance.db.getUserByUsername("billing-test")!;
  const conversation = instance.db.createConversation(crypto.randomUUID(), "Billing", undefined, user.id);
  for (const createdAt of ["2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"]) {
    const job = instance.db.createJob(crypto.randomUUID(), conversation.id);
    instance.db.addApiUsage({ id: crypto.randomUUID(), user_id: user.id, job_id: job.id, conversation_id: conversation.id, provider_id: BUILTIN_PROVIDER_ID, model_id: "model", input_tokens: 1_000_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, created_at: createdAt });
  }
  const range = { from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" };
  const pricingPath = `${prefix}/billing/pricing-rules/${BUILTIN_PROVIDER_ID}/model`;
  const payload = { inputPerMillion: 2, cacheReadPerMillion: 0, cacheWritePerMillion: 0, outputPerMillion: 0 };
  await agent.put(pricingPath).query(range).send(payload).expect(403);
  const saved = await agent.put(pricingPath).query(range).set("X-CSRF-Token", csrf).send(payload).expect(200);
  assert.equal(saved.body.summary.calls, 1);
  assert.equal(saved.body.summary.estimatedCost, 2);
  assert.equal(saved.body.from, range.from);
  assert.equal(saved.body.to, range.to);
  const sessionDirectory = path.join(tenantPaths(path.join(root, "tenants"), user.id).codexHome, "sessions", "2026", "08", "01");
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.writeFileSync(path.join(sessionDirectory, "rollout-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl"), [
    { timestamp: "2026-08-01T12:00:00.000Z", type: "session_meta", payload: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", originator: "codex-tui", model_provider: BUILTIN_PROVIDER_ID } },
    { timestamp: "2026-08-01T12:00:01.000Z", type: "turn_context", payload: { turn_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", model: "model" } },
    { timestamp: "2026-08-01T12:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 500_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } } } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await agent.post(`${prefix}/billing/sync-usage`).query(range).send({}).expect(403);
  const usageSynced = await agent.post(`${prefix}/billing/sync-usage`).query(range).set("X-CSRF-Token", csrf).send({}).expect(200);
  assert.equal(usageSynced.body.result.inserted, 1);
  assert.equal(usageSynced.body.billing.summary.calls, 2);
  assert.equal(usageSynced.body.billing.byClient.find((item: { clientName: string }) => item.clientName === "Codex CLI")?.calls, 1);
  for (const query of [{ from: range.from }, { to: range.to }, { from: range.to, to: range.from }, { from: "bad", to: range.to }, { from: "2026-02-30T00:00:00Z", to: range.to }, { days: -1 }, { days: "bad" }]) {
    await agent.get(`${prefix}/billing`).query(query).expect(400);
    await agent.put(pricingPath).query(query).set("X-CSRF-Token", csrf).send({ ...payload, inputPerMillion: 99 }).expect(400);
    await agent.post(`${prefix}/billing/recalculate`).query(query).set("X-CSRF-Token", csrf).send({}).expect(400);
  }
  assert.equal(instance.db.getPricingRule(user.id, BUILTIN_PROVIDER_ID, "model")?.input_per_million, 2);
  const synced = await agent.post(`${prefix}/billing/sync-pricing`).query(range).set("X-CSRF-Token", csrf).send({}).expect(200);
  assert.equal(synced.body.billing.summary.calls, 2);
  assert.equal(synced.body.billing.to, range.to);
  const repriced = await agent.post(`${prefix}/billing/recalculate`).query(range).set("X-CSRF-Token", csrf).send({}).expect(200);
  assert.equal(repriced.body.summary.calls, 2);
  assert.equal(repriced.body.to, range.to);
  const all = await agent.get(`${prefix}/billing`).query({ days: 0 }).expect(200);
  assert.equal(all.body.summary.calls, 3);
});
