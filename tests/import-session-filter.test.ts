import assert from "node:assert/strict";
import test from "node:test";
import type { ImportableSession } from "../src/api.js";
import { filterImportableSessionsByDateRange } from "../src/import-session-filter.js";

function session(threadId: string, createdAt: string): ImportableSession {
  return { threadId, title: threadId, createdAt, updatedAt: createdAt, fileSize: 1, cwd: null, originator: null, model: null };
}

test("empty bounds return every importable session", () => {
  const sessions = [session("a", "2026-08-01T00:00:00.000Z"), session("b", "2026-08-10T00:00:00.000Z")];
  assert.deepEqual(filterImportableSessionsByDateRange(sessions, "", ""), sessions);
});

test("from and to bounds filter by local calendar day", () => {
  const sessions = [
    session("a", "2026-08-01T12:00:00.000Z"),
    session("b", "2026-08-10T12:00:00.000Z"),
    session("c", "2026-08-20T12:00:00.000Z"),
  ];
  assert.deepEqual(filterImportableSessionsByDateRange(sessions, "2026-08-10", "2026-08-15").map((item) => item.threadId), ["b"]);
  assert.deepEqual(filterImportableSessionsByDateRange(sessions, "2026-08-10", "").map((item) => item.threadId), ["b", "c"]);
  assert.deepEqual(filterImportableSessionsByDateRange(sessions, "", "2026-08-10").map((item) => item.threadId), ["a", "b"]);
});

test("invalid dates are ignored and malformed session timestamps are excluded from narrow filters", () => {
  const sessions = [session("a", "not-a-date"), session("b", "2026-08-10T12:00:00.000Z")];
  assert.deepEqual(filterImportableSessionsByDateRange(sessions, "not-a-date", "").map((item) => item.threadId), ["a", "b"]);
  assert.deepEqual(filterImportableSessionsByDateRange(sessions, "", "").map((item) => item.threadId), ["a", "b"]);
  assert.deepEqual(filterImportableSessionsByDateRange(sessions, "2026-08-01", "2026-08-31").map((item) => item.threadId), ["b"]);
});
