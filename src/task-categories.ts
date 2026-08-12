import type { Conversation, WorkingDirFavorite } from "./api.js";

export const TASK_LIST_AUTO_STANDALONE_KEY = "auto:standalone";
export const TASK_LIST_AUTO_TEMP_KEY = "auto:temp";

export type TaskListCustomCategory = {
  id: string;
  name: string;
  assignedDirs: string[];
};

export type TaskListCategorySettings = {
  customCategories: TaskListCustomCategory[];
  pinned: string[];
  hidden: string[];
};

export type TaskListCategoryView = {
  key: string;
  kind: "auto" | "custom";
  name: string;
  detail: string;
  customId: string | null;
  pinned: boolean;
  pinIndex: number;
  assignedDirs: string[];
  conversations: Conversation[];
};

export type DirectoryCategoryAssignment = {
  dir: string | null;
  label: string;
  categoryKey: string | null;
  categoryName: string;
  customId: string | null;
  autoKind: "standalone" | "favorite" | "temporary";
};

export const EMPTY_TASK_LIST_CATEGORY_SETTINGS: TaskListCategorySettings = {
  customCategories: [],
  pinned: [],
  hidden: [],
};

export function customCategoryKey(id: string): string {
  return `custom:${id}`;
}

export function autoDirCategoryKey(dir: string): string {
  return `auto:dir:${encodeURIComponent(dir)}`;
}

export function parseCategoryKey(key: string): {
  kind: "auto" | "custom";
  autoKind?: "standalone" | "temporary" | "dir";
  customId?: string;
  dir?: string;
} | null {
  if (key === TASK_LIST_AUTO_STANDALONE_KEY) return { kind: "auto", autoKind: "standalone" };
  if (key === TASK_LIST_AUTO_TEMP_KEY) return { kind: "auto", autoKind: "temporary" };
  if (key.startsWith("custom:")) {
    const customId = key.slice("custom:".length);
    return customId ? { kind: "custom", customId } : null;
  }
  if (key.startsWith("auto:dir:")) {
    try {
      return { kind: "auto", autoKind: "dir", dir: decodeURIComponent(key.slice("auto:dir:".length)) };
    } catch {
      return null;
    }
  }
  return null;
}

function filterValidCategoryKeys(
  keys: string[],
  settings: Pick<TaskListCategorySettings, "customCategories">,
  favoritePaths: string[],
): string[] {
  const customIds = new Set(settings.customCategories.map((category) => category.id));
  const valid = new Set<string>([
    TASK_LIST_AUTO_STANDALONE_KEY,
    TASK_LIST_AUTO_TEMP_KEY,
    ...favoritePaths.map(autoDirCategoryKey),
    ...settings.customCategories.map((category) => customCategoryKey(category.id)),
  ]);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of keys) {
    if (!valid.has(key) || seen.has(key)) continue;
    if (key.startsWith("custom:") && !customIds.has(key.slice("custom:".length))) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

export function listValidPinnedCategoryKeys(
  settings: Pick<TaskListCategorySettings, "customCategories" | "pinned">,
  favoritePaths: string[],
): string[] {
  return filterValidCategoryKeys(settings.pinned, settings, favoritePaths);
}

export function listValidHiddenCategoryKeys(
  settings: Pick<TaskListCategorySettings, "customCategories" | "hidden">,
  favoritePaths: string[],
): string[] {
  return filterValidCategoryKeys(settings.hidden, settings, favoritePaths);
}

function sortedByUpdatedAt(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at) || right.created_at.localeCompare(left.created_at),
  );
}

type PendingView = {
  key: string;
  kind: "auto" | "custom";
  name: string;
  detail: string;
  customId: string | null;
  assignedDirs: string[];
  conversations: Conversation[];
};

function addPendingView(groups: Map<string, PendingView>, view: PendingView): void {
  const existing = groups.get(view.key);
  if (existing) {
    for (const conversation of view.conversations) existing.conversations.push(conversation);
    for (const dir of view.assignedDirs) {
      if (!existing.assignedDirs.includes(dir)) existing.assignedDirs.push(dir);
    }
  } else {
    // Pending views are accumulated below, so never retain arrays owned by
    // API settings or callers. In particular, custom categories reuse their
    // assignedDirs array for every matching conversation.
    groups.set(view.key, {
      ...view,
      assignedDirs: [...new Set(view.assignedDirs)],
      conversations: [...view.conversations],
    });
  }
}

/**
 * Derive the categorized sidebar view from the current active conversations,
 * favorite working directories, and server-persisted category settings.
 * Empty and hidden categories are omitted; categories are ordered by pinned
 * order first and then by the newest conversation inside each category.
 */
export function buildTaskCategoryViews(
  conversations: Conversation[],
  favorites: WorkingDirFavorite[],
  settings: TaskListCategorySettings,
): TaskListCategoryView[] {
  const hiddenKeys = new Set(settings.hidden);
  const favoriteByPath = new Map(favorites.map((favorite) => [favorite.path, favorite]));
  const customByDir = new Map<string, TaskListCustomCategory>();
  for (const category of settings.customCategories) {
    for (const dir of category.assignedDirs) customByDir.set(dir, category);
  }

  const groups = new Map<string, PendingView>();
  const standalone = conversations.filter((conversation) => !conversation.working_dir);
  if (standalone.length) {
    addPendingView(groups, {
      key: TASK_LIST_AUTO_STANDALONE_KEY,
      kind: "auto",
      name: "独立工作区",
      detail: "每个任务使用系统隔离目录",
      customId: null,
      assignedDirs: [],
      conversations: standalone,
    });
  }

  const temporary: Conversation[] = [];
  for (const conversation of conversations) {
    const dir = conversation.working_dir;
    if (!dir) continue;
    const custom = customByDir.get(dir);
    if (custom) {
      addPendingView(groups, {
        key: customCategoryKey(custom.id),
        kind: "custom",
        name: custom.name,
        detail: custom.assignedDirs.length === 1 ? custom.assignedDirs[0] : `${custom.assignedDirs.length} 个目录`,
        customId: custom.id,
        assignedDirs: custom.assignedDirs,
        conversations: [conversation],
      });
      continue;
    }
    const favorite = favoriteByPath.get(dir);
    if (favorite) {
      addPendingView(groups, {
        key: autoDirCategoryKey(favorite.path),
        kind: "auto",
        name: favorite.label,
        detail: favorite.path,
        customId: null,
        assignedDirs: [favorite.path],
        conversations: [conversation],
      });
      continue;
    }
    temporary.push(conversation);
  }
  if (temporary.length) {
    const tempDirs = [...new Set(temporary.map((conversation) => conversation.working_dir!).filter(Boolean))];
    addPendingView(groups, {
      key: TASK_LIST_AUTO_TEMP_KEY,
      kind: "auto",
      name: "临时工作区",
      detail: `${tempDirs.length} 个未收藏目录`,
      customId: null,
      assignedDirs: tempDirs,
      conversations: temporary,
    });
  }

  const pinnedIndex = new Map(settings.pinned.map((key, index) => [key, index]));
  const views: TaskListCategoryView[] = [];
  for (const group of groups.values()) {
    const pinIndex = pinnedIndex.get(group.key) ?? -1;
    views.push({
      ...group,
      assignedDirs: [...new Set(group.assignedDirs)],
      conversations: sortedByUpdatedAt(group.conversations),
      pinned: pinIndex >= 0,
      pinIndex,
    });
  }
  views.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    if (left.pinned) return left.pinIndex - right.pinIndex;
    const leftUpdated = left.conversations[0]?.updated_at ?? "";
    const rightUpdated = right.conversations[0]?.updated_at ?? "";
    return rightUpdated.localeCompare(leftUpdated);
  });
  return views.filter((view) => !hiddenKeys.has(view.key));
}

export type HiddenCategoryInfo = {
  key: string;
  kind: "auto" | "custom";
  name: string;
  detail: string;
};

/**
 * Resolve hidden category keys to displayable entries for the category
 * manager. Keys that no longer refer to an existing category or favorite are
 * ignored so stale settings never block recovery of visible categories.
 */
export function buildHiddenCategoryInfos(
  settings: TaskListCategorySettings,
  favorites: WorkingDirFavorite[],
): HiddenCategoryInfo[] {
  const favoriteByPath = new Map(favorites.map((favorite) => [favorite.path, favorite]));
  const customById = new Map(settings.customCategories.map((category) => [category.id, category]));
  const infos: HiddenCategoryInfo[] = [];
  for (const key of settings.hidden) {
    const parsed = parseCategoryKey(key);
    if (!parsed) continue;
    if (parsed.kind === "custom") {
      const category = parsed.customId ? customById.get(parsed.customId) : undefined;
      if (!category) continue;
      infos.push({
        key,
        kind: "custom",
        name: category.name,
        detail: category.assignedDirs.length ? `${category.assignedDirs.length} 个目录` : "还没有目录",
      });
      continue;
    }
    if (parsed.autoKind === "standalone") {
      infos.push({ key, kind: "auto", name: "独立工作区", detail: "每个任务使用系统隔离目录" });
      continue;
    }
    if (parsed.autoKind === "temporary") {
      infos.push({ key, kind: "auto", name: "临时工作区", detail: "未收藏目录自动归入" });
      continue;
    }
    if (parsed.autoKind === "dir" && parsed.dir) {
      const favorite = favoriteByPath.get(parsed.dir);
      if (!favorite) continue;
      infos.push({ key, kind: "auto", name: favorite.label, detail: parsed.dir });
    }
  }
  return infos;
}

export function buildDirectoryAssignments(
  conversations: Conversation[],
  favorites: WorkingDirFavorite[],
  settings: TaskListCategorySettings,
): DirectoryCategoryAssignment[] {
  const favoriteByPath = new Map(favorites.map((favorite) => [favorite.path, favorite]));
  const customByDir = new Map<string, TaskListCustomCategory>();
  for (const category of settings.customCategories) {
    for (const dir of category.assignedDirs) customByDir.set(dir, category);
  }

  const rows = new Map<string, DirectoryCategoryAssignment>();
  for (const conversation of conversations) {
    const dir = conversation.working_dir;
    const key = dir ?? "\u0000standalone";
    if (rows.has(key)) continue;
    if (!dir) {
      rows.set(key, {
        dir: null,
        label: "独立工作区",
        categoryKey: TASK_LIST_AUTO_STANDALONE_KEY,
        categoryName: "独立工作区",
        customId: null,
        autoKind: "standalone",
      });
      continue;
    }
    const custom = customByDir.get(dir);
    if (custom) {
      rows.set(key, {
        dir,
        label: pathLabel(dir),
        categoryKey: customCategoryKey(custom.id),
        categoryName: custom.name,
        customId: custom.id,
        autoKind: "temporary",
      });
      continue;
    }
    const favorite = favoriteByPath.get(dir);
    if (favorite) {
      rows.set(key, {
        dir,
        label: favorite.label,
        categoryKey: autoDirCategoryKey(favorite.path),
        categoryName: favorite.label,
        customId: null,
        autoKind: "favorite",
      });
      continue;
    }
    rows.set(key, {
      dir,
      label: pathLabel(dir),
      categoryKey: TASK_LIST_AUTO_TEMP_KEY,
      categoryName: "临时工作区",
      customId: null,
      autoKind: "temporary",
    });
  }
  return [...rows.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export type TaskCategoryBodyState = {
  visibleCount: number;
  remaining: number;
  showExpandControl: boolean;
};

/**
 * Decide how many tasks a category body shows and whether the expand/collapse
 * control is needed. The remaining count always refers to the collapsed
 * preview limit instead of the currently visible count, so fully expanding a
 * category never hides the collapse button.
 */
export function buildTaskCategoryBodyState(
  conversationCount: number,
  fullyExpanded: boolean,
  previewLimit = 3,
): TaskCategoryBodyState {
  const previewCount = Math.max(0, Math.min(conversationCount, Math.max(0, Math.trunc(previewLimit))));
  const remaining = Math.max(0, conversationCount - previewCount);
  return {
    visibleCount: fullyExpanded ? conversationCount : previewCount,
    remaining,
    showExpandControl: remaining > 0,
  };
}

function pathLabel(dir: string): string {
  const segments = dir.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments.at(-1) || dir;
}
