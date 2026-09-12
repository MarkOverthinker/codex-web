import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { recordTokenUsage } from "../server/billing.js";
import { loadConfig } from "../server/config.js";
import { AppDatabase } from "../server/db.js";
import { tenantPaths } from "../server/paths.js";
import { RolloutUsageSynchronizer } from "../server/rollout-usage.js";

const threadId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";

function line(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return `${JSON.stringify({ timestamp, type, payload })}\n`;
}

function token(timestamp: string, input: number, cached: number, output: number, reasoning = 0): string {
  return line(timestamp, "event_msg", {
    type: "token_count",
    info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning } },
  });
}

test("rollout usage sync incrementally backfills CLI turns and never overwrites authoritative Web usage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-rollout-usage-"));
  const tenantRoot = path.join(root, "tenants");
  const db = new AppDatabase(path.join(root, "data"), { username: "owner", passwordHash: "$2b$10$invalid", displayName: "Owner" }, false);
  const userId = db.listUsers()[0].id;
  const codexHome = tenantPaths(tenantRoot, userId).codexHome;
  const directory = path.join(codexHome, "sessions", "2026", "09", "12");
  fs.mkdirSync(directory, { recursive: true });
  const rollout = path.join(directory, `rollout-2026-09-12T00-00-00-${threadId}.jsonl`);
  fs.writeFileSync(rollout,
    line("2026-09-12T00:00:00.000Z", "session_meta", { id: threadId, originator: "codex-tui", model_provider: "provider-a" })
    + line("2026-09-12T00:00:01.000Z", "turn_context", { turn_id: turnId, model: "model-a" })
    + token("2026-09-12T00:00:02.000Z", 100, 40, 10, 3)
    + token("2026-09-12T00:00:03.000Z", 200, 100, 20, 4),
  );
  const sync = new RolloutUsageSynchronizer(loadConfig({ projectRoot: root, dataRoot: path.join(root, "data"), tenantRoot, hostMode: false }), db);

  try {
    const first = await sync.scanUser(userId);
    assert.equal(first.inserted, 1);
    let rows = db.listApiUsage(userId, new Date(0).toISOString());
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { input: rows[0].input_tokens, cached: rows[0].cached_input_tokens, output: rows[0].output_tokens, reasoning: rows[0].reasoning_output_tokens },
      { input: 300, cached: 140, output: 30, reasoning: 7 },
    );
    assert.equal(rows[0].source_kind, "rollout");
    assert.equal(rows[0].originator, "codex-tui");

    assert.equal((await sync.scanUser(userId)).inserted, 0);
    fs.appendFileSync(rollout, token("2026-09-12T00:00:04.000Z", 50, 20, 5, 1));
    assert.equal((await sync.scanUser(userId)).updated, 1);
    rows = db.listApiUsage(userId, new Date(0).toISOString());
    assert.equal(rows[0].input_tokens, 350);

    const conversation = db.createConversation("33333333-3333-4333-8333-333333333333", "Web authority", undefined, userId);
    const job = db.createJob("44444444-4444-4444-8444-444444444444", conversation.id);
    recordTokenUsage(db, {
      userId, jobId: job.id, conversationId: conversation.id, providerId: "provider-a", modelId: "model-a",
      identity: { threadId, turnId, createdAt: "2026-09-12T00:00:05.000Z" },
      usage: { input_tokens: 360, cached_input_tokens: 150, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 9 },
    });
    fs.appendFileSync(rollout, token("2026-09-12T00:00:06.000Z", 500, 400, 100, 50));
    assert.equal((await sync.scanUser(userId)).unchanged, 1);
    rows = db.listApiUsage(userId, new Date(0).toISOString());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_kind, "web");
    assert.equal(rows[0].input_tokens, 360);
    assert.equal(rows[0].job_id, job.id);
  } finally {
    await sync.stop();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rollout usage sync skips historical codex-web rows created before the ledger cutoff", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-rollout-cutoff-"));
  const tenantRoot = path.join(root, "tenants");
  const db = new AppDatabase(path.join(root, "data"), { username: "owner", passwordHash: "$2b$10$invalid", displayName: "Owner" }, false);
  const userId = db.listUsers()[0].id;
  const codexHome = tenantPaths(tenantRoot, userId).codexHome;
  const directory = path.join(codexHome, "archived_sessions");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-old-${threadId}.jsonl`),
    line("2020-01-01T00:00:00.000Z", "session_meta", { id: threadId, originator: "codex-web", model_provider: "provider-a" })
    + line("2020-01-01T00:00:01.000Z", "turn_context", { turn_id: turnId, model: "model-a" })
    + token("2020-01-01T00:00:02.000Z", 100, 0, 10),
  );
  const sync = new RolloutUsageSynchronizer(loadConfig({ projectRoot: root, dataRoot: path.join(root, "data"), tenantRoot, hostMode: false }), db);
  try {
    assert.equal((await sync.scanUser(userId)).inserted, 0);
    assert.equal(db.listApiUsage(userId, new Date(0).toISOString()).length, 0);
  } finally {
    await sync.stop();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rollout usage sync waits for complete JSONL lines and deduplicates copied threads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-rollout-complete-lines-"));
  const tenantRoot = path.join(root, "tenants");
  const db = new AppDatabase(path.join(root, "data"), { username: "owner", passwordHash: "$2b$10$invalid", displayName: "Owner" }, false);
  const userId = db.listUsers()[0].id;
  const codexHome = tenantPaths(tenantRoot, userId).codexHome;
  const sessions = path.join(codexHome, "sessions");
  const archived = path.join(codexHome, "archived_sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });
  const prefix = line("2026-09-12T00:00:00.000Z", "session_meta", { id: threadId, originator: "codex_exec", model_provider: "provider-a" })
    + line("2026-09-12T00:00:01.000Z", "turn_context", { turn_id: turnId, model: "model-a" });
  const usageLine = token("2026-09-12T00:00:02.000Z", 100, 40, 10, 3);
  fs.writeFileSync(path.join(sessions, `rollout-live-${threadId}.jsonl`), prefix + usageLine);
  const partialCopy = path.join(archived, `rollout-copy-${threadId}.jsonl`);
  fs.writeFileSync(partialCopy, prefix + usageLine.slice(0, -1));
  const sync = new RolloutUsageSynchronizer(loadConfig({ projectRoot: root, dataRoot: path.join(root, "data"), tenantRoot, hostMode: false }), db);

  try {
    const first = await sync.scanUser(userId);
    assert.equal(first.inserted, 1);
    assert.equal(db.listApiUsage(userId, new Date(0).toISOString()).length, 1);

    fs.appendFileSync(partialCopy, "\n");
    const second = await sync.scanUser(userId);
    assert.equal(second.unchanged, 1);
    assert.equal(second.updated, 0);
    assert.equal(db.listApiUsage(userId, new Date(0).toISOString()).length, 1);
  } finally {
    await sync.stop();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("API usage ledger migration preserves legacy rows and makes Web associations nullable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-usage-migration-"));
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(dataRoot, { recursive: true });
  const first = new AppDatabase(dataRoot, { username: "owner", passwordHash: "$2b$10$invalid", displayName: "Owner" }, false);
  const userId = first.listUsers()[0].id;
  const conversation = first.createConversation("55555555-5555-4555-8555-555555555555", "Legacy usage");
  const job = first.createJob("66666666-6666-4666-8666-666666666666", conversation.id);
  first.addApiUsage({
    id: "77777777-7777-4777-8777-777777777777", user_id: userId, job_id: job.id, conversation_id: conversation.id,
    provider_id: "provider-a", model_id: "model-a", input_tokens: 10, cached_input_tokens: 2,
    cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 1,
  });
  first.close();

  const sqlite = new DatabaseSync(path.join(dataRoot, "codex-web.sqlite"));
  sqlite.exec(`
    PRAGMA foreign_keys=OFF;
    ALTER TABLE api_usage RENAME TO api_usage_current;
    CREATE TABLE api_usage (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    INSERT INTO api_usage SELECT
      id,user_id,job_id,conversation_id,provider_id,model_id,input_tokens,cached_input_tokens,
      cache_write_input_tokens,output_tokens,reasoning_output_tokens,created_at
    FROM api_usage_current;
    DROP TABLE api_usage_current;
  `);
  sqlite.close();

  const migrated = new AppDatabase(dataRoot, { username: "owner", passwordHash: "$2b$10$invalid", displayName: "Owner" }, false);
  try {
    const columns = migrated.sqlite.prepare("PRAGMA table_info(api_usage)").all() as Array<{ name: string; notnull: number }>;
    assert.equal(columns.find((column) => column.name === "job_id")?.notnull, 0);
    assert.equal(columns.find((column) => column.name === "conversation_id")?.notnull, 0);
    assert.ok(columns.some((column) => column.name === "thread_id"));
    const rows = migrated.listApiUsage(userId, new Date(0).toISOString());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input_tokens, 10);
    assert.equal(rows[0].source_kind, "web");
  } finally {
    migrated.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
