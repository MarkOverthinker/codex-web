import assert from "node:assert/strict";
import test from "node:test";
import type { Conversation, WorkingDirFavorite } from "../src/api.js";
import {
  autoDirCategoryKey,
  buildDirectoryAssignments,
  buildTaskCategoryViews,
  customCategoryKey,
  TASK_LIST_AUTO_STANDALONE_KEY,
  TASK_LIST_AUTO_TEMP_KEY,
  type TaskListCategorySettings,
} from "../src/task-categories.js";

function conversation(id: string, workingDir: string | null, updatedAt: string): Conversation {
  return {
    id,
    title: id,
    title_source: "default",
    status: "idle",
    has_unread_result: 0,
    has_pending_work: 0,
    rollout_bytes: null,
    archived_at: null,
    working_dir: workingDir,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

const favorite: WorkingDirFavorite = { path: "/srv/favorite-project", label: "Favorite", added_at: "2026-01-01T00:00:00.000Z" };

test("task category view groups standalone, favorite, temporary, and custom directories", () => {
  const conversations = [
    conversation("standalone", null, "2026-01-01T00:00:00.000Z"),
    conversation("temp-a", "/tmp/temporary-a", "2026-01-02T00:00:00.000Z"),
    conversation("temp-b", "/tmp/temporary-b", "2026-01-03T00:00:00.000Z"),
    conversation("favorite-old", favorite.path, "2026-01-04T00:00:00.000Z"),
    conversation("favorite-new", favorite.path, "2026-01-05T00:00:00.000Z"),
  ];
  const settings: TaskListCategorySettings = {
    customCategories: [{ id: "custom-1", name: "归档项目", assignedDirs: ["/tmp/temporary-a"] }],
    pinned: [],
  };

  const views = buildTaskCategoryViews(conversations, [favorite], settings);
  assert.deepEqual(views.map((view) => view.key), [
    autoDirCategoryKey(favorite.path),
    TASK_LIST_AUTO_TEMP_KEY,
    customCategoryKey("custom-1"),
    TASK_LIST_AUTO_STANDALONE_KEY,
  ]);
  const custom = views.find((view) => view.customId === "custom-1")!;
  const favoriteView = views.find((view) => view.key === autoDirCategoryKey(favorite.path))!;
  const temporary = views.find((view) => view.key === TASK_LIST_AUTO_TEMP_KEY)!;
  const standalone = views.find((view) => view.key === TASK_LIST_AUTO_STANDALONE_KEY)!;
  assert.deepEqual(custom.conversations.map((item) => item.id), ["temp-a"]);
  assert.deepEqual(favoriteView.conversations.map((item) => item.id), ["favorite-new", "favorite-old"]);
  assert.deepEqual(temporary.conversations.map((item) => item.id), ["temp-b"]);
  assert.deepEqual(standalone.conversations.map((item) => item.id), ["standalone"]);
  assert.equal(favoriteView.name, favorite.label);
  assert.equal(temporary.name, "临时工作区");
  assert.equal(standalone.name, "独立工作区");
});

test("custom assignment overrides favorite auto categories and pinned order wins", () => {
  const conversations = [
    conversation("standalone", null, "2026-01-01T00:00:00.000Z"),
    conversation("favorite", favorite.path, "2026-01-05T00:00:00.000Z"),
  ];
  const settings: TaskListCategorySettings = {
    customCategories: [{ id: "custom-1", name: "重点项目", assignedDirs: [favorite.path] }],
    pinned: [TASK_LIST_AUTO_STANDALONE_KEY, customCategoryKey("custom-1")],
  };

  const views = buildTaskCategoryViews(conversations, [favorite], settings);
  assert.deepEqual(views.map((view) => view.key), [TASK_LIST_AUTO_STANDALONE_KEY, customCategoryKey("custom-1")]);
  const custom = views.find((view) => view.customId === "custom-1")!;
  assert.deepEqual(custom.conversations.map((item) => item.id), ["favorite"]);
  assert.equal(views.some((view) => view.key === autoDirCategoryKey(favorite.path)), false);
  assert.equal(views[0].pinIndex, 0);
  assert.equal(views[1].pinIndex, 1);
});

test("search filtering keeps category structure and counts only matching tasks", () => {
  const conversations = [
    conversation("standalone", null, "2026-01-01T00:00:00.000Z"),
    conversation("custom-a", "/tmp/temporary-a", "2026-01-02T00:00:00.000Z"),
    conversation("custom-b", "/tmp/temporary-a", "2026-01-03T00:00:00.000Z"),
  ];
  const settings: TaskListCategorySettings = {
    customCategories: [{ id: "custom-1", name: "归档项目", assignedDirs: ["/tmp/temporary-a"] }],
    pinned: [],
  };
  const filtered = [conversations[1]];
  const views = buildTaskCategoryViews(filtered, [], settings);
  assert.deepEqual(views.map((view) => view.key), [customCategoryKey("custom-1")]);
  assert.equal(views[0].conversations.length, 1);
});

test("directory assignments report the current auto or custom bucket", () => {
  const conversations = [
    conversation("standalone", null, "2026-01-01T00:00:00.000Z"),
    conversation("temp", "/tmp/temporary-a", "2026-01-02T00:00:00.000Z"),
    conversation("favorite", favorite.path, "2026-01-03T00:00:00.000Z"),
    conversation("custom", "/tmp/custom-a", "2026-01-04T00:00:00.000Z"),
  ];
  const settings: TaskListCategorySettings = {
    customCategories: [{ id: "custom-1", name: "归档项目", assignedDirs: ["/tmp/custom-a"] }],
    pinned: [],
  };
  const assignments = buildDirectoryAssignments(conversations, [favorite], settings);
  assert.equal(assignments.length, 4);
  assert.deepEqual(
    new Map(assignments.map((assignment) => [assignment.dir, assignment.customId])),
    new Map<string | null, string | null>([
      [null, null],
      ["/tmp/temporary-a", null],
      [favorite.path, null],
      ["/tmp/custom-a", "custom-1"],
    ]),
  );
  assert.equal(assignments.find((assignment) => assignment.dir === favorite.path)?.categoryName, "Favorite");
  assert.equal(assignments.find((assignment) => assignment.dir === "/tmp/temporary-a")?.categoryName, "临时工作区");
});
