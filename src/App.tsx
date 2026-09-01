import { createContext, Fragment, memo, useCallback, useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type Dispatch, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import {
  Archive, ArrowDown, ArrowUp, BarChart3, Bot, Brain, Check, ChevronDown, ChevronRight, CircleDashed, Code, Download, File as FileIcon, FileImage, FileText, FolderCog, FolderInput, FolderOpen, FolderTree,
  ChevronUp, ListChecks,
  Eye, EyeOff, CornerUpLeft, GripVertical, KeyRound, LayoutGrid, LayoutList, List, LoaderCircle, LogOut, Menu, Mic, Minus, Monitor, Moon, MoreHorizontal, Paperclip, Pencil, Pin, PinOff, Plus, Search, Settings2, Share2, Square, Sun, Timer,
  RotateCcw, ShieldAlert, ShieldCheck, Trash2, TriangleAlert, X, Zap,
} from "lucide-react";
import { api, ApiError, BASE_PATH, fileUrl, setCsrf, type AgentModelOption, type AgentOptions, type AgentSelection, type ComposerDraft, type Conversation, type ConversationDetail, type ImportableSession, type Job, type JobEvent, type Message, type MessageSourceReference, type PendingPrompt, type PresetPrompt, type ReasoningEffort, type ReasoningStep, type ReloadStatus, type SandboxMode, type Session, type WorkFile, type WorkingDirSettings } from "./api";
import {
  buildDirectoryAssignments, buildHiddenCategoryInfos, buildTaskCategoryBodyState, buildTaskCategoryViews, countRunningConversations, customCategoryKey, EMPTY_TASK_LIST_CATEGORY_SETTINGS,
  DEFAULT_TASK_CATEGORY_VISIBLE_COUNT, normalizeTaskCategoryVisibleCount, pathLabel, type DirectoryCategoryAssignment, type TaskListCategorySettings, type TaskListCategoryView,
} from "./task-categories";
import { canPreviewInline, filePreviewKind, firstMarkdownPreviewFile, isBrowserPreviewable, isLocalMarkdownUrl, localPathText, orderPreviewedFiles, resolveMessageFileLink } from "./file-links";
import { parseCodexSnippetUrl, parseFileRef, parseSnippetHref, type FileLineRef } from "./code-snippet";
import { CopyPathButton, copyText } from "./copy-path";
import { CodeSnippetPane } from "./code-snippet-pane";
import { sanitizeAgentMarkdown } from "./agent-content";
import { normalizeMathDelimiters } from "./markdown-math";
import { chooseComposerPrimaryAction } from "./composer-action";
import { chooseSelectedConversation, mergeJobEvents } from "./recovery";
import { resolveAccountIdentity } from "./account-identity";
import { CHAT_FONT_SIZE_DEFAULT, CHAT_FONT_SIZE_MAX, CHAT_FONT_SIZE_MIN, normalizeChatFontSize } from "./chat-font-size";
import { CHAT_COLUMN_WIDTH_DEFAULT, CHAT_COLUMN_WIDTH_MAX, CHAT_COLUMN_WIDTH_MIN, CHAT_COLUMN_WIDTH_STEP, normalizeChatColumnWidth } from "./chat-column-width";
import { applyThemePreference, readStoredThemePreference, THEME_PREFERENCE_KEY, type ThemePreference } from "./theme";
import { ASK_AGENT_SELECTION_MAX_CHARS, normalizeAskAgentSelection } from "./ask-agent-selection";
import { mergeMessagePages, preservePrependedScrollTop } from "./message-history";
import { findUserMessageJump, findViewportAnchorMessageId, type JumpDirection } from "./message-jump";
import { resolveScrollFollow } from "./scroll-follow";
import { buildProcessJournal, isNarrativeActivity } from "./process-journal";
import { collectReasoningSteps } from "./reasoning-steps";
import { ProviderManagerDialog } from "./provider-manager-dialog";
import { BillingPanel } from "./billing-panel";
import { SideChatPane, type SideChatReferenceRequest } from "./side-chat-pane";
import { PresetPromptManagerDialog } from "./preset-prompt-manager";
import { PathBrowserDialog, type PathBrowserRequest } from "./path-browser";
import { FileExplorerPane } from "./file-explorer-pane";
import { formatRolloutBytes, shouldWarnAboutRollout } from "./rollout-capacity";
import { formatElapsed, taskElapsedSeconds } from "./task-timing";
import { filterImportableSessionsByDateRange } from "./import-session-filter";
import { useTaskCategoryGridLayout } from "./task-grid-layout";

const SELECTED_CONVERSATION_KEY = "codex-web:selected-conversation";
const TASK_CATEGORY_EXPANDED_KEY = "codex-web:task-categories-expanded";
const TASK_CATEGORY_FULLY_EXPANDED_KEY = "codex-web:task-categories-fully-expanded";
const TASK_CATEGORY_VISIBLE_COUNTS_KEY = "codex-web:task-categories-visible-counts";
const TASK_VIEW_MODE_KEY = "codex-web:task-view-mode";
const SIDEBAR_WIDTH_KEY = "codex-web:sidebar-width";
const PREVIEW_WIDTH_KEY = "codex-web:preview-width";
const SIDE_CHAT_WIDTH_KEY = "codex-web:side-chat-width";
const FILE_EXPLORER_WIDTH_KEY = "codex-web:file-explorer-width";
const SIDEBAR_WIDTH_DEFAULT = 280;
const SIDEBAR_WIDTH_MIN = 220;
const SIDEBAR_WIDTH_MAX = 460;
const PREVIEW_WIDTH_MIN = 320;
const PREVIEW_WIDTH_MAX = 960;
const SIDE_CHAT_WIDTH_DEFAULT = 410;
const SIDE_CHAT_WIDTH_MIN = 320;
const SIDE_CHAT_WIDTH_MAX = 720;
const FILE_EXPLORER_WIDTH_DEFAULT = 480;
const FILE_EXPLORER_WIDTH_MIN = 340;
const FILE_EXPLORER_WIDTH_MAX = 760;
const COMPOSER_TEXT_HEIGHT_MIN = 72;
const COMPOSER_TEXT_HEIGHT_MAX = 560;
const RELOAD_STATUS_POLL_MS = 5_000;
const COMPOSER_DRAFT_SAVE_DELAY_MS = 1_500;

type CategoryTaskDragState = {
  categoryKey: string;
  conversationId: string;
  overIndex: number;
  order: string[];
};
const ACTIVITY_FLUSH_DELAY_MS = 60;
const TASK_CATEGORY_DRAG_PX_PER_STEP = 28;
const TASK_CATEGORY_DRAG_THRESHOLD_PX = 4;
const TASK_CATEGORY_DRAG_LONG_PRESS_MS = 350;
const TASK_CATEGORY_DRAG_ARM_CANCEL_PX = 10;
const JUMP_LOAD_PAGE_LIMIT = 50;
const EMPTY_WORK_FILES: WorkFile[] = [];
const EMPTY_PENDING_PROMPTS: PendingPrompt[] = [];
const EMPTY_PRESET_PROMPT_IDS: string[] = [];
const MAX_CONVERSATION_PRESET_PROMPTS = 20;
const EMPTY_REASONING_STEPS: ReasoningStep[] = [];
const MESSAGE_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const FULL_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const ACTIVITY_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

type DraftSaveState = "idle" | "unsaved" | "saving" | "saved" | "error";
type DraftUpload = { id: string; name: string };

function newUploadId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
type CachedComposerDraft = { content: string; quoteExcerpt: string; sourceReference: MessageSourceReference | null; composerDraft: ComposerDraft | null };

function conversationFieldsEqual(left: Conversation, right: Conversation): boolean {
  return left.id === right.id
    && left.title === right.title
    && left.title_source === right.title_source
    && left.status === right.status
    && left.has_unread_result === right.has_unread_result
    && left.has_pending_work === right.has_pending_work
    && JSON.stringify(left.contextUsage) === JSON.stringify(right.contextUsage)
    && left.rollout_bytes === right.rollout_bytes
    && left.archived_at === right.archived_at
    && left.created_at === right.created_at
    && left.updated_at === right.updated_at
    && left.working_dir === right.working_dir;
}

function conversationListEqual(left: readonly Conversation[], right: readonly Conversation[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!conversationFieldsEqual(left[index], right[index])) return false;
  }
  return true;
}

function composerDraftSignature(content: string, quoteExcerpt: string, sourceReference: MessageSourceReference | null = null): string {
  return `${content}\u0000${quoteExcerpt}\u0000${sourceReference ? JSON.stringify(sourceReference) : ""}`;
}

/**
 * localStorage is only a convenience cache. Some browsers expose the
 * property but throw while resolving it (for example when storage is blocked
 * by a privacy policy), so all access must stay behind this best-effort API.
 */
export function readLocalStorageValue(key: string, storage?: Pick<Storage, "getItem">): string | null {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    return source?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeLocalStorageValue(key: string, value: string, storage?: Pick<Storage, "setItem">): void {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    source?.setItem(key, value);
  } catch {
    // A disabled or full cache must never prevent the UI from rendering.
  }
}

export function removeLocalStorageValue(key: string, storage?: Pick<Storage, "removeItem">): void {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    source?.removeItem(key);
  } catch {
    // Clearing an optional cache is also best effort.
  }
}

/**
 * Keep resizable panes within both their hard bounds and the current
 * viewport, so the chat column always keeps a usable minimum width.
 */
function clampPaneWidth(value: number, min: number, max: number): number {
  const viewport = typeof window === "undefined" ? 1440 : window.innerWidth;
  const viewportMax = Math.max(min, Math.min(max, viewport - 480));
  return Math.min(Math.max(value, min), viewportMax);
}

function readPaneWidth(key: string, fallback: number, min: number, max: number): number {
  const raw = readLocalStorageValue(key);
  const parsed = raw === null ? Number.NaN : Number(raw);
  return clampPaneWidth(Number.isFinite(parsed) ? parsed : fallback, min, max);
}

function defaultPreviewWidth(): number {
  const viewport = typeof window === "undefined" ? 1440 : window.innerWidth;
  return Math.round(Math.min(720, Math.max(320, viewport * 0.34)));
}

type PaneResizeDirection = "grow-left" | "grow-right";

function composerTextMaxHeight(): number {
  if (typeof window === "undefined") return COMPOSER_TEXT_HEIGHT_MAX;
  return Math.max(COMPOSER_TEXT_HEIGHT_MIN, Math.min(COMPOSER_TEXT_HEIGHT_MAX, Math.round(window.innerHeight * 0.55)));
}

/**
 * Pointer-driven drag for the composer's top edge. Dragging upward makes the
 * input area taller while the composer stays anchored to the bottom of the
 * chat column.
 */
function beginComposerResize(
  event: ReactPointerEvent<HTMLElement>,
  startHeight: number,
  min: number,
  max: number,
  onHeight: (height: number) => void,
): void {
  if (event.button !== 0) return;
  event.preventDefault();
  const startY = event.clientY;
  let committed = startHeight;
  const move = (moveEvent: globalThis.PointerEvent) => {
    const raw = startHeight + (startY - moveEvent.clientY);
    const next = Math.round(Math.min(max, Math.max(min, raw)));
    if (next !== committed) {
      committed = next;
      onHeight(next);
    }
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    document.body.classList.remove("resizing-composer");
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
  document.body.classList.add("resizing-composer");
}

/**
 * Pointer-driven drag for pane resizers. The sidebar handle grows rightwards
 * when dragged right, while the preview handle grows leftwards when dragged
 * left; both keep the chat column at a usable minimum via clampPaneWidth.
 */
function beginPaneResize(
  event: ReactPointerEvent<HTMLElement>,
  startWidth: number,
  min: number,
  max: number,
  direction: PaneResizeDirection,
  onWidth: (width: number) => void,
  onCommit: (width: number) => void,
): void {
  if (event.button !== 0) return;
  event.preventDefault();
  const startX = event.clientX;
  let committed = startWidth;
  const move = (moveEvent: globalThis.PointerEvent) => {
    const raw = direction === "grow-right"
      ? startWidth + (moveEvent.clientX - startX)
      : startWidth + (startX - moveEvent.clientX);
    const next = clampPaneWidth(raw, min, max);
    if (next !== committed) {
      committed = next;
      onWidth(next);
    }
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    document.body.classList.remove("resizing-pane");
    onCommit(committed);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
  document.body.classList.add("resizing-pane");
}

function commitPaneWidth(key: string, width: number): void {
  writeLocalStorageValue(key, String(width));
}

function readCategoryDisplayState(key: string): Record<string, boolean> {
  const raw = readLocalStorageValue(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, boolean> : {};
  } catch {
    return {};
  }
}

function persistCategoryDisplayState(key: string, value: Record<string, boolean>): void {
  writeLocalStorageValue(key, JSON.stringify(value));
}

function readCategoryVisibleCounts(): Record<string, number> {
  const raw = readLocalStorageValue(TASK_CATEGORY_VISIBLE_COUNTS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const count = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : NaN;
      if (Number.isFinite(count) && count >= 1) result[key] = count;
    }
    return result;
  } catch {
    return {};
  }
}

function persistCategoryVisibleCounts(value: Record<string, number>): void {
  writeLocalStorageValue(TASK_CATEGORY_VISIBLE_COUNTS_KEY, JSON.stringify(value));
}

type TaskViewMode = "list" | "grid";

function readTaskViewMode(): TaskViewMode {
  return readLocalStorageValue(TASK_VIEW_MODE_KEY) === "grid" ? "grid" : "list";
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readStoredThemePreference());
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSessionError(null);
    void api.session()
      .then((value) => {
        if (cancelled) return;
        setCsrf(value.csrfToken);
        setSession(value);
      })
      .catch((reason) => {
        if (cancelled) return;
        setCsrf();
        setSession(null);
        const detail = reason instanceof Error ? reason.message.trim() : "";
        setSessionError(detail ? `无法连接到服务：${detail}` : "无法连接到服务，请检查服务状态后重试。");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [sessionAttempt]);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const update = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    applyThemePreference(themePreference, systemPrefersDark);
    writeLocalStorageValue(THEME_PREFERENCE_KEY, themePreference);
  }, [systemPrefersDark, themePreference]);

  if (loading) return <div className="boot"><div className="brand-mark"><Zap size={20} /></div><LoaderCircle className="spin" /></div>;
  if (sessionError) {
    return <main className="login-page"><section className="login-card" role="alert">
      <div className="login-heading"><h1>服务连接失败</h1><p>{sessionError}</p></div>
      <button className="primary-button" type="button" onClick={() => {
        setLoading(true);
        setSessionAttempt((attempt) => attempt + 1);
      }}>重试</button>
    </section></main>;
  }
  if (!session?.authenticated) return <Login onLogin={(value) => { setCsrf(value.csrfToken); setSession(value); }} />;
  return <Workspace session={session} onLogout={() => { setCsrf(); setSession({ authenticated: false }); }} onSessionChange={(value) => { setCsrf(value.csrfToken); setSession(value); }} themePreference={themePreference} onThemePreferenceChange={setThemePreference} />;
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try { onLogin(await api.login(username, password)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); }
    finally { setBusy(false); }
  }

  return <main className="login-page">
    <section className="login-card">
      <div className="brand-mark large"><Zap size={25} /></div>
      <div className="login-heading"><h1>Codex Web</h1><p>登录你的私人 Agent 工作站</p></div>
      <form onSubmit={submit}>
        <label>用户名<input autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>密码<input autoComplete="current-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : "登录"}</button>
      </form>
      <p className="privacy-note">任务与文件仅在你的本机处理</p>
    </section>
  </main>;
}

function Workspace({ session, onLogout, onSessionChange, themePreference, onThemePreferenceChange }: { session: Session; onLogout: () => void; onSessionChange: (session: Session) => void; themePreference: ThemePreference; onThemePreferenceChange: (preference: ThemePreference) => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => readLocalStorageValue(SELECTED_CONVERSATION_KEY));
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sideChatOpen, setSideChatOpen] = useState(false);
  const [fileExplorerOpen, setFileExplorerOpen] = useState(false);
  const [sideChatReferenceRequest, setSideChatReferenceRequest] = useState<SideChatReferenceRequest | null>(null);
  const [query, setQuery] = useState("");
  const [input, setInput] = useState("");
  const [composerInputRevision, setComposerInputRevision] = useState(0);
  const [askAgentQuote, setAskAgentQuote] = useState("");
  const [sourceReference, setSourceReference] = useState<MessageSourceReference | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [composerDraft, setComposerDraft] = useState<ComposerDraft | null>(null);
  const [draftUploads, setDraftUploads] = useState<DraftUpload[]>([]);
  const [draftSaveState, setDraftSaveState] = useState<DraftSaveState>("idle");
  const [editingPending, setEditingPending] = useState<PendingPrompt | null>(null);
  const [removedEditingFileIds, setRemovedEditingFileIds] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [skippingQueue, setSkippingQueue] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [activities, setActivities] = useState<JobEvent[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [agentOptions, setAgentOptions] = useState<AgentOptions | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">("");
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>("workspace-write");
  const [selectionSaving, setSelectionSaving] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [accountSecurityOpen, setAccountSecurityOpen] = useState(false);
  const [providerManagerOpen, setProviderManagerOpen] = useState(false);
  const [billingPanelOpen, setBillingPanelOpen] = useState(false);
  const [presetPromptManagerOpen, setPresetPromptManagerOpen] = useState(false);
  const [presetPrompts, setPresetPrompts] = useState<PresetPrompt[]>([]);
  const [presetSaving, setPresetSaving] = useState(false);
  const [accountUsername, setAccountUsername] = useState(session.username ?? "");
  const [accountCurrentPassword, setAccountCurrentPassword] = useState("");
  const [accountNewPassword, setAccountNewPassword] = useState("");
  const [accountConfirmPassword, setAccountConfirmPassword] = useState("");
  const [accountSaving, setAccountSaving] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [accountNotice, setAccountNotice] = useState("");
  const [providerManagementSaving, setProviderManagementSaving] = useState(false);
  const [taskMenu, setTaskMenu] = useState<{ conversationId: string; top: number; left: number } | null>(null);
  const [archivedDialogOpen, setArchivedDialogOpen] = useState(false);
  const [archivedConversations, setArchivedConversations] = useState<Conversation[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importableSessions, setImportableSessions] = useState<ImportableSession[] | null>(null);
  const [importSessionsLoading, setImportSessionsLoading] = useState(false);
  const [importingSessions, setImportingSessions] = useState(false);
  const [selectedSessionThreadIds, setSelectedSessionThreadIds] = useState<ReadonlySet<string>>(new Set());
  const [importFromDate, setImportFromDate] = useState("");
  const [importToDate, setImportToDate] = useState("");
  const selectAllImportRef = useRef<HTMLInputElement>(null);
  const [chatFontSize, setChatFontSize] = useState(() => normalizeChatFontSize(session.chatFontSize, CHAT_FONT_SIZE_DEFAULT));
  const [fontSizeSaving, setFontSizeSaving] = useState(false);
  const [chatColumnWidth, setChatColumnWidth] = useState(() => normalizeChatColumnWidth(session.chatColumnWidth, CHAT_COLUMN_WIDTH_DEFAULT));
  const [columnWidthSaving, setColumnWidthSaving] = useState(false);
  const [workingDirSettings, setWorkingDirSettings] = useState<WorkingDirSettings | null>(null);
  const [taskCategorySettings, setTaskCategorySettings] = useState<TaskListCategorySettings | null>(null);
  const [newTaskDirPanelOpen, setNewTaskDirPanelOpen] = useState(false);
  const [workingDirManagerOpen, setWorkingDirManagerOpen] = useState(false);
  const [pathBrowser, setPathBrowser] = useState<PathBrowserRequest | null>(null);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [categorySaving, setCategorySaving] = useState(false);
  const [reloadNotice, setReloadNotice] = useState<{ kind: "waiting" | "building" | "restarting" | "success" | "error"; text: string } | null>(null);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [workingDirSaving, setWorkingDirSaving] = useState(false);
  const [categoryMenu, setCategoryMenu] = useState<{ categoryKey: string; top: number; left: number } | null>(null);
  const [categoryNewTaskMenu, setCategoryNewTaskMenu] = useState<{ categoryKey: string; top: number; left: number } | null>(null);
  const [categoryExpanded, setCategoryExpanded] = useState<Record<string, boolean>>(() => readCategoryDisplayState(TASK_CATEGORY_EXPANDED_KEY));
  const [categoryFullyExpanded, setCategoryFullyExpanded] = useState<Record<string, boolean>>(() => readCategoryDisplayState(TASK_CATEGORY_FULLY_EXPANDED_KEY));
  const [categoryVisibleCounts, setCategoryVisibleCounts] = useState<Record<string, number>>(() => readCategoryVisibleCounts());
  const [categoryDragKey, setCategoryDragKey] = useState<string | null>(null);
  const categoryDragRef = useRef<{ moved: boolean } | null>(null);
  const [categoryTaskDrag, setCategoryTaskDrag] = useState<CategoryTaskDragState | null>(null);
  const categoryTaskDragRef = useRef<CategoryTaskDragState & { list: HTMLElement | null; moved: boolean; changed: boolean } | null>(null);
  const conversationsRef = useRef(conversations);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  const workingDirSettingsRef = useRef(workingDirSettings);
  useEffect(() => { workingDirSettingsRef.current = workingDirSettings; }, [workingDirSettings]);
  const taskCategorySettingsRef = useRef(taskCategorySettings);
  useEffect(() => { taskCategorySettingsRef.current = taskCategorySettings; }, [taskCategorySettings]);
  const [taskViewMode, setTaskViewMode] = useState<TaskViewMode>(readTaskViewMode);
  const [previewFile, setPreviewFile] = useState<WorkFile | null>(null);
  const [snippetPreview, setSnippetPreview] = useState<{ conversationId: string; path: string; line?: number } | null>(null);
  const pendingSourceFocusRef = useRef<{ conversationId: string; messageId: string } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => readPaneWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX));
  const [previewWidth, setPreviewWidth] = useState(() => readPaneWidth(PREVIEW_WIDTH_KEY, defaultPreviewWidth(), PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX));
  const [sideChatWidth, setSideChatWidth] = useState(() => readPaneWidth(SIDE_CHAT_WIDTH_KEY, SIDE_CHAT_WIDTH_DEFAULT, SIDE_CHAT_WIDTH_MIN, SIDE_CHAT_WIDTH_MAX));
  const [fileExplorerWidth, setFileExplorerWidth] = useState(() => readPaneWidth(FILE_EXPLORER_WIDTH_KEY, FILE_EXPLORER_WIDTH_DEFAULT, FILE_EXPLORER_WIDTH_MIN, FILE_EXPLORER_WIDTH_MAX));
  const [manualWorkingDir, setManualWorkingDir] = useState("");
  const [favoritePathInput, setFavoritePathInput] = useState("");
  const [favoriteLabelInput, setFavoriteLabelInput] = useState("");
  const [editingFavoriteLabel, setEditingFavoriteLabel] = useState<string | null>(null);
  const [editingFavoriteLabelValue, setEditingFavoriteLabelValue] = useState("");
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [historyLoadVersion, setHistoryLoadVersion] = useState(0);
  const messagesRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<ConversationDetail | null>(detail);
  const filteredImportableSessions = useMemo(
    () => importableSessions ? filterImportableSessionsByDateRange(importableSessions, importFromDate, importToDate) : [],
    [importableSessions, importFromDate, importToDate],
  );
  const allFilteredSelected = filteredImportableSessions.length > 0
    && filteredImportableSessions.every((item) => selectedSessionThreadIds.has(item.threadId));
  const someFilteredSelected = filteredImportableSessions.some((item) => selectedSessionThreadIds.has(item.threadId));

  useEffect(() => {
    if (selectAllImportRef.current) {
      selectAllImportRef.current.indeterminate = someFilteredSelected && !allFilteredSelected;
    }
  }, [someFilteredSelected, allFilteredSelected]);
  const autoFollowRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const loadingOlderMessagesRef = useRef(false);
  const jumpPendingRef = useRef<{ conversationId: string; direction: JumpDirection; anchorId: string; pages: number } | null>(null);
  const prependScrollRestoreRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const connectedJobRef = useRef<string | null>(null);
  const deletingConversationIdsRef = useRef(new Set<string>());
  const selectedIdRef = useRef<string | null>(selectedId);
  const editingPendingRef = useRef<PendingPrompt | null>(editingPending);
  const lastEventIdRef = useRef(0);
  const inputRef = useRef(input);
  const askAgentQuoteRef = useRef(askAgentQuote);
  const sourceReferenceRef = useRef<MessageSourceReference | null>(sourceReference);
  const composerDraftRef = useRef<ComposerDraft | null>(composerDraft);
  const draftUploadsRef = useRef<DraftUpload[]>(draftUploads);
  const draftLoadedConversationRef = useRef<string | null>(null);
  const draftCacheRef = useRef(new Map<string, CachedComposerDraft>());
  const draftSyncedSignaturesRef = useRef(new Map<string, string>());
  const draftMutationGenerationRef = useRef(new Map<string, number>());
  const draftSaveTimerRef = useRef<number | null>(null);
  const draftSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const newTaskDirPanelRef = useRef<HTMLDivElement>(null);
  const activityPendingRef = useRef<JobEvent[]>([]);
  const activityFlushTimerRef = useRef<number | null>(null);
  const currentConversationIdRef = useRef<string | null>(null);
  const taskMenuRef = useRef(taskMenu);
  const dismissedReloadSignatureRef = useRef<string | null>(null);
  const currentReloadSignatureRef = useRef("");
  const sideChatReferenceSequenceRef = useRef(0);
  selectedIdRef.current = selectedId;
  detailRef.current = detail;
  currentConversationIdRef.current = detail?.conversation.id === selectedId ? detail.conversation.id : null;
  taskMenuRef.current = taskMenu;
  editingPendingRef.current = editingPending;
  askAgentQuoteRef.current = askAgentQuote;
  sourceReferenceRef.current = sourceReference;
  composerDraftRef.current = composerDraft;
  draftUploadsRef.current = draftUploads;

  const askAgentAbout = useCallback((selectedText: string, _messageId: string) => {
    const normalized = normalizeAskAgentSelection(selectedText);
    if (!normalized) return;
    setAskAgentQuote(normalized.slice(0, ASK_AGENT_SELECTION_MAX_CHARS + 1));
    setComposerFocusRequest((request) => request + 1);
  }, []);

  const newConversationFromSourceRef = useRef<(sourceMessageId: string, excerpt: string) => void>(() => undefined);
  newConversationFromSourceRef.current = newConversationFromSource;

  const toggleSideChat = useCallback(() => {
    setPreviewFile(null);
    setSnippetPreview(null);
    setFileExplorerOpen(false);
    setSideChatOpen((open) => !open);
  }, []);

  const toggleFileExplorer = useCallback(() => {
    setPreviewFile(null);
    setSnippetPreview(null);
    setSideChatOpen(false);
    setSideChatReferenceRequest(null);
    setFileExplorerOpen((open) => !open);
  }, []);

  const askSideChatAbout = useCallback((selectedText: string, messageId: string) => {
    const excerpt = normalizeAskAgentSelection(selectedText);
    const sourceConversation = detailRef.current?.conversation;
    if (!excerpt || !sourceConversation) return;
    setPreviewFile(null);
    setSnippetPreview(null);
    setFileExplorerOpen(false);
    setSideChatOpen(true);
    sideChatReferenceSequenceRef.current += 1;
    setSideChatReferenceRequest({ id: sideChatReferenceSequenceRef.current, sourceConversation, sourceMessageId: messageId, excerpt });
  }, []);

  const openFilePreview = useCallback((file: WorkFile) => { setFileExplorerOpen(false); setSideChatOpen(false); setPreviewFile(file); }, []);
  const closeFilePreview = useCallback(() => setPreviewFile(null), []);
  const openCodeSnippet = useCallback((target: FileLineRef) => {
    const conversation = detailRef.current;
    if (!conversation) return;
    setFileExplorerOpen(false);
    setSideChatOpen(false);
    setPreviewFile(null);
    setSnippetPreview({ conversationId: conversation.conversation.id, path: target.path, line: target.line });
  }, []);
  const closeCodeSnippet = useCallback(() => setSnippetPreview(null), []);

  const refreshList = useCallback(async () => {
    const result = await api.conversations();
    setConversations((current) => conversationListEqual(current, result.conversations) ? current : result.conversations);
    return result.conversations;
  }, []);

  function showConversationInList(conversation: Conversation): void {
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
  }

  const refreshTaskCategories = useCallback(async () => {
    const result = await api.taskCategories(); setTaskCategorySettings(result.settings); return result.settings;
  }, []);

  const syncConversation = useCallback((conversation: Conversation) => {
    setConversations((current) => {
      const next = current.map((item) => item.id === conversation.id ? conversation : item);
      return conversationListEqual(current, next) ? current : next;
    });
    setDetail((current) => {
      if (current?.conversation.id !== conversation.id) return current;
      return conversationFieldsEqual(current.conversation, conversation) ? current : { ...current, conversation };
    });
  }, []);

  const persistComposerDraft = useCallback((conversationId: string, content: string, quoteExcerpt: string, sourceRef: MessageSourceReference | null, keepalive = false) => {
    const signature = composerDraftSignature(content, quoteExcerpt, sourceRef);
    const operation = draftSaveQueueRef.current.catch(() => undefined).then(async () => {
      if (selectedIdRef.current === conversationId && !editingPendingRef.current) setDraftSaveState("saving");
      const result = await api.saveConversationDraft(conversationId, content, quoteExcerpt, sourceRef, keepalive && new Blob([content, quoteExcerpt, JSON.stringify(sourceRef ?? "")]).size < 60_000);
      draftMutationGenerationRef.current.set(conversationId, (draftMutationGenerationRef.current.get(conversationId) ?? 0) + 1);
      draftSyncedSignaturesRef.current.set(conversationId, signature);
      const cached = draftCacheRef.current.get(conversationId);
      if (cached) draftCacheRef.current.set(conversationId, { ...cached, composerDraft: result.composerDraft });
      if (selectedIdRef.current === conversationId && !editingPendingRef.current) {
        composerDraftRef.current = result.composerDraft;
        setComposerDraft(result.composerDraft);
        setDraftSaveState(composerDraftSignature(inputRef.current, askAgentQuoteRef.current, sourceReferenceRef.current) === signature ? "saved" : "unsaved");
      }
    }).catch((reason) => {
      if (selectedIdRef.current === conversationId && !editingPendingRef.current) setDraftSaveState("error");
      throw reason;
    });
    draftSaveQueueRef.current = operation.catch(() => undefined);
    return operation;
  }, []);

  const applyExternalComposerText = useCallback((text: string) => {
    inputRef.current = text;
    setInput(text);
    // The textarea is intentionally non-controlled, so an external value
    // equal to the current state still needs a render to reach the DOM.
    setComposerInputRevision((revision) => revision + 1);
  }, []);

  const handleComposerTextChange = useCallback((text: string) => {
    inputRef.current = text;
    const conversationId = selectedIdRef.current;
    if (!conversationId || editingPendingRef.current || draftLoadedConversationRef.current !== conversationId) return;
    const quoteExcerpt = askAgentQuoteRef.current;
    const sourceRef = sourceReferenceRef.current;
    const signature = composerDraftSignature(text, quoteExcerpt, sourceRef);
    draftCacheRef.current.set(conversationId, { content: text, quoteExcerpt, sourceReference: sourceRef, composerDraft: composerDraftRef.current });
    if (signature === draftSyncedSignaturesRef.current.get(conversationId)) {
      setDraftSaveState(composerDraftRef.current ? "saved" : "idle");
      return;
    }
    setDraftSaveState("unsaved");
    if (draftSaveTimerRef.current !== null) window.clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = window.setTimeout(() => {
      draftSaveTimerRef.current = null;
      void persistComposerDraft(conversationId, text, quoteExcerpt, sourceRef).catch(() => undefined);
    }, COMPOSER_DRAFT_SAVE_DELAY_MS);
  }, [persistComposerDraft]);

  const flushActivities = useCallback(() => {
    if (activityFlushTimerRef.current !== null) {
      window.clearTimeout(activityFlushTimerRef.current);
      activityFlushTimerRef.current = null;
    }
    const pending = activityPendingRef.current;
    activityPendingRef.current = [];
    if (pending.length > 0) setActivities((previous) => mergeJobEvents(previous, pending));
  }, []);

  const clearActivitiesBuffer = useCallback(() => {
    if (activityFlushTimerRef.current !== null) {
      window.clearTimeout(activityFlushTimerRef.current);
      activityFlushTimerRef.current = null;
    }
    activityPendingRef.current = [];
  }, []);

  const queueActivity = useCallback((stored: JobEvent) => {
    activityPendingRef.current.push(stored);
    if (activityFlushTimerRef.current !== null) return;
    activityFlushTimerRef.current = window.setTimeout(() => {
      activityFlushTimerRef.current = null;
      const pending = activityPendingRef.current;
      activityPendingRef.current = [];
      if (pending.length > 0) setActivities((previous) => mergeJobEvents(previous, pending));
    }, ACTIVITY_FLUSH_DELAY_MS);
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    const draftGenerationAtRequest = draftMutationGenerationRef.current.get(id) ?? 0;
    let result = await api.conversation(id);
    if (selectedIdRef.current !== id) return result;
    const responseIsStale = (draftMutationGenerationRef.current.get(id) ?? 0) !== draftGenerationAtRequest;
    if (result.conversation.has_unread_result) {
      try {
        const seen = await api.markConversationSeen(id);
        result = { ...result, conversation: seen.conversation };
        syncConversation(seen.conversation);
      } catch {
        // Viewing the task must still work if the acknowledgement request is temporarily unavailable.
      }
    }
    setDetail((current) => current?.conversation.id === id
      ? {
          ...result,
          messages: mergeMessagePages(current.messages, result.messages),
          messagePage: current.messagePage,
        }
      : result);
    setSelectedModel(result.agentSelection.model);
    setReasoningEffort(result.agentSelection.reasoningEffort);
    setSandboxMode(result.agentSelection.sandbox ?? "workspace-write");
    setJob(result.activeJob);
    setSending(Boolean(result.activeJob));
    setActivities(mergeJobEvents([], result.jobEvents));
    if (result.editingPrompt && !responseIsStale) {
      composerDraftRef.current = result.composerDraft;
      setComposerDraft(result.composerDraft);
      const cachedDraft = draftCacheRef.current.get(id);
      if (cachedDraft) draftCacheRef.current.set(id, { ...cachedDraft, composerDraft: result.composerDraft });
      if (editingPendingRef.current?.id !== result.editingPrompt.id) {
        editingPendingRef.current = result.editingPrompt;
        setEditingPending(result.editingPrompt);
        setRemovedEditingFileIds([]);
        setFiles([]);
        applyExternalComposerText(result.editingPrompt.content);
        setAskAgentQuote(result.editingPrompt.quote_excerpt ?? "");
        setSourceReference(null);
      }
    } else if (!result.editingPrompt) {
      const wasEditing = Boolean(editingPendingRef.current);
      if (wasEditing && !responseIsStale) {
        editingPendingRef.current = null;
        setEditingPending(null);
        setRemovedEditingFileIds([]);
        draftLoadedConversationRef.current = null;
      }
      const cached = draftCacheRef.current.get(id);
      const shouldRestore = !responseIsStale && (wasEditing || draftLoadedConversationRef.current !== id);
      if (shouldRestore) {
        const cachedSignature = cached ? composerDraftSignature(cached.content, cached.quoteExcerpt, cached.sourceReference) : undefined;
        const cachedIsDirty = Boolean(cached && cachedSignature !== draftSyncedSignaturesRef.current.get(id));
        const restored = cachedIsDirty ? cached! : {
          content: result.composerDraft?.content ?? "",
          quoteExcerpt: result.composerDraft?.quote_excerpt ?? "",
          sourceReference: result.composerDraft?.source_reference ?? null,
          composerDraft: result.composerDraft,
        };
        draftLoadedConversationRef.current = id;
        composerDraftRef.current = restored.composerDraft;
        setComposerDraft(restored.composerDraft);
        applyExternalComposerText(restored.content);
        setAskAgentQuote(restored.quoteExcerpt);
        setSourceReference(restored.sourceReference);
        setFiles([]);
        draftCacheRef.current.set(id, restored);
        if (!cachedIsDirty) draftSyncedSignaturesRef.current.set(id, composerDraftSignature(restored.content, restored.quoteExcerpt, restored.sourceReference));
        setDraftSaveState(cachedIsDirty ? "unsaved" : restored.composerDraft ? "saved" : "idle");
      } else {
        const localSignature = composerDraftSignature(inputRef.current, askAgentQuoteRef.current, sourceReferenceRef.current);
        const syncedSignature = draftSyncedSignaturesRef.current.get(id);
        const serverContent = result.composerDraft?.content ?? "";
        const serverQuote = result.composerDraft?.quote_excerpt ?? "";
        const serverSource = result.composerDraft?.source_reference ?? null;
        const serverSignature = composerDraftSignature(serverContent, serverQuote, serverSource);
        const serverDraft = responseIsStale ? composerDraftRef.current : result.composerDraft;
        composerDraftRef.current = serverDraft;
        setComposerDraft(serverDraft);
        if (!responseIsStale && localSignature === syncedSignature && serverSignature !== syncedSignature) {
          applyExternalComposerText(serverContent);
          setAskAgentQuote(serverQuote);
          setSourceReference(serverSource);
          draftSyncedSignaturesRef.current.set(id, serverSignature);
          draftCacheRef.current.set(id, { content: serverContent, quoteExcerpt: serverQuote, sourceReference: serverSource, composerDraft: serverDraft });
          setDraftSaveState(serverDraft ? "saved" : "idle");
        } else {
          const current = draftCacheRef.current.get(id);
          if (current) draftCacheRef.current.set(id, { ...current, composerDraft: serverDraft });
        }
      }
    }
    lastEventIdRef.current = result.jobEvents.at(-1)?.seq ?? 0;
    if (result.latestJob?.status === "failed") setError(result.jobEvents.findLast((event) => event.message)?.message || "任务处理失败");
    return result;
  }, [syncConversation]);

  useEffect(() => {
    void refreshList().then((items) => {
      const next = chooseSelectedConversation(selectedIdRef.current, items);
      if (next !== selectedIdRef.current) setSelectedId(next);
    });
  }, [refreshList]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshList().catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [refreshList]);
  useEffect(() => {
    // Re-clamp persisted widths when the viewport shrinks, so the chat
    // column never collapses below its usable minimum.
    const handleWindowResize = () => {
      setSidebarWidth((current) => clampPaneWidth(current, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX));
      setPreviewWidth((current) => clampPaneWidth(current, PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX));
      setSideChatWidth((current) => clampPaneWidth(current, SIDE_CHAT_WIDTH_MIN, SIDE_CHAT_WIDTH_MAX));
    };
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, []);
  useEffect(() => {
    removeLocalStorageValue("codex-web:model");
    removeLocalStorageValue("codex-web:reasoning");
    void api.agentOptions().then((options) => {
      setAgentOptions(options);
      if (!selectedIdRef.current) {
        setSelectedModel(options.selection.model);
        setReasoningEffort(options.selection.reasoningEffort);
        setSandboxMode(options.selection.sandbox ?? "workspace-write");
      }
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "模型选项加载失败"));
    void api.workingDirs().then(({ settings }) => setWorkingDirSettings(settings))
      .catch(() => setWorkingDirSettings(null));
    void api.taskCategories().then(({ settings }) => setTaskCategorySettings(settings))
      .catch(() => setTaskCategorySettings(null));
    void api.presetPrompts().then(({ presetPrompts: next }) => setPresetPrompts(next))
      .catch(() => setPresetPrompts([]));
  }, []);
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    async function pollReloadStatus() {
      let signature = "";
      try {
        const status: ReloadStatus = await api.reloadStatus();
        if (cancelled) return;
        signature = `${status.state ?? ""}:${status.lastResult?.finishedAt ?? ""}`;
        currentReloadSignatureRef.current = signature;
        let next: { kind: "waiting" | "building" | "restarting" | "success" | "error"; text: string } | null = null;
        if (!status.available) {
          next = null;
        } else if (status.state === "waiting") {
          next = { kind: "waiting", text: "代码更新已排队，任务结束后将自动重启服务。" };
        } else if (status.state === "building") {
          next = { kind: "building", text: "正在构建更新，稍后将重启服务…" };
        } else if (status.state === "restarting") {
          next = { kind: "restarting", text: "服务正在重启，页面将短暂断开…" };
        } else if (status.state === "wait-timeout" || status.state === "build-failed" || status.state === "restart-failed") {
          next = { kind: "error", text: `Reload 未完成：${status.lastResult?.error ?? "请稍后重试"}` };
        } else if (status.state === "idle" && status.lastResult?.command === "restart" && status.lastResult.ok === true) {
          const finishedAt = Date.parse(status.lastResult.finishedAt ?? "");
          if (Number.isFinite(finishedAt) && Date.now() - finishedAt < 60_000) {
            next = { kind: "success", text: "服务已重启成功，请刷新页面以加载最新版本。" };
          }
        }
        if (next && dismissedReloadSignatureRef.current === signature) next = null;
        setReloadNotice(next);
      } catch {
        if (cancelled) return;
        setReloadNotice((current) => current?.kind === "success" ? current : null);
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void pollReloadStatus(), RELOAD_STATUS_POLL_MS);
      }
    }
    void pollReloadStatus();
    return () => { cancelled = true; if (timer !== null) window.clearTimeout(timer); };
  }, []);
  useEffect(() => {
    persistCategoryDisplayState(TASK_CATEGORY_EXPANDED_KEY, categoryExpanded);
    persistCategoryDisplayState(TASK_CATEGORY_FULLY_EXPANDED_KEY, categoryFullyExpanded);
  }, [categoryExpanded, categoryFullyExpanded]);
  useEffect(() => {
    persistCategoryVisibleCounts(categoryVisibleCounts);
  }, [categoryVisibleCounts]);
  useEffect(() => {
    if (!newTaskDirPanelOpen) return;
    function closeFromOutside(event: PointerEvent) {
      if (!newTaskDirPanelRef.current?.contains(event.target as Node)) setNewTaskDirPanelOpen(false);
    }
    window.addEventListener("pointerdown", closeFromOutside);
    return () => window.removeEventListener("pointerdown", closeFromOutside);
  }, [newTaskDirPanelOpen]);
  useEffect(() => {
    autoFollowRef.current = true;
    lastScrollTopRef.current = 0;
    loadingOlderMessagesRef.current = false;
    prependScrollRestoreRef.current = null;
    setLoadingOlderMessages(false);
    if (!selectedId) {
      removeLocalStorageValue(SELECTED_CONVERSATION_KEY);
      eventSourceRef.current?.close(); connectedJobRef.current = null;
      clearActivitiesBuffer();
      setDetail(null); setJob(null); setSending(false); setActivities([]);
      setEditingPending(null); setRemovedEditingFileIds([]); setAskAgentQuote("");
      setSourceReference(null);
      composerDraftRef.current = null; setComposerDraft(null); setDraftUploads([]); setDraftSaveState("idle");
      draftLoadedConversationRef.current = null;
      if (agentOptions) {
        setSelectedModel(agentOptions.selection.model);
        setReasoningEffort(agentOptions.selection.reasoningEffort);
        setSandboxMode(agentOptions.selection.sandbox ?? "workspace-write");
      }
      return;
    }
    writeLocalStorageValue(SELECTED_CONVERSATION_KEY, selectedId);
    eventSourceRef.current?.close(); connectedJobRef.current = null; setActivities([]);
    clearActivitiesBuffer();
    editingPendingRef.current = null; setEditingPending(null); setRemovedEditingFileIds([]); setFiles([]); setDraftUploads([]);
    const cached = draftCacheRef.current.get(selectedId);
    draftLoadedConversationRef.current = cached ? selectedId : null;
    composerDraftRef.current = cached?.composerDraft ?? null;
    setComposerDraft(cached?.composerDraft ?? null);
    applyExternalComposerText(cached?.content ?? "");
    setAskAgentQuote(cached?.quoteExcerpt ?? "");
    setSourceReference(cached?.sourceReference ?? null);
    setDraftSaveState(cached ? "unsaved" : "idle");
    void reconcile(selectedId);
    setSidebarOpen(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  useEffect(() => {
    if (!selectedId || editingPending || draftLoadedConversationRef.current !== selectedId) return;
    const content = inputRef.current;
    const signature = composerDraftSignature(content, askAgentQuote, sourceReference);
    draftCacheRef.current.set(selectedId, { content, quoteExcerpt: askAgentQuote, sourceReference, composerDraft: composerDraftRef.current });
    if (signature === draftSyncedSignaturesRef.current.get(selectedId)) {
      setDraftSaveState(composerDraftRef.current ? "saved" : "idle");
      return;
    }
    setDraftSaveState("unsaved");
    if (draftSaveTimerRef.current !== null) window.clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = window.setTimeout(() => {
      draftSaveTimerRef.current = null;
      void persistComposerDraft(selectedId, content, askAgentQuote, sourceReference).catch(() => undefined);
    }, COMPOSER_DRAFT_SAVE_DELAY_MS);
    return () => {
      if (draftSaveTimerRef.current !== null) window.clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    };
  }, [askAgentQuote, editingPending, persistComposerDraft, selectedId, sourceReference]);
  useEffect(() => () => {
    if (draftSaveTimerRef.current !== null) window.clearTimeout(draftSaveTimerRef.current);
    const conversationId = selectedId;
    if (!conversationId || editingPendingRef.current || draftLoadedConversationRef.current !== conversationId) return;
    const content = inputRef.current;
    const quoteExcerpt = askAgentQuoteRef.current;
    const sourceRef = sourceReferenceRef.current;
    if (composerDraftSignature(content, quoteExcerpt, sourceRef) !== draftSyncedSignaturesRef.current.get(conversationId)) {
      void persistComposerDraft(conversationId, content, quoteExcerpt, sourceRef, true).catch(() => undefined);
    }
  }, [persistComposerDraft, selectedId]);
  useEffect(() => {
    const resume = () => { if (selectedIdRef.current) void reconcile(selectedIdRef.current); };
    const visible = () => {
      if (document.visibilityState === "visible") return resume();
      const conversationId = selectedIdRef.current;
      if (!conversationId || editingPendingRef.current || draftLoadedConversationRef.current !== conversationId) return;
      const content = inputRef.current;
      const quoteExcerpt = askAgentQuoteRef.current;
      const sourceRef = sourceReferenceRef.current;
      if (composerDraftSignature(content, quoteExcerpt, sourceRef) !== draftSyncedSignaturesRef.current.get(conversationId)) {
        void persistComposerDraft(conversationId, content, quoteExcerpt, sourceRef, true).catch(() => undefined);
      }
    };
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", visible);
      eventSourceRef.current?.close();
      clearActivitiesBuffer();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearActivitiesBuffer, persistComposerDraft]);
  useLayoutEffect(() => {
    const restore = prependScrollRestoreRef.current;
    if (!restore) return;
    prependScrollRestoreRef.current = null;
    const messages = messagesRef.current;
    if (!messages) return;
    messages.scrollTop = preservePrependedScrollTop(restore.scrollTop, restore.scrollHeight, messages.scrollHeight);
    lastScrollTopRef.current = messages.scrollTop;
    autoFollowRef.current = false;
  }, [detail?.messages.length]);
  useEffect(() => {
    if (!autoFollowRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const messages = messagesRef.current;
      if (!messages || !autoFollowRef.current) return;
      messages.scrollTop = messages.scrollHeight;
      lastScrollTopRef.current = messages.scrollTop;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detail?.messages.length, activities, sending]);

  const loadOlderMessages = useCallback(async () => {
    const current = detailRef.current;
    const conversationId = current?.conversation.id;
    const before = current?.messagePage.nextCursor;
    if (!conversationId || !current.messagePage.hasMore || !before || loadingOlderMessagesRef.current) return;
    loadingOlderMessagesRef.current = true;
    setLoadingOlderMessages(true);
    try {
      const result = await api.conversationMessages(conversationId, before);
      if (selectedIdRef.current !== conversationId) return;
      const messages = messagesRef.current;
      prependScrollRestoreRef.current = messages
        ? { scrollTop: messages.scrollTop, scrollHeight: messages.scrollHeight }
        : null;
      setDetail((latest) => latest?.conversation.id === conversationId
        ? {
            ...latest,
            messages: mergeMessagePages(result.messages, latest.messages),
            messagePage: result.messagePage,
          }
        : latest);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更早消息加载失败");
    } finally {
      loadingOlderMessagesRef.current = false;
      if (selectedIdRef.current === conversationId) {
        setLoadingOlderMessages(false);
        setHistoryLoadVersion((version) => version + 1);
      }
    }
  }, []);

  useEffect(() => {
    const target = pendingSourceFocusRef.current;
    if (!target || detail?.conversation.id !== target.conversationId) return;
    const container = messagesRef.current;
    const message = container?.querySelector<HTMLElement>(`[data-message-id="${target.messageId}"]`);
    if (container && message) {
      pendingSourceFocusRef.current = null;
      scrollToMessage(target.messageId, container);
      return;
    }
    if (detail.messagePage.hasMore && !loadingOlderMessagesRef.current) {
      void loadOlderMessages();
      return;
    }
    if (!detail.messagePage.hasMore) pendingSourceFocusRef.current = null;
  }, [detail?.conversation.id, detail?.messages.length, detail?.messagePage.hasMore, historyLoadVersion, loadOlderMessages]);

  const handleMessagesScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const messages = event.currentTarget;
    const scrollingUp = messages.scrollTop < lastScrollTopRef.current - 1;
    autoFollowRef.current = resolveScrollFollow({
      previousScrollTop: lastScrollTopRef.current,
      scrollTop: messages.scrollTop,
      scrollHeight: messages.scrollHeight,
      clientHeight: messages.clientHeight,
      following: autoFollowRef.current,
    });
    lastScrollTopRef.current = messages.scrollTop;
    if (scrollingUp && messages.scrollTop <= 80) void loadOlderMessages();
  }, [loadOlderMessages]);

  const jumpToUserMessage = useCallback((direction: JumpDirection) => {
    const current = detailRef.current;
    const container = messagesRef.current;
    if (!current || !container) return;
    const anchorId = findViewportAnchorMessageId(container);
    if (!anchorId) return;
    const found = findUserMessageJump(current.messages, anchorId, direction);
    if (found) {
      scrollToMessage(found, container);
      return;
    }
    if (direction === "next" || !current.messagePage.hasMore) {
      setNotice(direction === "previous" ? "没有更早的我的消息" : "没有更晚的我的消息");
      return;
    }
    jumpPendingRef.current = { conversationId: current.conversation.id, direction, anchorId, pages: 0 };
    void loadOlderMessages();
  }, [loadOlderMessages]);

  useEffect(() => {
    const pending = jumpPendingRef.current;
    if (!pending || !detail || detail.conversation.id !== pending.conversationId || loadingOlderMessagesRef.current) return;
    const found = findUserMessageJump(detail.messages, pending.anchorId, pending.direction);
    if (found) {
      jumpPendingRef.current = null;
      const frame = window.requestAnimationFrame(() => {
        const container = messagesRef.current;
        if (container) scrollToMessage(found, container);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (!detail.messagePage.hasMore || pending.pages >= JUMP_LOAD_PAGE_LIMIT) {
      jumpPendingRef.current = null;
      setNotice(!detail.messagePage.hasMore
        ? (pending.direction === "previous" ? "没有更早的我的消息" : "没有更晚的我的消息")
        : "更早消息较多，请继续向上滚动查找");
      return;
    }
    jumpPendingRef.current = { ...pending, pages: pending.pages + 1 };
    void loadOlderMessages();
  }, [detail, historyLoadVersion, loadOlderMessages]);

  function connectJob(activeJob: Job) {
    if (connectedJobRef.current === activeJob.id && eventSourceRef.current?.readyState !== EventSource.CLOSED) return;
    eventSourceRef.current?.close();
    clearActivitiesBuffer();
    connectedJobRef.current = activeJob.id;
    setJob(activeJob); setSending(true);
    const after = lastEventIdRef.current;
    const source = new EventSource(`${BASE_PATH}/api/jobs/${activeJob.id}/events${after ? `?after=${after}` : ""}`);
    eventSourceRef.current = source;
    source.onmessage = (event) => {
      if (eventSourceRef.current !== source || selectedIdRef.current !== activeJob.conversation_id) return;
      const data = JSON.parse(event.data) as JobEvent;
      const seq = Number(event.lastEventId || data.seq || 0);
      const stored = { ...data, seq };
      if (data.type === "context_usage" && typeof data.usedTokens === "number") {
        const contextUsage = {
          usedTokens: data.usedTokens,
          contextWindow: typeof data.contextWindow === "number" ? data.contextWindow : null,
          updatedAt: data.created_at ?? new Date().toISOString(),
        };
        setDetail((current) => current?.conversation.id === activeJob.conversation_id ? { ...current, contextUsage } : current);
      }
      if (seq) lastEventIdRef.current = Math.max(lastEventIdRef.current, seq);
      if (data.type && ["status", "progress"].includes(data.type)) queueActivity(stored);
      if (data.type && ["done", "failed"].includes(data.type)) {
        flushActivities();
        source.close(); connectedJobRef.current = null;
        if (data.type === "failed") setError(data.message || "任务处理失败");
        void reconcile(activeJob.conversation_id);
      }
    };
    source.onerror = () => {
      if (eventSourceRef.current === source && selectedIdRef.current === activeJob.conversation_id) {
        window.setTimeout(() => void reconcile(activeJob.conversation_id), 250);
      }
    };
  }

  async function reconcile(id: string) {
    try {
      const [value] = await Promise.all([refreshDetail(id), refreshList()]);
      if (selectedIdRef.current !== id) return;
      syncConversation(value.conversation);
      if (value.activeJob) connectJob(value.activeJob);
      else {
        eventSourceRef.current?.close(); eventSourceRef.current = null; connectedJobRef.current = null;
        clearActivitiesBuffer();
        setSending(false); setJob(null);
      }
    } catch (reason) {
      if (selectedIdRef.current !== id) return;
      const items = await refreshList().catch(() => [] as Conversation[]);
      if (!items.some((conversation) => conversation.id === id)) {
        removeLocalStorageValue(SELECTED_CONVERSATION_KEY);
        setSelectedId(chooseSelectedConversation(null, items));
      } else {
        setError(reason instanceof Error ? reason.message : "状态刷新失败");
      }
    }
  }

  async function newConversation(workingDir?: string | null) {
    setError("");
    try {
      const result = await api.createConversation(workingDir);
      setSelectedModel(result.agentSelection.model); setReasoningEffort(result.agentSelection.reasoningEffort);
      setSandboxMode(result.agentSelection.sandbox ?? "workspace-write");
      showConversationInList(result.conversation);
      setSelectedId(result.conversation.id);
      setNewTaskDirPanelOpen(false);
      void refreshList().catch(() => undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "新建任务失败");
    }
  }

  async function newConversationFromSource(sourceMessageId: string, excerpt: string) {
    if (!selectedId || submitting || selectionSaving) return;
    setError(""); setSubmitting(true);
    try {
      const result = await api.createConversationFromSource(selectedId, sourceMessageId, excerpt);
      setSelectedModel(result.agentSelection.model);
      setReasoningEffort(result.agentSelection.reasoningEffort);
      setSandboxMode(result.agentSelection.sandbox ?? "workspace-write");
      const cached: CachedComposerDraft = {
        content: "",
        quoteExcerpt: result.composerDraft.quote_excerpt ?? "",
        sourceReference: result.composerDraft.source_reference,
        composerDraft: result.composerDraft,
      };
      draftCacheRef.current.set(result.conversation.id, cached);
      draftSyncedSignaturesRef.current.set(result.conversation.id, composerDraftSignature(cached.content, cached.quoteExcerpt, cached.sourceReference));
      draftLoadedConversationRef.current = result.conversation.id;
      showConversationInList(result.conversation);
      setSelectedId(result.conversation.id);
      void refreshList().catch(() => undefined);
      setComposerDraft(result.composerDraft);
      applyExternalComposerText("");
      setAskAgentQuote(result.composerDraft.quote_excerpt ?? "");
      setSourceReference(result.composerDraft.source_reference);
      setFiles([]);
      setDraftSaveState("saved");
      setComposerFocusRequest((request) => request + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "引用并新建任务失败");
    } finally {
      setSubmitting(false);
    }
  }

  function scrollToMessage(messageId: string, container: HTMLElement) {
    const message = container.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!message) return;
    const containerTop = container.getBoundingClientRect().top;
    const messageTop = message.getBoundingClientRect().top;
    const top = messageTop - containerTop + container.scrollTop;
    container.scrollTo({ top: Math.max(0, top - (container.clientHeight - message.clientHeight) / 2), behavior: "smooth" });
    message.classList.add("message-highlight");
    window.setTimeout(() => message.classList.remove("message-highlight"), 2200);
    autoFollowRef.current = false;
  }

  function openSourceReference(reference: MessageSourceReference) {
    if (reference.kind === "conversation-context") return;
    pendingSourceFocusRef.current = {
      conversationId: reference.sourceConversationId,
      messageId: reference.sourceMessageId,
    };
    if (reference.sourceConversationId === selectedIdRef.current) {
      const container = messagesRef.current;
      const message = container?.querySelector<HTMLElement>(`[data-message-id="${reference.sourceMessageId}"]`);
      if (container && message) {
        pendingSourceFocusRef.current = null;
        scrollToMessage(reference.sourceMessageId, container);
      } else {
        setHistoryLoadVersion((version) => version + 1);
      }
      return;
    }
    setSidebarOpen(false);
    setSelectedId(reference.sourceConversationId);
  }

  async function changeConversationWorkingDir(conversationId: string, workingDir: string | null) {
    setWorkingDirSaving(true); setError("");
    try {
      try {
        const result = await api.updateConversationWorkingDir(conversationId, workingDir);
        syncConversation(result.conversation);
        return;
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.code !== "working-dir-busy") throw reason;
      }
      if (!window.confirm("该工作目录已有其他会话正在排队或运行任务。确认切换后，本会话将与这些任务在同一目录交替执行，可能互相影响文件状态。是否仍要切换？")) return;
      const result = await api.updateConversationWorkingDir(conversationId, workingDir, true);
      syncConversation(result.conversation);
      setNotice("已确认切换到有其他会话活动的工作目录；同一目录的任务仍将串行执行。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "工作目录修改失败");
    } finally {
      setWorkingDirSaving(false);
    }
  }

  async function addFavoriteWorkingDir() {
    const path = favoritePathInput.trim();
    if (!path || workingDirSaving) return;
    setWorkingDirSaving(true); setError("");
    try {
      const { settings } = await api.updateFavoriteWorkingDir({ action: "add", path, label: favoriteLabelInput.trim() || undefined });
      setWorkingDirSettings(settings);
      setFavoritePathInput(""); setFavoriteLabelInput("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "添加收藏失败");
    } finally {
      setWorkingDirSaving(false);
    }
  }

  async function removeFavoriteWorkingDir(path: string) {
    if (workingDirSaving) return;
    setWorkingDirSaving(true); setError("");
    try {
      const { settings } = await api.updateFavoriteWorkingDir({ action: "remove", path });
      setWorkingDirSettings(settings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除收藏失败");
    } finally {
      setWorkingDirSaving(false);
    }
  }

  async function saveFavoriteLabel(path: string) {
    const label = editingFavoriteLabelValue.trim();
    setEditingFavoriteLabel(null);
    if (!label || workingDirSaving) return;
    setWorkingDirSaving(true); setError("");
    try {
      const { settings } = await api.updateFavoriteWorkingDir({ action: "rename", path, label });
      setWorkingDirSettings(settings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重命名收藏失败");
    } finally {
      setWorkingDirSaving(false);
    }
  }

  async function moveFavoriteWorkingDir(path: string, direction: "up" | "down") {
    if (workingDirSaving) return;
    setWorkingDirSaving(true); setError("");
    try {
      const { settings } = await api.updateFavoriteWorkingDir({ action: "move", path, direction });
      setWorkingDirSettings(settings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "调整收藏顺序失败");
    } finally {
      setWorkingDirSaving(false);
    }
  }

  async function toggleFavoriteAsDefault(path: string) {
    if (workingDirSaving) return;
    const isDefault = workingDirSettings?.defaultWorkingDir === path;
    setWorkingDirSaving(true); setError("");
    try {
      const { settings } = await api.setDefaultWorkingDir(isDefault ? null : path);
      setWorkingDirSettings(settings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : (isDefault ? "取消默认目录失败" : "设置默认目录失败"));
    } finally {
      setWorkingDirSaving(false);
    }
  }

  function applyComposerDraftUploadResult(result: { composerDraft: ComposerDraft }, conversationId: string) {
    draftMutationGenerationRef.current.set(conversationId, (draftMutationGenerationRef.current.get(conversationId) ?? 0) + 1);
    if (selectedIdRef.current === conversationId && !editingPendingRef.current) {
      composerDraftRef.current = result.composerDraft;
      setComposerDraft(result.composerDraft);
    }
    const cached = draftCacheRef.current.get(conversationId);
    if (cached) draftCacheRef.current.set(conversationId, { ...cached, composerDraft: result.composerDraft });
    else draftCacheRef.current.set(conversationId, {
      content: conversationId === selectedIdRef.current ? inputRef.current : result.composerDraft.content,
      quoteExcerpt: conversationId === selectedIdRef.current ? askAgentQuoteRef.current : result.composerDraft.quote_excerpt ?? "",
      sourceReference: conversationId === selectedIdRef.current ? sourceReferenceRef.current : result.composerDraft.source_reference ?? null,
      composerDraft: result.composerDraft,
    });
    const currentSignature = composerDraftSignature(inputRef.current, askAgentQuoteRef.current, sourceReferenceRef.current);
    setDraftSaveState(currentSignature === draftSyncedSignaturesRef.current.get(conversationId) ? "saved" : "unsaved");
  }

  async function addComposerFiles(incoming: File[]) {
    if (incoming.length === 0) return;
    const conversationId = selectedIdRef.current;
    if (editingPendingRef.current || !conversationId) {
      setFiles((previous) => [...previous, ...incoming].slice(0, 12));
      return;
    }
    const available = Math.max(0, 12 - (composerDraftRef.current?.files.length ?? 0) - draftUploadsRef.current.length);
    const accepted = incoming.slice(0, available);
    if (accepted.length === 0) { setNotice("单个会话草稿最多包含 12 个附件。"); return; }
    let uploads: DraftUpload[] = [];
    setError("");
    try {
      uploads = accepted.map((file) => ({ id: newUploadId(), name: file.name }));
      setDraftUploads((current) => [...current, ...uploads]);
      const result = await api.uploadConversationDraftFiles(conversationId, accepted);
      applyComposerDraftUploadResult(result, conversationId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "草稿附件上传失败");
    } finally {
      if (uploads.length > 0) {
        const ids = new Set<string>(uploads.map((upload) => upload.id));
        setDraftUploads((current) => current.filter((upload) => !ids.has(upload.id)));
      }
    }
  }

  async function addHostComposerFiles(paths: string[]) {
    if (paths.length === 0) return;
    const conversationId = selectedIdRef.current;
    if (editingPendingRef.current || !conversationId) {
      setNotice("请先完成或取消正在编辑的任务，再选择对话添加服务器文件。");
      return;
    }
    const available = Math.max(0, 12 - (composerDraftRef.current?.files.length ?? 0) - draftUploadsRef.current.length);
    const accepted = paths.slice(0, available);
    if (accepted.length === 0) { setNotice("单个会话草稿最多包含 12 个附件。"); return; }
    let uploads: DraftUpload[] = [];
    setError("");
    try {
      uploads = accepted.map((filePath) => ({ id: newUploadId(), name: filePath.split(/[\\/]/).at(-1) ?? filePath }));
      setDraftUploads((current) => [...current, ...uploads]);
      const result = await api.addHostDraftFiles(conversationId, accepted);
      applyComposerDraftUploadResult(result, conversationId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "从服务器添加附件失败");
    } finally {
      if (uploads.length > 0) {
        const ids = new Set<string>(uploads.map((upload) => upload.id));
        setDraftUploads((current) => current.filter((upload) => !ids.has(upload.id)));
      }
    }
  }

  async function removeComposerDraftFile(file: WorkFile) {
    const conversationId = selectedIdRef.current;
    if (!conversationId || !file.id) return;
    setError("");
    try {
      const result = await api.deleteConversationDraftFile(conversationId, file.id);
      draftMutationGenerationRef.current.set(conversationId, (draftMutationGenerationRef.current.get(conversationId) ?? 0) + 1);
      if (selectedIdRef.current !== conversationId || editingPendingRef.current) return;
      composerDraftRef.current = result.composerDraft;
      setComposerDraft(result.composerDraft);
      const cached = draftCacheRef.current.get(conversationId);
      if (cached) draftCacheRef.current.set(conversationId, { ...cached, composerDraft: result.composerDraft });
      const currentSignature = composerDraftSignature(inputRef.current, askAgentQuoteRef.current, sourceReferenceRef.current);
      setDraftSaveState(currentSignature === draftSyncedSignaturesRef.current.get(conversationId)
        ? result.composerDraft ? "saved" : "idle"
        : "unsaved");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "删除草稿附件失败"); }
  }

  async function clearComposerDraft() {
    const conversationId = selectedIdRef.current;
    if (!conversationId || editingPendingRef.current || draftUploads.length > 0) return;
    if (!window.confirm("清空这个会话尚未发送的正文、引用和附件？")) return;
    if (draftSaveTimerRef.current !== null) window.clearTimeout(draftSaveTimerRef.current);
    await draftSaveQueueRef.current;
    try {
      await api.deleteConversationDraft(conversationId);
      draftMutationGenerationRef.current.set(conversationId, (draftMutationGenerationRef.current.get(conversationId) ?? 0) + 1);
      draftCacheRef.current.delete(conversationId);
      draftSyncedSignaturesRef.current.set(conversationId, composerDraftSignature("", "", null));
      composerDraftRef.current = null;
      setComposerDraft(null); applyExternalComposerText(""); setAskAgentQuote(""); setSourceReference(null); setFiles([]); setDraftSaveState("idle");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "清空草稿失败"); }
  }

  async function send(message?: string) {
    const content = message ?? inputRef.current;
    const hasRetainedEditingFile = Boolean(editingPending?.files.some((file) => !removedEditingFileIds.includes(file.id)));
    const hasComposerDraftFile = Boolean(!editingPending && composerDraft?.files.length);
    if ((!content.trim() && !askAgentQuote && files.length === 0 && !hasRetainedEditingFile && !hasComposerDraftFile) || submitting || selectionSaving) return;
    if (draftUploads.length > 0) { setNotice("请等待草稿附件上传完成后再发送。"); return; }
    setError(""); setNotice(""); setSubmitting(true);
    if (!sending) setActivities([{ kind: "status", label: files.length ? "正在上传并准备文件" : "正在提交任务" }]);
    try {
      let id = selectedId;
      const useComposerDraft = Boolean(id && !editingPending);
      if (!id) {
        const created = await api.createConversation(); id = created.conversation.id;
        setSelectedModel(created.agentSelection.model); setReasoningEffort(created.agentSelection.reasoningEffort);
        setSandboxMode(created.agentSelection.sandbox ?? "workspace-write");
        selectedIdRef.current = id; setSelectedId(id);
      }
      if (editingPending) {
        const result = await api.updatePendingPrompt(id, editingPending.id, content, files, removedEditingFileIds, askAgentQuote, sourceReferenceRef.current);
        if (result.needsInstruction) {
          const persisted = result.editingPrompt ?? result.pendingPrompt ?? editingPending;
          editingPendingRef.current = persisted; setEditingPending(persisted); setRemovedEditingFileIds([]);
          setNotice(result.guidance || "文件已上传，请输入具体操作后再发送。");
        } else {
          editingPendingRef.current = null; setEditingPending(null); setRemovedEditingFileIds([]);
          draftLoadedConversationRef.current = null;
        }
      } else {
        if (useComposerDraft) {
          if (draftSaveTimerRef.current !== null) window.clearTimeout(draftSaveTimerRef.current);
          await draftSaveQueueRef.current;
          await persistComposerDraft(id, content, askAgentQuote, sourceReferenceRef.current);
        }
        const result = await api.sendMessage(id, content, useComposerDraft ? [] : files, askAgentQuote, useComposerDraft);
        if (result.needsInstruction) setNotice(result.guidance || "文件已上传，请输入具体操作后再发送。");
        if (useComposerDraft) {
          draftMutationGenerationRef.current.set(id, (draftMutationGenerationRef.current.get(id) ?? 0) + 1);
          draftCacheRef.current.delete(id);
          draftSyncedSignaturesRef.current.set(id, composerDraftSignature("", "", null));
          draftLoadedConversationRef.current = id;
          composerDraftRef.current = null; setComposerDraft(null); setDraftSaveState("idle");
        }
      }
      applyExternalComposerText(""); setAskAgentQuote(""); setSourceReference(null); setFiles([]);
      await reconcile(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发送失败");
    } finally { setSubmitting(false); }
  }

  async function beginPendingEdit(prompt: PendingPrompt) {
    if (!selectedId || editingPending || submitting) return;
    setError(""); setSubmitting(true);
    try {
      if (draftLoadedConversationRef.current === selectedId) {
        if (draftSaveTimerRef.current !== null) window.clearTimeout(draftSaveTimerRef.current);
        await draftSaveQueueRef.current;
        await persistComposerDraft(selectedId, inputRef.current, askAgentQuoteRef.current, sourceReferenceRef.current);
      }
      const result = await api.editPendingPrompt(selectedId, prompt.id);
      editingPendingRef.current = result.editingPrompt;
      setEditingPending(result.editingPrompt); setRemovedEditingFileIds([]); setFiles([]); setAskAgentQuote(result.editingPrompt.quote_excerpt ?? ""); setSourceReference(result.editingPrompt.source_reference); applyExternalComposerText(result.editingPrompt.content);
      draftLoadedConversationRef.current = null;
      if (selectedModel !== prompt.agent_model || reasoningEffort !== prompt.reasoning_effort || sandboxMode !== (prompt.sandbox_mode ?? "workspace-write")) {
        await persistAgentSelection({ model: prompt.agent_model, reasoningEffort: prompt.reasoning_effort, sandbox: prompt.sandbox_mode ?? "workspace-write" });
      }
      await refreshDetail(selectedId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "进入编辑状态失败"); }
    finally { setSubmitting(false); }
  }

  async function cancelPendingEdit() {
    if (!selectedId || !editingPending || submitting) return;
    setSubmitting(true); setError("");
    try {
      if (editingPending.content.trim() || editingPending.quote_excerpt) await api.restorePendingPrompt(selectedId, editingPending.id);
      else await api.deletePendingPrompt(selectedId, editingPending.id);
      editingPendingRef.current = null; setEditingPending(null); setRemovedEditingFileIds([]); applyExternalComposerText(""); setAskAgentQuote(""); setSourceReference(null); setFiles([]);
      draftLoadedConversationRef.current = null;
      setNotice("");
      await reconcile(selectedId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "取消编辑失败"); }
    finally { setSubmitting(false); }
  }

  async function deletePendingPrompt(prompt: PendingPrompt) {
    if (!selectedId || submitting) return;
    setSubmitting(true); setError("");
    try { await api.deletePendingPrompt(selectedId, prompt.id); await reconcile(selectedId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "删除待发送任务失败"); }
    finally { setSubmitting(false); }
  }

  async function steerPendingPrompt(prompt: PendingPrompt) {
    if (!selectedId || submitting || job?.status !== "running") return;
    setSubmitting(true); setError("");
    try { await api.steerPendingPrompt(selectedId, prompt.id); await reconcile(selectedId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "引导当前任务失败"); }
    finally { setSubmitting(false); }
  }

  async function skipQueuedJob(jobId: string) {
    if (!selectedId || submitting || skippingQueue) return;
    if (!window.confirm("跳过排队将立即启动该任务。若同一工作目录已有其他任务正在运行，两个 Codex 会话可能同时读写该目录，是否继续？")) return;
    setError(""); setNotice(""); setSkippingQueue(true);
    try {
      await api.skipQueuedJob(jobId);
      setNotice("已跳过排队，任务开始直接执行。");
      await reconcile(selectedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "跳过排队失败");
    } finally { setSkippingQueue(false); }
  }

  async function reorderPendingPrompts(ordered: PendingPrompt[]) {
    if (!selectedId || !detail) return;
    const previous = detail.pendingPrompts;
    setDetail({ ...detail, pendingPrompts: ordered });
    try {
      const result = await api.reorderPendingPrompts(selectedId, ordered.map((prompt) => prompt.id));
      setDetail((current) => current ? { ...current, pendingPrompts: result.pendingPrompts } : current);
    } catch (reason) {
      setDetail((current) => current ? { ...current, pendingPrompts: previous } : current);
      setError(reason instanceof Error ? reason.message : "调整待发送顺序失败");
      await refreshDetail(selectedId).catch(() => undefined);
    }
  }

  async function deleteConversation(conversation: Conversation) {
    if (!window.confirm(`删除“${conversation.title}”？相关任务会被停止，本机工作文件和结果文件将无法恢复；数据库审计记录会保留。`)) return;
    if (deletingConversationIdsRef.current.has(conversation.id)) return;
    deletingConversationIdsRef.current.add(conversation.id);
    const wasSelected = selectedIdRef.current === conversation.id;
    const originalIndex = conversationsRef.current.findIndex((item) => item.id === conversation.id);
    setTaskMenu(null);
    setConversations((current) => current.filter((item) => item.id !== conversation.id));
    if (wasSelected) {
      setPreviewFile(null);
      setSnippetPreview(null);
      setSideChatOpen(false);
      setFileExplorerOpen(false);
      setSelectedId(null);
    }
    try {
      await api.deleteConversation(conversation.id);
      void refreshList().catch(() => undefined);
    } catch (reason) {
      setConversations((current) => {
        if (current.some((item) => item.id === conversation.id)) return current;
        const next = [...current];
        next.splice(Math.min(Math.max(originalIndex, 0), next.length), 0, conversation);
        return next;
      });
      if (wasSelected && selectedIdRef.current === null) setSelectedId(conversation.id);
      setError(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      deletingConversationIdsRef.current.delete(conversation.id);
    }
  }

  async function renameConversation(conversation: Conversation) {
    const title = window.prompt("修改任务名称", conversation.title)?.trim();
    if (!title || title === conversation.title) return;
    await api.renameConversation(conversation.id, title); await refreshList(); if (selectedId === conversation.id) await refreshDetail(conversation.id);
  }

  const selectConversation = useCallback((id: string) => setSelectedId(id), []);

  const toggleTaskMenu = useCallback((conversation: Conversation, button: HTMLButtonElement) => {
    if (taskMenuRef.current?.conversationId === conversation.id) {
      setTaskMenu(null);
      return;
    }
    const bounds = button.getBoundingClientRect();
    const width = 156;
    const height = 126;
    const top = bounds.bottom + 6 + height <= window.innerHeight - 8
      ? bounds.bottom + 6
      : Math.max(8, bounds.top - height - 6);
    const left = Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8));
    setTaskMenu({ conversationId: conversation.id, top, left });
  }, []);

  const handleChatWorkingDirChange = useCallback((workingDir: string | null) => {
    const conversationId = currentConversationIdRef.current;
    if (conversationId) void changeConversationWorkingDir(conversationId, workingDir);
  }, []);

  useEffect(() => {
    if (!taskMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest("[data-task-menu]")) setTaskMenu(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setTaskMenu(null);
    };
    const closeOnResize = () => setTaskMenu(null);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [taskMenu]);
  useEffect(() => {
    if (!categoryMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest("[data-category-menu]")) setCategoryMenu(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setCategoryMenu(null);
    };
    const closeOnResize = () => setCategoryMenu(null);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [categoryMenu]);
  useEffect(() => {
    if (!categoryNewTaskMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest("[data-category-new-task-menu]")) setCategoryNewTaskMenu(null);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setCategoryNewTaskMenu(null);
    };
    const closeOnResize = () => setCategoryNewTaskMenu(null);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnResize);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnResize);
    };
  }, [categoryNewTaskMenu]);

  async function openArchivedConversations() {
    setAccountSettingsOpen(false);
    setArchivedDialogOpen(true);
    setArchivedLoading(true);
    setError("");
    try {
      const result = await api.archivedConversations();
      setArchivedConversations(result.conversations);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取已归档任务失败");
    } finally {
      setArchivedLoading(false);
    }
  }

  async function openImportDialog() {
    setAccountSettingsOpen(false);
    setImportDialogOpen(true);
    setError("");
    if (importableSessions !== null) return;
    setImportSessionsLoading(true);
    try {
      const result = await api.importableSessions();
      setImportableSessions(result.sessions);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取本地历史会话失败");
    } finally {
      setImportSessionsLoading(false);
    }
  }

  async function togglePresetPrompt(id: string, enabled: boolean) {
    const conversationId = selectedIdRef.current;
    const currentDetailValue = detailRef.current;
    if (!conversationId || !currentDetailValue || presetSaving) return;
    const current = currentDetailValue.enabledPresetPromptIds;
    const next = enabled ? [...current, id] : current.filter((candidate) => candidate !== id);
    if (next.length > MAX_CONVERSATION_PRESET_PROMPTS) {
      setError(`每个对话最多启用 ${MAX_CONVERSATION_PRESET_PROMPTS} 条预设。`);
      return;
    }
    setDetail((value) => value && value.conversation.id === conversationId ? { ...value, enabledPresetPromptIds: next } : value);
    setPresetSaving(true); setError("");
    try {
      const result = await api.setConversationPresetPrompts(conversationId, next);
      setDetail((value) => value && value.conversation.id === conversationId ? { ...value, enabledPresetPromptIds: result.enabledPresetPromptIds } : value);
    } catch (reason) {
      setDetail((value) => value && value.conversation.id === conversationId ? { ...value, enabledPresetPromptIds: current } : value);
      setError(reason instanceof Error ? reason.message : "保存预设启用状态失败");
    } finally {
      setPresetSaving(false);
    }
  }

  async function refreshPresetPrompts() {
    try {
      const { presetPrompts: next } = await api.presetPrompts();
      setPresetPrompts(next);
      const conversationId = selectedIdRef.current;
      if (conversationId) await reconcile(conversationId);
    } catch {
      setError("刷新预设 Prompt 失败，请稍后重试。");
    }
  }

  function toggleImportSession(threadId: string) {
    setSelectedSessionThreadIds((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }

  function toggleSelectAllImportableSessions() {
    setSelectedSessionThreadIds((current) => {
      const next = new Set(current);
      for (const item of filteredImportableSessions) {
        if (allFilteredSelected) next.delete(item.threadId);
        else next.add(item.threadId);
      }
      return next;
    });
  }

  async function importSelectedSessions() {
    if (selectedSessionThreadIds.size === 0) return;
    setImportingSessions(true);
    setError("");
    try {
      const result = await api.importSessions([...selectedSessionThreadIds]);
      setImportDialogOpen(false);
      setSelectedSessionThreadIds(new Set());
      setImportableSessions(null);
      await refreshList();
      if (result.conversations.length > 0) {
        setSelectedId(result.conversations[0].id);
        setNotice(result.skipped.length > 0
          ? `已导入 ${result.conversations.length} 个历史会话，${result.skipped.length} 个已跳过`
          : `已导入 ${result.conversations.length} 个历史会话`);
      } else if (result.skipped.length > 0) {
        setNotice("所选会话无法导入或已经导入");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导入历史会话失败");
    } finally {
      setImportingSessions(false);
    }
  }

  async function archiveConversation(conversation: Conversation) {
    setTaskMenu(null);
    try {
      await api.archiveConversation(conversation.id);
      await refreshList();
      if (selectedId === conversation.id) await refreshDetail(conversation.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "归档失败");
    }
  }

  async function restoreConversation(conversation: Conversation) {
    try {
      await api.restoreConversation(conversation.id);
      setArchivedConversations((current) => current.filter((item) => item.id !== conversation.id));
      await refreshList();
      if (selectedId === conversation.id) await refreshDetail(conversation.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "恢复失败");
    }
  }

  async function logout() { try { await api.logout(); } finally { onLogout(); } }

  function openAccountSecurity() {
    setAccountUsername(session.username ?? "");
    setAccountCurrentPassword("");
    setAccountNewPassword("");
    setAccountConfirmPassword("");
    setAccountError("");
    setAccountNotice("");
    setAccountSecurityOpen(true);
  }

  async function saveAccount(event: FormEvent) {
    event.preventDefault();
    setAccountError("");
    setAccountNotice("");
    const nextUsername = accountUsername.trim();
    const changedUsername = nextUsername !== session.username;
    const newPassword = accountNewPassword;
    if (newPassword !== accountConfirmPassword) {
      setAccountError("两次输入的新密码不一致。");
      return;
    }
    if (newPassword && newPassword.length < 12) {
      setAccountError("新密码至少需要 12 个字符。");
      return;
    }
    if (!changedUsername && !newPassword) {
      setAccountError("没有需要保存的变更。");
      return;
    }
    if (!accountCurrentPassword) {
      setAccountError("请输入当前密码以确认身份。");
      return;
    }
    setAccountSaving(true);
    try {
      const updated = await api.updateAccount({
        currentPassword: accountCurrentPassword,
        ...(changedUsername ? { newUsername: nextUsername } : {}),
        ...(newPassword ? { newPassword } : {}),
      });
      onSessionChange(updated);
      setAccountUsername(updated.username ?? nextUsername);
      setAccountCurrentPassword("");
      setAccountNewPassword("");
      setAccountConfirmPassword("");
      setAccountNotice("账户信息已保存。");
    } catch (reason) {
      setAccountError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setAccountSaving(false);
    }
  }

  async function toggleProviderManagement(enabled: boolean) {
    setProviderManagementSaving(true);
    setError("");
    try {
      const result = await api.updateProviderManagement(enabled);
      onSessionChange({ ...session, providerManagementEnabled: result.providerManagementEnabled });
      if (!enabled) setProviderManagerOpen(false);
      setNotice(enabled ? "API 源管理已打开。" : "API 源管理已关闭，Codex Web 将只读取你的 Codex 配置文件。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "API 源管理设置保存失败");
    } finally {
      setProviderManagementSaving(false);
    }
  }

  async function persistAgentSelection(selection: { model: string; reasoningEffort: ReasoningEffort; provider?: string | null; sandbox?: SandboxMode }) {
    const targetId = selectedIdRef.current;
    const previous = { model: selectedModel, reasoningEffort, sandboxMode };
    setSelectedModel(selection.model); setReasoningEffort(selection.reasoningEffort); setSandboxMode(selection.sandbox ?? "workspace-write"); setSelectionSaving(true); setError("");
    try {
      const model = agentOptions?.models.find((candidate) => candidate.id === selection.model);
      const provider = selection.provider ?? model?.provider ?? null;
      const payload: AgentSelection = {
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
        sandbox: selection.sandbox ?? "workspace-write",
        ...(provider ? { provider } : {}),
      };
      const result = await api.updateAgentSelection(payload, targetId ?? undefined);
      if (selectedIdRef.current === targetId) {
        setSelectedModel(result.selection.model);
        setReasoningEffort(result.selection.reasoningEffort);
        setSandboxMode(result.selection.sandbox ?? "workspace-write");
      }
      setAgentOptions((current) => current ? { ...current, selection: result.selection } : current);
    } catch (reason) {
      if (selectedIdRef.current === targetId) {
        setSelectedModel(previous.model);
        setReasoningEffort(previous.reasoningEffort);
        setSandboxMode(previous.sandboxMode);
      }
      setError(reason instanceof Error ? reason.message : "模型设置保存失败");
    } finally {
      setSelectionSaving(false);
    }
  }

  function changeModel(modelId: string) {
    const options = agentOptions;
    const model = options?.models.find((candidate) => candidate.id === modelId);
    if (!options || !model) return;
    const nextEffort = reasoningEffort && model.reasoningEfforts.includes(reasoningEffort)
      ? reasoningEffort
      : model.reasoningEfforts.includes(options.defaults.reasoningEffort)
        ? options.defaults.reasoningEffort
        : model.reasoningEfforts.at(-1)!;
    void persistAgentSelection({ model: model.id, reasoningEffort: nextEffort, sandbox: sandboxMode, ...(model.provider ? { provider: model.provider } : {}) });
  }

  function changeReasoning(effort: ReasoningEffort) {
    if (!selectedModel) return;
    const selectedModelOption = agentOptions?.models.find((candidate) => candidate.id === selectedModel);
    void persistAgentSelection({ model: selectedModel, reasoningEffort: effort, sandbox: sandboxMode, ...(selectedModelOption?.provider ? { provider: selectedModelOption.provider } : {}) });
  }

  function changeSandbox(mode: SandboxMode) {
    if (!selectedModel) return;
    if (mode === "danger-full-access" && !window.confirm("完全访问模式会跳过沙箱：Codex 将拥有该账户的完整系统权限，可执行任意命令并读写任意文件。仅在你完全信任任务内容时使用，确认启用？")) return;
    const selectedModelOption = agentOptions?.models.find((candidate) => candidate.id === selectedModel);
    void persistAgentSelection({ model: selectedModel, reasoningEffort, sandbox: mode, ...(selectedModelOption?.provider ? { provider: selectedModelOption.provider } : {}) });
  }

  async function changeChatFontSize(delta: number) {
    if (fontSizeSaving) return;
    const previous = chatFontSize;
    const next = normalizeChatFontSize(previous + delta, previous);
    if (next === previous) return;
    setChatFontSize(next);
    setFontSizeSaving(true);
    setError("");
    try {
      const saved = await api.updateChatFontSize(next);
      setChatFontSize(saved.chatFontSize);
    } catch (reason) {
      setChatFontSize(previous);
      setError(reason instanceof Error ? reason.message : "字号设置保存失败");
    } finally {
      setFontSizeSaving(false);
    }
  }

  async function changeChatColumnWidth(delta: number) {
    if (columnWidthSaving) return;
    const previous = chatColumnWidth;
    const next = normalizeChatColumnWidth(previous + delta, previous);
    if (next === previous) return;
    setChatColumnWidth(next);
    setColumnWidthSaving(true);
    setError("");
    try {
      const saved = await api.updateChatColumnWidth(next);
      setChatColumnWidth(saved.chatColumnWidth);
    } catch (reason) {
      setChatColumnWidth(previous);
      setError(reason instanceof Error ? reason.message : "聊天区宽度设置保存失败");
    } finally {
      setColumnWidthSaving(false);
    }
  }

  function renderConversationRow(conversation: Conversation) {
    return <ConversationRow
      key={conversation.id}
      conversation={conversation}
      selected={selectedId === conversation.id}
      menuOpen={taskMenu?.conversationId === conversation.id}
      onSelect={selectConversation}
      onMenu={toggleTaskMenu}
    />;
  }

  function handlePaneResizerKey(event: KeyboardEvent, kind: "sidebar" | "preview" | "side-chat" | "file-explorer") {
    const isSidebar = kind === "sidebar";
    const isSideChat = kind === "side-chat";
    const isFileExplorer = kind === "file-explorer";
    const min = isSidebar ? SIDEBAR_WIDTH_MIN : isSideChat ? SIDE_CHAT_WIDTH_MIN : isFileExplorer ? FILE_EXPLORER_WIDTH_MIN : PREVIEW_WIDTH_MIN;
    const max = isSidebar ? SIDEBAR_WIDTH_MAX : isSideChat ? SIDE_CHAT_WIDTH_MAX : isFileExplorer ? FILE_EXPLORER_WIDTH_MAX : PREVIEW_WIDTH_MAX;
    const current = isSidebar ? sidebarWidth : isSideChat ? sideChatWidth : isFileExplorer ? fileExplorerWidth : previewWidth;
    const step = event.shiftKey ? 40 : 16;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = isSidebar ? current - step : current + step;
    else if (event.key === "ArrowRight") next = isSidebar ? current + step : current - step;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    if (next === null) return;
    event.preventDefault();
    const clamped = clampPaneWidth(next, min, max);
    if (isSidebar) setSidebarWidth(clamped);
    else if (isSideChat) setSideChatWidth(clamped);
    else if (isFileExplorer) setFileExplorerWidth(clamped);
    else setPreviewWidth(clamped);
    commitPaneWidth(isSidebar ? SIDEBAR_WIDTH_KEY : isSideChat ? SIDE_CHAT_WIDTH_KEY : isFileExplorer ? FILE_EXPLORER_WIDTH_KEY : PREVIEW_WIDTH_KEY, clamped);
  }

  function renderCategoryView(category: TaskListCategoryView, style?: CSSProperties) {
    const expanded = categoryExpanded[category.key] !== false;
    const fullyExpanded = categoryFullyExpanded[category.key] === true;
    const previewLimit = normalizeTaskCategoryVisibleCount(
      categoryVisibleCounts[category.key] ?? DEFAULT_TASK_CATEGORY_VISIBLE_COUNT,
      category.conversations.length,
    );
    const bodyState = buildTaskCategoryBodyState(category.conversations.length, fullyExpanded, previewLimit);
    const dragState = categoryTaskDrag?.categoryKey === category.key ? categoryTaskDrag : null;
    const orderedConversations = dragState ? orderCategoryConversations(category.conversations, dragState.order) : category.conversations;
    // 拖动期间临时显示全部任务，避免把拖出折叠范围的任务截断。
    const visible = dragState ? orderedConversations : orderedConversations.slice(0, bodyState.visibleCount);
    const runningCount = countRunningConversations(category.conversations);
    const dragging = categoryDragKey === category.key;
    return <section key={category.key} style={style} className={`task-category ${category.pinned ? "pinned" : ""} ${taskViewMode === "grid" ? "task-category-card" : ""}`}>
      <div className="task-category-header">
        <button type="button" className="task-category-toggle" aria-expanded={expanded} aria-label={`${expanded ? "折叠" : "展开"}分类 ${category.name}`} onClick={() => toggleCategoryExpanded(category.key)}>
          <ChevronDown size={14} className={expanded ? "" : "collapsed"} />
          <span className="task-category-copy">
            <strong>{category.name}</strong>
            <small title={category.detail}>{category.detail}</small>
          </span>
          <span className="task-category-count">{category.conversations.length}</span>
          {runningCount > 0 && <span className="task-category-status" title={runningCount > 1 ? `${runningCount} 个任务正在执行` : "有任务正在执行"}>
            <LoaderCircle size={11} className="spin" />
            {runningCount > 1 ? runningCount : null}
          </span>}
        </button>
        <div className="task-category-actions">
          <button type="button" className={category.pinned ? "pinned" : ""} aria-label={category.pinned ? `取消置顶 ${category.name}` : `置顶 ${category.name}`} aria-pressed={category.pinned} title={category.pinned ? "取消置顶" : "置顶"} onClick={() => void toggleCategoryPinned(category)}>
            {category.pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
          <button type="button" className="category-menu-trigger" data-category-menu aria-label={`分类 ${category.name} 操作`} aria-haspopup="menu" aria-expanded={categoryMenu?.categoryKey === category.key} title="分类操作" onClick={(event) => toggleCategoryMenu(category.key, event.currentTarget)}><MoreHorizontal size={15} /></button>
        </div>
      </div>
      {expanded && <div className="task-category-body" data-category-key={category.key} onPointerDown={handleCategoryBodyPointerDown}>
        {visible.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            selected={selectedId === conversation.id}
            menuOpen={taskMenu?.conversationId === conversation.id}
            onSelect={selectConversation}
            onMenu={toggleTaskMenu}
            draggableInCategory
            dragging={dragState?.conversationId === conversation.id}
            rowCategoryKey={category.key}
          />
        ))}
        {bodyState.showExpandControl && <button
          type="button"
          className={`task-category-more${dragging ? " dragging" : ""}`}
          aria-expanded={fullyExpanded}
          aria-label={fullyExpanded ? `收起为最近 ${bodyState.collapseTarget} 条` : `展开分类 ${category.name}`}
          title="点击展开或收起，按住并上下拖动可调整展示条数"
          onClick={() => {
            if (categoryDragRef.current?.moved) return;
            toggleCategoryFullyExpanded(category.key);
          }}
          onPointerDown={(event) => startCategoryCountDrag(category.key, bodyState.visibleCount, category.conversations.length, event)}
        >{dragging ? `显示 ${bodyState.visibleCount} 条` : fullyExpanded ? `收起为最近 ${bodyState.collapseTarget} 条` : `… 还有 ${bodyState.remaining} 条`}</button>}
      </div>}
    </section>;
  }

  function toggleCategoryExpanded(key: string) {
    const expanding = categoryExpanded[key] === false;
    setCategoryExpanded((current) => ({ ...current, [key]: current[key] === false }));
    if (!expanding) {
      // 折叠分类时清除“完全展开”标记，重新展开后回到该分类设置的展示条数。
      setCategoryFullyExpanded((fully) => {
        if (!fully[key]) return fully;
        const next = { ...fully };
        delete next[key];
        return next;
      });
    }
  }

  function toggleCategoryFullyExpanded(key: string) {
    setCategoryFullyExpanded((current) => {
      const next = { ...current, [key]: current[key] !== true };
      return next;
    });
  }

  function startCategoryCountDrag(
    key: string,
    startCount: number,
    total: number,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (event.button !== 0 || total <= 1) return;
    event.preventDefault();
    const startY = event.clientY;
    const dragState = { moved: false };
    categoryDragRef.current = dragState;
    setCategoryDragKey(key);
    // 进入拖动即退出“完全展开”，让拖动的条数直接生效。
    setCategoryFullyExpanded((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      // 向下拖动（手指下移）展开更多条，向上拖动收起更少条。
      const deltaY = moveEvent.clientY - startY;
      if (Math.abs(deltaY) >= TASK_CATEGORY_DRAG_THRESHOLD_PX) dragState.moved = true;
      if (!dragState.moved) return;
      const next = normalizeTaskCategoryVisibleCount(
        startCount + Math.round(deltaY / TASK_CATEGORY_DRAG_PX_PER_STEP),
        total,
      );
      setCategoryVisibleCounts((current) => {
        if (current[key] === next) return current;
        return { ...current, [key]: next };
      });
    };
    const stop = (endEvent: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      target.releasePointerCapture?.(endEvent.pointerId);
      setCategoryDragKey(null);
      // 让紧随其后的 click 仍能看到本次拖动的 moved 标记，再释放引用。
      window.setTimeout(() => {
        if (categoryDragRef.current === dragState) categoryDragRef.current = null;
      }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  /**
   * Reorder the conversations inside a category by dragging rows. The
   * pointer-down handler is delegated on the category body so the stable
   * callback never invalidates memoized row components; the current DOM row
   * order is read at drag start and the pending order is kept in state for
   * live preview, then persisted once the drag ends.
   */
  const handleCategoryBodyPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || categoryTaskDragRef.current) return;
    if (event.target instanceof Element && event.target.closest(".row-actions")) return;
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-category-task-row]") : null;
    if (!row) return;
    const categoryKey = row.dataset.categoryTaskKey;
    const conversationId = row.dataset.categoryTaskId;
    const list = row.closest<HTMLElement>(".task-category-body");
    if (!categoryKey || !conversationId || !list) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-category-task-id]"));
    if (rows.length <= 1) return;
    const order = rows.map((candidate) => candidate.dataset.categoryTaskId ?? "").filter(Boolean);
    const fromIndex = order.indexOf(conversationId);
    if (fromIndex < 0) return;
    const startY = event.clientY;
    const dragState = {
      categoryKey,
      conversationId,
      overIndex: fromIndex,
      order,
      list,
      moved: false,
      changed: false,
    };
    categoryTaskDragRef.current = dragState;
    let suppressingClick = false;
    let armed = false;
    let longPressTimer: number | undefined;
    const suppressClick = (clickEvent: MouseEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
    };
    const cancelLongPress = () => {
      if (longPressTimer !== undefined) {
        window.clearTimeout(longPressTimer);
        longPressTimer = undefined;
      }
    };
    // 长按达成后进入拖动模式：锁定滚动方向、抑制点击，并展开整类任务做实时预览。
    const armDrag = () => {
      if (armed) return;
      armed = true;
      longPressTimer = undefined;
      suppressingClick = true;
      document.body.style.userSelect = "none";
      document.addEventListener("click", suppressClick, true);
      if (dragState.list) dragState.list.style.touchAction = "none";
      dragState.moved = true;
      setCategoryTaskDrag({ categoryKey, conversationId, overIndex: dragState.overIndex, order: dragState.order });
    };
    longPressTimer = window.setTimeout(armDrag, TASK_CATEGORY_DRAG_LONG_PRESS_MS);
    const move = (moveEvent: PointerEvent) => {
      const deltaY = moveEvent.clientY - startY;
      // 长按尚未达成时，手指大幅移动视为滚动列表，取消长按。
      if (!armed) {
        if (Math.abs(deltaY) >= TASK_CATEGORY_DRAG_ARM_CANCEL_PX) cancelLongPress();
        return;
      }
      if (Math.abs(deltaY) < TASK_CATEGORY_DRAG_THRESHOLD_PX) return;
      let overIndex = dragState.overIndex;
      const listRect = dragState.list?.getBoundingClientRect();
      if (listRect && listRect.height > 0) {
        let candidate = 0;
        const pointerY = moveEvent.clientY;
        for (const item of dragState.list!.querySelectorAll<HTMLElement>("[data-category-task-id]")) {
          if (item.dataset.categoryTaskId === conversationId) continue;
          const rect = item.getBoundingClientRect();
          if (pointerY > rect.top + rect.height / 2) candidate += 1;
          else break;
        }
        overIndex = Math.max(0, Math.min(candidate, dragState.order.length - 1));
      }
      if (overIndex !== dragState.overIndex) {
        dragState.overIndex = overIndex;
        dragState.changed = true;
        const next = [...dragState.order];
        const current = next.indexOf(conversationId);
        if (current >= 0) {
          next.splice(current, 1);
          next.splice(overIndex, 0, conversationId);
          dragState.order = next;
          setCategoryTaskDrag({ categoryKey, conversationId, overIndex, order: next });
        }
      }
    };
    const stop = (endEvent: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      cancelLongPress();
      if (suppressingClick) document.removeEventListener("click", suppressClick, true);
      document.body.style.userSelect = "";
      const savedOrder = dragState.order;
      const moved = dragState.moved && dragState.changed;
      const savedCategoryKey = dragState.categoryKey;
      if (dragState.list) dragState.list.style.touchAction = "";
      // 只要长按激活过拖动预览，松开时都要恢复折叠状态；
      // 只有真正移动过顺序才需要保存。
      if (dragState.moved) setCategoryTaskDrag(null);
      categoryTaskDragRef.current = null;
      if (moved && endEvent.type !== "pointercancel") {
        const settings = taskCategorySettingsRef.current;
        const existingOrder = settings?.conversationOrders[savedCategoryKey];
        let fullOrder = savedOrder;
        if (existingOrder?.length) {
          fullOrder = mergeCategoryTaskOrder(existingOrder, savedOrder);
        } else {
          const fullViews = buildTaskCategoryViews(
            conversationsRef.current,
            workingDirSettingsRef.current?.favorites ?? [],
            settings ?? EMPTY_TASK_LIST_CATEGORY_SETTINGS,
          );
          const fullCategory = fullViews.find((view) => view.key === savedCategoryKey);
          if (fullCategory?.conversations.length) {
            fullOrder = mergeCategoryTaskOrder(
              fullCategory.conversations.map((item) => item.id),
              savedOrder,
            );
          }
        }
        void (async () => {
          setCategorySaving(true);
          setError("");
          try {
            const { settings: saved } = await api.updateTaskCategoryConversationOrder(savedCategoryKey, fullOrder);
            setTaskCategorySettings(saved);
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : "保存任务顺序失败");
          } finally {
            setCategorySaving(false);
          }
        })();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, []);

  function changeTaskViewMode(mode: TaskViewMode) {
    setTaskViewMode(mode);
    writeLocalStorageValue(TASK_VIEW_MODE_KEY, mode);
  }

  async function toggleCategoryPinned(view: TaskListCategoryView) {
    const settings = taskCategorySettings;
    if (!settings || categorySaving) return;
    const next = [...settings.pinned];
    const index = next.indexOf(view.key);
    if (index >= 0) next.splice(index, 1);
    else next.push(view.key);
    setCategorySaving(true); setError("");
    try {
      const { settings: saved } = await api.updateTaskCategoryPins(next);
      setTaskCategorySettings(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "置顶分类失败");
    } finally {
      setCategorySaving(false);
    }
  }

  async function saveCategoryHidden(keys: string[]) {
    setCategorySaving(true); setError("");
    try {
      const { settings: saved } = await api.updateTaskCategoryHidden(keys);
      setTaskCategorySettings(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "更新隐藏分类失败");
    } finally {
      setCategorySaving(false);
    }
  }

  async function toggleCategoryHidden(view: TaskListCategoryView) {
    const settings = taskCategorySettings;
    if (!settings || categorySaving) return;
    const next = settings.hidden.includes(view.key)
      ? settings.hidden.filter((key) => key !== view.key)
      : [...settings.hidden, view.key];
    await saveCategoryHidden(next);
  }

  async function restoreHiddenCategory(key: string) {
    const settings = taskCategorySettings;
    if (!settings || categorySaving) return;
    await saveCategoryHidden(settings.hidden.filter((candidate) => candidate !== key));
  }

  async function movePinnedCategory(key: string, delta: number) {
    const settings = taskCategorySettings;
    if (!settings || categorySaving) return;
    const next = [...settings.pinned];
    const index = next.indexOf(key);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setCategorySaving(true); setError("");
    try {
      const { settings: saved } = await api.updateTaskCategoryPins(next);
      setTaskCategorySettings(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "调整置顶顺序失败");
    } finally {
      setCategorySaving(false);
    }
  }

  async function createCustomCategory() {
    const name = newCategoryName.trim();
    if (!name || categorySaving) return;
    setCategorySaving(true); setError("");
    try {
      const { settings } = await api.createTaskCategory(name);
      setTaskCategorySettings(settings);
      setNewCategoryName("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建分类失败");
    } finally {
      setCategorySaving(false);
    }
  }

  async function saveCustomCategoryName(id: string) {
    const name = editingCategoryName.trim();
    setEditingCategoryId(null);
    if (!name || categorySaving) return;
    setCategorySaving(true); setError("");
    try {
      const { settings } = await api.renameTaskCategory(id, name);
      setTaskCategorySettings(settings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "重命名分类失败");
    } finally {
      setCategorySaving(false);
    }
  }

  async function deleteCustomCategory(category: TaskListCategorySettings["customCategories"][number]) {
    if (!window.confirm(`删除自定义分类“${category.name}”？其中的工作目录会回到自动分类，任务本身不会被删除。`)) return;
    setCategorySaving(true); setError("");
    try {
      const { settings } = await api.deleteTaskCategory(category.id);
      setTaskCategorySettings(settings);
      if (editingCategoryId === category.id) setEditingCategoryId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除分类失败");
    } finally {
      setCategorySaving(false);
    }
  }

  async function assignDirectory(dir: string, categoryId: string | null) {
    if (categorySaving) return;
    setCategorySaving(true); setError("");
    try {
      const { settings } = await api.assignTaskCategoryDir(dir, categoryId);
      setTaskCategorySettings(settings);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "移动工作目录失败");
    } finally {
      setCategorySaving(false);
    }
  }

  function toggleCategoryMenu(categoryKey: string, button: HTMLButtonElement) {
    if (categoryMenu?.categoryKey === categoryKey) {
      setCategoryMenu(null);
      return;
    }
    const bounds = button.getBoundingClientRect();
    const width = 186;
    const height = 172;
    const top = bounds.bottom + 6 + height <= window.innerHeight - 8
      ? bounds.bottom + 6
      : Math.max(8, bounds.top - height - 6);
    const left = Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8));
    setCategoryMenu({ categoryKey, top, left });
  }

  function startNewTaskInCategory(category: TaskListCategoryView) {
    const anchor = categoryMenu;
    setCategoryMenu(null);
    if (category.assignedDirs.length <= 1) {
      void newConversation(category.assignedDirs[0] ?? null);
      return;
    }
    if (!anchor) return;
    const width = 280;
    const left = anchor.left + 186 + 6 <= window.innerWidth - width - 8
      ? anchor.left + 186 + 6
      : Math.max(8, anchor.left - width - 6);
    const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 8 - 300));
    setCategoryNewTaskMenu({ categoryKey: category.key, top, left });
  }

  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(
    () => conversations.filter((item) => (item.title ?? "").toLowerCase().includes(deferredQuery.toLowerCase())),
    [conversations, deferredQuery],
  );
  const categoryViews = useMemo(
    () => buildTaskCategoryViews(filtered, workingDirSettings?.favorites ?? [], taskCategorySettings ?? EMPTY_TASK_LIST_CATEGORY_SETTINGS),
    [filtered, workingDirSettings, taskCategorySettings],
  );
  const categoryGridLayout = useTaskCategoryGridLayout(taskViewMode === "grid", categoryViews.length);
  const categoryDirectoryAssignments = useMemo(
    () => buildDirectoryAssignments(conversations, workingDirSettings?.favorites ?? [], taskCategorySettings ?? EMPTY_TASK_LIST_CATEGORY_SETTINGS),
    [conversations, workingDirSettings, taskCategorySettings],
  );
  const pinnedCategoryViews = useMemo(
    () => categoryViews.filter((category) => category.pinned).sort((left, right) => left.pinIndex - right.pinIndex),
    [categoryViews],
  );
  const hiddenCategoryInfos = useMemo(
    () => buildHiddenCategoryInfos(
      taskCategorySettings ?? EMPTY_TASK_LIST_CATEGORY_SETTINGS,
      workingDirSettings?.favorites ?? [],
      conversations.map((conversation) => conversation.working_dir).filter((dir): dir is string => Boolean(dir)),
    ),
    [taskCategorySettings, workingDirSettings, conversations],
  );
  // While a task streams, these derived values are not rendered by the message
  // list. Keeping them constant during streaming lets memoized subtrees below
  // the Chat bail out instead of re-rendering on every 60ms activity flush.
  const reasoningSteps = useMemo(
    () => sending ? EMPTY_REASONING_STEPS : collectReasoningSteps(activities),
    [activities, sending],
  );
  const taskDurationSeconds = useMemo(
    () => sending ? null : taskElapsedSeconds(activities),
    [activities, sending],
  );
  const visibleTaskCount = workingDirSettings?.enabled && taskCategorySettings
    ? categoryViews.reduce((sum, category) => sum + category.conversations.length, 0)
    : filtered.length;
  const currentDetail = detail?.conversation.id === selectedId ? detail : null;
  const sideChatCurrentConversation = currentDetail?.conversation
    ?? conversations.find((conversation) => conversation.id === selectedId)
    ?? archivedConversations.find((conversation) => conversation.id === selectedId)
    ?? null;
  const loadingConversation = Boolean(selectedId && !currentDetail);
  const composerPendingPrompts = currentDetail?.pendingPrompts ?? EMPTY_PENDING_PROMPTS;
  const composerDraftFiles = composerDraft?.files ?? EMPTY_WORK_FILES;
  const composerCanSteer = job?.status === "running";
  const hostFilesAvailable = Boolean(workingDirSettings?.enabled);
  const taskMenuConversation = taskMenu ? conversations.find((conversation) => conversation.id === taskMenu.conversationId) : undefined;
  const categoryMenuCategory = categoryMenu ? categoryViews.find((category) => category.key === categoryMenu.categoryKey) : undefined;
  const categoryNewTaskCategory = categoryNewTaskMenu ? categoryViews.find((category) => category.key === categoryNewTaskMenu.categoryKey) : undefined;
  const account = resolveAccountIdentity(session);
  const providerManagementEnabled = session.providerManagementEnabled === true;
  // Memoize the composer element so the high-frequency activity stream does not
  // re-render the textarea, pending queue, model menus and file chips. React
  // skips a subtree entirely when the element reference stays identical, and
  // every dependency below is either a state value the element renders or a
  // value captured by the callbacks it receives.
  const composerElement = useMemo(() => <Composer
    key={selectedId ?? "new-conversation"}
    input={input} inputRevision={composerInputRevision} onTextChange={handleComposerTextChange}
    askAgentQuote={askAgentQuote} onClearAskAgentQuote={() => setAskAgentQuote("")}
    sourceReference={sourceReference} onClearSourceReference={() => { setAskAgentQuote(""); setSourceReference(null); }}
    onOpenSourceReference={(reference) => openSourceReference(reference)}
    focusRequest={composerFocusRequest}
    files={files} setFiles={setFiles}
    draftFiles={composerDraftFiles} draftUploads={draftUploads} draftSaveState={draftSaveState}
    sending={sending} submitting={submitting} selectionSaving={selectionSaving}
    voiceEnabled={Boolean(session.voiceEnabled)}
    conversationId={selectedId}
    pendingPrompts={composerPendingPrompts} editingPending={editingPending} removedEditingFileIds={removedEditingFileIds}
    presetPrompts={presetPrompts} enabledPresetPromptIds={currentDetail?.enabledPresetPromptIds ?? EMPTY_PRESET_PROMPT_IDS}
    onTogglePresetPrompt={(id, enabled) => void togglePresetPrompt(id, enabled)} presetSaving={presetSaving}
    onOpenPresetManager={() => setPresetPromptManagerOpen(true)}
    agentOptions={agentOptions} selectedModel={selectedModel} reasoningEffort={reasoningEffort} sandboxMode={sandboxMode}
    onModelChange={changeModel} onReasoningChange={changeReasoning} onSandboxChange={changeSandbox}
    onReorderPending={(ordered) => void reorderPendingPrompts(ordered)} onEditPending={(prompt) => void beginPendingEdit(prompt)}
    onDeletePending={(prompt) => void deletePendingPrompt(prompt)} onSteerPending={(prompt) => void steerPendingPrompt(prompt)}
    canSteer={composerCanSteer} onCancelPendingEdit={() => void cancelPendingEdit()}
    onAddFiles={(incoming) => void addComposerFiles(incoming)} onRemoveDraftFile={(file) => void removeComposerDraftFile(file)} onClearDraft={() => void clearComposerDraft()}
    onRemoveEditingFile={(fileId) => setRemovedEditingFileIds((current) => [...current, fileId])}
    onRestoreEditingFile={(fileId) => setRemovedEditingFileIds((current) => current.filter((id) => id !== fileId))}
    hostFilesAvailable={hostFilesAvailable}
    onBrowseHostFiles={() => setPathBrowser({ mode: "files", title: "从服务器选择文件", confirmLabel: "添加所选文件", maxFiles: 12, onSelect: (paths) => void addHostComposerFiles(paths) })}
    onSend={(message) => void send(message)} onCancel={job && selectedId ? () => void api.cancelConversation(selectedId).then(() => reconcile(selectedId)) : undefined}
  />, [
    agentOptions, askAgentQuote, composerCanSteer, composerDraft, composerFocusRequest, composerPendingPrompts,
    currentDetail, draftSaveState, draftUploads, editingPending, files, handleComposerTextChange, input, composerInputRevision, job, reasoningEffort, sandboxMode,
    hostFilesAvailable, presetPrompts, presetSaving, removedEditingFileIds, selectedId, selectedModel, selectionSaving, sending, session.voiceEnabled, sourceReference, submitting,
  ]);

  return <div className="shell">
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? "open" : ""}`} style={{ width: sidebarWidth, flexBasis: sidebarWidth }}>
      <div className="sidebar-top">
        <div className="wordmark"><span className="brand-mark small"><Zap size={15} /></span><span className="brand-copy"><strong>Codex Web</strong><small>SELF-HOSTED CODEX WORKSTATION</small></span></div>
        <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)} aria-label="关闭"><X size={19} /></button>
      </div>
      {workingDirSettings?.enabled
        ? <div className="new-task-wrap" ref={newTaskDirPanelRef}>
            <button className="new-task" onClick={() => void newConversation()}><Plus size={17} />新建任务</button>
            <button className="new-task-toggle" aria-label="选择工作目录" aria-expanded={newTaskDirPanelOpen} title="选择工作目录" onClick={() => setNewTaskDirPanelOpen((open) => !open)}><ChevronDown size={14} /></button>
            {newTaskDirPanelOpen && <div className="new-task-dir-panel" role="dialog" aria-label="选择工作目录">
              <div className="new-task-dir-heading"><FolderOpen size={15} /><strong>工作目录</strong></div>
              <div className="new-task-dir-options">
                <button type="button" className="new-task-dir-option" onClick={() => void newConversation(null)}>
                  <span><strong>独立工作区</strong><small>每个对话使用系统隔离目录</small></span>
                </button>
                {workingDirSettings.favorites.map((favorite) => (
                  <button type="button" key={favorite.path} className="new-task-dir-option" onClick={() => void newConversation(favorite.path)}>
                    <span><strong>{favorite.label}</strong><small>{favorite.path}</small></span>
                  </button>
                ))}
              </div>
              <div className="new-task-dir-manual">
                <input value={manualWorkingDir} onChange={(event) => setManualWorkingDir(event.target.value)} placeholder="或手动输入绝对路径" />
                <button type="button" className="path-browse-trigger" aria-label="浏览目录" title="浏览目录" onClick={() => setPathBrowser({
                  mode: "dir",
                  title: "选择工作目录",
                  confirmLabel: "使用该目录",
                  initialPath: manualWorkingDir || undefined,
                  onSelect: (paths) => setManualWorkingDir(paths[0] ?? ""),
                })}><FolderOpen size={15} /></button>
                <button type="button" className="primary-button" disabled={!manualWorkingDir.trim() || workingDirSaving} onClick={() => void newConversation(manualWorkingDir.trim())}>创建</button>
              </div>
              <div className="new-task-dir-footer">
                <button type="button" onClick={() => { setWorkingDirManagerOpen(true); setNewTaskDirPanelOpen(false); }}>管理收藏…</button>
                {workingDirSettings.defaultWorkingDir
                  && <small title={workingDirSettings.defaultWorkingDir}>默认：{workingDirSettings.favorites.find((favorite) => favorite.path === workingDirSettings.defaultWorkingDir)?.label ?? workingDirSettings.defaultWorkingDir}</small>}
              </div>
            </div>}
          </div>
        : <button className="new-task" onClick={() => void newConversation()}><Plus size={17} />新建任务</button>}
      <button className="import-sessions-button" onClick={() => void openImportDialog()} title="导入本地 Codex 历史会话"><Download size={15} />导入历史会话</button>
      <div className="search-box"><Search size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索任务" /></div>
      <div className="conversation-section">
        <div className="section-label"><span>任务</span><span className="section-label-actions"><strong>{visibleTaskCount}</strong>{workingDirSettings?.enabled && taskCategorySettings && <div className="task-view-toggle" role="group" aria-label="任务视图">
          <button type="button" className={taskViewMode === "list" ? "active" : ""} aria-pressed={taskViewMode === "list"} title="竖列列表" onClick={() => changeTaskViewMode("list")}><List size={13} /></button>
          <button type="button" className={taskViewMode === "grid" ? "active" : ""} aria-pressed={taskViewMode === "grid"} title="多宫格" onClick={() => changeTaskViewMode("grid")}><LayoutGrid size={13} /></button>
        </div>}{workingDirSettings?.enabled && taskCategorySettings && <button type="button" className="category-manage-trigger" onClick={() => setCategoryManagerOpen(true)}><LayoutList size={13} />管理分类</button>}</span></div>
        <div className="conversation-list" ref={categoryGridLayout.containerRef} onScroll={() => { setTaskMenu(null); setCategoryMenu(null); setCategoryNewTaskMenu(null); }}>
          {workingDirSettings?.enabled && taskCategorySettings
            ? taskViewMode === "grid"
              ? <div className="task-category-grid" style={categoryGridLayout.gridStyle}>
                  {categoryViews.map((category, index) => renderCategoryView(category, categoryGridLayout.cardStyles[index]))}
                </div>
              : categoryViews.map((category) => renderCategoryView(category))
            : filtered.map(renderConversationRow)}
          {visibleTaskCount === 0 && <div className="empty-list">{query ? "没有匹配任务" : filtered.length > 0 ? "所有任务都在隐藏分类中" : "还没有任务"}</div>}
        </div>
      </div>
      <div className="account-area">
        {accountSettingsOpen && <section className="account-settings" aria-label="个人设置">
          <div className="account-settings-heading"><Settings2 size={15} /><strong>个人设置</strong></div>
          <button type="button" className="account-security-trigger" onClick={openAccountSecurity}>
            <KeyRound size={16} />
            <span className="account-security-trigger-copy"><strong>账户与密码</strong><small>修改登录用户名与密码</small></span>
            <span className="account-security-trigger-action"><Pencil size={12} />修改</span>
          </button>
          <div className="font-size-setting">
            <div><strong>聊天正文字号</strong><small>正文、行距与内容间距同步调整</small></div>
            <div className="font-size-stepper">
              <button type="button" aria-label="减小聊天正文字号" disabled={fontSizeSaving || chatFontSize <= CHAT_FONT_SIZE_MIN} onClick={() => void changeChatFontSize(-1)}><Minus size={15} /></button>
              <output aria-live="polite">{chatFontSize}px</output>
              <button type="button" aria-label="增大聊天正文字号" disabled={fontSizeSaving || chatFontSize >= CHAT_FONT_SIZE_MAX} onClick={() => void changeChatFontSize(1)}><Plus size={15} /></button>
            </div>
          </div>
          <div className="chat-width-setting">
            <div><strong>聊天区宽度</strong><small>消息与输入框内容的最大宽度，移动端不适用</small></div>
            <div className="font-size-stepper">
              <button type="button" aria-label="减小聊天区宽度" disabled={columnWidthSaving || chatColumnWidth <= CHAT_COLUMN_WIDTH_MIN} onClick={() => void changeChatColumnWidth(-CHAT_COLUMN_WIDTH_STEP)}><Minus size={15} /></button>
              <output aria-live="polite">{chatColumnWidth}px</output>
              <button type="button" aria-label="增大聊天区宽度" disabled={columnWidthSaving || chatColumnWidth >= CHAT_COLUMN_WIDTH_MAX} onClick={() => void changeChatColumnWidth(CHAT_COLUMN_WIDTH_STEP)}><Plus size={15} /></button>
            </div>
          </div>
          <div className="theme-setting">
            <div><strong>外观</strong><small>选择固定主题或跟随设备设置</small></div>
            <div className="theme-options" role="group" aria-label="外观模式">
              <button type="button" aria-label="使用浅色模式" aria-pressed={themePreference === "light"} onClick={() => onThemePreferenceChange("light")}><Sun size={16} /><span>浅色</span></button>
              <button type="button" aria-label="使用深色模式" aria-pressed={themePreference === "dark"} onClick={() => onThemePreferenceChange("dark")}><Moon size={16} /><span>深色</span></button>
              <button type="button" aria-label="外观跟随系统" aria-pressed={themePreference === "system"} onClick={() => onThemePreferenceChange("system")}><Monitor size={16} /><span>系统</span></button>
            </div>
          </div>
          <button type="button" className="account-settings-archive" onClick={() => void openArchivedConversations()}><Archive size={15} /><span>已归档任务</span></button>
          <label className="provider-management-setting">
            <span className="provider-management-copy"><strong>API 源管理</strong><small>{providerManagementEnabled ? "Codex Web 将维护数据库中的源和模型目录" : "关闭后只读取你自己维护的 ~/.codex 配置"}</small></span>
            <input type="checkbox" checked={providerManagementEnabled} disabled={providerManagementSaving} onChange={(event) => void toggleProviderManagement(event.target.checked)} />
          </label>
          {providerManagementEnabled && <button type="button" className="account-settings-archive" onClick={() => { setProviderManagerOpen(true); setAccountSettingsOpen(false); }}><Settings2 size={15} /><span>打开 API 源管理器</span></button>}
          <button type="button" className="account-settings-archive" onClick={() => { setBillingPanelOpen(true); setAccountSettingsOpen(false); }}><BarChart3 size={15} /><span>API 调用计费统计</span></button>
          <button type="button" className="account-settings-archive" onClick={() => { setPresetPromptManagerOpen(true); setAccountSettingsOpen(false); }}><ListChecks size={15} /><span>预设 Prompt 管理</span></button>
        </section>}
        <div className="account-row">
          <button className="account-profile" type="button" aria-expanded={accountSettingsOpen} onClick={() => setAccountSettingsOpen((open) => !open)}>
            <span className="avatar" aria-label={`${account.displayName} 头像`}>{account.initials}</span><span className="account-copy"><strong>{account.displayName}</strong><small>自托管工作站</small></span><Settings2 size={15} />
          </button>
          <button className="icon-button" onClick={() => void logout()} title="退出登录"><LogOut size={17} /></button>
        </div>
      </div>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整任务栏宽度"
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={0}
        onPointerDown={(event) => beginPaneResize(event, sidebarWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, "grow-right", setSidebarWidth, (width) => commitPaneWidth(SIDEBAR_WIDTH_KEY, width))}
        onKeyDown={(event) => handlePaneResizerKey(event, "sidebar")}
      />
    </aside>

    {taskMenu && taskMenuConversation && createPortal(<div
      className="task-menu-panel"
      data-task-menu
      role="menu"
      aria-label={`任务 ${taskMenuConversation.title} 操作`}
      style={{ top: taskMenu.top, left: taskMenu.left }}
    >
      <button type="button" role="menuitem" onClick={() => void archiveConversation(taskMenuConversation)}><Archive size={16} /><span>归档</span></button>
      <button type="button" role="menuitem" onClick={() => { setTaskMenu(null); void renameConversation(taskMenuConversation); }}><Pencil size={16} /><span>重命名</span></button>
      <button type="button" role="menuitem" className="danger" onClick={() => { setTaskMenu(null); void deleteConversation(taskMenuConversation); }}><Trash2 size={16} /><span>删除</span></button>
    </div>, document.body)}

    {categoryMenuCategory && createPortal(<div
      className="task-menu-panel category-menu-panel"
      data-category-menu
      role="menu"
      aria-label={`分类 ${categoryMenuCategory.name} 操作`}
      style={{ top: categoryMenu!.top, left: categoryMenu!.left }}
    >
      <button type="button" role="menuitem" onClick={() => startNewTaskInCategory(categoryMenuCategory)}>
        <Plus size={16} /><span>新建任务</span>
      </button>
      <button type="button" role="menuitem" onClick={() => { setCategoryMenu(null); void toggleCategoryPinned(categoryMenuCategory); }}>
        {categoryMenuCategory.pinned ? <PinOff size={16} /> : <Pin size={16} />}
        <span>{categoryMenuCategory.pinned ? "取消置顶" : "置顶"}</span>
      </button>
      <button type="button" role="menuitem" onClick={() => { setCategoryMenu(null); void toggleCategoryHidden(categoryMenuCategory); }}>
        <EyeOff size={16} /><span>隐藏分类</span>
      </button>
      {categoryMenuCategory.kind === "auto" && <button type="button" role="menuitem" onClick={() => { setCategoryMenu(null); setCategoryManagerOpen(true); }}>
        <FolderInput size={16} /><span>移动目录…</span>
      </button>}
      {categoryMenuCategory.kind === "custom" && <button type="button" role="menuitem" onClick={() => {
        const id = categoryMenuCategory.customId!;
        setCategoryMenu(null);
        setEditingCategoryId(id);
        setEditingCategoryName(categoryMenuCategory.name);
        setCategoryManagerOpen(true);
      }}><Pencil size={16} /><span>重命名</span></button>}
      {categoryMenuCategory.kind === "custom" && <button type="button" role="menuitem" className="danger" onClick={() => {
        const category = taskCategorySettings?.customCategories.find((candidate) => candidate.id === categoryMenuCategory.customId);
        setCategoryMenu(null);
        if (category) void deleteCustomCategory(category);
      }}><Trash2 size={16} /><span>删除分类</span></button>}
    </div>, document.body)}

    {categoryNewTaskCategory && createPortal(<div
      className="task-menu-panel category-new-task-panel"
      data-category-new-task-menu
      role="menu"
      aria-label={`在分类 ${categoryNewTaskCategory.name} 新建任务`}
      style={{ top: categoryNewTaskMenu!.top, left: categoryNewTaskMenu!.left }}
    >
      <div className="category-new-task-heading"><FolderOpen size={14} /><strong>在“{categoryNewTaskCategory.name}”新建任务</strong></div>
      {categoryNewTaskCategory.assignedDirs.map((dir) => (
        <button type="button" role="menuitem" key={dir} onClick={() => { setCategoryNewTaskMenu(null); void newConversation(dir); }}>
          <FolderOpen size={15} />
          <span><strong>{pathLabel(dir)}</strong><small>{dir}</small></span>
        </button>
      ))}
    </div>, document.body)}

    {accountSecurityOpen && createPortal(<div className="account-security-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAccountSecurityOpen(false); }}>
      <section className="account-security-dialog" role="dialog" aria-modal="true" aria-label="修改账户与密码">
        <header><div><KeyRound size={19} /><strong>修改账户与密码</strong></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setAccountSecurityOpen(false)}><X size={18} /></button></header>
        <form className="account-security-dialog-form" onSubmit={saveAccount}>
          <div className="account-security-dialog-fields">
            <label className="account-security-field">
              <span>登录用户名</span>
              <input value={accountUsername} disabled={session.canChangeUsername === false} autoComplete="username" onChange={(event) => setAccountUsername(event.target.value)} />
              {session.canChangeUsername === false && <small>宿主模式下用户名由系统账户决定，不能在这里修改。</small>}
            </label>
            <label className="account-security-field">
              <span>当前密码</span>
              <input type="password" value={accountCurrentPassword} autoComplete="current-password" onChange={(event) => setAccountCurrentPassword(event.target.value)} />
            </label>
            <label className="account-security-field">
              <span>新密码（至少 12 位）</span>
              <input type="password" value={accountNewPassword} autoComplete="new-password" onChange={(event) => setAccountNewPassword(event.target.value)} />
            </label>
            <label className="account-security-field">
              <span>确认新密码</span>
              <input type="password" value={accountConfirmPassword} autoComplete="new-password" onChange={(event) => setAccountConfirmPassword(event.target.value)} />
            </label>
            {accountError && <div className="form-error" role="alert">{accountError}</div>}
            {accountNotice && <div className="account-security-dialog-notice" role="status">{accountNotice}</div>}
          </div>
          <footer className="account-security-dialog-footer">
            <button type="button" className="account-security-dialog-cancel" onClick={() => setAccountSecurityOpen(false)}>取消</button>
            <button className="primary-button account-security-dialog-save" disabled={accountSaving} type="submit">
              {accountSaving ? <LoaderCircle className="spin" size={17} /> : <Check size={16} />}
              <span>保存修改</span>
            </button>
          </footer>
        </form>
      </section>
    </div>, document.body)}

    {archivedDialogOpen && createPortal(<div className="archive-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setArchivedDialogOpen(false); }}>
      <section className="archive-dialog" role="dialog" aria-modal="true" aria-label="已归档任务">
        <header><div><Archive size={19} /><strong>已归档任务</strong></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setArchivedDialogOpen(false)}><X size={18} /></button></header>
        <div className="archived-conversation-list">
          {archivedLoading ? <div className="archived-conversation-empty"><LoaderCircle className="spin" size={18} /><span>正在加载…</span></div>
            : archivedConversations.length === 0 ? <div className="archived-conversation-empty">还没有已归档任务</div>
            : archivedConversations.map((conversation) => <div className="archived-conversation-row" key={conversation.id}>
                <button type="button" className="archived-conversation-open" onClick={() => { setSelectedId(conversation.id); setArchivedDialogOpen(false); }}>
                  <Archive size={17} /><span><strong>{conversation.title}</strong><small>{formatMessageDateTime(conversation.archived_at ?? conversation.updated_at)}</small></span>
                </button>
                <button type="button" className="archived-conversation-restore" aria-label={`恢复 ${conversation.title}`} title="恢复" onClick={() => void restoreConversation(conversation)}><RotateCcw size={16} /></button>
              </div>)}
        </div>
      </section>
    </div>, document.body)}

    {importDialogOpen && createPortal(<div className="import-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setImportDialogOpen(false); }}>
      <section className="import-dialog" role="dialog" aria-modal="true" aria-label="导入历史会话">
        <header><div><Download size={19} /><strong>导入历史会话</strong></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setImportDialogOpen(false)}><X size={18} /></button></header>
        <p className="import-dialog-hint">扫描当前执行器的 Codex Home，把尚未接入网页的本地 Codex 会话导入为网页任务。导入后可以继续对话；删除任务时也会清理对应的 Codex 会话文件。</p>
        <div className="import-session-toolbar">
          <label className="import-session-select-all">
            <input ref={selectAllImportRef} type="checkbox" checked={allFilteredSelected} disabled={filteredImportableSessions.length === 0} onChange={toggleSelectAllImportableSessions} />
            全选当前结果
          </label>
          <div className="import-session-time-range">
            <input type="date" value={importFromDate} max={importToDate || undefined} aria-label="开始日期" onChange={(event) => setImportFromDate(event.target.value)} />
            <span>至</span>
            <input type="date" value={importToDate} min={importFromDate || undefined} aria-label="结束日期" onChange={(event) => setImportToDate(event.target.value)} />
            {(importFromDate || importToDate) && <button type="button" onClick={() => { setImportFromDate(""); setImportToDate(""); }}>清除</button>}
          </div>
          <span className="import-session-count">共 {filteredImportableSessions.length} 条</span>
        </div>
        <div className="import-session-list">
          {importSessionsLoading ? <div className="import-session-empty"><LoaderCircle className="spin" size={18} /><span>正在扫描本地会话…</span></div>
            : importableSessions === null || importableSessions.length === 0
              ? <div className="import-session-empty"><Download size={18} /><span>没有发现可导入的本地 Codex 会话</span></div>
              : filteredImportableSessions.length === 0
                ? <div className="import-session-empty"><Download size={18} /><span>没有符合当前时间范围的会话</span></div>
                : filteredImportableSessions.map((session) => {
                  const selected = selectedSessionThreadIds.has(session.threadId);
                  return <label className={`import-session-row ${selected ? "selected" : ""}`} key={session.threadId}>
                    <input type="checkbox" checked={selected} onChange={() => toggleImportSession(session.threadId)} />
                    <span className="import-session-copy"><strong>{session.title}</strong><small>{formatMessageDateTime(session.updatedAt)} · {session.model || "未知模型"}{session.cwd ? ` · ${session.cwd}` : ""} · {formatSize(session.fileSize)}</small></span>
                  </label>;
                })}
        </div>
        <footer className="import-dialog-footer">
          <button type="button" className="import-dialog-cancel" onClick={() => setImportDialogOpen(false)}>取消</button>
          <button type="button" className="primary-button" disabled={selectedSessionThreadIds.size === 0 || importingSessions} onClick={() => void importSelectedSessions()}>
            {importingSessions ? <><LoaderCircle className="spin" size={15} />正在导入…</> : <>导入选中（{selectedSessionThreadIds.size}）</>}
          </button>
        </footer>
      </section>
    </div>, document.body)}

    {workingDirManagerOpen && workingDirSettings?.enabled && createPortal(<div className="working-dir-manager-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setWorkingDirManagerOpen(false); }}>
      <section className="working-dir-manager" role="dialog" aria-modal="true" aria-label="管理工作目录收藏">
        <header><div><FolderOpen size={19} /><strong>工作目录收藏</strong></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setWorkingDirManagerOpen(false)}><X size={18} /></button></header>
        <div className="working-dir-add">
          <input value={favoritePathInput} onChange={(event) => setFavoritePathInput(event.target.value)} placeholder="绝对路径，例如 /home/you/projects/alpha" />
          <button type="button" className="path-browse-trigger" aria-label="浏览目录" title="浏览目录" onClick={() => setPathBrowser({
            mode: "dir",
            title: "选择要收藏的目录",
            confirmLabel: "使用该目录",
            initialPath: favoritePathInput || undefined,
            onSelect: (paths) => setFavoritePathInput(paths[0] ?? ""),
          })}><FolderOpen size={15} /></button>
          <input value={favoriteLabelInput} onChange={(event) => setFavoriteLabelInput(event.target.value)} placeholder="名称（可选，默认取目录名）" />
          <button type="button" className="primary-button" disabled={workingDirSaving || !favoritePathInput.trim()} onClick={() => void addFavoriteWorkingDir()}>添加</button>
        </div>
        <div className="working-dir-favorite-list">
          {workingDirSettings.favorites.length === 0
            ? <div className="working-dir-favorite-empty">还没有收藏目录</div>
            : workingDirSettings.favorites.map((favorite, index) => (
              <div className="working-dir-favorite-row" key={favorite.path}>
                <span className="working-dir-favorite-copy">
                  {editingFavoriteLabel === favorite.path
                    ? <input autoFocus value={editingFavoriteLabelValue} onChange={(event) => setEditingFavoriteLabelValue(event.target.value)} onBlur={() => void saveFavoriteLabel(favorite.path)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditingFavoriteLabel(null); }} />
                    : <><strong>{favorite.label}</strong><small>{favorite.path}</small></>}
                </span>
                <span className="working-dir-favorite-actions">
                  <button type="button" className="move" title="上移" aria-label={`上移 ${favorite.label}`} disabled={workingDirSaving || index === 0} onClick={() => void moveFavoriteWorkingDir(favorite.path, "up")}><ArrowUp size={14} /></button>
                  <button type="button" className="move" title="下移" aria-label={`下移 ${favorite.label}`} disabled={workingDirSaving || index === workingDirSettings.favorites.length - 1} onClick={() => void moveFavoriteWorkingDir(favorite.path, "down")}><ArrowDown size={14} /></button>
                  <button type="button" className={workingDirSettings.defaultWorkingDir === favorite.path ? "default" : ""} title={workingDirSettings.defaultWorkingDir === favorite.path ? "取消默认" : "设为默认"} disabled={workingDirSaving} onClick={() => void toggleFavoriteAsDefault(favorite.path)}>{workingDirSettings.defaultWorkingDir === favorite.path ? "取消默认" : "默认"}</button>
                  <button type="button" title="重命名" onClick={() => { setEditingFavoriteLabel(favorite.path); setEditingFavoriteLabelValue(favorite.label); }}><Pencil size={14} /></button>
                  <button type="button" className="danger" title="删除收藏" onClick={() => void removeFavoriteWorkingDir(favorite.path)}><Trash2 size={14} /></button>
                </span>
              </div>
            ))}
        </div>
        <footer className="working-dir-manager-footer"><small>仅 host 模式可用；目录必须存在且为绝对路径，不能指向应用自身的数据目录。</small></footer>
      </section>
    </div>, document.body)}

    {categoryManagerOpen && workingDirSettings?.enabled && taskCategorySettings && createPortal(<div className="category-manager-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCategoryManagerOpen(false); }}>
      <section className="category-manager" role="dialog" aria-modal="true" aria-label="管理任务分类">
        <header><div><FolderCog size={19} /><strong>管理任务分类</strong></div><button type="button" className="icon-button" aria-label="关闭" onClick={() => setCategoryManagerOpen(false)}><X size={18} /></button></header>
        <div className="category-manager-body">
          <div className="category-manager-create">
            <input value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createCustomCategory(); }} placeholder="新分类名称" />
            <button type="button" className="primary-button" disabled={categorySaving || !newCategoryName.trim()} onClick={() => void createCustomCategory()}>创建</button>
          </div>
          <div className="category-manager-section">
            <div className="category-manager-heading"><Pin size={14} /><strong>置顶顺序</strong></div>
            {pinnedCategoryViews.length === 0
              ? <div className="category-manager-empty">还没有置顶分类</div>
              : pinnedCategoryViews.map((view, index) => (
                <div className="category-pin-row" key={view.key}>
                  <span className="category-pin-copy"><strong>{view.name}</strong><small title={view.detail}>{view.detail}</small></span>
                  <span className="category-pin-actions">
                    <button type="button" title="上移" aria-label={`上移 ${view.name}`} disabled={categorySaving || index === 0} onClick={() => void movePinnedCategory(view.key, -1)}><ArrowUp size={14} /></button>
                    <button type="button" title="下移" aria-label={`下移 ${view.name}`} disabled={categorySaving || index === pinnedCategoryViews.length - 1} onClick={() => void movePinnedCategory(view.key, 1)}><ArrowDown size={14} /></button>
                    <button type="button" title="取消置顶" aria-label={`取消置顶 ${view.name}`} disabled={categorySaving} onClick={() => void toggleCategoryPinned(view)}><PinOff size={14} /></button>
                  </span>
                </div>
              ))}
          </div>
          <div className="category-manager-section">
            <div className="category-manager-heading"><LayoutList size={14} /><strong>自定义分类</strong></div>
            {taskCategorySettings.customCategories.length === 0
              ? <div className="category-manager-empty">还没有自定义分类</div>
              : taskCategorySettings.customCategories.map((category) => (
                <div className="category-custom-row" key={category.id}>
                  <span className="category-custom-copy">
                    {editingCategoryId === category.id
                      ? <input autoFocus value={editingCategoryName} onChange={(event) => setEditingCategoryName(event.target.value)} onBlur={() => void saveCustomCategoryName(category.id)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditingCategoryId(null); }} />
                      : <><strong>{category.name}</strong><small>{category.assignedDirs.length ? `${category.assignedDirs.length} 个目录` : "还没有目录"}</small></>}
                  </span>
                  <span className="category-custom-actions">
                    <button type="button" title="重命名" aria-label={`重命名 ${category.name}`} disabled={categorySaving} onClick={() => { setEditingCategoryId(category.id); setEditingCategoryName(category.name); }}><Pencil size={14} /></button>
                    <button type="button" className="danger" title="删除分类" aria-label={`删除 ${category.name}`} disabled={categorySaving} onClick={() => void deleteCustomCategory(category)}><Trash2 size={14} /></button>
                  </span>
                </div>
              ))}
          </div>
          {hiddenCategoryInfos.length > 0 && <div className="category-manager-section">
            <div className="category-manager-heading"><EyeOff size={14} /><strong>已隐藏分类</strong></div>
            {hiddenCategoryInfos.map((info) => (
              <div className="category-custom-row" key={info.key}>
                <span className="category-custom-copy"><strong>{info.name}</strong><small title={info.detail}>{info.detail}</small></span>
                <span className="category-custom-actions">
                  <button type="button" title="恢复显示" aria-label={`恢复显示 ${info.name}`} disabled={categorySaving} onClick={() => void restoreHiddenCategory(info.key)}><Eye size={14} /></button>
                </span>
              </div>
            ))}
          </div>}
          <div className="category-manager-section">
            <div className="category-manager-heading"><FolderOpen size={14} /><strong>目录归类</strong></div>
            <small className="category-manager-hint">选择“自动归类”时，已收藏目录回到自己的分类，其他目录回到临时工作区。</small>
            {categoryDirectoryAssignments.filter((assignment) => assignment.dir).length === 0
              ? <div className="category-manager-empty">当前任务还没有可归类的工作目录</div>
              : categoryDirectoryAssignments.filter((assignment) => assignment.dir).map((assignment) => (
                <div className="category-dir-row" key={assignment.dir!}>
                  <span className="category-dir-copy"><strong>{assignment.label}</strong><small title={assignment.dir!}>{assignment.dir}</small></span>
                  <select value={assignment.customId ?? ""} disabled={categorySaving} aria-label={`${assignment.label} 所属分类`} onChange={(event) => void assignDirectory(assignment.dir!, event.target.value || null)}>
                    <option value="">自动归类（{assignment.categoryName}）</option>
                    {taskCategorySettings.customCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                  </select>
                </div>
              ))}
          </div>
        </div>
        <footer className="category-manager-footer"><small>目录移入自定义分类后，该目录下所有任务都会随分类显示；隐藏的分类可从上方恢复，删除分类不会删除任务。</small></footer>
      </section>
    </div>, document.body)}

    <ProviderManagerDialog
      open={providerManagerOpen}
      onClose={() => setProviderManagerOpen(false)}
      onChanged={() => {
        void api.agentOptions().then(setAgentOptions).catch(() => undefined);
        if (selectedIdRef.current) void reconcile(selectedIdRef.current);
      }}
    />

    <PresetPromptManagerDialog
      open={presetPromptManagerOpen}
      onClose={() => setPresetPromptManagerOpen(false)}
      onChanged={() => void refreshPresetPrompts()}
    />

    <PathBrowserDialog request={pathBrowser} onClose={() => setPathBrowser(null)} />

    <main className={`workspace ${currentDetail?.pendingPrompts.length ? "has-pending-queue" : ""}`} style={{ "--chat-column-width": `${chatColumnWidth}px` } as CSSProperties}>
      <header className="desktop-header"><div className="desktop-header-copy"><span>CODEX WEB</span><strong>AI 工作台</strong></div><div className="desktop-header-actions"><button type="button" className={`desktop-tool-trigger ${fileExplorerOpen ? "active" : ""}`} disabled={!currentDetail} onClick={toggleFileExplorer}><FolderTree size={16} /><span>文件</span></button><button type="button" className="desktop-billing-trigger" onClick={() => setBillingPanelOpen(true)}><BarChart3 size={16} /><span>API 计费统计</span></button></div></header>
      <header className="mobile-header"><button className="icon-button" onClick={() => setSidebarOpen(true)} aria-label="打开侧栏"><Menu size={20} /></button><div className="wordmark"><span className="brand-mark small"><Zap size={14} /></span><span className="brand-copy"><strong>Codex Web</strong><small>SELF-HOSTED CODEX WORKSTATION</small></span></div><button className={`icon-button mobile-file-trigger ${fileExplorerOpen ? "active" : ""}`} disabled={!currentDetail} onClick={toggleFileExplorer} aria-label="打开文件浏览器" title="文件"><FolderTree size={19} /></button></header>
      {currentDetail ? <LiveActivitiesContext.Provider value={activities}><Chat detail={currentDetail} reasoningSteps={reasoningSteps} taskDurationSeconds={taskDurationSeconds} sending={sending} loadingOlderMessages={loadingOlderMessages} messagesRef={messagesRef} onMessagesScroll={handleMessagesScroll} onJumpToUserMessage={jumpToUserMessage} onAskAgent={askAgentAbout} onAskSideChat={askSideChatAbout} onToggleSideChat={toggleSideChat} sideChatOpen={sideChatOpen} onNewConversationFromSource={(messageId, excerpt) => newConversationFromSourceRef.current(messageId, excerpt)} onOpenSnippet={openCodeSnippet} onOpenSourceReference={openSourceReference} userInitials={account.initials} chatFontSize={chatFontSize} workingDirSettings={workingDirSettings} workingDirSaving={workingDirSaving} onWorkingDirChange={handleChatWorkingDirChange} onBrowseWorkingDir={(initialPath) => setPathBrowser({ mode: "dir", title: "选择工作目录", confirmLabel: "使用该目录", initialPath, onSelect: (paths) => { const path = paths[0] ?? null; if (path) handleChatWorkingDirChange(path); } })} onPreview={openFilePreview} onSkipQueue={skipQueuedJob} skipQueueBusy={skippingQueue} /></LiveActivitiesContext.Provider>
        : loadingConversation ? <ConversationLoading />
        : <Welcome onSuggestion={(text) => applyExternalComposerText(text)} />}
      {error && <div className="toast"><span>{error}</span><button onClick={() => setError("")}><X size={16} /></button></div>}
      {notice && <div className="toast info" role="status"><span>{notice}</span><button onClick={() => setNotice("")}><X size={16} /></button></div>}
      {currentDetail?.conversation.archived_at && <div className="archived-conversation-banner"><Archive size={15} /><span>这个任务已归档，历史内容仍可查看。</span><button type="button" onClick={() => void restoreConversation(currentDetail.conversation)}>恢复任务</button></div>}
      {reloadNotice && <div className={`reload-banner ${reloadNotice.kind}`} role="status">
        <span>{reloadNotice.text}</span>
        {reloadNotice.kind === "success" && <button type="button" className="reload-banner-action" onClick={() => window.location.reload()}>刷新页面</button>}
        <button type="button" className="icon-button" aria-label="关闭 reload 提示" onClick={() => { dismissedReloadSignatureRef.current = currentReloadSignatureRef.current; setReloadNotice(null); }}><X size={15} /></button>
      </div>}
      {agentOptions && agentOptions.codexConfigured === false && <div className="codex-config-banner"><TriangleAlert size={15} /><span>{agentOptions.codexConfigHint || "你的 Codex 尚未配置，请先完成 codex 登录配置。"}</span></div>}
      {(!selectedId || (currentDetail && !currentDetail.conversation.archived_at)) && composerElement}
    </main>
    {sideChatOpen && sideChatCurrentConversation && <SideChatPane
      currentConversation={sideChatCurrentConversation}
      agentOptions={agentOptions}
      referenceRequest={sideChatReferenceRequest}
      onReferenceHandled={(requestId) => setSideChatReferenceRequest((current) => current?.id === requestId ? null : current)}
      onClose={() => { setSideChatOpen(false); setSideChatReferenceRequest(null); }}
      onError={setError}
      onOpenSourceReference={openSourceReference}
      width={sideChatWidth}
      widthMin={SIDE_CHAT_WIDTH_MIN}
      widthMax={SIDE_CHAT_WIDTH_MAX}
      onResizeStart={(event) => beginPaneResize(event, sideChatWidth, SIDE_CHAT_WIDTH_MIN, SIDE_CHAT_WIDTH_MAX, "grow-left", setSideChatWidth, (width) => commitPaneWidth(SIDE_CHAT_WIDTH_KEY, width))}
      onResizeKeyDown={(event) => handlePaneResizerKey(event, "side-chat")}
    />}
    {fileExplorerOpen && currentDetail && <FileExplorerPane
      conversationId={currentDetail.conversation.id}
      width={fileExplorerWidth}
      onResizeStart={(event) => beginPaneResize(event, fileExplorerWidth, FILE_EXPLORER_WIDTH_MIN, FILE_EXPLORER_WIDTH_MAX, "grow-left", setFileExplorerWidth, (width) => commitPaneWidth(FILE_EXPLORER_WIDTH_KEY, width))}
      onResizeKeyDown={(event) => handlePaneResizerKey(event, "file-explorer")}
      onClose={() => setFileExplorerOpen(false)}
    />}
    <BillingPanel open={billingPanelOpen} onClose={() => setBillingPanelOpen(false)} providers={agentOptions?.providers ?? []} builtinModels={agentOptions?.models.filter((model) => !model.provider) ?? []} />
    {snippetPreview
      ? <CodeSnippetPane
          key={`${snippetPreview.conversationId}:${snippetPreview.path}:${snippetPreview.line}`}
          conversationId={snippetPreview.conversationId}
          target={snippetPreview}
          width={previewWidth}
          onResizeStart={(event) => beginPaneResize(event, previewWidth, PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX, "grow-left", setPreviewWidth, (width) => commitPaneWidth(PREVIEW_WIDTH_KEY, width))}
          onResizeKeyDown={(event) => handlePaneResizerKey(event, "preview")}
          onClose={closeCodeSnippet}
        />
      : previewFile && <FilePreviewPane
          key={previewFile.id}
          file={previewFile}
          width={previewWidth}
          onResizeStart={(event) => beginPaneResize(event, previewWidth, PREVIEW_WIDTH_MIN, PREVIEW_WIDTH_MAX, "grow-left", setPreviewWidth, (width) => commitPaneWidth(PREVIEW_WIDTH_KEY, width))}
          onResizeKeyDown={(event) => handlePaneResizerKey(event, "preview")}
          onClose={closeFilePreview}
        />}
  </div>;
}

function ConversationLoading() {
  return <section className="conversation-loading" role="status" aria-live="polite"><LoaderCircle className="spin" size={23} /><span>正在加载任务…</span></section>;
}

function Welcome({ onSuggestion }: { onSuggestion: (value: string) => void }) {
  const suggestions = [
    [<FileText key="a" />, "处理文档", "整理、改写或生成 Word/PDF"],
    [<FolderOpen key="b" />, "制作演示", "分析资料并制作一份 PPT"],
    [<FileImage key="c" />, "分析图片", "识别截图并给出处理结果"],
    [<Bot key="d" />, "执行临时任务", "在独立工作区完成复杂操作"],
  ];
  return <section className="welcome"><div className="welcome-logo"><Zap size={27} /></div><h1>今天想完成什么？</h1><p>文字、图片和文件都会交给本机 Agent 处理</p><div className="suggestions">
    {suggestions.map(([icon, title, description]) => <button key={String(title)} onClick={() => onSuggestion(`${title}：`)}>{icon}<strong>{title}</strong><span>{description}</span></button>)}
  </div></section>;
}

/**
 * Reorder conversations according to a live drag order. Ids missing from the
 * order (e.g. tasks created mid-drag) are appended in their current order.
 */
function orderCategoryConversations(
  conversations: readonly Conversation[],
  order: readonly string[] | undefined,
): Conversation[] {
  if (!order || order.length === 0) return conversations as Conversation[];
  const byId = new Map(conversations.map((item) => [item.id, item]));
  const result: Conversation[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item) {
      result.push(item);
      byId.delete(id);
    }
  }
  for (const item of conversations) if (byId.has(item.id)) result.push(item);
  return result;
}

/**
 * Merge a drag result (only the rows that were visible during the drag) back
 * into the full category order. Rows that were not part of the drag keep their
 * relative position; the dragged rows are inserted together at the position of
 * the first dragged row, preserving the full order even when the drag happened
 * under search filtering.
 */
function mergeCategoryTaskOrder(
  baseIds: readonly string[],
  visibleOrder: readonly string[],
): string[] {
  const visible = new Set(visibleOrder);
  const result: string[] = [];
  let inserted = false;
  for (const id of baseIds) {
    if (visible.has(id)) {
      if (!inserted) {
        result.push(...visibleOrder);
        inserted = true;
      }
    } else {
      result.push(id);
    }
  }
  if (!inserted) result.push(...visibleOrder);
  return result;
}

function conversationRowPropsEqual(previous: ConversationRowProps, next: ConversationRowProps): boolean {
  return previous.selected === next.selected
    && previous.menuOpen === next.menuOpen
    && previous.onSelect === next.onSelect
    && previous.onMenu === next.onMenu
    && previous.draggableInCategory === next.draggableInCategory
    && previous.dragging === next.dragging
    && previous.rowCategoryKey === next.rowCategoryKey
    && conversationFieldsEqual(previous.conversation, next.conversation);
}

type ConversationRowProps = {
  conversation: Conversation;
  selected: boolean;
  menuOpen: boolean;
  onSelect: (id: string) => void;
  onMenu: (conversation: Conversation, button: HTMLButtonElement) => void;
  draggableInCategory?: boolean;
  dragging?: boolean;
  rowCategoryKey?: string;
};

const ConversationRow = memo(function ConversationRow({
  conversation, selected, menuOpen, onSelect, onMenu, draggableInCategory, dragging, rowCategoryKey,
}: ConversationRowProps) {
  return <div
    className={`conversation-row ${selected ? "active" : ""} ${conversation.has_unread_result ? "unread" : ""} ${menuOpen ? "menu-open" : ""} ${draggableInCategory ? "category-draggable" : ""} ${dragging ? "dragging" : ""}`}
    {...(rowCategoryKey ? {
      "data-category-task-row": "",
      "data-category-task-key": rowCategoryKey,
      "data-category-task-id": conversation.id,
      title: "长按拖动排序",
    } : {})}
  >
    <button className="conversation-select" onClick={() => onSelect(conversation.id)}>
      <FolderOpen size={16} /><span>{conversation.title}</span>
      {conversation.status === "running"
        ? <LoaderCircle size={14} className="spin" role="img" aria-label="正在执行" />
        : Boolean(conversation.has_pending_work)
          ? <CircleDashed size={14} className="conversation-waiting" role="img" aria-label="等待发送" />
          : null}
      {conversation.contextUsage && <small className="conversation-context-usage">{formatContextTokens(conversation.contextUsage.usedTokens)}{conversation.contextUsage.contextWindow ? ` / ${formatContextTokens(conversation.contextUsage.contextWindow)}` : ""}</small>}
    </button>
    <div className="row-actions">
      <button type="button" className="task-menu-trigger" data-task-menu aria-label={`任务 ${conversation.title} 操作`} aria-haspopup="menu" aria-expanded={menuOpen} title="任务操作" onClick={(event) => onMenu(conversation, event.currentTarget)}><MoreHorizontal size={15} /></button>
    </div>
  </div>;
}, conversationRowPropsEqual);

type AskAgentSelection = { text: string; messageId: string; left: number; top: number; below: boolean };

type MessageCardProps = {
  message: Message;
  userInitials: string;
  chatFontSize: number;
  citationFiles: WorkFile[];
  onPreview: (file: WorkFile) => void;
  onOpenSnippet: (target: FileLineRef) => void;
  onOpenSourceReference: (reference: MessageSourceReference) => void;
};

const MessageCard = memo(function MessageCard({ message, userInitials, chatFontSize, citationFiles, onPreview, onOpenSnippet, onOpenSourceReference }: MessageCardProps) {
  return <article className={`message ${message.role}`} data-message-id={message.id}>
    <div className="message-avatar">{message.role === "assistant" ? <Zap size={15} /> : userInitials}</div>
    <div className="message-body">
      <div className="message-meta"><span className="message-name">{message.role === "assistant" ? "Codex Web" : "你"}</span><time dateTime={message.created_at} title={formatFullDateTime(message.created_at)}>{formatMessageDateTime(message.created_at)}</time></div>
      {message.role === "assistant" ? <div className="markdown" data-agent-selectable="true"><ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }], rehypeHighlight]}
        urlTransform={(url) => isLocalMarkdownUrl(url) || url.toLowerCase().startsWith("codex-snippet:") ? url : defaultUrlTransform(url)}
        components={{ a: ({ href, children }) => {
          const snippet = parseCodexSnippetUrl(href) ?? parseSnippetHref(href, message.files);
          if (snippet) return <button type="button" className="code-snippet-trigger" title={`${snippet.path}${snippet.line ? `:${snippet.line}` : ""}`} onClick={() => onOpenSnippet(snippet)}><Code size={12} />{children}</button>;
          const resolved = resolveMessageFileLink(href, message.files);
          if (resolved.kind === "download") return <a href={resolved.href} download>{children}</a>;
          if (resolved.kind === "unavailable") {
            const ref = parseFileRef(href, message.files);
            if (ref) return <button type="button" className="code-snippet-trigger" title={ref.path} onClick={() => onOpenSnippet(ref)}><Code size={12} />{children}</button>;
            const path = localPathText(href);
            return <span className="unavailable-file-link" title={path ? `本机文件路径：${path}` : "该本机文件未登记为此消息的附件"}>
              {children}{path && <><code className="unavailable-file-path">{path}</code><CopyPathButton value={path} className="unavailable-file-copy" /></>}<span className="unavailable-file-note">（不可下载）</span>
            </span>;
          }
          return <a href={resolved.href} target="_blank" rel="noreferrer">{children}</a>;
        }, code: ({ className, children }) => {
          const text = typeof children === "string" ? children : Array.isArray(children) ? children.join("") : "";
          const snippet = !className && !text.includes("\n") ? parseFileRef(text, message.files) : null;
          if (snippet) return <button type="button" className="code-snippet-trigger" title={`${snippet.path}${snippet.line ? `:${snippet.line}` : ""}`} onClick={() => onOpenSnippet(snippet)}><Code size={12} />{children}</button>;
          return <code className={className}>{children}</code>;
        } }}
      >{normalizeMathDelimiters(sanitizeAgentMarkdown(message.content, citationFiles))}</ReactMarkdown></div> : <>
        {message.source_reference
          ? <div className="message-source-reference">
              <div className="message-source-reference-copy">
                <CornerUpLeft size={14} />
                <span className="message-source-reference-quote" title={message.source_reference.excerpt}>{message.source_reference.excerpt}</span>
                <button type="button" className="message-source-link" onClick={() => onOpenSourceReference(message.source_reference!)}>来源：{message.source_reference.sourceConversationTitle}</button>
              </div>
            </div>
          : message.quote_excerpt
            ? <div className="message-reference" title={message.quote_excerpt}><CornerUpLeft size={14} /><span><strong>引用</strong>{message.quote_excerpt}</span></div>
            : null}
        {message.content && <p data-agent-selectable="true">{message.content}</p>}
      </>}
      {message.files.length > 0 && <div className="file-grid">{message.files.map((file) => <FileCard key={file.id} file={file} onPreview={onPreview} />)}</div>}
    </div>
  </article>;
});

type MessageListProps = {
  messages: Message[];
  detail: ConversationDetail;
  hasMore: boolean;
  loadingOlderMessages: boolean;
  sending: boolean;
  reasoningSteps: ReasoningStep[];
  taskDurationSeconds: number | null;
  messagesRef: React.RefObject<HTMLDivElement | null>;
  onMessagesScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  onJumpToUserMessage: (direction: JumpDirection) => void;
  onOpenSnippet: (target: FileLineRef) => void;
  onOpenSourceReference: (reference: MessageSourceReference) => void;
  userInitials: string;
  chatFontSize: number;
  citationFiles: WorkFile[];
  onPreview: (file: WorkFile) => void;
  onSkipQueue?: (jobId: string) => void;
  skipQueueBusy?: boolean;
};

const LiveActivitiesContext = createContext<JobEvent[]>([]);

function LiveProcessPanel({ detail, onSkipQueue, skipQueueBusy }: { detail: ConversationDetail; onSkipQueue?: (jobId: string) => void; skipQueueBusy?: boolean }) {
  const activities = useContext(LiveActivitiesContext);
  const activeJobId = detail.activeJob?.id ?? null;
  return <ProcessPanel key={detail.conversation.id} activities={activities} startedAt={detail.activeJob?.startedAt ?? null}
    activeJobId={activeJobId} onSkipQueue={onSkipQueue} skipQueueBusy={skipQueueBusy} />;
}

const MessageList = memo(function MessageList({ messages, detail, hasMore, loadingOlderMessages, sending, reasoningSteps, taskDurationSeconds, messagesRef, onMessagesScroll, onJumpToUserMessage, onOpenSnippet, onOpenSourceReference, userInitials, chatFontSize, citationFiles, onPreview, onSkipQueue, skipQueueBusy }: MessageListProps) {
  const reasoningMessageIndex = messages.findLastIndex((message) => message.role === "assistant");
  return <div ref={messagesRef} className="messages" onScroll={onMessagesScroll} style={{ "--chat-font-size": `${chatFontSize}px` } as CSSProperties}>
    {hasMore && <div className="history-loader" aria-live="polite">{loadingOlderMessages ? <><LoaderCircle className="spin" size={14} /><span>正在加载更早消息…</span></> : <span>向上滚动加载更早消息</span>}</div>}
    {messages.map((message, index) => {
      const reasoningAbove = !sending && index === reasoningMessageIndex && reasoningSteps.length > 0;
      return <Fragment key={message.id}>
        {reasoningAbove && <CompletedReasoningPanel steps={reasoningSteps} durationSeconds={taskDurationSeconds} />}
        <MessageCard message={message} userInitials={userInitials} chatFontSize={chatFontSize} citationFiles={citationFiles} onPreview={onPreview} onOpenSnippet={onOpenSnippet} onOpenSourceReference={onOpenSourceReference} />
      </Fragment>;
    })}
    {sending && <article className="message assistant running"><div className="message-avatar"><Zap size={15} /></div><div className="message-body"><div className="message-meta"><span className="message-name">Codex Web</span><span className="live-label">实时进度</span></div><LiveProcessPanel detail={detail} onSkipQueue={onSkipQueue} skipQueueBusy={skipQueueBusy} /></div></article>}
    {!sending && reasoningMessageIndex === -1 && <CompletedReasoningPanel steps={reasoningSteps} durationSeconds={taskDurationSeconds} />}
    {messages.some((message) => message.role === "user") && <div className="message-jump-nav" aria-label="我的消息导航">
      <button type="button" title="上一条我的消息" aria-label="上一条我的消息" onClick={() => onJumpToUserMessage("previous")}><ArrowUp size={15} /></button>
      <button type="button" title="下一条我的消息" aria-label="下一条我的消息" onClick={() => onJumpToUserMessage("next")}><ArrowDown size={15} /></button>
    </div>}
    <div />
  </div>;
});

function CompletedReasoningPanel({ steps, durationSeconds }: { steps: ReasoningStep[]; durationSeconds: number | null }) {
  if (steps.length === 0) return null;
  return <article className="message assistant reasoning-completed">
    <div className="message-avatar"><Brain size={15} /></div>
    <div className="message-body">
      <details className="reasoning-panel">
        <summary><span className="reasoning-panel-title"><Brain size={14} />思考过程</span><span className="reasoning-panel-meta">{steps.length} 个步骤</span><ChevronDown size={14} /></summary>
        <ol className="reasoning-steps">
          {steps.map((step, index) => (
            <li key={step.id ?? `${step.title ?? index}-${index}`}>
              <details className={`reasoning-step${step.id?.startsWith("approval:") ? " approval-reasoning-step" : ""}`}>
                <summary><span className="reasoning-step-index">{index + 1}</span><span className="reasoning-step-title">{step.title || "思考步骤"}</span><ChevronDown size={13} /></summary>
                <div className="markdown reasoning-step-detail"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false }], rehypeHighlight]}>{normalizeMathDelimiters(step.detail || step.title || "")}</ReactMarkdown></div>
              </details>
            </li>
          ))}
        </ol>
      </details>
      {durationSeconds != null && <div className="reasoning-duration"><Timer size={13} />总用时 {formatElapsed(durationSeconds)}</div>}
    </div>
  </article>;
}
function formatContextTokens(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function ContextUsageBadge({ usage }: { usage: ConversationDetail["contextUsage"] }) {
  if (!usage) return <span className="context-usage-badge context-usage-empty" title="尚未收到 Codex 的上下文状态">上下文暂无</span>;
  const percent = usage.contextWindow ? Math.min(100, Math.max(0, usage.usedTokens / usage.contextWindow * 100)) : null;
  return <span className="context-usage-badge" title={`最近更新：${usage.updatedAt ? formatFullDateTime(usage.updatedAt) : "未知"}`}>
    <span>上下文</span><strong>{formatContextTokens(usage.usedTokens)}{usage.contextWindow ? ` / ${formatContextTokens(usage.contextWindow)}` : ""}</strong>{percent !== null && <em>{percent.toFixed(1)}%</em>}
  </span>;
}

const Chat = memo(function Chat({ detail, reasoningSteps, taskDurationSeconds, sending, loadingOlderMessages, messagesRef, onMessagesScroll, onJumpToUserMessage, onAskAgent, onAskSideChat, onToggleSideChat, sideChatOpen, onNewConversationFromSource, onOpenSnippet, onOpenSourceReference, userInitials, chatFontSize, workingDirSettings, workingDirSaving, onWorkingDirChange, onBrowseWorkingDir, onPreview, onSkipQueue, skipQueueBusy }: {
  detail: ConversationDetail; reasoningSteps: ReasoningStep[]; taskDurationSeconds: number | null; sending: boolean; loadingOlderMessages: boolean; messagesRef: React.RefObject<HTMLDivElement | null>; onMessagesScroll: (event: React.UIEvent<HTMLDivElement>) => void; onJumpToUserMessage: (direction: JumpDirection) => void; onAskAgent: (selectedText: string, messageId: string) => void; onAskSideChat: (selectedText: string, messageId: string) => void; onToggleSideChat: () => void; sideChatOpen: boolean; onNewConversationFromSource: (messageId: string, excerpt: string) => void; onOpenSourceReference: (reference: MessageSourceReference) => void; userInitials: string; chatFontSize: number;
  workingDirSettings: WorkingDirSettings | null; workingDirSaving: boolean; onWorkingDirChange: (workingDir: string | null) => void; onBrowseWorkingDir: (initialPath?: string) => void; onPreview: (file: WorkFile) => void; onOpenSnippet: (target: FileLineRef) => void; onSkipQueue?: (jobId: string) => void; skipQueueBusy?: boolean;
}) {
  const citationFiles = useMemo(() => [...detail.outputFiles, ...detail.messages.flatMap((message) => message.files)], [detail.messages, detail.outputFiles]);
  const chatRef = useRef<HTMLElement>(null);
  const [askSelection, setAskSelection] = useState<AskAgentSelection | null>(null);
  const [previewedOutputFileIds, setPreviewedOutputFileIds] = useState<string[]>([]);
  const autoPreviewedMarkdownRef = useRef(new Set<string>());
  const handlePreview = useCallback((file: WorkFile) => {
    if (file.kind === "output" && canPreviewInline(file)) {
      setPreviewedOutputFileIds((current) => [file.id, ...current.filter((id) => id !== file.id)]);
    }
    onPreview(file);
  }, [onPreview]);
  const orderedOutputFiles = useMemo(
    () => orderPreviewedFiles(detail.outputFiles, previewedOutputFileIds),
    [detail.outputFiles, previewedOutputFileIds],
  );

  useEffect(() => {
    const outputFileIds = new Set(detail.outputFiles.map((file) => file.id));
    setPreviewedOutputFileIds((current) => {
      const next = current.filter((fileId) => outputFileIds.has(fileId));
      return next.length === current.length ? current : next;
    });
  }, [detail.conversation.id, detail.outputFiles]);

  useEffect(() => {
    const markdown = firstMarkdownPreviewFile(detail.outputFiles);
    if (!markdown || autoPreviewedMarkdownRef.current.has(markdown.id)) return;
    autoPreviewedMarkdownRef.current.add(markdown.id);
    handlePreview(markdown);
  }, [detail.conversation.id, detail.outputFiles, handlePreview]);

  useEffect(() => {
    let frame = 0;
    const clear = () => setAskSelection(null);
    const selectableParent = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement;
      return element?.closest<HTMLElement>("[data-agent-selectable]") ?? null;
    };
    const messageParent = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement;
      return element?.closest<HTMLElement>("[data-message-id]") ?? null;
    };
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return clear();
        const text = normalizeAskAgentSelection(selection.toString());
        if (!text) return clear();
        const range = selection.getRangeAt(0);
        const start = selectableParent(range.startContainer);
        const end = selectableParent(range.endContainer);
        if (!start || start !== end || !chatRef.current?.contains(start)) return clear();
        const message = messageParent(range.startContainer);
        const messageEnd = messageParent(range.endContainer);
        if (!message || message !== messageEnd) return clear();
        const messageId = message.dataset.messageId;
        if (!messageId) return clear();
        const rect = range.getBoundingClientRect();
        if (!rect.width && !rect.height) return clear();
        const horizontalInset = 72;
        const left = Math.min(window.innerWidth - horizontalInset, Math.max(horizontalInset, rect.left + rect.width / 2));
        const below = window.innerHeight - rect.bottom >= 64;
        setAskSelection({ text, messageId, left, top: below ? rect.bottom + 10 : rect.top - 10, below });
      });
    };
    document.addEventListener("selectionchange", update);
    window.addEventListener("resize", clear);
    const messages = messagesRef.current;
    messages?.addEventListener("scroll", clear, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("resize", clear);
      messages?.removeEventListener("scroll", clear);
    };
  }, [detail.conversation.id]);

  function useSelectedText() {
    if (!askSelection) return;
    onAskAgent(askSelection.text, askSelection.messageId);
    setAskSelection(null);
    window.getSelection()?.removeAllRanges();
  }

  function useSelectedTextInSideChat() {
    if (!askSelection) return;
    onAskSideChat(askSelection.text, askSelection.messageId);
    setAskSelection(null);
    window.getSelection()?.removeAllRanges();
  }

  function useSelectedTextAsNewTask() {
    if (!askSelection) return;
    onNewConversationFromSource(askSelection.messageId, askSelection.text);
    setAskSelection(null);
    window.getSelection()?.removeAllRanges();
  }

  return <section ref={chatRef} className="chat"><div className="chat-header"><div><span className="chat-kicker">CODEX WEB <i>/</i> AI 工作台</span><h1>{detail.conversation.title}</h1>{workingDirSettings?.enabled && <div className="chat-working-dir" title={detail.conversation.working_dir ?? undefined}>{detail.conversation.working_dir ?? "独立工作区"}</div>}</div><div className="chat-header-actions"><ContextUsageBadge usage={detail.contextUsage} /><span className="message-count">已加载 {detail.messages.length} 条</span>{workingDirSettings?.enabled && <SettingMenu
      className="working-dir"
      label="目录"
      value={detail.conversation.working_dir ?? ""}
      options={[
        { id: "", label: "独立工作区", description: "使用对话自己的隔离目录" },
        ...workingDirSettings.favorites.map((favorite) => ({ id: favorite.path, label: favorite.label, description: favorite.path })),
        { id: "__browse__", label: "浏览其他目录…" },
      ]}
      placeholder="独立工作区"
      title="选择本对话的 Codex 工作目录"
      disabled={workingDirSaving || detail.conversation.status === "running" || detail.conversation.has_pending_work > 0}
      direction="down"
      onChange={(value) => {
        if (value === "__browse__") { onBrowseWorkingDir(detail.conversation.working_dir ?? undefined); return; }
        onWorkingDirChange(value || null);
      }}
    />}{shouldWarnAboutRollout(detail.rolloutBytes) && <details className="rollout-warning"><summary className="icon-button" aria-label="会话历史容量提醒"><TriangleAlert size={19} /><span /></summary><div className="rollout-warning-panel"><strong>会话历史已达 {formatRolloutBytes(detail.rolloutBytes!)}</strong><p>超长会话会增加加载和续接成本。建议完成当前任务后归档，并新建任务继续。</p></div></details>}<button type="button" className={`side-chat-toggle ${sideChatOpen ? "active" : ""}`} onClick={onToggleSideChat} aria-pressed={sideChatOpen} title="打开侧边聊天"><Bot size={16} /><span>侧边聊天</span></button><button className="icon-button" aria-label="更多"><MoreHorizontal size={20} /></button></div></div>
    <OutputFilesPanel key={detail.conversation.id} files={orderedOutputFiles} onPreview={handlePreview} />
    <MessageList
      messages={detail.messages}
      detail={detail}
      hasMore={detail.messagePage.hasMore}
      loadingOlderMessages={loadingOlderMessages}
      sending={sending}
      reasoningSteps={reasoningSteps}
      taskDurationSeconds={taskDurationSeconds}
      messagesRef={messagesRef}
      onMessagesScroll={onMessagesScroll}
      onJumpToUserMessage={onJumpToUserMessage}
      onOpenSnippet={onOpenSnippet}
      onOpenSourceReference={onOpenSourceReference}
      userInitials={userInitials}
      chatFontSize={chatFontSize}
      citationFiles={citationFiles}
      onPreview={handlePreview}
      onSkipQueue={onSkipQueue}
      skipQueueBusy={skipQueueBusy}
    />{askSelection && <div className={`ask-agent-selection selection-actions ${askSelection.below ? "below" : "above"}`} style={{ left: askSelection.left, top: askSelection.top }}>
      <button type="button" onPointerDown={(event) => { event.preventDefault(); useSelectedTextInSideChat(); }} onClick={(event) => { if (event.detail === 0) useSelectedTextInSideChat(); }}><Bot size={14} /><span>侧边提问</span></button>
      <button type="button" onPointerDown={(event) => { event.preventDefault(); useSelectedText(); }} onClick={(event) => { if (event.detail === 0) useSelectedText(); }}><Zap size={14} /><span>询问 Agent</span></button>
      <button type="button" onPointerDown={(event) => { event.preventDefault(); useSelectedTextAsNewTask(); }} onClick={(event) => { if (event.detail === 0) useSelectedTextAsNewTask(); }}><Plus size={14} /><span>新建任务</span></button>
    </div>}
  </section>;
});

function useElapsedTimer(startedAt: string | null): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const update = () => {
      const start = new Date(startedAt).getTime();
      setElapsedSeconds(Number.isFinite(start) ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : 0);
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return elapsedSeconds;
}

function ProcessPanel({ activities, startedAt: jobStartedAt, activeJobId, onSkipQueue, skipQueueBusy }: {
  activities: JobEvent[];
  startedAt?: string | null;
  activeJobId?: string | null;
  onSkipQueue?: (jobId: string) => void;
  skipQueueBusy?: boolean;
}) {
  const latestStatus = activities.findLast((item) => item.type === "status" || item.kind === "status");
  const queueStatus = activities.findLast((activity) => activity.status === "queued");
  const queued = Boolean(queueStatus) && !activities.some((activity) => activity.status === "running");
  const retrying = !queued && latestStatus?.status === "retrying";
  const plan = activities.findLast((activity) => activity.kind === "todo" && Boolean(activity.items?.length));
  const journal = buildProcessJournal(activities);
  const completedPlanItems = plan?.items?.filter((item) => item.completed).length ?? 0;
  const startedAt = jobStartedAt
    ?? activities.find((activity) => (activity.kind === "status" || activity.type === "status") && activity.status === "running")?.created_at
    ?? null;
  const elapsedSeconds = useElapsedTimer(startedAt);

  return <div className="activity-card" role="status" aria-live="polite">
    <div className="activity-title"><LoaderCircle className="spin" size={17} /><strong>{queued ? "正在排队" : retrying ? "正在自动重试" : "正在处理"}</strong><span>{queued ? (queueStatus?.jobsAhead ? `前方还有 ${queueStatus.jobsAhead} 个任务 · 当前排在第 ${queueStatus.queuePosition} 位` : "前方无任务，即将自动开始") : retrying ? latestStatus.label : "完成前持续保留，可随时引导"}</span>{queued && activeJobId && onSkipQueue && <button type="button" className="activity-skip-queue" disabled={skipQueueBusy} onClick={() => onSkipQueue(activeJobId)}><Zap size={13} /><span>跳过排队直接执行</span></button>}</div>
    {plan?.items && <div className="process-plan"><div className="process-section-title"><strong>执行计划</strong><span>{completedPlanItems}/{plan.items.length}</span></div><ul>
      {plan.items.map((item, index) => <li className={item.completed ? "completed" : index === completedPlanItems ? "current" : ""} key={`${item.text}-${index}`}><span>{item.completed ? <Check size={12} /> : index === completedPlanItems ? <LoaderCircle className="spin" size={12} /> : index + 1}</span><p>{item.text}</p></li>)}
    </ul></div>}
    <div className="process-section-title"><strong>工作记录</strong><span>{journal.length ? `${journal.length} 条 · 阶段反馈保留上限 5 条` : "实时更新"}</span></div>
    <div className="process-journal">{journal.length ? journal.map((activity, index) => isNarrativeActivity(activity)
      ? <ProcessJournalNote activity={activity} key={activity.seq ?? `${activity.kind}-${index}`} />
      : <div className="activity-line" key={activity.seq ?? `${activity.label}-${index}`}>
          {activity.kind === "approval"
            ? activity.reviewStatus === "inProgress" ? <LoaderCircle className="spin" size={14} /> : activity.reviewStatus === "approved" ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />
            : activity.label?.startsWith("正在") ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
          <div><span>{activity.label}</span>{activity.created_at && <time dateTime={activity.created_at}>{formatActivityTime(activity.created_at)}</time>}
            {activity.kind === "file" && activity.files?.length ? <small title={activity.files.join("、")}>{activity.files.map((file) => file.split(/[\\/]/).at(-1)).join("、")}</small> : null}
            {["search", "tool", "subagent"].includes(activity.kind ?? "") && activity.detail ? <small>{activity.detail}</small> : null}
            {activity.kind === "command" && activity.detail ? <details className="technical-detail"><summary>{activity.actionCount && activity.actionCount > 1 ? `查看 ${activity.actionCount} 个技术步骤` : "查看技术细节"}</summary><code>{activity.groupedDetails?.join("\n\n") || activity.detail}</code></details> : null}
            {activity.kind === "approval" && activity.detail ? <details className={`approval-detail ${activity.reviewStatus ?? ""}`}><summary>查看审核内容</summary><div className="process-note-content"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false }], rehypeHighlight]}>{normalizeMathDelimiters(activity.detail)}</ReactMarkdown></div></details> : null}
          </div>
        </div>) : <p className="process-journal-empty">正在建立执行方向…</p>}</div>
    {startedAt && !queued && <div className="process-timer-row"><Timer size={13} />已用时 {formatElapsed(elapsedSeconds)}</div>}
  </div>;
}

const ProcessJournalNote = memo(function ProcessJournalNote({ activity }: { activity: JobEvent }) {
  return <section className="process-journal-note">
    <header><Bot size={14} /><strong>{activity.kind === "reasoning" ? "重要思路" : "阶段反馈"}</strong>{activity.created_at && <time dateTime={activity.created_at}>{formatActivityTime(activity.created_at)}</time>}</header>
    <div className="process-note-content"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false }], rehypeHighlight]}>{normalizeMathDelimiters(activity.detail ?? "")}</ReactMarkdown></div>
  </section>;
});

function formatMessageDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return MESSAGE_DATE_FORMATTER.format(date);
}

function formatFullDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return FULL_DATE_FORMATTER.format(date);
}

function formatActivityTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return ACTIVITY_TIME_FORMATTER.format(date);
}

function OutputFilesPanel({ files, onPreview }: { files: WorkFile[]; onPreview: (file: WorkFile) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;
  const previewableCount = files.filter((file) => canPreviewInline(file)).length;
  return <section className={`chat-outputs ${expanded ? "expanded" : ""}`} aria-label="输出文件">
    <button type="button" className="chat-outputs-toggle" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
      <span className="chat-outputs-toggle-copy">
        <span className="chat-outputs-heading"><FolderOpen size={13} /><strong>输出文件</strong></span>
        <small>{files.length} 个文件{previewableCount > 0 ? ` · ${previewableCount} 个可预览` : ""}</small>
      </span>
      <ChevronDown size={15} className="chat-outputs-toggle-icon" />
    </button>
    {expanded && <div className="chat-outputs-list" role="list">
      {files.map((file) => {
        const path = file.host_path ?? file.relative_path;
        const kind = filePreviewKind(file);
        const chipContent = <>{kind === "image" ? <FileImage size={13} /> : <FileText size={13} />}<span>{file.original_name}</span><small>{formatSize(file.size)}</small></>;
        return <span className="chat-output-chip-wrap" key={file.id} role="listitem">
          {canPreviewInline(file)
            ? <button type="button" className="chat-output-chip" title={path} onClick={() => onPreview(file)}>{chipContent}</button>
            : <a className="chat-output-chip" href={fileUrl(file, true)} download={file.original_name} title={path}>{chipContent}</a>}
          <CopyPathButton value={path} className="chat-output-chip-copy" />
        </span>;
      })}
    </div>}
  </section>;
}

function FileCard({ file, onPreview }: { file: WorkFile; onPreview: (file: WorkFile) => void }) {
  const kind = filePreviewKind(file);
  const previewable = canPreviewInline(file);
  const icon = kind === "image" ? <FileImage size={20} /> : kind ? <FileText size={20} /> : <FileIcon size={20} />;
  const path = file.host_path ?? file.relative_path;
  const meta = `${formatSize(file.size)} · ${file.kind === "output" ? "结果文件" : "上传文件"}${previewable ? " · 点击预览" : ""}`;
  const body = <>{icon}<span><strong>{file.original_name}</strong><small>{meta}</small><small className="file-path" title={path}>{path}</small></span></>;
  return <div className="file-card">
    {previewable
      ? <button type="button" className="file-preview-trigger" title="点击预览" onClick={() => onPreview(file)}>{body}</button>
      : <a href={fileUrl(file, true)} download={file.original_name}>{body}</a>}
    <CopyPathButton value={path} className="file-path-copy" />
    <a className="download-button" href={fileUrl(file, true)} download={file.original_name} title="下载"><Download size={16} /></a>
  </div>;
}

function FilePreviewPane({ file, width, onResizeStart, onResizeKeyDown, onClose }: {
  file: WorkFile;
  width: number;
  onResizeStart: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizeKeyDown: (event: KeyboardEvent) => void;
  onClose: () => void;
}) {
  const kind = filePreviewKind(file);
  const source = fileUrl(file);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [shareState, setShareState] = useState<"idle" | "loading" | "copied" | "error">("idle");
  const shareTimerRef = useRef<number | null>(null);
  const isTextKind = kind === "markdown" || kind === "text";
  const shareable = file.kind === "output" && isBrowserPreviewable(file);

  useEffect(() => () => {
    if (shareTimerRef.current !== null) window.clearTimeout(shareTimerRef.current);
  }, []);

  async function handleShare() {
    if (shareState === "loading") return;
    setShareState("loading");
    try {
      const { url } = await api.createFileShare(file.id);
      const ok = await copyText(new URL(url, window.location.origin).href);
      setShareState(ok ? "copied" : "error");
    } catch {
      setShareState("error");
    }
    if (shareTimerRef.current !== null) window.clearTimeout(shareTimerRef.current);
    shareTimerRef.current = window.setTimeout(() => setShareState("idle"), 2200);
  }

  useEffect(() => {
    if (!isTextKind) return;
    const controller = new AbortController();
    let cancelled = false;
    setText(null);
    setError("");
    fetch(source, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error || `文件读取失败 (${response.status})`);
        }
        const value = await response.text();
        if (!cancelled) setText(value);
      })
      .catch((reason) => {
        if (cancelled || (reason instanceof DOMException && reason.name === "AbortError")) return;
        if (!cancelled) setError(reason instanceof Error ? reason.message : "文件读取失败");
      });
    return () => { cancelled = true; controller.abort(); };
  }, [file.id, isTextKind, source]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const path = file.host_path ?? file.relative_path;
  const subtitle = `${file.kind === "output" ? "结果文件" : "上传文件"} · ${formatSize(file.size)}`;
  return <aside className="file-preview-pane" style={{ width }} aria-label={`预览 ${file.original_name}`}>
      <div
        className="file-preview-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整预览栏宽度"
        aria-valuemin={PREVIEW_WIDTH_MIN}
        aria-valuemax={PREVIEW_WIDTH_MAX}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onKeyDown={onResizeKeyDown}
      />
      <header>
        {kind === "image" ? <FileImage size={19} /> : kind ? <FileText size={19} /> : <FileIcon size={19} />}
        <span className="file-preview-title"><strong>{file.original_name}</strong><small title={path}>{path} · {subtitle}</small></span>
      <span className="file-preview-actions">
        <CopyPathButton value={path} className="file-preview-copy" />
        {shareable && <button type="button" className="icon-button" title={shareState === "copied" ? "分享链接已复制（7 天内有效）" : shareState === "error" ? "分享链接生成失败" : "复制分享链接（7 天内有效）"} aria-label="复制分享链接" onClick={() => void handleShare()}>{shareState === "copied" ? <Check size={17} /> : <Share2 size={17} />}</button>}
        <a className="icon-button" href={fileUrl(file, true)} download={file.original_name} title="下载"><Download size={17} /></a>
          <button type="button" className="icon-button" aria-label="关闭" autoFocus onClick={onClose}><X size={18} /></button>
        </span>
      </header>
      <div className={`file-preview-body ${kind === "image" || kind === "pdf" ? "fit" : ""}`}>
        {kind === "image" && <img className="file-preview-image" src={source} alt={file.original_name} />}
        {kind === "pdf" && <iframe className="file-preview-frame" src={source} title={file.original_name} />}
        {kind === "markdown" && (error ? <FilePreviewError error={error} /> : text === null ? <FilePreviewLoading /> : <div className="markdown file-preview-markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false }], rehypeHighlight]}>{normalizeMathDelimiters(text)}</ReactMarkdown></div>)}
        {kind === "text" && (error ? <FilePreviewError error={error} /> : text === null ? <FilePreviewLoading /> : <pre className="file-preview-plain">{text}</pre>)}
        {!kind && <FilePreviewError error="该文件格式暂不支持页内预览，请下载后查看。" />}
      </div>
  </aside>;
}

function FilePreviewLoading() {
  return <div className="file-preview-loading"><LoaderCircle className="spin" size={20} /><span>正在加载预览…</span></div>;
}

function FilePreviewError({ error }: { error: string }) {
  return <div className="file-preview-error"><TriangleAlert size={20} /><span>{error}</span></div>;
}

function PendingQueue({ prompts, busy, canSteer, onReorder, onEdit, onDelete, onSteer }: {
  prompts: PendingPrompt[];
  busy: boolean;
  canSteer: boolean;
  onReorder: (ordered: PendingPrompt[]) => void;
  onEdit: (prompt: PendingPrompt) => void;
  onDelete: (prompt: PendingPrompt) => void;
  onSteer: (prompt: PendingPrompt) => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  function dropOn(targetId: string) {
    if (!draggingId || draggingId === targetId) return setDraggingId(null);
    const sourceIndex = prompts.findIndex((prompt) => prompt.id === draggingId);
    const targetIndex = prompts.findIndex((prompt) => prompt.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return setDraggingId(null);
    const ordered = [...prompts];
    const [moved] = ordered.splice(sourceIndex, 1);
    ordered.splice(targetIndex, 0, moved);
    setDraggingId(null);
    onReorder(ordered);
  }
  return <section className="pending-queue" aria-label="待发送任务队列">
    <div className="pending-queue-heading"><strong>待发送</strong><span>{prompts.length} 个任务 · 当前任务完成后依次发送</span></div>
    <div className="pending-queue-list">
      {prompts.map((prompt) => <article key={prompt.id} className={`pending-queue-item ${draggingId === prompt.id ? "dragging" : ""}`}
        onDragOver={(event) => { if (draggingId) event.preventDefault(); }} onDrop={() => dropOn(prompt.id)}>
        <button type="button" className="pending-drag-handle" draggable={!busy}
          onDragStart={(event) => { setDraggingId(prompt.id); event.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => setDraggingId(null)} title="拖动调整顺序" aria-label="拖动调整顺序"><GripVertical size={17} /></button>
        <div className="pending-queue-copy" title={prompt.content || prompt.quote_excerpt || prompt.files.map((file) => file.original_name).join("、")}>
          <span>{prompt.content || prompt.quote_excerpt || prompt.files.map((file) => file.original_name).join("、") || "附件任务"}</span>
          {prompt.quote_excerpt && <small><CornerUpLeft size={11} />含引用</small>}
          {prompt.files.length > 0 && <small><Paperclip size={11} />{prompt.files.length} 个附件</small>}
        </div>
        <div className="pending-queue-actions">
          <button type="button" className="steer-action" disabled={busy || !canSteer} onClick={() => onSteer(prompt)} title={canSteer ? "立即引导当前任务" : "当前任务开始运行后可引导"}><CornerUpLeft size={14} /><span>引导</span></button>
          <button type="button" disabled={busy} onClick={() => onEdit(prompt)} title="编辑"><Pencil size={14} /></button>
          <button type="button" disabled={busy} onClick={() => onDelete(prompt)} title="删除"><Trash2 size={14} /></button>
        </div>
      </article>)}
    </div>
  </section>;
}

function Composer({ conversationId, input, inputRevision, onTextChange, askAgentQuote, onClearAskAgentQuote, sourceReference, onClearSourceReference, onOpenSourceReference, focusRequest, files, setFiles, draftFiles, draftUploads, draftSaveState, sending, submitting, selectionSaving, voiceEnabled, pendingPrompts, editingPending, removedEditingFileIds, presetPrompts, enabledPresetPromptIds, onTogglePresetPrompt, presetSaving, onOpenPresetManager, agentOptions, selectedModel, reasoningEffort, sandboxMode, onModelChange, onReasoningChange, onSandboxChange, onReorderPending, onEditPending, onDeletePending, onSteerPending, canSteer, onCancelPendingEdit, onAddFiles, onRemoveDraftFile, onClearDraft, onRemoveEditingFile, onRestoreEditingFile, hostFilesAvailable, onBrowseHostFiles, onSend, onCancel }: {
  conversationId: string | null;
  input: string;
  inputRevision: number;
  onTextChange: (text: string) => void;
  askAgentQuote: string;
  onClearAskAgentQuote: () => void;
  sourceReference: MessageSourceReference | null;
  onClearSourceReference: () => void;
  onOpenSourceReference: (reference: MessageSourceReference) => void;
  focusRequest: number;
  files: File[];
  setFiles: Dispatch<SetStateAction<File[]>>;
  draftFiles: WorkFile[];
  draftUploads: DraftUpload[];
  draftSaveState: DraftSaveState;
  sending: boolean;
  submitting: boolean;
  selectionSaving: boolean;
  voiceEnabled: boolean;
  pendingPrompts: PendingPrompt[];
  editingPending: PendingPrompt | null;
  removedEditingFileIds: string[];
  presetPrompts: PresetPrompt[];
  enabledPresetPromptIds: string[];
  onTogglePresetPrompt: (id: string, enabled: boolean) => void;
  presetSaving: boolean;
  onOpenPresetManager: () => void;
  agentOptions: AgentOptions | null;
  selectedModel: string;
  reasoningEffort: ReasoningEffort | "";
  sandboxMode: SandboxMode;
  onModelChange: (model: string) => void;
  onReasoningChange: (effort: ReasoningEffort) => void;
  onSandboxChange: (mode: SandboxMode) => void;
  onReorderPending: (ordered: PendingPrompt[]) => void;
  onEditPending: (prompt: PendingPrompt) => void;
  onDeletePending: (prompt: PendingPrompt) => void;
  onSteerPending: (prompt: PendingPrompt) => void;
  canSteer: boolean;
  onCancelPendingEdit: () => void;
  onAddFiles: (files: File[]) => void;
  onRemoveDraftFile: (file: WorkFile) => void;
  onClearDraft: () => void;
  onRemoveEditingFile: (fileId: string) => void;
  onRestoreEditingFile: (fileId: string) => void;
  hostFilesAvailable: boolean;
  onBrowseHostFiles: () => void;
  onSend: (message?: string) => void;
  onCancel?: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const pasteTimer = useRef<number | undefined>(undefined);
  const [pasteNotice, setPasteNotice] = useState("");
  const [composerTextHeight, setComposerTextHeight] = useState<number | null>(null);
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [voiceElapsed, setVoiceElapsed] = useState(0);
  const [voiceError, setVoiceError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef<number | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const recordingLimitRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sendAfterTranscriptionRef = useRef(false);
  const discardRecordingRef = useRef(false);
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const handledFocusRequestRef = useRef(focusRequest);
  const inputRef = useRef(input);
  const hadInputRef = useRef(Boolean(input));
  const [hasText, setHasText] = useState(() => Boolean(input.trim()));
  const onTextChangeRef = useRef(onTextChange);
  const filesRef = useRef(files);
  const draftFilesRef = useRef(draftFiles);
  const draftUploadsRef = useRef(draftUploads);
  const editingPendingRef = useRef(editingPending);
  const removedEditingFileIdsRef = useRef(removedEditingFileIds);
  const onSendRef = useRef(onSend);
  onTextChangeRef.current = onTextChange;
  filesRef.current = files;
  draftFilesRef.current = draftFiles;
  draftUploadsRef.current = draftUploads;
  editingPendingRef.current = editingPending;
  removedEditingFileIdsRef.current = removedEditingFileIds;
  onSendRef.current = onSend;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (textarea.value !== input) textarea.value = input;
    inputRef.current = input;
    hadInputRef.current = Boolean(input);
    setHasText(Boolean(input.trim()));
    if (!input) setComposerTextHeight(null);
  }, [input, inputRevision]);

  useEffect(() => () => {
    window.clearTimeout(pasteTimer.current);
    discardRecordingRef.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    releaseAudio();
  }, []);

  useEffect(() => {
    if (focusRequest === handledFocusRequestRef.current) return;
    handledFocusRequestRef.current = focusRequest;
    const frame = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);

  function releaseAudio() {
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    if (durationTimerRef.current !== null) window.clearInterval(durationTimerRef.current);
    if (recordingLimitRef.current !== null) window.clearTimeout(recordingLimitRef.current);
    animationRef.current = null; durationTimerRef.current = null; recordingLimitRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
  }

  function drawWaveform(analyser: AnalyserNode) {
    const canvas = waveformRef.current;
    if (canvas) {
      const values = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(values);
      const context = canvas.getContext("2d");
      if (context) {
        const width = canvas.clientWidth * window.devicePixelRatio;
        const height = canvas.clientHeight * window.devicePixelRatio;
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        context.clearRect(0, 0, width, height);
        context.fillStyle = "#4b5794";
        const bars = 36; const gap = 2 * window.devicePixelRatio; const barWidth = Math.max(2, (width - gap * (bars - 1)) / bars);
        for (let index = 0; index < bars; index += 1) {
          const sample = values[Math.floor(index * values.length / bars)] / 255;
          const barHeight = Math.max(3 * window.devicePixelRatio, sample * height * .9);
          context.beginPath();
          context.roundRect(index * (barWidth + gap), (height - barHeight) / 2, barWidth, barHeight, barWidth / 2);
          context.fill();
        }
      }
    }
    animationRef.current = requestAnimationFrame(() => drawWaveform(analyser));
  }

  async function startRecording() {
    if (voiceState !== "idle" || submitting || selectionSaving) return;
    setVoiceError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setVoiceError("当前浏览器不支持录音，请改用最新版 Chrome、Edge 或 Safari。");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
      const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      streamRef.current = stream; recorderRef.current = recorder; chunksRef.current = [];
      sendAfterTranscriptionRef.current = false; discardRecordingRef.current = false;
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onerror = () => {
        discardRecordingRef.current = true;
        if (recorder.state === "recording") recorder.stop();
        setVoiceError("录音中断，请检查麦克风权限后重试。"); releaseAudio(); setVoiceState("idle");
      };
      recorder.onstop = () => void processRecording(recorder.mimeType || mimeType || "audio/webm");
      recorder.start(250);
      setVoiceElapsed(0); setVoiceState("recording");
      const startedAt = Date.now();
      durationTimerRef.current = window.setInterval(() => setVoiceElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250);
      recordingLimitRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") {
          sendAfterTranscriptionRef.current = false;
          recorder.stop();
          setVoiceState("transcribing");
        }
      }, 5 * 60 * 1000);
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        const audioContext = new AudioContextClass(); audioContextRef.current = audioContext;
        const analyser = audioContext.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = .76;
        audioContext.createMediaStreamSource(stream).connect(analyser);
        drawWaveform(analyser);
      }
    } catch (reason) {
      releaseAudio(); setVoiceState("idle");
      const denied = reason instanceof DOMException && ["NotAllowedError", "PermissionDeniedError"].includes(reason.name);
      setVoiceError(denied ? "请允许浏览器使用麦克风，然后再试一次。" : "无法开始录音，请检查麦克风是否可用。");
    }
  }

  function finishRecording(sendAfter: boolean) {
    if (voiceState !== "recording" || recorderRef.current?.state !== "recording") return;
    sendAfterTranscriptionRef.current = sendAfter;
    recorderRef.current.stop();
    setVoiceState("transcribing");
  }

  function cancelRecording() {
    if (voiceState !== "recording" || recorderRef.current?.state !== "recording") return;
    discardRecordingRef.current = true;
    recorderRef.current.stop();
    releaseAudio();
    setVoiceState("idle"); setVoiceElapsed(0);
  }

  function handleTextChange(value: string) {
    const hadInput = hadInputRef.current;
    inputRef.current = value;
    hadInputRef.current = Boolean(value);
    setHasText(Boolean(value.trim()));
    if (hadInput && !value) setComposerTextHeight(null);
    onTextChangeRef.current(value);
  }

  async function processRecording(mimeType: string) {
    releaseAudio(); recorderRef.current = null;
    if (discardRecordingRef.current) { chunksRef.current = []; return; }
    const blob = new Blob(chunksRef.current, { type: mimeType }); chunksRef.current = [];
    if (blob.size === 0) { setVoiceError("没有录到声音，请重新录制。"); setVoiceState("idle"); return; }
    const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "mp4" : "webm";
    try {
      const retainedNames = (editingPendingRef.current?.files ?? [])
        .filter((file) => !removedEditingFileIdsRef.current.includes(file.id))
        .map((file) => file.original_name);
      const attachmentNames = [...retainedNames, ...draftFilesRef.current.map((file) => file.original_name), ...draftUploadsRef.current.map((file) => file.name), ...filesRef.current.map((file) => file.name)].slice(0, 12);
      const result = await api.transcribeAudio(blob, `recording.${extension}`, {
        conversationId: conversationId ?? undefined,
        draftText: inputRef.current,
        attachmentNames,
      });
      const existing = inputRef.current;
      const combined = existing ? `${existing}${/\s$/.test(existing) ? "" : "\n"}${result.text}` : result.text;
      handleTextChange(combined); setVoiceState("idle"); setVoiceElapsed(0);
      if (sendAfterTranscriptionRef.current) onSendRef.current(combined);
    } catch (reason) {
      setVoiceError(reason instanceof Error ? reason.message : "语音识别失败，请重试。");
      setVoiceState("idle");
    } finally { sendAfterTranscriptionRef.current = false; }
  }
  function addFiles(list: FileList | File[] | null) {
    if (!list) return;
    onAddFiles(Array.from(list));
  }
  function pasted(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardFiles = Array.from(event.clipboardData.files);
    if (clipboardFiles.length === 0) {
      for (const item of Array.from(event.clipboardData.items)) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) clipboardFiles.push(file);
      }
    }
    if (clipboardFiles.length === 0) return;
    event.preventDefault();
    const timestamp = clipboardTimestamp(new Date());
    const normalized = clipboardFiles.map((file, index) => normalizeClipboardFile(file, timestamp, index));
    addFiles(normalized);
    const available = Math.max(0, 12 - files.length - draftFiles.length - draftUploads.length);
    const added = Math.min(normalized.length, available);
    setPasteNotice(added > 0 ? `已从剪贴板添加 ${added} 个附件` : "单次最多添加 12 个附件");
    window.clearTimeout(pasteTimer.current);
    pasteTimer.current = window.setTimeout(() => setPasteNotice(""), 2600);
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); voiceState === "recording" ? finishRecording(true) : onSend(inputRef.current); } }
  const selectedModelOption = agentOptions?.models.find((model) => model.id === selectedModel);
  const effortOptions = agentOptions?.reasoningEfforts.filter((effort) => selectedModelOption?.reasoningEfforts.includes(effort.id)) ?? [];
  const sandboxOptions = agentOptions?.sandboxModes.map((mode) => ({
    id: mode.id,
    label: mode.label,
    description: mode.description,
  })) ?? [];
  const hasRetainedEditingFile = Boolean(editingPending?.files.some((file) => !removedEditingFileIds.includes(file.id)));
  const primaryAction = chooseComposerPrimaryAction({
    running: Boolean(sending && onCancel),
    hasText: Boolean(hasText || askAgentQuote),
    hasAttachments: files.length > 0 || draftFiles.length > 0 || draftUploads.length > 0 || hasRetainedEditingFile,
    voiceActive: voiceState !== "idle",
  });
  const awaitingInstruction = Boolean(editingPending && !editingPending.content.trim() && !editingPending.quote_excerpt);
  const hasUnsentDraft = !editingPending && Boolean(hasText || askAgentQuote || draftFiles.length || draftUploads.length);
  const draftStatusLabel = draftUploads.length > 0 ? "正在上传附件…"
    : draftSaveState === "saving" ? "正在保存草稿…"
    : draftSaveState === "unsaved" ? "草稿将在停止输入后自动保存"
    : draftSaveState === "error" ? "草稿暂未保存，将在继续编辑时重试"
    : draftSaveState === "saved" || draftFiles.length > 0 ? "草稿已保存到服务器"
    : "";
  return <div className="composer-wrap">
    {pendingPrompts.length > 0 && <PendingQueue prompts={pendingPrompts} busy={submitting} canSteer={canSteer}
      onReorder={onReorderPending} onEdit={onEditPending} onDelete={onDeletePending} onSteer={onSteerPending} />}
    {editingPending && <div className={`editing-pending-banner ${awaitingInstruction ? "awaiting-instruction" : ""}`}><span>{awaitingInstruction ? <Paperclip size={13} /> : <Pencil size={13} />}{awaitingInstruction ? `已上传 ${editingPending.files.length} 个文件，请输入具体操作` : "正在编辑待发送任务"}</span><button type="button" onClick={onCancelPendingEdit} disabled={submitting}><X size={14} />{awaitingInstruction ? "清除文件" : "取消编辑"}</button></div>}
    <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
    <div
      className="composer-resize-handle"
      aria-hidden="true"
      title="拖动调整输入框高度"
      onPointerDown={(event) => {
        const textarea = textareaRef.current;
        beginComposerResize(
          event,
          textarea?.getBoundingClientRect().height ?? COMPOSER_TEXT_HEIGHT_MIN,
          COMPOSER_TEXT_HEIGHT_MIN,
          composerTextMaxHeight(),
          setComposerTextHeight,
        );
      }}
    />
    {sourceReference && <div className="derived-task-reference">
      <div className="derived-task-reference-copy">
        <CornerUpLeft size={15} />
        <span className="derived-task-reference-quote" title={sourceReference.excerpt}>{sourceReference.excerpt}</span>
        <button type="button" className="derived-task-source-link" onClick={() => onOpenSourceReference(sourceReference)}>来源：{sourceReference.sourceConversationTitle}</button>
      </div>
      <button type="button" className="derived-task-reference-remove" onClick={onClearSourceReference} aria-label="移除引用" title="移除引用"><X size={14} /></button>
    </div>}
    {!sourceReference && askAgentQuote && <div className="ask-agent-reference" title={askAgentQuote}><CornerUpLeft size={15} /><span>{askAgentQuote}</span><button type="button" onClick={onClearAskAgentQuote} aria-label="移除引用" title="移除引用"><X size={14} /></button></div>}
    {editingPending && editingPending.files.length > 0 && <div className="editing-pending-files">{editingPending.files.map((file) => {
      const removed = removedEditingFileIds.includes(file.id);
      return <span key={file.id} className={removed ? "removed" : ""}><FileIcon size={14} /><span className="pending-file-name">{file.original_name}</span><button type="button" onClick={() => removed ? onRestoreEditingFile(file.id) : onRemoveEditingFile(file.id)} title={removed ? "恢复附件" : "移除附件"}>{removed ? <Plus size={13} /> : <X size={13} />}</button></span>;
    })}</div>}
    {!editingPending && draftFiles.length > 0 && <div className="pending-files">{draftFiles.map((file) => <span key={file.id}><FileIcon size={14} /><span className="pending-file-name">{file.original_name}</span><button type="button" aria-label={`移除附件 ${file.original_name}`} title="移除附件" onClick={() => onRemoveDraftFile(file)}><X size={13} /></button></span>)}</div>}
    {!editingPending && draftUploads.length > 0 && <div className="pending-files">{draftUploads.map((file) => <span key={file.id} className="uploading"><LoaderCircle className="spin" size={14} /><span className="pending-file-name">{file.name}</span></span>)}</div>}
    {files.length > 0 && <div className="pending-files">{files.map((file, index) => <span key={`${file.name}-${index}`}><FileIcon size={14} /><span className="pending-file-name">{file.name}</span><button onClick={() => setFiles(files.filter((_, i) => i !== index))}><X size={13} /></button></span>)}</div>}
    {pasteNotice && <div className="paste-notice" role="status" aria-live="polite"><Check size={14} />{pasteNotice}</div>}
    {voiceError && <div className="voice-error" role="alert"><span>{voiceError}</span><button type="button" onClick={() => setVoiceError("")}><X size={13} /></button></div>}
    <textarea ref={textareaRef} defaultValue={input} onChange={(e) => handleTextChange(e.target.value)} onKeyDown={keyDown} onPaste={pasted} placeholder={voiceState === "recording" ? "可以继续输入文字；点击发送会先转写语音…" : awaitingInstruction ? "请输入要如何处理刚才上传的文件…" : editingPending ? "修改这条待发送任务…" : sourceReference ? "请输入要基于引用执行的具体指令…" : askAgentQuote ? "输入你想询问的问题…" : sending ? "继续输入，新任务会先进入待发送队列…" : "给 Agent 发送任务，或粘贴、拖入文件…"} rows={1} disabled={submitting || voiceState === "transcribing"} style={composerTextHeight === null ? undefined : { height: `${composerTextHeight}px`, maxHeight: "min(560px, 55vh)" }} />
    {voiceState !== "idle" && <div className={`voice-panel ${voiceState}`}>
      {voiceState === "recording" ? <><button type="button" className="voice-cancel" onClick={cancelRecording} title="取消录音"><X size={15} /></button><canvas ref={waveformRef} aria-label="实时音量波形" /><time>{formatVoiceDuration(voiceElapsed)}</time><button type="button" className="voice-stop" onClick={() => finishRecording(false)} title="停止并转成文字"><Square size={12} fill="currentColor" /></button></> : <><LoaderCircle className="spin" size={17} /><span>正在识别语音…</span></>}
    </div>}
    <div className="composer-actions"><div className="composer-primary-actions"><button className="attach-button" onClick={() => fileInput.current?.click()} disabled={submitting}><Paperclip size={17} /><span>添加文件</span></button><input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ""; }} />
      {hostFilesAvailable && <button type="button" className="attach-button host-attach" onClick={onBrowseHostFiles} disabled={submitting || !conversationId || Boolean(editingPending)} title="从服务器文件系统选择文件"><FolderOpen size={16} /><span>服务器文件</span></button>}
      <PresetMenu conversationId={conversationId} presetPrompts={presetPrompts} enabledPresetPromptIds={enabledPresetPromptIds} disabled={submitting || selectionSaving || !conversationId} saving={presetSaving} onToggle={onTogglePresetPrompt} onOpenManager={onOpenPresetManager} />
      <ProviderModelMenu agentOptions={agentOptions} selectedModel={selectedModel} disabled={submitting || selectionSaving || !agentOptions} onChange={onModelChange} />
      <SettingMenu className="effort" label="思考" value={reasoningEffort} options={effortOptions} placeholder="加载中" title="选择模型的思考深度" disabled={submitting || selectionSaving || effortOptions.length === 0} onChange={(value) => onReasoningChange(value as ReasoningEffort)} />
      {sandboxOptions.length > 1 && <SettingMenu className={`permission ${sandboxMode === "danger-full-access" ? "danger-selected" : ""}`} label="权限" value={sandboxMode} options={sandboxOptions} placeholder="工作区写入" title="选择 Codex 的运行权限；完全访问会跳过沙箱" disabled={submitting || selectionSaving} onChange={(value) => onSandboxChange(value as SandboxMode)} />}
    </div>
      <div className="composer-submit-actions">
        {voiceEnabled && voiceState === "idle" && <button type="button" className="mic-button" onClick={() => void startRecording()} disabled={submitting || selectionSaving} title="录音输入" aria-label="录音输入"><Mic size={18} /></button>}
        {primaryAction === "stop" && onCancel
          ? <button type="button" className="send-button stop" onClick={onCancel} title="停止当前显示的任务" aria-label="停止当前显示的任务"><Square size={15} fill="currentColor" /></button>
          : <button type="button" className="send-button" onClick={() => voiceState === "recording" ? finishRecording(true) : onSend(inputRef.current)} disabled={submitting || selectionSaving || draftUploads.length > 0 || voiceState === "transcribing" || (voiceState !== "recording" && !hasText && !askAgentQuote && files.length === 0 && draftFiles.length === 0 && !hasRetainedEditingFile)} title={voiceState === "recording" ? "识别语音并发送" : "发送"} aria-label={voiceState === "recording" ? "识别语音并发送" : "发送"}>{submitting || voiceState === "transcribing" ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}</button>}
      </div>
    </div>
  </div><p className="composer-note"><span>{draftStatusLabel || "任务运行中，新内容会先进入待发送队列；也可选择“引导”立即调整当前任务。"}</span>{hasUnsentDraft && conversationId && <button type="button" onClick={onClearDraft} disabled={submitting || draftUploads.length > 0}>清空草稿</button>}</p></div>;
}

function PresetMenu({ conversationId, presetPrompts, enabledPresetPromptIds, disabled, saving, onToggle, onOpenManager }: {
  conversationId: string | null;
  presetPrompts: PresetPrompt[];
  enabledPresetPromptIds: string[];
  disabled: boolean;
  saving: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onOpenManager: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const enabledPresets = presetPrompts.filter((preset) => enabledPresetPromptIds.includes(preset.id));
  const presetValue = presetPrompts.length === 0
    ? "未添加"
    : enabledPresets.length === 0
      ? `0/${presetPrompts.length}`
      : enabledPresets.length === 1
        ? enabledPresets[0].name
        : `${enabledPresets[0].name} +${enabledPresets.length - 1}`;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", closeFromOutside);
    return () => window.removeEventListener("pointerdown", closeFromOutside);
  }, [open]);

  return <div ref={rootRef} className="preset-menu">
    <button type="button" className="setting-select preset-select" aria-label="预设 Prompt" aria-haspopup="true" aria-expanded={open} disabled={disabled} title="选择随任务附加的预设 Prompt" onClick={() => setOpen((current) => !current)}>
      <ListChecks size={14} /><span>预设</span><strong className="setting-value" title={presetValue}>{presetValue}</strong><ChevronDown size={13} />
    </button>
    {open && <div className="preset-menu-panel" role="group" aria-label="预设 Prompt">
      {presetPrompts.length === 0
        ? <div className="preset-menu-empty">还没有预设 Prompt，先点击“管理预设”创建。</div>
        : presetPrompts.map((preset) => (
          <label key={preset.id} className={`preset-menu-item ${enabledPresetPromptIds.includes(preset.id) ? "enabled" : ""}`}>
            <input type="checkbox" checked={enabledPresetPromptIds.includes(preset.id)} disabled={disabled || saving} onChange={(event) => onToggle(preset.id, event.currentTarget.checked)} />
            <span className="preset-menu-copy"><strong>{preset.name}</strong><small title={preset.content}>{preset.content.length > 90 ? `${preset.content.slice(0, 90)}…` : preset.content}</small></span>
          </label>
        ))}
      <button type="button" className="preset-menu-manage" onClick={() => { setOpen(false); onOpenManager(); }}><Settings2 size={13} />管理预设</button>
    </div>}
  </div>;
}

function ProviderModelMenu({ agentOptions, selectedModel, disabled, onChange }: {
  agentOptions: AgentOptions | null;
  selectedModel: string;
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [openProviderId, setOpenProviderId] = useState<string | null>(null);
  const models = agentOptions?.models ?? [];
  const providers = agentOptions?.providers ?? [];
  const selected = models.find((model) => model.id === selectedModel);
  const menuId = "setting-menu-model";
  const providerGroups = providers.map((provider) => ({
    ...provider,
    models: models.filter((model) => model.provider === provider.id),
  }));
  const unassignedModels = models.filter((model) => !model.provider || !providers.some((provider) => provider.id === model.provider));
  if (unassignedModels.length > 0) providerGroups.push({ id: "__unassigned__", name: "其他模型", models: unassignedModels });
  const menuDisabled = disabled || models.length === 0;

  useEffect(() => {
    if (disabled || models.length === 0) setOpen(false);
  }, [disabled, models.length]);
  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", closeFromOutside);
    return () => window.removeEventListener("pointerdown", closeFromOutside);
  }, [open]);

  function choose(model: AgentModelOption) {
    if (model.id !== selectedModel) onChange(model.id);
    setOpen(false);
    setOpenProviderId(null);
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (menuDisabled) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen((current) => !current);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setOpenProviderId(null);
    }
  }

  if (!agentOptions || providers.length === 0) {
    const options = models.map((model) => ({
      id: model.id,
      label: model.providerName ? `${model.providerName} · ${model.label}` : model.label,
      description: model.description,
    }));
    return <SettingMenu className="model" label="模型" value={selectedModel} options={options} placeholder="加载中" title={selected?.description || "选择任务使用的模型"} disabled={menuDisabled} onChange={onChange} />;
  }

  return <div ref={rootRef} className="setting-menu model provider-model-menu">
    <button type="button" className="setting-select" aria-label="模型" aria-haspopup="true" aria-expanded={open} aria-controls={menuId} disabled={menuDisabled} title={selected?.description || "选择任务使用的模型"} onClick={() => setOpen((current) => !current)} onKeyDown={keyDown}>
      <span>模型</span><strong className="setting-value">{selected ? `${selected.providerName || ""}${selected.providerName ? " · " : ""}${selected.label}` : "加载中"}</strong><ChevronDown size={13} />
    </button>
    {open && <div id={menuId} className="setting-menu-panel provider-model-panel" role="menu" aria-label="API 源和模型">
      {providerGroups.map((provider) => <div key={provider.id} className={`model-provider-group ${openProviderId === provider.id ? "open" : ""}`} onMouseEnter={() => setOpenProviderId(provider.id)}>
        <button type="button" className="model-provider-trigger" aria-haspopup="true" aria-expanded={openProviderId === provider.id} onFocus={() => setOpenProviderId(provider.id)} onClick={() => setOpenProviderId((current) => current === provider.id ? null : provider.id)}>
          <span><strong>{provider.name}</strong><small>{provider.models.length > 0 ? `${provider.models.length} 个模型` : "暂无可用模型"}</small></span><ChevronRight size={14} />
        </button>
        <div className="model-provider-submenu" role="listbox" aria-label={`${provider.name} 模型`}>
          {provider.models.length > 0
            ? provider.models.map((model) => <button key={model.id} type="button" role="option" aria-selected={model.id === selectedModel} className={model.id === selectedModel ? "selected" : ""} onClick={() => choose(model)}>
              <span><strong>{model.label}</strong><small title={model.description}>{model.description}</small></span>{model.id === selectedModel && <Check size={14} />}
            </button>)
            : <div className="model-provider-empty">该源暂无可见模型</div>}
        </div>
      </div>)}
    </div>}
  </div>;
}

type SettingMenuOption = { id: string; label: string; description?: string };

function SettingMenu({ className, label, value, options, placeholder, title, disabled, onChange, direction = "up" }: {
  className: string;
  label: string;
  value: string;
  options: SettingMenuOption[];
  placeholder: string;
  title: string;
  disabled: boolean;
  onChange: (value: string) => void;
  direction?: "up" | "down";
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options.find((option) => option.id === value);
  const menuId = `setting-menu-${className}`;

  useEffect(() => {
    if (disabled || options.length === 0) setOpen(false);
  }, [disabled, options.length]);
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);
  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", closeFromOutside);
    return () => window.removeEventListener("pointerdown", closeFromOutside);
  }, [open]);

  function choose(option: SettingMenuOption) {
    if (option.id !== value) onChange(option.id);
    setOpen(false);
  }

  function moveActive(step: number) {
    setActiveIndex((current) => (current + step + options.length) % options.length);
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled || options.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      else moveActive(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open && options[activeIndex]) choose(options[activeIndex]);
      else setOpen(true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  return <div ref={rootRef} className={`setting-menu ${className}`}>
    <button type="button" className="setting-select" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId} disabled={disabled} title={title} onClick={() => setOpen((current) => !current)} onKeyDown={keyDown}>
      <span>{label}</span><strong className="setting-value">{(selected?.label ?? value) || placeholder}</strong><ChevronDown size={13} />
    </button>
    {open && <div id={menuId} className={`setting-menu-panel ${direction === "down" ? "open-down" : ""}`} role="listbox" aria-label={label}>
      {options.map((option, index) => <button key={option.id} type="button" role="option" aria-selected={option.id === value} className={`${option.id === value ? "selected" : ""} ${index === activeIndex ? "active" : ""}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(option)}>
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.id === value && <Check size={14} />}
      </button>)}
    </div>}
  </div>;
}

function clipboardTimestamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

function normalizeClipboardFile(file: File, timestamp: string, index: number): File {
  const genericName = !file.name || /^(image|blob|clipboard)(\.[a-z0-9]+)?$/i.test(file.name);
  if (!genericName) return file;
  const extensionByType: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
    "application/pdf": "pdf", "text/plain": "txt",
  };
  const extension = extensionByType[file.type] ?? file.name.split(".").pop()?.toLowerCase() ?? "bin";
  const prefix = file.type.startsWith("image/") ? "clipboard-image" : "clipboard-file";
  return new File([file], `${prefix}-${timestamp}-${index + 1}.${extension}`, { type: file.type, lastModified: Date.now() });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatVoiceDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
