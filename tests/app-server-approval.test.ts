import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startAppServerTurn } from "../server/app-server-turn.js";
import { DEFAULT_OPTIONAL_AGENT_CAPABILITIES } from "../server/optional-capabilities.js";
import { buildProcessJournal } from "../src/process-journal.js";
import { mergeJobEvents, PROCESS_EVENT_WINDOW } from "../src/recovery.js";
import { collectReasoningSteps } from "../src/reasoning-steps.js";
import type { JobEvent } from "../src/api.js";

function withTimeout<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("app-server approval test timed out")), timeoutMs)),
  ]);
}

test("app-server uses automatic approval review and rejects residual manual approvals", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-auto-review-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-app-server.mjs");
  const capturePath = path.join(root, "capture.json");
  const workspace = path.join(root, "workspace");
  const library = path.join(root, "library");
  fs.mkdirSync(workspace);
  fs.mkdirSync(library);
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const capturePath = process.env.CAPTURE_PATH;
const capture = { argv: process.argv.slice(2), messages: [], approvalResponse: null };
const persist = () => fs.writeFileSync(capturePath, JSON.stringify(capture));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
persist();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  capture.messages.push(message);
  if (message.id === "approval-1" && message.result) capture.approvalResponse = message.result;
  persist();
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-1" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "item/autoApprovalReview/started", params: {
      threadId: "thread-1", turnId: "turn-1", reviewId: "review-1", targetItemId: "item-1", startedAtMs: 1,
      review: { status: "inProgress", riskLevel: null, userAuthorization: null, rationale: null },
      action: { type: "command", source: "unifiedExec", command: "npm test", cwd: process.cwd() },
    } });
    send({ method: "item/autoApprovalReview/completed", params: {
      threadId: "thread-1", turnId: "turn-1", reviewId: "review-1", targetItemId: "item-1", startedAtMs: 1, completedAtMs: 2,
      decisionSource: "agent",
      review: { status: "approved", riskLevel: "medium", userAuthorization: "high", rationale: "The requested test command is scoped to the workspace." },
      action: { type: "command", source: "unifiedExec", command: "npm test", cwd: process.cwd() },
    } });
    send({ method: "item/commandExecution/requestApproval", id: "approval-1", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-2", startedAtMs: 3, command: "touch /outside", cwd: process.cwd(),
    } });
  }
  if (message.id === "approval-1" && message.result) {
    send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed", error: null } } });
  }
});
`, { mode: 0o755 });

  const progress: JobEvent[] = [];
  let threadId = "";
  const controller = new AbortController();
  const execution = startAppServerTurn({
    executablePath: executable,
    cwd: workspace,
    env: { ...process.env, CAPTURE_PATH: capturePath },
    threadId: null,
    prompt: "run tests",
    imagePaths: [],
    model: "test-model",
    reasoningEffort: "medium",
    library,
    shellEnvironment: {},
    networkAccessEnabled: false,
    webSearchMode: "cached",
    optionalCapabilities: DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
  }, {
    signal: controller.signal,
    onThreadStarted: (value) => { threadId = value; },
    onProgress: (payload) => progress.push(payload as JobEvent),
  });

  assert.equal(await withTimeout(execution.result), "");
  assert.equal(threadId, "thread-1");
  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8")) as {
    argv: string[];
    messages: Array<{ method?: string; params?: Record<string, unknown> }>;
    approvalResponse: unknown;
  };
  assert.deepEqual(capture.argv, [
    "app-server", "--listen", "stdio://",
    "-c", 'approval_policy="on-request"',
    "-c", 'approvals_reviewer="auto_review"',
    "-c", 'sandbox_mode="workspace-write"',
  ]);
  const threadStart = capture.messages.find((message) => message.method === "thread/start")?.params;
  assert.equal(threadStart?.approvalPolicy, "on-request");
  assert.equal(threadStart?.approvalsReviewer, "auto_review");
  assert.equal(threadStart?.sandbox, "workspace-write");
  assert.deepEqual((threadStart?.config as { sandbox_workspace_write?: { writable_roots?: string[] } })?.sandbox_workspace_write?.writable_roots, [workspace, library]);
  const turnStart = capture.messages.find((message) => message.method === "turn/start")?.params;
  assert.equal(turnStart?.approvalPolicy, "on-request");
  assert.equal(turnStart?.approvalsReviewer, "auto_review");
  assert.deepEqual(capture.approvalResponse, { decision: "decline" });

  const completedReview = progress.find((event) => event.reviewId === "review-1" && event.reviewStatus === "approved");
  assert.equal(completedReview?.kind, "approval");
  assert.equal(completedReview?.riskLevel, "medium");
  assert.match(completedReview?.detail ?? "", /审核依据/);
  assert.ok(progress.some((event) => event.reviewId === "fallback:approval-1" && event.reviewStatus === "denied"));
});

test("automatic approval reviews replace live entries and remain in completed reasoning", () => {
  const activities: JobEvent[] = [
    {
      seq: 1,
      kind: "approval",
      label: "正在自动审核请求",
      detail: "审核中",
      reviewId: "review-1",
      reviewStatus: "inProgress",
      steps: [{ id: "approval:review-1", title: "请求审核：执行命令", detail: "审核中" }],
    },
    {
      seq: 2,
      kind: "approval",
      label: "自动审核已批准请求",
      detail: "已批准",
      reviewId: "review-1",
      reviewStatus: "approved",
      steps: [{ id: "approval:review-1", title: "请求审核：执行命令", detail: "已批准" }],
    },
  ];
  const journal = buildProcessJournal(activities);
  assert.equal(journal.length, 1);
  assert.equal(journal[0].reviewStatus, "approved");
  assert.deepEqual(collectReasoningSteps(activities), [
    { id: "approval:review-1", title: "请求审核：执行命令", detail: "已批准" },
  ]);

  const overflow = Array.from({ length: PROCESS_EVENT_WINDOW + 5 }, (_, index): JobEvent => ({
    seq: index + 3,
    kind: "command",
    label: "本机处理步骤完成",
    detail: `command-${index}`,
  }));
  const merged = mergeJobEvents([], [...activities, ...overflow]);
  assert.ok(merged.some((event) => event.reviewId === "review-1" && event.reviewStatus === "approved"));
  assert.ok(!merged.some((event) => event.reviewId === "review-1" && event.reviewStatus === "inProgress"));
});
