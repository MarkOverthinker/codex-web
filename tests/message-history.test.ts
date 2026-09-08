import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../src/api.js";
import { mergeMessagePages, reuseUnchangedMessages } from "../src/message-history.js";

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    role: "assistant",
    content: `内容 ${overrides.id}`,
    quote_excerpt: null,
    source_reference: null,
    created_at: "2026-09-09T00:00:00.000Z",
    files: [],
    ...overrides,
  };
}

test("reuseUnchangedMessages keeps previous identities for unchanged refreshes", () => {
  const previous = [message({ id: "a" }), message({ id: "b" })];
  const refreshed = [message({ id: "a" }), message({ id: "b" })];
  const result = reuseUnchangedMessages(previous, refreshed);
  assert.equal(result[0], previous[0]);
  assert.equal(result[1], previous[1]);
});

test("reuseUnchangedMessages returns the previous array when nothing changed", () => {
  const previous = [message({ id: "a" }), message({ id: "b" })];
  const refreshed = [message({ id: "a" }), message({ id: "b" })];
  assert.equal(reuseUnchangedMessages(previous, refreshed), previous);
});

test("reuseUnchangedMessages keeps reused objects but a new array when order changes", () => {
  const previous = [message({ id: "a" }), message({ id: "b" })];
  const reordered = [message({ id: "b" }), message({ id: "a" })];
  const result = reuseUnchangedMessages(previous, reordered);
  assert.notEqual(result, previous);
  assert.deepEqual(result.map((item) => item.id), ["b", "a"]);
  assert.equal(result[0], previous[1]);
  assert.equal(result[1], previous[0]);
});

test("reuseUnchangedMessages swaps in refreshed objects when rendered content changes", () => {
  const previous = [message({ id: "a" }), message({ id: "b" })];
  const refreshed = [message({ id: "a" }), message({ id: "b", content: "更新后的内容" })];
  const result = reuseUnchangedMessages(previous, refreshed);
  assert.equal(result[0], previous[0]);
  assert.notEqual(result[1], previous[1]);
  assert.equal(result[1].content, "更新后的内容");
});

test("reuseUnchangedMessages treats missing and null optionals as equal", () => {
  const previous = [message({ id: "a", can_edit: undefined, files: [] })];
  const refreshed = [message({ id: "a", can_edit: undefined, files: [] })];
  const result = reuseUnchangedMessages(previous, refreshed);
  assert.equal(result[0], previous[0]);
});

test("reuseUnchangedMessages reacts to file list, edit flag and quote changes", () => {
  const base = message({ id: "a", files: [{ id: "f1", kind: "output", original_name: "x.txt", size: 3, mime_type: "text/plain", relative_path: "x.txt" }] });
  const result = reuseUnchangedMessages([base], [message({ id: "a", files: [] })]);
  assert.notEqual(result[0], base);
  const edited = reuseUnchangedMessages([base], [message({ id: "a", files: base.files, can_edit: true })]);
  assert.notEqual(edited[0], base);
  const quoted = reuseUnchangedMessages([base], [message({ id: "a", files: base.files, quote_excerpt: "引用" })]);
  assert.notEqual(quoted[0], base);
});

test("reuseUnchangedMessages passes through pages without prior history", () => {
  const next = [message({ id: "a" })];
  assert.equal(reuseUnchangedMessages([], next)[0], next[0]);
});

test("mergeMessagePages still prefers later pages for duplicate ids", () => {
  const older = [message({ id: "a", content: "旧" })];
  const newer = [message({ id: "a", content: "新" })];
  assert.equal(mergeMessagePages(older, newer)[0].content, "新");
});
