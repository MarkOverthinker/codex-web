import assert from "node:assert/strict";
import test from "node:test";
import type { Conversation, WorkingDirFavorite } from "../src/api.js";
import {
  applyCategoryConversationOrder,
  autoDirCategoryKey,
  buildTaskCategoryBodyState,
  buildHiddenCategoryInfos,
  buildDirectoryAssignments,
  buildTaskCategoryViews,
  countRunningConversations,
  customCategoryKey,
  DEFAULT_TASK_CATEGORY_VISIBLE_COUNT,
  listValidHiddenCategoryKeys,
  normalizeTaskCategoryVisibleCount,
  TASK_LIST_AUTO_STANDALONE_KEY,
  type TaskListCategorySettings,
} from "../src/task-categories.js";

function conversation(id: string, workingDir: string | null, updatedAt: string, status: "idle" | "running" = "idle"): Conversation {
  return {
    id,
    title: id,
    title_source: "default",
    status,
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

test("task category view groups standalone, favorite, per-directory, and custom directories", () => {
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
    conversationOrders: {},
  };

  const views = buildTaskCategoryViews(conversations, [favorite], settings);
  assert.deepEqual(views.map((view) => view.key), [
    autoDirCategoryKey(favorite.path),
    autoDirCategoryKey("/tmp/temporary-b"),
    customCategoryKey("custom-1"),
    TASK_LIST_AUTO_STANDALONE_KEY,
  ]);
  const custom = views.find((view) => view.customId === "custom-1")!;
  const favoriteView = views.find((view) => view.key === autoDirCategoryKey(favorite.path))!;
  const temporary = views.find((view) => view.key === autoDirCategoryKey("/tmp/temporary-b"))!;
  const standalone = views.find((view) => view.key === TASK_LIST_AUTO_STANDALONE_KEY)!;
  assert.deepEqual(custom.conversations.map((item) => item.id), ["temp-a"]);
  assert.deepEqual(favoriteView.conversations.map((item) => item.id), ["favorite-new", "favorite-old"]);
  assert.deepEqual(temporary.conversations.map((item) => item.id), ["temp-b"]);
  assert.deepEqual(standalone.conversations.map((item) => item.id), ["standalone"]);
  assert.equal(favoriteView.name, favorite.label);
  assert.equal(temporary.name, "temporary-b");
  assert.equal(temporary.detail, "/tmp/temporary-b");
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
    conversationOrders: {},
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
    conversationOrders: {},
  };
  const originalSettings = structuredClone(settings);
  Object.freeze(settings.customCategories[0].assignedDirs);
  Object.freeze(settings.customCategories[0]);
  Object.freeze(settings.customCategories);
  Object.freeze(settings);
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
    conversationOrders: {},
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
    conversationOrders: {},
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
  assert.equal(assignments.find((assignment) => assignment.dir === "/tmp/temporary-a")?.categoryName, "temporary-a");
  assert.equal(assignments.find((assignment) => assignment.dir === "/tmp/temporary-a")?.categoryKey, autoDirCategoryKey("/tmp/temporary-a"));
  assert.equal(assignments.find((assignment) => assignment.dir === "/tmp/temporary-a")?.autoKind, "dir");
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
    conversationOrders: {},
  };

  const views = buildTaskCategoryViews(conversations, [favorite], settings);
  assert.deepEqual(views.map((view) => view.key), [autoDirCategoryKey("/tmp/temporary-a")]);

  const infos = buildHiddenCategoryInfos(settings, [favorite]);
  assert.deepEqual(infos.map((info) => info.key), [TASK_LIST_AUTO_STANDALONE_KEY, autoDirCategoryKey(favorite.path)]);
  assert.equal(infos[0].name, "独立工作区");
  assert.equal(infos[1].name, favorite.label);
  assert.deepEqual(
    buildHiddenCategoryInfos(
      { customCategories: [], pinned: [], hidden: [autoDirCategoryKey("/tmp/temporary-a")], conversationOrders: {} },
      [],
      ["/tmp/temporary-a"],
    ),
    [{ key: autoDirCategoryKey("/tmp/temporary-a"), kind: "auto", name: "temporary-a", detail: "/tmp/temporary-a" }],
  );
});

test("hidden keys validation keeps only known categories and hides stale keys from recovery", () => {
  const settings: TaskListCategorySettings = {
    customCategories: [{ id: "custom-1", name: "归档项目", assignedDirs: [] }],
    pinned: [],
    hidden: [customCategoryKey("custom-1"), customCategoryKey("deleted"), autoDirCategoryKey("/tmp/active"), "auto:dir:/gone", "unknown:key"],
    conversationOrders: {},
  };

  assert.deepEqual(
    listValidHiddenCategoryKeys(settings, [favorite.path], ["/tmp/active"]),
    [customCategoryKey("custom-1"), autoDirCategoryKey("/tmp/active")],
  );
  assert.deepEqual(
    buildHiddenCategoryInfos(settings, [favorite], ["/tmp/active"]),
    [
      { key: customCategoryKey("custom-1"), kind: "custom", name: "归档项目", detail: "还没有目录" },
      { key: autoDirCategoryKey("/tmp/active"), kind: "auto", name: "active", detail: "/tmp/active" },
    ],
  );
});

test("category body keeps the collapse control visible after full expansion", () => {
  assert.deepEqual(buildTaskCategoryBodyState(5, false), { visibleCount: 3, remaining: 2, showExpandControl: true, collapseTarget: 3 });
  assert.deepEqual(buildTaskCategoryBodyState(5, true), { visibleCount: 5, remaining: 2, showExpandControl: true, collapseTarget: 3 });
  assert.deepEqual(buildTaskCategoryBodyState(3, true), { visibleCount: 3, remaining: 0, showExpandControl: true, collapseTarget: 3 });
  assert.deepEqual(buildTaskCategoryBodyState(0, false), { visibleCount: 0, remaining: 0, showExpandControl: false, collapseTarget: 0 });
});

test("category body accepts a per-category visible count", () => {
  assert.deepEqual(buildTaskCategoryBodyState(8, false, 5), { visibleCount: 5, remaining: 3, showExpandControl: true, collapseTarget: 5 });
  assert.deepEqual(buildTaskCategoryBodyState(8, true, 5), { visibleCount: 8, remaining: 3, showExpandControl: true, collapseTarget: 5 });
  assert.deepEqual(buildTaskCategoryBodyState(8, false, 0), { visibleCount: 0, remaining: 8, showExpandControl: true, collapseTarget: 0 });
  assert.deepEqual(buildTaskCategoryBodyState(8, false, 9), { visibleCount: 8, remaining: 0, showExpandControl: false, collapseTarget: 8 });
});

test("normalizeTaskCategoryVisibleCount clamps drag values below the full count", () => {
  assert.equal(DEFAULT_TASK_CATEGORY_VISIBLE_COUNT, 3);
  assert.equal(normalizeTaskCategoryVisibleCount(undefined, 8), 3);
  assert.equal(normalizeTaskCategoryVisibleCount(undefined, 2), 2);
  assert.equal(normalizeTaskCategoryVisibleCount(undefined, 1), 1);
  assert.equal(normalizeTaskCategoryVisibleCount(1, 8), 1);
  assert.equal(normalizeTaskCategoryVisibleCount(7, 8), 7);
  assert.equal(normalizeTaskCategoryVisibleCount(9, 8), 7);
  assert.equal(normalizeTaskCategoryVisibleCount(-2, 8), 1);
  assert.equal(normalizeTaskCategoryVisibleCount(4.9, 8), 4);
  assert.equal(normalizeTaskCategoryVisibleCount(5, 3), 2);
  assert.equal(normalizeTaskCategoryVisibleCount(5, 2), 1);
  assert.equal(normalizeTaskCategoryVisibleCount(1, 1), 1);
});

test("countRunningConversations counts only executing tasks in a category", () => {
  const idle = conversation("idle", favorite.path, "2026-01-01T00:00:00.000Z");
  const runningOne = conversation("running-one", favorite.path, "2026-01-02T00:00:00.000Z", "running");
  const runningTwo = conversation("running-two", favorite.path, "2026-01-03T00:00:00.000Z", "running");
  assert.equal(countRunningConversations([idle]), 0);
  assert.equal(countRunningConversations([idle, runningOne]), 1);
  assert.equal(countRunningConversations([runningOne, runningTwo, idle]), 2);
  assert.equal(countRunningConversations([]), 0);
});

test("applyCategoryConversationOrder honors the saved order and keeps new tasks on top", () => {
  const oldest = conversation("oldest", favorite.path, "2026-01-01T00:00:00.000Z");
  const middle = conversation("middle", favorite.path, "2026-01-02T00:00:00.000Z");
  const newest = conversation("newest", favorite.path, "2026-01-03T00:00:00.000Z");
  assert.deepEqual(
    applyCategoryConversationOrder([oldest, middle, newest], undefined).map((item) => item.id),
    ["newest", "middle", "oldest"],
  );
  assert.deepEqual(
    applyCategoryConversationOrder([oldest, middle, newest], []).map((item) => item.id),
    ["newest", "middle", "oldest"],
  );
  assert.deepEqual(
    applyCategoryConversationOrder([oldest, middle, newest], ["oldest", "newest", "middle"]).map((item) => item.id),
    ["oldest", "newest", "middle"],
  );
  // 已保存顺序里没有的新任务排在顶部，保持可见；过期 id 被忽略。
  const fresh = conversation("fresh", favorite.path, "2026-01-04T00:00:00.000Z");
  assert.deepEqual(
    applyCategoryConversationOrder([oldest, middle, newest, fresh], ["oldest", "middle", "newest", "gone"]).map((item) => item.id),
    ["fresh", "oldest", "middle", "newest"],
  );
});

test("buildTaskCategoryViews applies per-category conversation order", () => {
  const conversations = [
    conversation("newest", favorite.path, "2026-01-05T00:00:00.000Z"),
    conversation("middle", favorite.path, "2026-01-04T00:00:00.000Z"),
    conversation("oldest", favorite.path, "2026-01-03T00:00:00.000Z"),
    conversation("standalone", null, "2026-01-02T00:00:00.000Z"),
  ];
  const settings: TaskListCategorySettings = {
    customCategories: [],
    pinned: [],
    hidden: [],
    conversationOrders: {
      [autoDirCategoryKey(favorite.path)]: ["oldest", "middle", "newest"],
    },
  };

  const views = buildTaskCategoryViews(conversations, [favorite], settings);
  const favoriteView = views.find((view) => view.key === autoDirCategoryKey(favorite.path))!;
  assert.deepEqual(favoriteView.conversations.map((item) => item.id), ["oldest", "middle", "newest"]);
});
