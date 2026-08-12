import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { AppDatabase } from "../server/db.js";

function runIdleCheck(dataRoot: string): { idle: boolean; running: number; error?: string } {
  const result = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "scripts", "check-codex-web-idle.mjs")],
    { env: { ...process.env, CODEX_WEB_DATA_ROOT: dataRoot }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split("\n").find((candidate) => candidate.trim().startsWith("{"));
  assert.ok(line, "idle check must print a JSON line");
  return JSON.parse(line) as { idle: boolean; running: number; error?: string };
}

test("idle check reports running jobs and only passes once they finish", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-idle-check-test-"));
  const dataRoot = path.join(root, "data");
  const db = new AppDatabase(dataRoot);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const conversationId = crypto.randomUUID();
  db.createConversation(conversationId, "test");
  const jobId = crypto.randomUUID();
  db.createJob(jobId, conversationId);
  db.updateJob(jobId, "running");

  const busy = runIdleCheck(dataRoot);
  assert.equal(busy.idle, false);
  assert.equal(busy.running, 1);

  db.finishJob(jobId, conversationId, "completed");
  const idle = runIdleCheck(dataRoot);
  assert.equal(idle.idle, true);
  assert.equal(idle.running, 0);
});

test("idle check fails closed when the database cannot be verified", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cww-idle-check-missing-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = runIdleCheck(path.join(root, "data"));
  assert.equal(result.idle, false);
  assert.equal(result.running, -1);
  assert.match(result.error ?? "", /database not found/);
});
