import assert from "node:assert/strict";
import test from "node:test";
import type { Conversation, WorkingDirFavorite } from "../src/api.js";
import {
  autoDirCategoryKey,
  buildTaskCategoryBodyState,
  buildHiddenCategoryInfos,
  buildDirectoryAssignments,
  buildTaskCategoryViews,
  customCategoryKey,
  listValidHiddenCategoryKeys,
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
    hidden: [],
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
    hidden: [],
  };

  const views = buildTaskCategoryViews(conversations, [favorite], settings);
  assert.deepEqual(views.map((view) => view.key), [TASK_LIST_AUTO_STANDALONE_KEY, customCategoryKey("custom-1")]);
  const custom = views.find((view) => view.customId === "custom-1")!;
  assert.deepEqual(custom.conversations.map((item) => item.id), ["favorite"]);
  assert.equal(views.some((view) => view.key === autoDirCategoryKey(favorite.path)), false);
  assert.equal(views[0].pinIndex, 0);
  assert.equal(views[1].pinIndex, 1);
});

test("custom category groups repeated conversations without mutating settings", () => {
  const settings: TaskListCategorySettings = {
    customCategories: [{
      id: "custom-1",
      name: "重点项目",
      assignedDirs: ["/tmp/custom-a", "/tmp/custom-b", "/tmp/custom-a"],
    }],
    pinned: [],
    hidden: [],
  };
  const originalSettings = structuredClone(settings);
  const conversations = [
    conversation("custom-a-old", "/tmp/custom-a", "2026-01-01T00:00:00.000Z"),
    conversation("custom-a-new", "/tmp/custom-a", "2026-01-03T00:00:00.000Z"),
    conversation("custom-b", "/tmp/custom-b", "2026-01-02T00:00:00.000Z"),
  ];

  const views = buildTaskCategoryViews(conversations, [], settings);

  assert.equal(views.length, 1);
  assert.deepEqual(views[0].conversations.map((item) => item.id), ["custom-a-new", "custom-b", "custom-a-old"]);
  assert.deepEqual(views[0].assignedDirs, ["/tmp/custom-a", "/tmp/custom-b"]);
  assert.notStrictEqual(views[0].assignedDirs, settings.customCategories[0].assignedDirs);
  assert.deepEqual(settings, originalSettings);
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
    hidden: [],
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
    hidden: [],
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

test("hidden categories are omitted from views but remain restorable", () => {
  const conversations = [
    conversation("standalone", null, "2026-01-01T00:00:00.000Z"),
    conversation("favorite", favorite.path, "2026-01-02T00:00:00.000Z"),
    conversation("temp", "/tmp/temporary-a", "2026-01-03T00:00:00.000Z"),
  ];
  const settings: TaskListCategorySettings = {
    customCategories: [],
    pinned: [],
    hidden: [TASK_LIST_AUTO_STANDALONE_KEY, autoDirCategoryKey(favorite.path)],
  };

  const views = buildTaskCategoryViews(conversations, [favorite], settings);
  assert.deepEqual(views.map((view) => view.key), [TASK_LIST_AUTO_TEMP_KEY]);

  const infos = buildHiddenCategoryInfos(settings, [favorite]);
  assert.deepEqual(infos.map((info) => info.key), [TASK_LIST_AUTO_STANDALONE_KEY, autoDirCategoryKey(favorite.path)]);
  assert.equal(infos[0].name, "独立工作区");
  assert.equal(infos[1].name, favorite.label);
});

test("hidden keys validation keeps only known categories and hides stale keys from recovery", () => {
  const settings: TaskListCategorySettings = {
    customCategories: [{ id: "custom-1", name: "归档项目", assignedDirs: [] }],
    pinned: [],
    hidden: [customCategoryKey("custom-1"), customCategoryKey("deleted"), "auto:dir:/gone", "unknown:key"],
  };

  assert.deepEqual(
    listValidHiddenCategoryKeys(settings, [favorite.path]),
    [customCategoryKey("custom-1")],
  );
  assert.deepEqual(
    buildHiddenCategoryInfos(settings, [favorite]),
    [{ key: customCategoryKey("custom-1"), kind: "custom", name: "归档项目", detail: "还没有目录" }],
  );
});

test("category body keeps the collapse control visible after full expansion", () => {
  assert.deepEqual(buildTaskCategoryBodyState(5, false), { visibleCount: 3, remaining: 2, showExpandControl: true });
  assert.deepEqual(buildTaskCategoryBodyState(5, true), { visibleCount: 5, remaining: 2, showExpandControl: true });
  assert.deepEqual(buildTaskCategoryBodyState(3, true), { visibleCount: 3, remaining: 0, showExpandControl: false });
  assert.deepEqual(buildTaskCategoryBodyState(0, false), { visibleCount: 0, remaining: 0, showExpandControl: false });
});
