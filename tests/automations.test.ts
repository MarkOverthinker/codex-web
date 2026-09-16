import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { AppDatabase, LEGACY_USER_ID } from "../server/db.js";
import { AutomationError, Automations, automationInput, nextDailyRun } from "../server/automations.js";
import type { AutomationInput } from "../src/automation-types.js";

const input: AutomationInput = { name: "Daily review", prompt: "Review the repository and write a report.", workingDir: null,
  time: "09:00", timeZone: "Asia/Shanghai", model: "test-model", reasoningEffort: "high", sandbox: "workspace-write", enabled: true };
const before = new Date("2026-09-16T00:00:00.000Z");
const due = new Date("2026-09-16T01:00:00.000Z");

function fixture(context: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automations-"));
  let db = new AppDatabase(root);
  let blocked = false;
  let invalid = false;
  let dispatches = 0;
  const dependencies = {
    validate(_user: string, task: AutomationInput) {
      if (invalid) throw new Error("Model no longer available");
      return { input: task, selection: { model: task.model, reasoningEffort: "high" as const, sandbox: task.sandbox } };
    },
    prepare() {}, blocked: () => blocked, dispatch: () => { dispatches++; }, onError: (error: unknown) => { throw error; },
  };
  let automations = new Automations(db, dependencies);
  context.after(() => { automations.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { get db() { return db; }, get automations() { return automations; }, get dispatches() { return dispatches; },
    block: () => { blocked = true; }, invalidate: () => { invalid = true; },
    reopen() { db.close(); db = new AppDatabase(root); automations = new Automations(db, dependencies); } };
}

test("daily schedule uses explicit zones and rolls over midnight", () => {
  assert.equal(nextDailyRun(before, "09:00", "Asia/Shanghai"), due.toISOString());
  assert.equal(nextDailyRun(due, "09:00", "Asia/Shanghai"), "2026-09-17T01:00:00.000Z");
  assert.equal(nextDailyRun(new Date("2026-09-16T23:59:45Z"), "00:00", "UTC"), "2026-09-17T00:00:00.000Z");
  assert.equal(nextDailyRun(before, "09:00", "Asia/Kathmandu"), "2026-09-16T03:15:00.000Z");
});

test("DST nonexistent times are skipped and repeated times run once per local day", () => {
  assert.equal(nextDailyRun(new Date("2026-03-08T05:00:00Z"), "02:30", "America/New_York"), "2026-03-09T06:30:00.000Z");
  assert.equal(nextDailyRun(new Date("2026-11-01T04:00:00Z"), "01:30", "America/New_York"), "2026-11-01T05:30:00.000Z");
  assert.equal(nextDailyRun(new Date("2026-11-01T05:30:00Z"), "01:30", "America/New_York", "2026-11-01"), "2026-11-02T06:30:00.000Z");
});

test("input rejects invalid or overlong fields, zones, times and unknown properties", () => {
  for (const change of [{ time: "24:00" }, { time: "9:00" }, { timeZone: "Invalid/Zone" }, { prompt: " " }, { name: "" },
    { prompt: "x".repeat(100001) }, { enabled: "true" }, { sandbox: "root" }, { userId: "another-user" }]) {
    assert.equal(automationInput.safeParse({ ...input, ...change }).success, false);
  }
  assert.equal(automationInput.safeParse(input).success, true);
});

test("due schedule atomically creates one conversation, fixed prompt, job and run", (context) => {
  const fixtureState = fixture(context);
  const task = fixtureState.automations.save(LEGACY_USER_ID, input, undefined, before);
  fixtureState.automations.tick(before);
  assert.equal(fixtureState.automations.runs(LEGACY_USER_ID).length, 0);
  fixtureState.automations.tick(due);
  fixtureState.automations.tick(due);
  const runs = fixtureState.automations.runs(LEGACY_USER_ID);
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.status, "queued");
  assert.equal(run.trigger, "scheduled");
  assert.deepEqual(run.snapshot, input);
  const conversation = fixtureState.db.getConversationForUser(run.conversationId!, LEGACY_USER_ID)!;
  assert.equal(conversation.title, "Daily review · 2026-09-16");
  assert.equal(conversation.title_source, "manual");
  assert.equal(conversation.agent_model, input.model);
  assert.equal(conversation.reasoning_effort, input.reasoningEffort);
  assert.equal(conversation.sandbox_mode, input.sandbox);
  assert.equal(fixtureState.db.listMessages(conversation.id)[0].content, input.prompt);
  assert.equal(fixtureState.db.getJob(run.jobId!)?.message_id, fixtureState.db.listMessages(conversation.id)[0].id);
  assert.equal(fixtureState.automations.get(LEGACY_USER_ID, task.id).nextRunAt, "2026-09-17T01:00:00.000Z");
  assert.equal(fixtureState.dispatches, 1);
});

test("restart catches up once without replaying every missed day", (context) => {
  const fixtureState = fixture(context);
  const task = fixtureState.automations.save(LEGACY_USER_ID, input, undefined, before);
  fixtureState.reopen();
  fixtureState.automations.tick(new Date("2026-09-20T12:00:00Z"));
  fixtureState.reopen();
  fixtureState.automations.tick(new Date("2026-09-20T12:01:00Z"));
  assert.equal(fixtureState.automations.runs(LEGACY_USER_ID).length, 1);
  assert.equal(fixtureState.automations.get(LEGACY_USER_ID, task.id).nextRunAt, "2026-09-21T01:00:00.000Z");
});

test("overlapping runs are recorded as skipped and job state remains live", (context) => {
  const fixtureState = fixture(context);
  const task = fixtureState.automations.save(LEGACY_USER_ID, input, undefined, before);
  fixtureState.automations.tick(due);
  const first = fixtureState.automations.runs(LEGACY_USER_ID)[0];
  fixtureState.automations.run(LEGACY_USER_ID, task.id, "manual", new Date("2026-09-16T02:00:00Z"));
  assert.equal(fixtureState.automations.runs(LEGACY_USER_ID)[0].status, "skipped");
  fixtureState.db.updateJob(first.jobId!, "completed");
  fixtureState.automations.tick(new Date("2026-09-17T01:00:00Z"));
  const runs = fixtureState.automations.runs(LEGACY_USER_ID);
  assert.equal(runs.length, 3);
  assert.equal(runs[2].status, "completed");
  assert.notEqual(runs[0].conversationId, first.conversationId);
});

test("failed validation is recorded without orphan conversations and advances schedule", (context) => {
  const fixtureState = fixture(context);
  const task = fixtureState.automations.save(LEGACY_USER_ID, input, undefined, before);
  fixtureState.invalidate();
  fixtureState.automations.tick(due);
  const run = fixtureState.automations.runs(LEGACY_USER_ID)[0];
  assert.equal(run.status, "failed");
  assert.equal(run.error, "Model no longer available");
  assert.equal(run.conversationId, null);
  assert.equal(fixtureState.db.sqlite.prepare("SELECT count(*) AS count FROM conversations").get()?.count, 0);
  assert.equal(fixtureState.automations.get(LEGACY_USER_ID, task.id).nextRunAt, "2026-09-17T01:00:00.000Z");
});

test("partial materialization rolls back while retaining the failed run", (context) => {
  const fixtureState = fixture(context);
  fixtureState.automations.save(LEGACY_USER_ID, input, undefined, before);
  fixtureState.db.createJob = () => { throw new Error("Simulated insert failure"); };
  fixtureState.automations.tick(due);
  assert.equal(fixtureState.automations.runs(LEGACY_USER_ID)[0].error, "Simulated insert failure");
  assert.equal(fixtureState.db.sqlite.prepare("SELECT count(*) AS count FROM conversations").get()?.count, 0);
  assert.equal(fixtureState.db.sqlite.prepare("SELECT count(*) AS count FROM messages").get()?.count, 0);
});

test("pause, resume, edits and deletion retain immutable run snapshots", (context) => {
  const fixtureState = fixture(context);
  const task = fixtureState.automations.save(LEGACY_USER_ID, input, undefined, before);
  fixtureState.automations.setEnabled(LEGACY_USER_ID, task.id, false, before);
  fixtureState.automations.tick(due);
  assert.equal(fixtureState.automations.runs(LEGACY_USER_ID).length, 0);
  fixtureState.automations.setEnabled(LEGACY_USER_ID, task.id, true, new Date("2026-09-17T02:00:00Z"));
  assert.equal(fixtureState.automations.get(LEGACY_USER_ID, task.id).nextRunAt, "2026-09-18T01:00:00.000Z");
  fixtureState.automations.run(LEGACY_USER_ID, task.id, "manual", new Date("2026-09-17T03:00:00Z"));
  fixtureState.automations.save(LEGACY_USER_ID, { ...input, prompt: "Updated prompt" }, task.id, new Date("2026-09-17T04:00:00Z"));
  assert.equal(fixtureState.automations.runs(LEGACY_USER_ID)[0].snapshot.prompt, input.prompt);
  fixtureState.automations.remove(LEGACY_USER_ID, task.id);
  assert.equal(fixtureState.automations.list(LEGACY_USER_ID).length, 0);
  assert.equal(fixtureState.automations.runs(LEGACY_USER_ID).length, 1);
  assert.throws(() => fixtureState.automations.run(LEGACY_USER_ID, task.id), /不存在/);
});

test("disabled users and maintenance cannot launch new automated work", (context) => {
  const fixtureState = fixture(context);
  const task = fixtureState.automations.save(LEGACY_USER_ID, input, undefined, before);
  fixtureState.db.sqlite.prepare("UPDATE users SET status='disabled' WHERE id=?").run(LEGACY_USER_ID);
  fixtureState.automations.tick(due);
  assert.equal(fixtureState.automations.runs(LEGACY_USER_ID).length, 0);
  assert.throws(() => fixtureState.automations.run(LEGACY_USER_ID, task.id), /停用/);
  fixtureState.db.sqlite.prepare("UPDATE users SET status='active' WHERE id=?").run(LEGACY_USER_ID);
  fixtureState.block();
  fixtureState.automations.tick(due);
  assert.throws(() => fixtureState.automations.run(LEGACY_USER_ID, task.id), (error: unknown) => error instanceof AutomationError && error.status === 503);
  assert.equal(fixtureState.automations.get(LEGACY_USER_ID, task.id).nextRunAt, due.toISOString());
});

test("run history tolerates deleted conversations and jobs", (context) => {
  const fixtureState = fixture(context);
  fixtureState.automations.save(LEGACY_USER_ID, input, undefined, before);
  fixtureState.automations.tick(due);
  const run = fixtureState.automations.runs(LEGACY_USER_ID)[0];
  fixtureState.db.sqlite.prepare("DELETE FROM conversations WHERE id=?").run(run.conversationId!);
  const history = fixtureState.automations.runs(LEGACY_USER_ID)[0];
  assert.equal(history.conversationId, null);
  assert.equal(history.status, "unavailable");
  assert.equal(history.snapshot.prompt, input.prompt);
});

test("durable daily uniqueness prevents duplicate occurrences after a scheduler restart", (context) => {
  const fixtureState = fixture(context);
  const task = fixtureState.automations.save(LEGACY_USER_ID, input, undefined, before);
  fixtureState.automations.tick(due);
  fixtureState.reopen();
  fixtureState.db.sqlite.prepare("UPDATE automations SET next_run_at=? WHERE id=?").run(due.toISOString(), task.id);
  fixtureState.automations.tick(due);
  assert.equal(fixtureState.automations.runs(LEGACY_USER_ID).length, 1);
  assert.equal(fixtureState.automations.get(LEGACY_USER_ID, task.id).nextRunAt, "2026-09-17T01:00:00.000Z");
});

test("scheduler starts immediately, start is idempotent and stop releases its timer", (context) => {
  const fixtureState = fixture(context);
  let ticks = 0;
  fixtureState.automations.tick = () => { ticks++; };
  fixtureState.automations.start();
  fixtureState.automations.start();
  assert.equal(ticks, 1);
  fixtureState.automations.stop();
  fixtureState.automations.start();
  assert.equal(ticks, 2);
  fixtureState.automations.stop();
});
