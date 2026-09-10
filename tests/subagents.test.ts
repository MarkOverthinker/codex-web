import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JobEvent } from "../src/api";
import { collectSubagents } from "../src/subagents";
import { SubagentPanel } from "../src/subagent-panel";
import { mergeJobEvents } from "../src/recovery";
import { summarizeAppServerItem } from "../server/app-server-turn";

const spawn: JobEvent = { seq: 1, kind: "subagent", subagentTool: "spawnAgent", subagentStatus: "completed", agentThreadIds: ["child"], agentPrompt: "检查路由" };

test("spawn completion and wait completion do not imply child completion", () => {
  assert.equal(collectSubagents([spawn], true)[0].status, "running");
  const wait = { ...spawn, seq: 2, subagentTool: "wait" };
  assert.equal(collectSubagents([spawn, wait], true)[0].status, "running");
  assert.equal(collectSubagents([spawn, wait], false)[0].status, "unconfirmed");
});

test("structured states aggregate multiple agents and activity updates by thread", () => {
  const event: JobEvent = { kind: "subagent", agentStates: { child: "completed", second: "errored" } };
  const agents = collectSubagents([spawn, event], true);
  assert.equal(agents.length, 2);
  assert.equal(agents[0].status, "completed");
  assert.equal(agents[0].prompt, "检查路由");
  assert.equal(agents[1].status, "errored");
  assert.equal(collectSubagents([spawn, { kind: "subagent", agentThreadId: "child", subagentActivity: "completed" }], false)[0].status, "completed");
  assert.equal(collectSubagents([{ ...spawn, subagentTool: "wait" }], true)[0].status, "unknown");
});

test("subagent snapshots survive rolling events and duplicate replay", () => {
  const events: JobEvent[] = Array.from({ length: 100 }, (_, index) => ({ seq: index + 3, kind: "command" }));
  const completed: JobEvent = { seq: 2, kind: "subagent", agentStates: { child: "completed" } };
  const merged = mergeJobEvents([spawn, completed], events);
  assert.equal(collectSubagents(merged, false)[0].status, "completed");
  assert.deepEqual(mergeJobEvents(merged, [spawn, completed]), merged);
});

test("server emits structured agent state rather than just display text", () => {
  const event = summarizeAppServerItem({ type: "collabAgentToolCall", tool: "wait", status: "completed", receiverThreadIds: ["child"], prompt: "检查路由", agentsStates: { child: { status: "running" } } }, true) as JobEvent;
  assert.deepEqual(event.agentStates, { child: "running" });
  assert.equal(event.agentPrompt, "检查路由");
  assert.equal(collectSubagents([event], true)[0].status, "running");
});

test("panel renders dedicated counts, details and terminal statuses; empty tasks stay hidden", () => {
  const render = (events: JobEvent[], active = true) => renderToStaticMarkup(React.createElement(SubagentPanel, { events, active }));
  assert.equal(render([]), "");
  const html = render([spawn, { kind: "subagent", agentStates: { other: "completed" } }]);
  assert.match(html, /aria-label="子代理状态"/);
  assert.match(html, /2 个 · 1 运行中 · 1 已完成/);
  assert.match(html, /<details>/);
  assert.match(html, /检查路由/);
  assert.match(render([spawn], false), /状态未确认/);
});

test("database replay retains old subagents but respects cursor and job isolation", async (context) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { AppDatabase } = await import("../server/db");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-replay-"));
  const db = new AppDatabase(root);
  context.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.createConversation("conversation", "Replay");
  db.createJob("job", "conversation");
  db.createJob("other", "conversation");
  const first = db.appendEvent("job", "progress", spawn);
  db.appendEvent("other", "progress", spawn);
  for (let index = 0; index < 60; index++) db.appendEvent("job", "progress", { kind: "command" });
  const replay = db.listRecentEvents("job", 5);
  assert.equal(replay.length, 6);
  assert.equal(replay[0].seq, first);
  assert.equal(db.listRecentEvents("job", 5, first).length, 5);
});
