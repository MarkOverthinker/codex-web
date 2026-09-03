import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startAppServerTurn, summarizeAppServerItem } from "../server/app-server-turn.js";
import type { TokenUsage } from "../server/billing.js";
import { DEFAULT_OPTIONAL_AGENT_CAPABILITIES } from "../server/optional-capabilities.js";
import { isRetryableUpstreamError } from "../server/retry-policy.js";
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
    modelContextWindow: 128_000,
    autoCompactTokenLimit: 115_200,
    modelProvider: "chat-provider",
    runtimeModelProvider: {
      id: "chat-provider",
      name: "Chat Provider",
      baseUrl: "http://127.0.0.1:43123/v1",
      envKey: "CODEX_WEB_RELAY_TOKEN",
    },
    sandboxMode: "workspace-write",
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
    "-c", "model_context_window=128000",
    "-c", "model_auto_compact_token_limit=115200",
    "-c", 'model_providers.chat-provider.name="Chat Provider"',
    "-c", 'model_providers.chat-provider.base_url="http://127.0.0.1:43123/v1"',
    "-c", 'model_providers.chat-provider.wire_api="responses"',
    "-c", 'model_providers.chat-provider.env_key="CODEX_WEB_RELAY_TOKEN"',
    "-c", 'model_providers.chat-provider.requires_openai_auth=false',
    "-c", 'model_providers.chat-provider.supports_websockets=false',
  ]);
  const threadStart = capture.messages.find((message) => message.method === "thread/start")?.params;
  assert.equal(threadStart?.modelProvider, "chat-provider");
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

test("app-server preserves a retryable error notification when it exits before completion", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-app-server-429-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-app-server.mjs");
  const workspace = path.join(root, "workspace");
  const library = path.join(root, "library");
  fs.mkdirSync(workspace);
  fs.mkdirSync(library);
  fs.writeFileSync(executable, `#!/usr/bin/env node
import readline from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-429" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-429" } } });
    send({ method: "error", params: { error: { statusCode: 429, message: "Too Many Requests" } } });
    setTimeout(() => process.exit(1), 10);
  }
});
`, { mode: 0o755 });

  const controller = new AbortController();
  const execution = startAppServerTurn({
    executablePath: executable,
    cwd: workspace,
    env: process.env,
    threadId: null,
    prompt: "retry after rate limit",
    imagePaths: [],
    model: "test-model",
    reasoningEffort: "medium",
    sandboxMode: "workspace-write",
    library,
    shellEnvironment: {},
    networkAccessEnabled: false,
    webSearchMode: "cached",
    optionalCapabilities: DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
  }, {
    signal: controller.signal,
    onThreadStarted: () => undefined,
    onProgress: () => undefined,
  });

  await assert.rejects(withTimeout(execution.result), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(isRetryableUpstreamError(error), true);
    return true;
  });
});

test("app-server records cumulative token usage updates when a turn completes", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-token-usage-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-app-server.mjs");
  const workspace = path.join(root, "workspace");
  const library = path.join(root, "library");
  fs.mkdirSync(workspace);
  fs.mkdirSync(library);
  fs.writeFileSync(executable, `#!/usr/bin/env node
import readline from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-usage" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-usage" } } });
    send({ method: "thread/tokenUsage/updated", params: {
      threadId: "thread-usage", turnId: "turn-usage",
      tokenUsage: {
        total: { totalTokens: 145, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 3, outputTokens: 40, reasoningOutputTokens: 5 },
        last: { totalTokens: 145, inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 3, outputTokens: 40, reasoningOutputTokens: 5 },
        modelContextWindow: 128000,
      },
    } });
    send({ method: "thread/tokenUsage/updated", params: {
      threadId: "thread-usage", turnId: "turn-usage",
      tokenUsage: {
        total: { totalTokens: 220, inputTokens: 160, cachedInputTokens: 30, cacheWriteInputTokens: 3, outputTokens: 55, reasoningOutputTokens: 7 },
        last: { totalTokens: 75, inputTokens: 60, cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 15, reasoningOutputTokens: 2 },
        modelContextWindow: 128000,
      },
    } });
    send({ method: "turn/completed", params: { threadId: "thread-usage", turn: { id: "turn-usage", status: "completed", error: null } } });
  }
});
`, { mode: 0o755 });

  const controller = new AbortController();
  let usage: TokenUsage | undefined;
  let contextUsage: { usedTokens: number; contextWindow: number | null } | undefined;
  const execution = startAppServerTurn({
    executablePath: executable,
    cwd: workspace,
    env: process.env,
    threadId: null,
    prompt: "record usage",
    imagePaths: [],
    model: "test-model",
    reasoningEffort: "medium",
    autoCompactTokenLimit: 115_200,
    sandboxMode: "workspace-write",
    library,
    shellEnvironment: {},
    networkAccessEnabled: false,
    webSearchMode: "cached",
    optionalCapabilities: DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
  }, {
    signal: controller.signal,
    onThreadStarted: () => undefined,
    onProgress: () => undefined,
    onUsage: (value) => { usage = value; },
    onContextUsage: (value) => { contextUsage = value; },
  });

  assert.equal(await withTimeout(execution.result), "");
  assert.deepEqual(usage, {
    input_tokens: 160,
    cached_input_tokens: 30,
    cache_write_input_tokens: 3,
    output_tokens: 55,
    reasoning_output_tokens: 7,
  });
  assert.deepEqual(contextUsage, { usedTokens: 75, contextWindow: 115_200 });
});

test("app-server forwards reasoning summary and raw-content deltas", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-reasoning-deltas-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-app-server.mjs");
  const workspace = path.join(root, "workspace");
  const library = path.join(root, "library");
  fs.mkdirSync(workspace);
  fs.mkdirSync(library);
  fs.writeFileSync(executable, `#!/usr/bin/env node
import readline from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-reasoning" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-reasoning" } } });
    send({ method: "item/started", params: { item: { id: "reasoning-1", type: "reasoning", summary: [], content: [] } } });
    send({ method: "item/reasoning/summaryTextDelta", params: { itemId: "reasoning-1", summaryIndex: 0, delta: "先核对数据口径" } });
    send({ method: "item/reasoning/summaryPartAdded", params: { itemId: "reasoning-1", summaryIndex: 1 } });
    send({ method: "item/reasoning/summaryTextDelta", params: { itemId: "reasoning-1", summaryIndex: 1, delta: "再验证汇总结果" } });
    send({ method: "item/completed", params: { item: { id: "reasoning-1", type: "reasoning", summary: [], content: [] } } });
    send({ method: "item/started", params: { item: { id: "reasoning-2", type: "reasoning", summary: [], content: [] } } });
    send({ method: "item/reasoning/textDelta", params: { itemId: "reasoning-2", contentIndex: 0, delta: "原始推理片段" } });
    send({ method: "item/completed", params: { item: { id: "reasoning-2", type: "reasoning", summary: [], content: [] } } });
    send({ method: "turn/completed", params: { turn: { id: "turn-reasoning", status: "completed", error: null } } });
  }
});
`, { mode: 0o755 });

  const progress: JobEvent[] = [];
  const controller = new AbortController();
  const execution = startAppServerTurn({
    executablePath: executable,
    cwd: workspace,
    env: process.env,
    threadId: null,
    prompt: "inspect the data",
    imagePaths: [],
    model: "gpt-reasoning-test",
    reasoningEffort: "high",
    sandboxMode: "workspace-write",
    library,
    shellEnvironment: {},
    networkAccessEnabled: false,
    webSearchMode: "cached",
    optionalCapabilities: DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
  }, {
    signal: controller.signal,
    onThreadStarted: () => undefined,
    onProgress: (payload) => progress.push(payload as JobEvent),
  });

  assert.equal(await withTimeout(execution.result), "");
  const summary = progress.find((event) => event.detail === "先核对数据口径\n\n再验证汇总结果");
  assert.deepEqual(summary, {
    kind: "reasoning",
    label: "思考过程",
    detail: "先核对数据口径\n\n再验证汇总结果",
    steps: [
      { title: "先核对数据口径", detail: "先核对数据口径" },
      { title: "再验证汇总结果", detail: "再验证汇总结果" },
    ],
  });
  assert.ok(progress.some((event) => event.kind === "reasoning" && event.detail === "原始推理片段"));
});

test("app-server forks a thread before the edited turn and reports the new turn", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-thread-fork-"));
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
const capture = { messages: [] };
const persist = () => fs.writeFileSync(capturePath, JSON.stringify(capture));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
persist();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  capture.messages.push(message);
  persist();
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/fork") send({ id: message.id, result: { thread: { id: "forked-thread" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "forked-turn" } } });
    send({ method: "turn/completed", params: { turn: { id: "forked-turn", status: "completed", error: null } } });
  }
});
`, { mode: 0o755 });

  const started = { threadId: "", turnId: "" };
  const controller = new AbortController();
  const execution = startAppServerTurn({
    executablePath: executable,
    cwd: workspace,
    env: { ...process.env, CAPTURE_PATH: capturePath },
    threadId: "source-thread",
    forkBeforeTurnId: "source-turn",
    prompt: "edited prompt",
    imagePaths: [],
    model: "test-model",
    reasoningEffort: "medium",
    sandboxMode: "workspace-write",
    library,
    shellEnvironment: {},
    networkAccessEnabled: false,
    webSearchMode: "cached",
    optionalCapabilities: DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
  }, {
    signal: controller.signal,
    onThreadStarted: (threadId) => { started.threadId = threadId; },
    onTurnStarted: (turnId) => { started.turnId = turnId; },
    onProgress: () => undefined,
  });

  assert.equal(await withTimeout(execution.result), "");
  assert.deepEqual(started, { threadId: "forked-thread", turnId: "forked-turn" });
  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8")) as { messages: Array<{ method?: string; params?: Record<string, unknown> }> };
  const fork = capture.messages.find((message) => message.method === "thread/fork");
  assert.equal(fork?.params?.threadId, "source-thread");
  assert.equal(fork?.params?.beforeTurnId, "source-turn");
  assert.equal(fork?.params?.deferGoalContinuation, true);
  assert.equal(fork?.params?.model, "test-model");
  assert.equal(fork?.params?.cwd, workspace);
  assert.deepEqual(fork?.params?.runtimeWorkspaceRoots, [workspace, library]);
  assert.equal(fork?.params?.approvalPolicy, "on-request");
  assert.equal(fork?.params?.approvalsReviewer, "auto_review");
  assert.equal(fork?.params?.sandbox, "workspace-write");
  assert.equal(fork?.params?.excludeTurns, true);
  const forkConfig = fork?.params?.config as Record<string, unknown> | undefined;
  assert.deepEqual(forkConfig?.sandbox_workspace_write, { writable_roots: [workspace, library], network_access: false });
  assert.deepEqual(forkConfig?.shell_environment_policy, { inherit: "core", set: {} });
  assert.equal(forkConfig?.model_reasoning_summary, "auto");
  assert.equal(forkConfig?.hide_agent_reasoning, false);
  assert.equal(forkConfig?.show_raw_agent_reasoning, true);
  assert.equal(forkConfig?.web_search, "cached");
  assert.equal(capture.messages.some((message) => message.method === "thread/start" || message.method === "thread/resume"), false);
});
test("app-server forks a thread through the selected turn with lastTurnId", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-last-turn-fork-"));
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
const capture = { messages: [] };
const persist = () => fs.writeFileSync(capturePath, JSON.stringify(capture));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
persist();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  capture.messages.push(message);
  persist();
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/fork") send({ id: message.id, result: { thread: { id: "forked-thread" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "forked-turn" } } });
    send({ method: "turn/completed", params: { turn: { id: "forked-turn", status: "completed", error: null } } });
  }
});
`, { mode: 0o755 });

  const controller = new AbortController();
  const execution = startAppServerTurn({
    executablePath: executable,
    cwd: workspace,
    env: { ...process.env, CAPTURE_PATH: capturePath },
    threadId: "source-thread",
    forkLastTurnId: "source-turn",
    prompt: "side question",
    imagePaths: [],
    model: "test-model",
    reasoningEffort: "medium",
    sandboxMode: "workspace-write",
    library,
    shellEnvironment: {},
    networkAccessEnabled: false,
    webSearchMode: "cached",
    optionalCapabilities: DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
  }, {
    signal: controller.signal,
    onThreadStarted: () => undefined,
    onProgress: () => undefined,
  });

  assert.equal(await withTimeout(execution.result), "");
  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8")) as { messages: Array<{ method?: string; params?: Record<string, unknown> }> };
  const fork = capture.messages.find((message) => message.method === "thread/fork");
  assert.equal(fork?.params?.threadId, "source-thread");
  assert.equal(fork?.params?.lastTurnId, "source-turn");
  assert.equal("beforeTurnId" in (fork?.params ?? {}), false);
  assert.equal(fork?.params?.deferGoalContinuation, true);
  assert.equal(capture.messages.some((message) => message.method === "thread/start" || message.method === "thread/resume"), false);
});

test("app-server passes danger-full-access through and skips workspace writable roots", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-danger-access-"));
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
const capture = { argv: process.argv.slice(2), messages: [] };
const persist = () => fs.writeFileSync(capturePath, JSON.stringify(capture));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
persist();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  capture.messages.push(message);
  persist();
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-danger" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-danger" } } });
    send({ method: "turn/completed", params: { turn: { id: "turn-danger", status: "completed", error: null } } });
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
    prompt: "run with full access",
    imagePaths: [],
    model: "test-model",
    reasoningEffort: "medium",
    sandboxMode: "danger-full-access",
    library,
    shellEnvironment: {},
    networkAccessEnabled: true,
    webSearchMode: "cached",
    optionalCapabilities: DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
  }, {
    signal: controller.signal,
    onThreadStarted: (value) => { threadId = value; },
    onProgress: (payload) => progress.push(payload as JobEvent),
  });

  assert.equal(await withTimeout(execution.result), "");
  assert.equal(threadId, "thread-danger");
  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8")) as {
    argv: string[];
    messages: Array<{ method?: string; params?: Record<string, unknown> }>;
  };
  assert.deepEqual(capture.argv, [
    "app-server", "--listen", "stdio://",
    "-c", 'approval_policy="on-request"',
    "-c", 'approvals_reviewer="auto_review"',
    "-c", 'sandbox_mode="danger-full-access"',
  ]);
  const threadStart = capture.messages.find((message) => message.method === "thread/start")?.params;
  assert.equal(threadStart?.sandbox, "danger-full-access");
  const threadConfig = threadStart?.config as Record<string, unknown>;
  assert.equal("sandbox_workspace_write" in threadConfig, false);
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

test("app-server subagent items become durable work-journal activities", () => {
  const spawn = summarizeAppServerItem({
    type: "collabAgentToolCall",
    id: "collab-1",
    tool: "spawnAgent",
    status: "inProgress",
    senderThreadId: "parent-thread",
    receiverThreadIds: ["child-thread"],
    prompt: "检查 API 路由并汇报风险",
    model: "gpt-5.4",
    reasoningEffort: "high",
    agentsStates: { "child-thread": { status: "running" } },
  }, false) as JobEvent;
  const activity = summarizeAppServerItem({
    type: "subAgentActivity",
    id: "activity-1",
    kind: "completed",
    agentThreadId: "child-thread",
    agentPath: "主线程/子代理 1",
  }, true) as JobEvent;

  assert.equal(spawn.kind, "subagent");
  assert.equal(spawn.label, "正在启动子代理");
  assert.match(spawn.detail ?? "", /检查 API 路由并汇报风险/);
  assert.deepEqual(spawn.agentThreadIds, ["child-thread"]);
  assert.equal(activity.label, "子代理已完成工作");
  assert.match(activity.detail ?? "", /主线程\/子代理 1/);
  assert.equal(buildProcessJournal([spawn, activity]).length, 2);
});
