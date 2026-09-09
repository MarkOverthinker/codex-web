import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate as nextTick } from "node:timers/promises";
import { startAppServerTurn, type ContextUsage } from "../server/app-server-turn.js";
import type { TokenUsage } from "../server/billing.js";
import { DEFAULT_OPTIONAL_AGENT_CAPABILITIES } from "../server/optional-capabilities.js";
import type { JobEvent } from "../src/api.js";

const scenarios = [
  { name: "child completes without text", status: "completed", started: true, text: false, turnId: "child-turn" },
  { name: "child fails", status: "failed", started: true, text: true, turnId: "child-turn" },
  { name: "child is interrupted", status: "interrupted", started: true, text: true, turnId: "child-turn" },
  { name: "child shares the parent turn id", status: "completed", started: true, text: true, turnId: "parent-turn" },
  { name: "child finishes after the parent answer", status: "completed", started: false, text: true, turnId: "child-turn" },
  { name: "parent is interrupted while child runs", status: "running", started: true, text: true, turnId: "child-turn", interrupt: true },
];

for (const scenario of scenarios) {
  test(`app-server isolates thread notifications: ${scenario.name}`, { timeout: 5_000 }, async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-thread-isolation-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const executable = path.join(root, "fake-app-server.mjs");
    const capturePath = path.join(root, "requests.jsonl");
    fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const scenario = ${JSON.stringify(scenario)};
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const notify = (method, params, threadId = "parent-thread", turnId = "parent-turn") => send({ method, params: { threadId, turnId, ...params } });
const item = (value, threadId, turnId) => notify("item/completed", { item: value }, threadId, turnId);
const usage = (threadId, turnId, count) => notify("thread/tokenUsage/updated", {
  tokenUsage: { last: { inputTokens: count, totalTokens: count }, modelContextWindow: 1000 },
}, threadId, turnId);
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(process.env.CAPTURE_PATH, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "parent-thread" } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "parent-turn" } } });
    setTimeout(() => {
      notify("turn/started", { turn: { id: "parent-turn", status: "inProgress" } });
      item({ type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child-thread"] });
      usage("parent-thread", "parent-turn", 10);
      if (!scenario.started) item({ type: "agentMessage", id: "answer", text: "parent answer" });
      if (scenario.started) notify("turn/started", { turn: { id: scenario.turnId, status: "inProgress" } }, "child-thread", scenario.turnId);
      notify("item/reasoning/summaryTextDelta", { itemId: "reasoning", summaryIndex: 0, delta: "child-only reasoning" }, "child-thread", scenario.turnId);
      item({ type: "commandExecution", command: "child-only command", status: "completed" }, "child-thread", scenario.turnId);
      notify("error", { error: { message: "child-only error" } }, "child-thread", scenario.turnId);
      notify("item/autoApprovalReview/started", { reviewId: "child-review", review: { status: "inProgress" } }, "child-thread", scenario.turnId);
      usage("child-thread", scenario.turnId, 900);
      if (scenario.text) item({ type: "agentMessage", id: "child-answer", text: "child-only answer" }, "child-thread", scenario.turnId);
      if (scenario.status !== "running") notify("turn/completed", { turn: { id: scenario.turnId, status: scenario.status, error: scenario.status === "failed" ? { message: "child-only failure" } : null } }, "child-thread", scenario.turnId);
      item({ type: "commandExecution", command: "parent checkpoint", status: "completed" });
    }, 10);
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: "parent-turn" } });
    setTimeout(() => {
      notify("item/reasoning/summaryTextDelta", { itemId: "reasoning", summaryIndex: 0, delta: "parent reasoning" });
      item({ type: "reasoning", id: "reasoning", summary: [], content: [] });
      if (scenario.started) item({ type: "agentMessage", id: "answer", text: "parent answer" });
      notify("turn/completed", { turn: { id: "parent-turn", status: "completed", error: null } });
      item({ type: "agentMessage", id: "late", text: "late parent event" });
    }, 10);
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    notify("turn/completed", { turn: { id: message.params.turnId, status: "interrupted", error: null } });
  }
});
`, { mode: 0o755 });

    const progress: JobEvent[] = [];
    const usages: TokenUsage[] = [];
    const contexts: ContextUsage[] = [];
    const threads: string[] = [];
    const turns: string[] = [];
    let reachedCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => { reachedCheckpoint = resolve; });
    const controller = new AbortController();
    const execution = startAppServerTurn({
      executablePath: executable,
      cwd: root,
      env: { ...process.env, CAPTURE_PATH: capturePath },
      threadId: null,
      prompt: "delegate a task",
      imagePaths: [],
      model: "test-model",
      reasoningEffort: "medium",
      sandboxMode: "workspace-write",
      library: root,
      shellEnvironment: {},
      networkAccessEnabled: false,
      webSearchMode: "cached",
      optionalCapabilities: DEFAULT_OPTIONAL_AGENT_CAPABILITIES,
    }, {
      signal: controller.signal,
      onThreadStarted: (threadId) => threads.push(threadId),
      onTurnStarted: (turnId) => turns.push(turnId),
      onProgress: (payload) => {
        const event = payload as JobEvent;
        progress.push(event);
        if (event.detail === "parent checkpoint") reachedCheckpoint();
      },
      onUsage: (usage) => usages.push(usage),
      onContextUsage: (usage) => contexts.push(usage),
    });
    let settled = false;
    void execution.result.then(() => { settled = true; }, () => { settled = true; });
    context.after(async () => {
      controller.abort();
      await execution.result.catch(() => undefined);
    });

    await Promise.race([checkpoint, execution.result]);
    await nextTick();
    assert.equal(settled, false, "child lifecycle must not settle the parent task");
    assert.deepEqual(contexts, [{ usedTokens: 10, contextWindow: 1000 }]);
    assert.equal(progress.some((event) => event.kind === "subagent"), true);
    assert.doesNotMatch(JSON.stringify(progress), /child-only|child-review/);
    if (scenario.interrupt) {
      execution.interrupt();
      await assert.rejects(execution.result, { name: "AbortError" });
    } else {
      assert.equal(await execution.steer("continue parent"), "parent-turn");
      assert.equal(await execution.result, "parent answer");
      assert.equal(usages.length, 1);
      assert.equal(usages[0].input_tokens, 10);
      assert.doesNotMatch(JSON.stringify(progress), /child-only|late parent event/);
      assert.match(JSON.stringify(progress), /parent reasoning/);
    }
    assert.deepEqual(threads, ["parent-thread"]);
    assert.deepEqual(turns, ["parent-turn"]);
    const requests = fs.readFileSync(capturePath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    const control = requests.find((request) => request.method === (scenario.interrupt ? "turn/interrupt" : "turn/steer"));
    assert.equal(control?.params?.threadId, "parent-thread");
    assert.equal(control?.params?.[scenario.interrupt ? "turnId" : "expectedTurnId"], "parent-turn");
  });
}
