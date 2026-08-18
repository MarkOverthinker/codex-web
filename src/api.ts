import type { TaskListCategorySettings } from "./task-categories.js";
import type { MessageSourceReference } from "./message-source.js";

export type { MessageSourceReference } from "./message-source.js";

export const BASE_PATH = "/codex-web";

export type Session = { authenticated: boolean; username?: string; displayName?: string; csrfToken?: string; chatFontSize?: number; chatColumnWidth?: number; voiceEnabled?: boolean; canChangeUsername?: boolean };
export type Conversation = {
  id: string; title: string; title_source: "default" | "ai" | "manual" | "legacy"; status: "idle" | "running"; has_unread_result: number; has_pending_work: number; rollout_bytes: number | null; archived_at: string | null; created_at: string; updated_at: string;
  working_dir: string | null;
};
export type WorkingDirFavorite = { path: string; label: string; added_at: string };
export type WorkingDirSettings = { enabled: boolean; favorites: WorkingDirFavorite[]; defaultWorkingDir: string | null };
export type ReloadStatus = {
  available: boolean;
  state?: string;
  busy?: boolean;
  lastResult?: {
    command?: string;
    ok?: boolean;
    finishedAt?: string;
    idle?: boolean;
    running?: number;
    error?: string;
  };
};
export type WorkFile = {
  id: string; original_name: string; relative_path: string; host_path?: string; mime_type: string; size: number; kind: "upload" | "output";
};
export type Message = {
  id: string; role: "user" | "assistant" | "system"; content: string; quote_excerpt: string | null; source_reference: MessageSourceReference | null; created_at: string; files: WorkFile[];
};
export type PendingPrompt = {
  id: string;
  conversation_id: string;
  content: string;
  quote_excerpt: string | null;
  agent_model: string;
  reasoning_effort: string;
  position: number;
  status: "queued" | "editing";
  files: WorkFile[];
  created_at: string;
  updated_at: string;
};
export type ComposerDraft = {
  conversation_id: string;
  content: string;
  quote_excerpt: string | null;
  source_reference: MessageSourceReference | null;
  files: WorkFile[];
  created_at: string;
  updated_at: string;
};
export type Job = { id: string; status: string; conversation_id: string; queuePosition?: number; startedAt?: string | null };
// The online Codex catalog is authoritative. Keep this open so a newer CLI can
// expose a new reasoning level without requiring a front-end release first.
export type ReasoningEffort = string;
export type AgentModelOption = {
  id: string;
  label: string;
  description: string;
  reasoningEfforts: ReasoningEffort[];
  provider?: string;
  providerName?: string;
  upstreamModel?: string;
  displayName?: string;
};
export type AgentOptions = {
  models: AgentModelOption[];
  reasoningEfforts: Array<{ id: ReasoningEffort; label: string }>;
  defaults: { model: string; reasoningEffort: ReasoningEffort; provider?: string | null };
  selection: AgentSelection;
  codexConfigured?: boolean;
  codexConfigHint?: string;
};
export type AgentSelection = { model: string; reasoningEffort: ReasoningEffort; provider?: string | null };
export type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  modelsFile: string | null;
  wireApi: "responses" | "chat" | "anthropic";
  requiresOpenaiAuth: boolean;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyHint: string;
  extraConfig: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
export type ProviderModel = {
  id: string;
  providerId: string;
  modelId: string;
  slug: string;
  displayName: string;
  description: string;
  reasoningEfforts: string[];
  inputModalities: string[];
  priority: number;
  visible: boolean;
  createdAt: string;
  updatedAt: string;
};
export type ProviderState = { providers: Provider[]; models: ProviderModel[] };
export type PresetPrompt = {
  id: string;
  name: string;
  content: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};
export type ReasoningStep = {
  id?: string;
  title?: string;
  detail?: string;
  summary?: string;
};
export type JobEvent = {
  seq?: number;
  type?: string;
  created_at?: string;
  kind?: "status" | "reasoning" | "update" | "command" | "file" | "search" | "tool" | "todo" | "error" | string;
  label?: string;
  detail?: string;
  files?: string[];
  items?: Array<{ text: string; completed: boolean }>;
  status?: string;
  queuePosition?: number;
  jobsAhead?: number;
  message?: string;
  steps?: ReasoningStep[];
  reviewId?: string;
  reviewStatus?: string;
  riskLevel?: string;
  userAuthorization?: string;
};
export type ConversationDetail = {
  conversation: Conversation;
  agentSelection: AgentSelection;
  messages: Message[];
  outputFiles: WorkFile[];
  messagePage: MessagePage;
  pendingPrompts: PendingPrompt[];
  editingPrompt: PendingPrompt | null;
  composerDraft: ComposerDraft | null;
  enabledPresetPromptIds: string[];
  activeJob: Job | null;
  latestJob: Job | null;
  jobEvents: JobEvent[];
  rolloutBytes: number | null;
};
export type MessagePage = { hasMore: boolean; nextCursor: string | null };
export type ConversationMessagesPage = { messages: Message[]; messagePage: MessagePage };
export type CodeSnippetWindow = {
  path: string;
  originalName: string;
  totalLines: number;
  start: number;
  end: number;
  line: number;
  lines: string[];
};
export type ImportableSession = {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  fileSize: number;
  cwd: string | null;
  originator: string | null;
  model: string | null;
};
export type PendingMutationResponse = {
  job?: Job;
  pendingPrompt?: PendingPrompt | null;
  editingPrompt?: PendingPrompt | null;
  activeJob?: Job | null;
  queued?: boolean;
  needsInstruction?: boolean;
  guidance?: string;
};

export class ApiError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

let csrfToken = "";
export function setCsrf(value?: string) { csrfToken = value ?? ""; }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase()) && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(`${BASE_PATH}/api${path}`, { ...init, headers, credentials: "same-origin" });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error || `请求失败 (${response.status})`, body.code);
  return body as T;
}

export const api = {
  session: () => request<Session>("/auth/session"),
  login: (username: string, password: string) => request<Session>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  updateAccount: (payload: { currentPassword: string; newUsername?: string; newPassword?: string }) =>
    request<Session>("/auth/account", { method: "PUT", body: JSON.stringify(payload) }),
  conversations: () => request<{ conversations: Conversation[] }>("/conversations"),
  archivedConversations: (query = "") => request<{ conversations: Conversation[] }>(`/conversations/archived${query ? `?query=${encodeURIComponent(query)}` : ""}`),
  importableSessions: () => request<{ sessions: ImportableSession[] }>("/conversations/importable-sessions"),
  importSessions: (threadIds: string[]) => request<{ conversations: Conversation[]; skipped: string[] }>(
    "/conversations/import-sessions",
    { method: "POST", body: JSON.stringify({ threadIds }) },
  ),
  agentOptions: () => request<AgentOptions>("/agent-options"),
  updateAgentSelection: (selection: AgentSelection, conversationId?: string) => request<{ selection: AgentSelection }>(
    conversationId ? `/conversations/${conversationId}/agent-selection` : "/agent-selection",
    { method: "PUT", body: JSON.stringify(selection) },
  ),
  providers: () => request<ProviderState>("/providers"),
  createProvider: (payload: { name: string; baseUrl: string; apiKey?: string; modelsFile?: string; wireApi?: Provider["wireApi"]; requiresOpenaiAuth?: boolean; enabled?: boolean }) =>
    request<{ provider: Provider }>("/providers", { method: "POST", body: JSON.stringify(payload) }),
  updateProvider: (id: string, payload: Partial<Omit<Provider, "id" | "createdAt" | "updatedAt" | "hasApiKey" | "apiKeyHint" | "extraConfig">> & { apiKey?: string | null }) =>
    request<{ provider: Provider }>(`/providers/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteProvider: (id: string) => request<void>(`/providers/${id}`, { method: "DELETE" }),
  importProviderConfig: () => request<ProviderState>("/providers/import-config", { method: "POST" }),
  importProviderModels: (providerId: string) => request<{ models: ProviderModel[] }>(
    `/providers/${providerId}/import-models`, { method: "POST" },
  ),
  createProviderModel: (providerId: string, payload: { modelId: string; displayName?: string; description?: string; reasoningEfforts?: string[]; inputModalities?: string[]; priority?: number; visible?: boolean }) =>
    request<{ models: ProviderModel[] }>(`/providers/${providerId}/models`, { method: "POST", body: JSON.stringify(payload) }),
  updateProviderModel: (providerId: string, modelId: string, payload: Partial<Omit<ProviderModel, "id" | "providerId" | "slug" | "createdAt" | "updatedAt">>) =>
    request<{ models: ProviderModel[] }>(`/providers/${providerId}/models/${modelId}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteProviderModel: (providerId: string, modelId: string) => request<void>(
    `/providers/${providerId}/models/${modelId}`, { method: "DELETE" },
  ),
  presetPrompts: () => request<{ presetPrompts: PresetPrompt[] }>("/preset-prompts"),
  createPresetPrompt: (name: string, content: string) =>
    request<{ presetPrompt: PresetPrompt }>("/preset-prompts", { method: "POST", body: JSON.stringify({ name, content }) }),
  updatePresetPrompt: (id: string, payload: { name?: string; content?: string; position?: number }) =>
    request<{ presetPrompt: PresetPrompt }>(`/preset-prompts/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  deletePresetPrompt: (id: string) => request<void>(`/preset-prompts/${id}`, { method: "DELETE" }),
  setConversationPresetPrompts: (conversationId: string, presetPromptIds: string[]) =>
    request<{ enabledPresetPromptIds: string[] }>(
      `/conversations/${conversationId}/preset-prompts`,
      { method: "PUT", body: JSON.stringify({ presetPromptIds }) },
    ),
  updateChatFontSize: (chatFontSize: number) => request<{ chatFontSize: number }>("/user-settings/chat-font-size", {
    method: "PUT", body: JSON.stringify({ chatFontSize }),
  }),
  updateChatColumnWidth: (chatColumnWidth: number) => request<{ chatColumnWidth: number }>("/user-settings/chat-column-width", {
    method: "PUT", body: JSON.stringify({ chatColumnWidth }),
  }),
  workingDirs: () => request<{ settings: WorkingDirSettings }>("/working-dirs"),
  reloadStatus: () => request<ReloadStatus>("/reload-status"),
  updateFavoriteWorkingDir: (payload: { action: "add" | "remove" | "rename" | "move"; path?: string; label?: string; direction?: "up" | "down" }) =>
    request<{ settings: WorkingDirSettings }>("/working-dirs/favorites", { method: "PUT", body: JSON.stringify(payload) }),
  setDefaultWorkingDir: (path: string | null) =>
    request<{ settings: WorkingDirSettings }>("/working-dirs/default", { method: "PUT", body: JSON.stringify({ path }) }),
  taskCategories: () => request<{ settings: TaskListCategorySettings }>("/task-categories"),
  createTaskCategory: (name: string) =>
    request<{ settings: TaskListCategorySettings }>("/task-categories/custom", { method: "POST", body: JSON.stringify({ name }) }),
  renameTaskCategory: (id: string, name: string) =>
    request<{ settings: TaskListCategorySettings }>(`/task-categories/custom/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteTaskCategory: (id: string) =>
    request<{ settings: TaskListCategorySettings }>(`/task-categories/custom/${id}`, { method: "DELETE" }),
  assignTaskCategoryDir: (dir: string, categoryId: string | null) =>
    request<{ settings: TaskListCategorySettings }>("/task-categories/dirs", { method: "PUT", body: JSON.stringify({ dir, categoryId }) }),
  updateTaskCategoryPins: (keys: string[]) =>
    request<{ settings: TaskListCategorySettings }>("/task-categories/pins", { method: "PUT", body: JSON.stringify({ keys }) }),
  updateTaskCategoryHidden: (keys: string[]) =>
    request<{ settings: TaskListCategorySettings }>("/task-categories/hidden", { method: "PUT", body: JSON.stringify({ keys }) }),
  createConversation: (workingDir?: string | null) =>
    request<{ conversation: Conversation; agentSelection: AgentSelection }>("/conversations", { method: "POST", body: JSON.stringify({ workingDir }) }),
  createConversationFromSource: (sourceConversationId: string, sourceMessageId: string, excerpt: string) =>
    request<{ conversation: Conversation; agentSelection: AgentSelection; composerDraft: ComposerDraft }>(
      "/conversations/from-source",
      { method: "POST", body: JSON.stringify({ sourceConversationId, sourceMessageId, excerpt }) },
    ),
  updateConversationWorkingDir: (id: string, workingDir: string | null, confirm = false) =>
    request<{ conversation: Conversation }>(`/conversations/${id}/working-dir`, { method: "PUT", body: JSON.stringify({ workingDir, confirm }) }),
  conversation: (id: string) => request<ConversationDetail>(`/conversations/${id}`),
  conversationMessages: (id: string, before: string) => request<ConversationMessagesPage>(
    `/conversations/${id}/messages?before=${encodeURIComponent(before)}`,
  ),
  codeSnippet: (conversationId: string, params: { path: string; line: number; before?: number; after?: number }, signal?: AbortSignal) => request<CodeSnippetWindow>(
    `/conversations/${conversationId}/code-snippet?path=${encodeURIComponent(params.path)}&line=${params.line}${params.before ? `&before=${params.before}` : ""}${params.after ? `&after=${params.after}` : ""}`,
    { signal },
  ),
  createFileShare: (id: string) => request<{ url: string; expiresAt: string }>(`/files/${id}/share`, { method: "POST" }),
  renameConversation: (id: string, title: string) => request<{ conversation: Conversation }>(`/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  markConversationSeen: (id: string) => request<{ conversation: Conversation }>(`/conversations/${id}/seen`, { method: "POST" }),
  deleteConversation: (id: string) => request<void>(`/conversations/${id}`, { method: "DELETE" }),
  archiveConversation: (id: string) => request<{ conversation: Conversation }>(`/conversations/${id}/archive`, { method: "POST" }),
  restoreConversation: (id: string) => request<{ conversation: Conversation }>(`/conversations/${id}/restore`, { method: "POST" }),
  cancelConversation: (id: string) => request<{ ok: true }>(`/conversations/${id}/cancel`, { method: "POST" }),
  saveConversationDraft: (id: string, content: string, quoteExcerpt = "", sourceReference: MessageSourceReference | null = null, keepalive = false) => request<{ composerDraft: ComposerDraft | null }>(
    `/conversations/${id}/draft`,
    { method: "PUT", body: JSON.stringify({ content, quoteExcerpt, sourceReference }), keepalive },
  ),
  uploadConversationDraftFiles: (id: string, files: File[]) => {
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    return request<{ composerDraft: ComposerDraft }>(`/conversations/${id}/draft/files`, { method: "POST", body });
  },
  deleteConversationDraftFile: (id: string, fileId: string) => request<{ composerDraft: ComposerDraft | null }>(
    `/conversations/${id}/draft/files/${fileId}`, { method: "DELETE" },
  ),
  deleteConversationDraft: (id: string) => request<void>(`/conversations/${id}/draft`, { method: "DELETE" }),
  sendMessage: (id: string, message: string, files: File[], quoteExcerpt = "", useComposerDraft = false) => {
    const body = new FormData();
    body.set("message", message);
    body.set("quoteExcerpt", quoteExcerpt);
    if (useComposerDraft) body.set("useComposerDraft", "true");
    files.forEach((file) => body.append("files", file));
    return request<PendingMutationResponse>(`/conversations/${id}/messages`, { method: "POST", body });
  },
  transcribeAudio: (audio: Blob, fileName: string, context: { conversationId?: string; draftText?: string; attachmentNames?: string[] } = {}) => {
    const body = new FormData();
    body.set("audio", audio, fileName);
    body.set("conversationId", context.conversationId ?? "");
    body.set("draftText", context.draftText ?? "");
    body.set("attachmentNames", JSON.stringify(context.attachmentNames ?? []));
    return request<{ text: string }>("/transcriptions", { method: "POST", body });
  },
  reorderPendingPrompts: (conversationId: string, ids: string[]) => request<{ pendingPrompts: PendingPrompt[] }>(
    `/conversations/${conversationId}/pending-prompts/order`,
    { method: "PUT", body: JSON.stringify({ ids }) },
  ),
  editPendingPrompt: (conversationId: string, promptId: string) => request<{ editingPrompt: PendingPrompt }>(
    `/conversations/${conversationId}/pending-prompts/${promptId}/edit`, { method: "POST" },
  ),
  restorePendingPrompt: (conversationId: string, promptId: string) => request<{ pendingPrompt: PendingPrompt | null; activeJob: Job | null }>(
    `/conversations/${conversationId}/pending-prompts/${promptId}/restore`, { method: "POST" },
  ),
  updatePendingPrompt: (conversationId: string, promptId: string, message: string, files: File[], removedFileIds: string[], quoteExcerpt = "") => {
    const body = new FormData();
    body.set("message", message);
    body.set("quoteExcerpt", quoteExcerpt);
    body.set("removedFileIds", JSON.stringify(removedFileIds));
    files.forEach((file) => body.append("files", file));
    return request<PendingMutationResponse>(
      `/conversations/${conversationId}/pending-prompts/${promptId}`, { method: "PUT", body },
    );
  },
  deletePendingPrompt: (conversationId: string, promptId: string) => request<void>(
    `/conversations/${conversationId}/pending-prompts/${promptId}`, { method: "DELETE" },
  ),
  steerPendingPrompt: (conversationId: string, promptId: string) => request<{ ok: true; turnId: string }>(
    `/conversations/${conversationId}/pending-prompts/${promptId}/steer`, { method: "POST" },
  ),
  cancelJob: (id: string) => request<{ ok: true }>(`/jobs/${id}/cancel`, { method: "POST" }),
  reportClientError: (report: { message: string; stack?: string; componentStack?: string; source: string; href: string }) =>
    request<{ ok: true }>("/client-errors", { method: "POST", body: JSON.stringify(report) }),
};

export function fileUrl(file: WorkFile, download = false): string {
  return `${BASE_PATH}/api/files/${file.id}${download ? "?download=1" : ""}`;
}
