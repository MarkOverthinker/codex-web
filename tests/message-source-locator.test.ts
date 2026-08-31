import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { locateMessageInCodexRollout } from "../server/message-source-locator.js";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";

test("locates an exact excerpt in a response_item JSONL record", async (context) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cww-source-locator-"));
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const directory = path.join(codexHome, "sessions", "2026", "08", "31");
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `rollout-${THREAD_ID}.jsonl`);
  const lines = [
    JSON.stringify({ timestamp: "2026-08-31T01:00:00.000Z", type: "session_meta", payload: { id: THREAD_ID } }),
    JSON.stringify({ timestamp: "2026-08-31T01:00:01.000Z", type: "event_msg", payload: { type: "agent_message", message: "旧的重复短语" } }),
    JSON.stringify({ timestamp: "2026-08-31T01:00:02.000Z", type: "response_item", payload: { id: "item-2", type: "message", role: "assistant", content: [{ type: "output_text", text: "第一段\n需要精确定位的语句\n最后一段" }] } }),
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);

  const location = await locateMessageInCodexRollout({
    codexHome,
    threadId: THREAD_ID,
    role: "assistant",
    messageContent: "第一段\n需要精确定位的语句\n最后一段",
    messageCreatedAt: "2026-08-31T01:00:02.100Z",
    excerpt: "需要精确定位的语句",
  });

  assert.deepEqual(location, {
    kind: "codex-rollout",
    threadId: THREAD_ID,
    path: `sessions/2026/08/31/rollout-${THREAD_ID}.jsonl`,
    line: 3,
    byteOffset: Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`, "utf8"),
    recordType: "response_item",
    jsonPointer: "/payload/content/0/text",
    itemId: "item-2",
    textStart: 4,
    textEnd: 13,
  });
});

test("matches browser-collapsed whitespace and prefers the closest record", async (context) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cww-source-locator-"));
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const directory = path.join(codexHome, "archived_sessions");
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `rollout-${THREAD_ID}.jsonl`);
  fs.writeFileSync(filePath, [
    JSON.stringify({ timestamp: "2026-08-31T01:00:00.000Z", type: "event_msg", payload: { type: "user_message", message: "alpha   beta" } }),
    JSON.stringify({ timestamp: "2026-08-31T02:00:00.000Z", type: "response_item", payload: { id: "item-latest", type: "message", role: "user", content: [{ type: "input_text", text: "alpha\n beta" }] } }),
  ].join("\n"));

  const location = await locateMessageInCodexRollout({
    codexHome,
    threadId: THREAD_ID,
    role: "user",
    messageContent: "alpha beta",
    messageCreatedAt: "2026-08-31T02:00:01.000Z",
    excerpt: "alpha beta",
  });

  assert.equal(location?.line, 2);
  assert.equal(location?.itemId, "item-latest");
  assert.deepEqual([location?.textStart, location?.textEnd], [0, 11]);
});

test("reports exact byte offsets for CRLF JSONL files", async (context) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "cww-source-locator-"));
  context.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const directory = path.join(codexHome, "sessions", "2026", "08", "31");
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `rollout-${THREAD_ID}.jsonl`);
  const first = JSON.stringify({ timestamp: "2026-08-31T01:00:00.000Z", type: "session_meta", payload: { id: THREAD_ID } });
  const second = JSON.stringify({ timestamp: "2026-08-31T01:00:01.000Z", type: "event_msg", payload: { type: "agent_message", message: "精确偏移" } });
  fs.writeFileSync(filePath, `${first}\r\n${second}\r\n`);

  const location = await locateMessageInCodexRollout({
    codexHome,
    threadId: THREAD_ID,
    role: "assistant",
    messageContent: "精确偏移",
    messageCreatedAt: "2026-08-31T01:00:01.000Z",
    excerpt: "精确偏移",
  });

  assert.equal(location?.line, 2);
  assert.equal(location?.byteOffset, Buffer.byteLength(`${first}\r\n`, "utf8"));
});
