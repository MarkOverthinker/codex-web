import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHAT_FONT_SIZE_DEFAULT, normalizeChatFontSize } from "../src/chat-font-size.js";
import { CHAT_COLUMN_WIDTH_DEFAULT, normalizeChatColumnWidth } from "../src/chat-column-width.js";
import type { MessageSourceReference } from "../src/message-source.js";
import { type TaskListCategorySettings, type TaskListCustomCategory } from "../src/task-categories.js";
import { isDeliverablePath, normalizeStoredRelativePath, normalizeUploadFileName } from "./paths.js";

export const LEGACY_USER_ID = "00000000-0000-4000-8000-000000000001";
export const DEFAULT_MODEL_CONTEXT_WINDOW = 512_000;
export const DEFAULT_AUTO_COMPACT_TOKEN_LIMIT = 435_000;

export type UserRow = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: "owner" | "member";
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
};

export type ConversationRow = {
  id: string;
  user_id: string;
  title: string;
  title_source: ConversationTitleSource;
  codex_thread_id: string | null;
  fork_source_thread_id: string | null;
  fork_last_turn_id: string | null;
  fork_source_message_id: string | null;
  working_dir: string | null;
  agent_model: string | null;
  reasoning_effort: string | null;
  agent_provider: string | null;
  sandbox_mode: string | null;
  status: "idle" | "running";
  has_unread_result: number;
  has_pending_work: number;
  rollout_bytes: number | null;
  context_used_tokens: number | null;
  context_window: number | null;
  context_updated_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ConversationTitleSource = "default" | "ai" | "manual" | "legacy";

export type SideConversationRow = ConversationRow & {
  parent_conversation_id: string;
  parent_title: string;
  side_created_at: string;
  last_opened_at: string;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  quote_excerpt?: string | null;
  source_reference?: string | null;
  codex_turn_id?: string | null;
  superseded_at?: string | null;
  superseded_by?: string | null;
  created_at: string;
};

export type FileRow = {
  id: string;
  conversation_id: string;
  message_id: string | null;
  pending_prompt_id?: string | null;
  composer_draft_id?: string | null;
  original_name: string;
  relative_path: string;
  mime_type: string;
  size: number;
  kind: "upload" | "output";
  created_at: string;
};

export type MessagePage = {
  messages: Array<MessageRow & { files: FileRow[] }>;
  hasMore: boolean;
  nextCursor: string | null;
};

export type PendingPromptRow = {
  id: string;
  conversation_id: string;
  content: string;
  quote_excerpt: string | null;
  source_reference: string | null;
  agent_model: string;
  reasoning_effort: string;
  agent_provider: string | null;
  sandbox_mode: string;
  position: number;
  status: "queued" | "editing";
  created_at: string;
  updated_at: string;
};

export type PendingPromptWithFiles = PendingPromptRow & { files: FileRow[] };

export type ComposerDraftRow = {
  conversation_id: string;
  content: string;
  quote_excerpt: string | null;
  source_reference: string | null;
  created_at: string;
  updated_at: string;
};

export type ComposerDraftWithFiles = ComposerDraftRow & { files: FileRow[] };

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type JobRow = {
  id: string;
  conversation_id: string;
  message_id: string | null;
  agent_model: string | null;
  reasoning_effort: string | null;
  agent_provider: string | null;
  sandbox_mode: string | null;
  fork_before_turn_id: string | null;
  queue_seq: number;
  skip_queue: number;
  status: JobStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type SessionRow = {
  token_hash: string;
  csrf_token: string;
  expires_at: string;
  user_id: string;
  username: string;
  display_name: string;
  role: UserRow["role"];
};

export type JobEventRow = {
  seq: number;
  event_type: string;
  payload: string;
  created_at: string;
};

export type ApiUsageRow = {
  id: string;
  user_id: string;
  job_id: string;
  conversation_id: string;
  provider_id: string;
  model_id: string;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  created_at: string;
};

export type PricingRuleRow = {
  user_id: string;
  provider_id: string;
  model_id: string;
  input_per_million: number;
  cached_input_per_million: number;
  cache_write_per_million: number;
  output_per_million: number;
  currency: string;
  source: "manual" | "remote";
  pricing_url: string | null;
  peak_enabled: number;
  peak_input_per_million: number | null;
  peak_cached_input_per_million: number | null;
  peak_cache_write_per_million: number | null;
  peak_output_per_million: number | null;
  peak_start_minute: number | null;
  peak_end_minute: number | null;
  peak_weekdays: string;
  timezone: string;
  updated_at: string;
};

export type PricingRuleHistoryRow = Omit<PricingRuleRow, "updated_at"> & {
  id: number;
  effective_from: string;
  effective_to: string;
};

export type StoredAgentSelection = {
  model: string;
  reasoningEffort: string;
  provider?: string | null;
  sandbox?: "workspace-write" | "danger-full-access";
};

export type ProviderRow = {
  user_id: string;
  id: string;
  name: string;
  base_url: string;
  api_key: string | null;
  models_file: string | null;
  auto_review_model_override: string | null;
  extra_config: string | null;
  wire_api: "responses" | "chat" | "anthropic";
  requires_openai_auth: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type ProviderModelRow = {
  user_id: string;
  id: string;
  provider_id: string;
  model_id: string;
  slug: string;
  display_name: string;
  description: string;
  reasoning_efforts: string;
  input_modalities: string;
  model_context_window: number | null;
  auto_compact_token_limit: number | null;
  priority: number;
  visible: boolean;
  created_at: string;
  updated_at: string;
};

export type PresetPromptRow = {
  id: string;
  user_id: string;
  name: string;
  content: string;
  position: number;
  default_enabled: number;
  created_at: string;
  updated_at: string;
};

export type EnabledPresetPrompt = {
  id: string;
  name: string;
  content: string;
  position: number;
};

export type WorkingDirectoryFavorite = {
  path: string;
  label: string;
  added_at: string;
};

type LegacyUserSeed = { username: string; passwordHash: string; displayName?: string };

export const MAX_PRESET_PROMPTS_PER_USER = 100;
export const MAX_CONVERSATION_PRESET_PROMPTS = 20;
export const PRESET_PROMPT_NAME_MAX = 50;
export const PRESET_PROMPT_CONTENT_MAX = 10_000;
export const PRESET_PROMPT_TOTAL_MAX = 50_000;
const TASK_LIST_CATEGORY_ORDER_RESET_MIGRATION = "task_list_category_order_reset_v1";
const LEGACY_MODEL_CONTEXT_WINDOW = 272_000;
const LEGACY_AUTO_COMPACT_TOKEN_LIMIT = 250_000;

const conversationSelect = `
  conversations.*,
  CASE WHEN
    EXISTS (SELECT 1 FROM jobs WHERE jobs.conversation_id=conversations.id AND jobs.status='queued')
    OR EXISTS (SELECT 1 FROM pending_prompts WHERE pending_prompts.conversation_id=conversations.id AND pending_prompts.status='queued')
  THEN 1 ELSE 0 END AS has_pending_work
`;

export class AppDatabase {
  readonly sqlite: DatabaseSync;

  constructor(dataRoot: string, legacyUser: LegacyUserSeed = { username: "owner", passwordHash: "", displayName: "Owner" }, recoverJobs = true) {
    fs.mkdirSync(dataRoot, { recursive: true });
    this.sqlite = new DatabaseSync(path.join(dataRoot, "codex-web.sqlite"));
    this.sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate(legacyUser);
    if (recoverJobs) {
      // A running child process cannot survive an application restart. Queued work is
      // deliberately retained and the queue pump will resume it in FIFO order. Leave a
      // visible message and event so interrupted work cannot look silently completed.
      const interrupted = this.sqlite.prepare(`
        SELECT job.id,job.conversation_id,conversation.deleted_at
        FROM jobs job JOIN conversations conversation ON conversation.id=job.conversation_id
        WHERE job.status='running'
      `).all() as Array<{ id: string; conversation_id: string; deleted_at: string | null }>;
      const now = new Date().toISOString();
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const job of interrupted) {
          const error = "服务重启，原运行任务已中断";
          const event = this.sqlite.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM job_events WHERE job_id=?").get(job.id) as { seq: number };
          this.sqlite.prepare("UPDATE jobs SET status='interrupted',error=COALESCE(error,?),updated_at=? WHERE id=?").run(error, now, job.id);
          this.sqlite.prepare("INSERT INTO job_events(job_id,seq,event_type,payload,created_at) VALUES(?,?,?,?,?)")
            .run(job.id, event.seq, "failed", JSON.stringify({ status: "interrupted", message: error }), now);
          if (job.deleted_at) continue;
          this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,created_at) VALUES(?,?,'assistant',?,NULL,?)")
            .run(crypto.randomUUID(), job.conversation_id, "上一条任务因服务重启而中断，尚未执行完成。为避免重复产生副作用，系统没有自动重试；请重新发送该任务。", now);
          this.sqlite.prepare("UPDATE conversations SET status='idle',has_unread_result=1,updated_at=? WHERE id=?")
            .run(now, job.conversation_id);
        }
        this.sqlite.prepare("UPDATE conversations SET status='idle' WHERE status='running'").run();
        this.sqlite.exec("COMMIT");
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private migrate(legacyUser: LegacyUserSeed): void {
    this.sqlite.exec("DROP INDEX IF EXISTS jobs_queue_idx");
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        title TEXT NOT NULL,
        title_source TEXT NOT NULL DEFAULT 'legacy',
        codex_thread_id TEXT,
        fork_source_thread_id TEXT,
        fork_last_turn_id TEXT,
        fork_source_message_id TEXT,
        sandbox_mode TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        has_unread_result INTEGER NOT NULL DEFAULT 0,
        rollout_bytes INTEGER,
        context_used_tokens INTEGER,
        context_window INTEGER,
        context_updated_at TEXT,
        archived_at TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_side_chats (
        parent_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        quote_excerpt TEXT,
        source_reference TEXT,
        codex_turn_id TEXT,
        superseded_at TEXT,
        superseded_by TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_prompts (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        quote_excerpt TEXT,
        source_reference TEXT,
        agent_model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        sandbox_mode TEXT NOT NULL DEFAULT 'workspace-write',
        position INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS composer_drafts (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        quote_excerpt TEXT,
        source_reference TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        pending_prompt_id TEXT REFERENCES pending_prompts(id) ON DELETE CASCADE,
        composer_draft_id TEXT REFERENCES composer_drafts(conversation_id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        agent_model TEXT,
        reasoning_effort TEXT,
        sandbox_mode TEXT,
        fork_before_turn_id TEXT,
        skip_queue INTEGER NOT NULL DEFAULT 0,
        queue_seq INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_events (
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(job_id, seq)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, key)
      );
      CREATE TABLE IF NOT EXISTS preset_prompts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        default_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, id)
      );
      CREATE TABLE IF NOT EXISTS conversation_preset_prompts (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        preset_prompt_id TEXT NOT NULL REFERENCES preset_prompts(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY(conversation_id, preset_prompt_id)
      );
      CREATE TABLE IF NOT EXISTS providers (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT,
        models_file TEXT,
        auto_review_model_override TEXT,
        extra_config TEXT,
        wire_api TEXT NOT NULL DEFAULT 'responses',
        requires_openai_auth INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, id)
      );
      CREATE TABLE IF NOT EXISTS provider_models (
        user_id TEXT NOT NULL,
        id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        reasoning_efforts TEXT NOT NULL DEFAULT '[]',
        input_modalities TEXT NOT NULL DEFAULT '["text","image"]',
        model_context_window INTEGER,
        auto_compact_token_limit INTEGER,
        priority INTEGER NOT NULL DEFAULT 0,
        visible INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, id),
        FOREIGN KEY(user_id, provider_id) REFERENCES providers(user_id, id) ON DELETE CASCADE,
        UNIQUE(user_id, provider_id, model_id)
      );
      CREATE TABLE IF NOT EXISTS api_usage (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS api_usage_user_created_idx ON api_usage(user_id, created_at);
      CREATE TABLE IF NOT EXISTS pricing_rules (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        input_per_million REAL NOT NULL DEFAULT 0,
        cached_input_per_million REAL NOT NULL DEFAULT 0,
        cache_write_per_million REAL NOT NULL DEFAULT 0,
        output_per_million REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        source TEXT NOT NULL DEFAULT 'manual',
        pricing_url TEXT,
        peak_enabled INTEGER NOT NULL DEFAULT 0,
        peak_input_per_million REAL,
        peak_cached_input_per_million REAL,
        peak_cache_write_per_million REAL,
        peak_output_per_million REAL,
        peak_start_minute INTEGER,
        peak_end_minute INTEGER,
        peak_weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5',
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, provider_id, model_id)
      );
      CREATE TABLE IF NOT EXISTS pricing_rule_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        input_per_million REAL NOT NULL,
        cached_input_per_million REAL NOT NULL,
        cache_write_per_million REAL NOT NULL,
        output_per_million REAL NOT NULL,
        currency TEXT NOT NULL,
        source TEXT NOT NULL,
        pricing_url TEXT,
        peak_enabled INTEGER NOT NULL DEFAULT 0,
        peak_input_per_million REAL,
        peak_cached_input_per_million REAL,
        peak_cache_write_per_million REAL,
        peak_output_per_million REAL,
        peak_start_minute INTEGER,
        peak_end_minute INTEGER,
        peak_weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5',
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        effective_from TEXT NOT NULL,
        effective_to TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pricing_rule_history_lookup_idx ON pricing_rule_history(user_id, provider_id, model_id, effective_from, effective_to);
    `);

    const conversationColumns = this.columnNames("conversations");
    if (!conversationColumns.has("user_id")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN user_id TEXT REFERENCES users(id)");
    if (!conversationColumns.has("working_dir")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN working_dir TEXT");
    if (!conversationColumns.has("agent_model")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN agent_model TEXT");
    if (!conversationColumns.has("reasoning_effort")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN reasoning_effort TEXT");
    if (!conversationColumns.has("has_unread_result")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN has_unread_result INTEGER NOT NULL DEFAULT 0");
    if (!conversationColumns.has("rollout_bytes")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN rollout_bytes INTEGER");
    if (!conversationColumns.has("context_used_tokens")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN context_used_tokens INTEGER");
    if (!conversationColumns.has("context_window")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN context_window INTEGER");
    if (!conversationColumns.has("context_updated_at")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN context_updated_at TEXT");
    if (!conversationColumns.has("archived_at")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN archived_at TEXT");
    if (!conversationColumns.has("deleted_at")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN deleted_at TEXT");
    if (!conversationColumns.has("title_source")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'legacy'");
    if (!conversationColumns.has("fork_source_thread_id")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN fork_source_thread_id TEXT");
    if (!conversationColumns.has("fork_last_turn_id")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN fork_last_turn_id TEXT");
    if (!conversationColumns.has("fork_source_message_id")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN fork_source_message_id TEXT");
    const messageColumns = this.columnNames("messages");
    if (!messageColumns.has("quote_excerpt")) this.sqlite.exec("ALTER TABLE messages ADD COLUMN quote_excerpt TEXT");
    if (!messageColumns.has("source_reference")) this.sqlite.exec("ALTER TABLE messages ADD COLUMN source_reference TEXT");
    if (!messageColumns.has("codex_turn_id")) this.sqlite.exec("ALTER TABLE messages ADD COLUMN codex_turn_id TEXT");
    if (!messageColumns.has("superseded_at")) this.sqlite.exec("ALTER TABLE messages ADD COLUMN superseded_at TEXT");
    if (!messageColumns.has("superseded_by")) this.sqlite.exec("ALTER TABLE messages ADD COLUMN superseded_by TEXT");
    const composerDraftColumns = this.columnNames("composer_drafts");
    if (!composerDraftColumns.has("source_reference")) this.sqlite.exec("ALTER TABLE composer_drafts ADD COLUMN source_reference TEXT");
    const pendingPromptColumns = this.columnNames("pending_prompts");
    if (!pendingPromptColumns.has("quote_excerpt")) this.sqlite.exec("ALTER TABLE pending_prompts ADD COLUMN quote_excerpt TEXT");
    if (!pendingPromptColumns.has("source_reference")) this.sqlite.exec("ALTER TABLE pending_prompts ADD COLUMN source_reference TEXT");
    const sessionColumns = this.columnNames("sessions");
    if (!sessionColumns.has("user_id")) this.sqlite.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)");
    const jobColumns = this.columnNames("jobs");
    if (!jobColumns.has("message_id")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN message_id TEXT REFERENCES messages(id) ON DELETE SET NULL");
    if (!jobColumns.has("agent_model")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN agent_model TEXT");
    if (!jobColumns.has("reasoning_effort")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN reasoning_effort TEXT");
    if (!jobColumns.has("queue_seq")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN queue_seq INTEGER");
    if (!jobColumns.has("fork_before_turn_id")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN fork_before_turn_id TEXT");
    const conversationColumnsAfter = this.columnNames("conversations");
    if (!conversationColumnsAfter.has("agent_provider")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN agent_provider TEXT");
    if (!conversationColumnsAfter.has("sandbox_mode")) this.sqlite.exec("ALTER TABLE conversations ADD COLUMN sandbox_mode TEXT");
    const pendingPromptColumnsAfter = this.columnNames("pending_prompts");
    if (!pendingPromptColumnsAfter.has("agent_provider")) this.sqlite.exec("ALTER TABLE pending_prompts ADD COLUMN agent_provider TEXT");
    if (!pendingPromptColumnsAfter.has("sandbox_mode")) this.sqlite.exec("ALTER TABLE pending_prompts ADD COLUMN sandbox_mode TEXT NOT NULL DEFAULT 'workspace-write'");
    const jobColumnsAfter = this.columnNames("jobs");
    if (!jobColumnsAfter.has("agent_provider")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN agent_provider TEXT");
    if (!jobColumnsAfter.has("sandbox_mode")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN sandbox_mode TEXT");
    if (!jobColumnsAfter.has("skip_queue")) this.sqlite.exec("ALTER TABLE jobs ADD COLUMN skip_queue INTEGER NOT NULL DEFAULT 0");
    const providerColumns = this.columnNames("providers");
    if (!providerColumns.has("models_file")) this.sqlite.exec("ALTER TABLE providers ADD COLUMN models_file TEXT");
    if (!providerColumns.has("auto_review_model_override")) this.sqlite.exec("ALTER TABLE providers ADD COLUMN auto_review_model_override TEXT");
    if (!providerColumns.has("extra_config")) this.sqlite.exec("ALTER TABLE providers ADD COLUMN extra_config TEXT");
    const providerModelColumns = this.columnNames("provider_models");
    if (!providerModelColumns.has("model_context_window")) this.sqlite.exec("ALTER TABLE provider_models ADD COLUMN model_context_window INTEGER");
    if (!providerModelColumns.has("auto_compact_token_limit")) this.sqlite.exec("ALTER TABLE provider_models ADD COLUMN auto_compact_token_limit INTEGER");
    const fileColumns = this.columnNames("files");
    if (!fileColumns.has("pending_prompt_id")) this.sqlite.exec("ALTER TABLE files ADD COLUMN pending_prompt_id TEXT REFERENCES pending_prompts(id) ON DELETE CASCADE");
    if (!fileColumns.has("composer_draft_id")) this.sqlite.exec("ALTER TABLE files ADD COLUMN composer_draft_id TEXT REFERENCES composer_drafts(conversation_id) ON DELETE CASCADE");
    const presetPromptColumns = this.columnNames("preset_prompts");
    if (!presetPromptColumns.has("default_enabled")) this.sqlite.exec("ALTER TABLE preset_prompts ADD COLUMN default_enabled INTEGER NOT NULL DEFAULT 0");
    const pricingRuleColumns = this.columnNames("pricing_rules");
    if (!pricingRuleColumns.has("peak_enabled")) this.sqlite.exec("ALTER TABLE pricing_rules ADD COLUMN peak_enabled INTEGER NOT NULL DEFAULT 0");
    if (!pricingRuleColumns.has("peak_input_per_million")) this.sqlite.exec("ALTER TABLE pricing_rules ADD COLUMN peak_input_per_million REAL");
    if (!pricingRuleColumns.has("peak_cached_input_per_million")) this.sqlite.exec("ALTER TABLE pricing_rules ADD COLUMN peak_cached_input_per_million REAL");
    if (!pricingRuleColumns.has("peak_cache_write_per_million")) this.sqlite.exec("ALTER TABLE pricing_rules ADD COLUMN peak_cache_write_per_million REAL");
    if (!pricingRuleColumns.has("peak_output_per_million")) this.sqlite.exec("ALTER TABLE pricing_rules ADD COLUMN peak_output_per_million REAL");
    if (!pricingRuleColumns.has("peak_start_minute")) this.sqlite.exec("ALTER TABLE pricing_rules ADD COLUMN peak_start_minute INTEGER");
    if (!pricingRuleColumns.has("peak_end_minute")) this.sqlite.exec("ALTER TABLE pricing_rules ADD COLUMN peak_end_minute INTEGER");
    if (!pricingRuleColumns.has("peak_weekdays")) this.sqlite.exec("ALTER TABLE pricing_rules ADD COLUMN peak_weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5'");
    if (!pricingRuleColumns.has("timezone")) this.sqlite.exec("ALTER TABLE pricing_rules ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai'");
    this.sqlite.exec("CREATE INDEX IF NOT EXISTS messages_visible_order ON messages(conversation_id,superseded_at,created_at,id)");
    this.migrateSideChats();
    this.sqlite.prepare("UPDATE jobs SET queue_seq=rowid WHERE queue_seq IS NULL").run();

    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO users(id,username,display_name,password_hash,role,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'active',?,?)
      ON CONFLICT(id) DO UPDATE SET
        password_hash=CASE WHEN excluded.password_hash<>'' THEN excluded.password_hash ELSE users.password_hash END,
        role='owner', status='active', updated_at=excluded.updated_at
    `).run(LEGACY_USER_ID, legacyUser.username, legacyUser.displayName ?? legacyUser.username, legacyUser.passwordHash, "owner", now, now);

    this.migrateProvidersToUsers();
    this.migrateLegacyModelContextLimits();
    this.migrateProviderManagementSettings();
    this.migrateLegacyTaskCategoryOrders();

    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("UPDATE conversations SET user_id=? WHERE user_id IS NULL").run(LEGACY_USER_ID);
      this.sqlite.prepare("UPDATE sessions SET user_id=? WHERE user_id IS NULL").run(LEGACY_USER_ID);
      const legacySetting = this.sqlite.prepare("SELECT value,updated_at FROM app_settings WHERE key='agent_selection'").get() as { value: string; updated_at: string } | undefined;
      if (legacySetting) {
        this.sqlite.prepare("INSERT OR IGNORE INTO user_settings(user_id,key,value,updated_at) VALUES(?,'agent_selection',?,?)")
          .run(LEGACY_USER_ID, legacySetting.value, legacySetting.updated_at);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }

    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id, updated_at);
      CREATE INDEX IF NOT EXISTS conversations_user_active_idx ON conversations(user_id, deleted_at, updated_at);
      CREATE INDEX IF NOT EXISTS conversations_user_archived_idx ON conversations(user_id, deleted_at, archived_at);
      CREATE INDEX IF NOT EXISTS conversations_working_dir_idx ON conversations(working_dir) WHERE working_dir IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_side_chats_child_idx ON conversation_side_chats(conversation_id);
      CREATE INDEX IF NOT EXISTS conversation_side_chats_parent_idx ON conversation_side_chats(parent_conversation_id, last_opened_at DESC);
      CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS files_conversation_idx ON files(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS files_pending_prompt_idx ON files(pending_prompt_id, created_at);
      CREATE INDEX IF NOT EXISTS files_composer_draft_idx ON files(composer_draft_id, created_at);
      CREATE INDEX IF NOT EXISTS pending_prompts_queue_idx ON pending_prompts(conversation_id, status, position);
      CREATE INDEX IF NOT EXISTS jobs_conversation_idx ON jobs(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, queue_seq);
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS providers_enabled_idx ON providers(user_id, enabled, created_at);
      CREATE INDEX IF NOT EXISTS provider_models_provider_idx ON provider_models(user_id, provider_id, priority, created_at);
      CREATE INDEX IF NOT EXISTS preset_prompts_user_idx ON preset_prompts(user_id, position);
      CREATE INDEX IF NOT EXISTS conversation_preset_prompts_conversation_idx ON conversation_preset_prompts(conversation_id, position);
    `);

    const uploadedFiles = this.sqlite.prepare("SELECT id,original_name FROM files WHERE kind='upload'").all() as Array<{ id: string; original_name: string }>;
    const updateName = this.sqlite.prepare("UPDATE files SET original_name=? WHERE id=?");
    for (const file of uploadedFiles) {
      const normalizedName = normalizeUploadFileName(file.original_name);
      if (normalizedName !== file.original_name) updateName.run(normalizedName, file.id);
    }
    this.sqlite.prepare("UPDATE files SET relative_path=replace(relative_path, '\\', '/') WHERE instr(relative_path, '\\') > 0").run();
  }

  private columnNames(table: string): Set<string> {
    return new Set((this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
  }

  private migrateSideChats(): void {
    const columns = this.sqlite.prepare("PRAGMA table_info(conversation_side_chats)").all() as Array<{ name: string; pk: number }>;
    const parentIsPrimaryKey = columns.some((column) => column.name === "parent_conversation_id" && column.pk > 0);
    const hasLastOpenedAt = columns.some((column) => column.name === "last_opened_at");
    if (!parentIsPrimaryKey && hasLastOpenedAt) return;

    this.sqlite.exec("PRAGMA foreign_keys=OFF");
    try {
      this.sqlite.exec("BEGIN IMMEDIATE");
      this.sqlite.exec("ALTER TABLE conversation_side_chats RENAME TO conversation_side_chats_legacy");
      this.sqlite.exec(`
        CREATE TABLE conversation_side_chats (
          parent_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          last_opened_at TEXT NOT NULL
        )
      `);
      this.sqlite.exec(`
        INSERT INTO conversation_side_chats(parent_conversation_id,conversation_id,created_at,last_opened_at)
        SELECT parent_conversation_id,conversation_id,created_at,${hasLastOpenedAt ? "last_opened_at" : "created_at"}
        FROM conversation_side_chats_legacy
      `);
      this.sqlite.exec("DROP TABLE conversation_side_chats_legacy");
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      this.sqlite.exec("PRAGMA foreign_keys=ON");
    }
  }

  private migrateLegacyTaskCategoryOrders(): void {
    const marker = this.sqlite.prepare("SELECT value FROM app_settings WHERE key=?").get(TASK_LIST_CATEGORY_ORDER_RESET_MIGRATION) as { value: string } | undefined;
    if (marker) return;

    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.sqlite.prepare("SELECT user_id,value FROM user_settings WHERE key='task_list_categories'").all() as Array<{ user_id: string; value: string }>;
      const update = this.sqlite.prepare("UPDATE user_settings SET value=?,updated_at=? WHERE user_id=? AND key='task_list_categories'");
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.value) as Record<string, unknown> | null;
          if (!parsed || typeof parsed !== "object" || !("conversationOrders" in parsed)) continue;
          delete parsed.conversationOrders;
          update.run(JSON.stringify(parsed), now, row.user_id);
        } catch {
          // The normal settings reader already falls back safely for malformed JSON.
        }
      }
      this.sqlite.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)").run(
        TASK_LIST_CATEGORY_ORDER_RESET_MIGRATION,
        "1",
        now,
      );
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateProvidersToUsers(): void {
    const providerColumns = this.columnNames("providers");
    const modelColumns = this.columnNames("provider_models");
    if (providerColumns.has("user_id") && modelColumns.has("user_id")) return;
    if (providerColumns.has("user_id") || modelColumns.has("user_id")) {
      throw new Error("Provider tables have inconsistent user scoping");
    }

    this.sqlite.exec("PRAGMA foreign_keys=OFF");
    try {
      this.sqlite.exec("BEGIN IMMEDIATE");
      this.sqlite.exec(`
        ALTER TABLE provider_models RENAME TO provider_models_legacy_global;
        ALTER TABLE providers RENAME TO providers_legacy_global;
        CREATE TABLE providers (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          api_key TEXT,
          models_file TEXT,
          auto_review_model_override TEXT,
          extra_config TEXT,
          wire_api TEXT NOT NULL DEFAULT 'responses',
          requires_openai_auth INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(user_id, id)
        );
        CREATE TABLE provider_models (
          user_id TEXT NOT NULL,
          id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          display_name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          reasoning_efforts TEXT NOT NULL DEFAULT '[]',
          input_modalities TEXT NOT NULL DEFAULT '["text","image"]',
          model_context_window INTEGER,
          auto_compact_token_limit INTEGER,
          priority INTEGER NOT NULL DEFAULT 0,
          visible INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(user_id, id),
          FOREIGN KEY(user_id, provider_id) REFERENCES providers(user_id, id) ON DELETE CASCADE,
          UNIQUE(user_id, provider_id, model_id)
        );
        INSERT INTO providers(user_id,id,name,base_url,api_key,models_file,auto_review_model_override,extra_config,wire_api,requires_openai_auth,enabled,created_at,updated_at)
        SELECT account.id,provider.id,provider.name,provider.base_url,provider.api_key,provider.models_file,provider.auto_review_model_override,provider.extra_config,
          provider.wire_api,provider.requires_openai_auth,provider.enabled,provider.created_at,provider.updated_at
        FROM users account CROSS JOIN providers_legacy_global provider;
        INSERT INTO provider_models(user_id,id,provider_id,model_id,slug,display_name,description,reasoning_efforts,input_modalities,model_context_window,auto_compact_token_limit,priority,visible,created_at,updated_at)
        SELECT account.id,model.id,model.provider_id,model.model_id,model.slug,model.display_name,model.description,
          model.reasoning_efforts,model.input_modalities,model.model_context_window,model.auto_compact_token_limit,
          model.priority,model.visible,model.created_at,model.updated_at
        FROM users account CROSS JOIN provider_models_legacy_global model;
        DROP TABLE provider_models_legacy_global;
        DROP TABLE providers_legacy_global;
      `);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      this.sqlite.exec("PRAGMA foreign_keys=ON");
    }
  }

  private migrateLegacyModelContextLimits(): void {
    // 272k/250k was an intermediate hard-coded setting from before the
    // configurable defaults were introduced. Upgrade only that exact pair;
    // other explicit per-model values remain user-owned settings.
    this.sqlite.prepare(`
      UPDATE provider_models
      SET model_context_window=?, auto_compact_token_limit=?, updated_at=?
      WHERE model_context_window=? AND auto_compact_token_limit=?
    `).run(
      DEFAULT_MODEL_CONTEXT_WINDOW,
      DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
      new Date().toISOString(),
      LEGACY_MODEL_CONTEXT_WINDOW,
      LEGACY_AUTO_COMPACT_TOKEN_LIMIT,
    );
  }

  /**
   * Provider management was enabled implicitly before its per-user setting
   * was introduced. Preserve that behavior for existing provider records;
   * an explicit false setting remains an opt-out.
   */
  private migrateProviderManagementSettings(): void {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO user_settings(user_id,key,value,updated_at)
      SELECT DISTINCT providers.user_id, 'provider_management_enabled', 'true', ?
      FROM providers
      WHERE NOT EXISTS (
        SELECT 1 FROM user_settings
        WHERE user_settings.user_id=providers.user_id
          AND user_settings.key='provider_management_enabled'
      )
    `).run(now);
  }

  listUsers(): UserRow[] {
    return this.sqlite.prepare("SELECT * FROM users ORDER BY created_at,id").all() as UserRow[];
  }

  getUser(id: string): UserRow | undefined {
    return this.sqlite.prepare("SELECT * FROM users WHERE id=?").get(id) as UserRow | undefined;
  }

  getUserByUsername(username: string): UserRow | undefined {
    return this.sqlite.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE").get(username) as UserRow | undefined;
  }

  createUser(user: UserRow): void {
    this.sqlite.prepare("INSERT INTO users(id,username,display_name,password_hash,role,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(
      user.id, user.username, user.display_name, user.password_hash, user.role, user.status, user.created_at, user.updated_at,
    );
  }

  setUserPassword(userId: string, passwordHash: string): void {
    this.sqlite.prepare("UPDATE users SET password_hash=?,updated_at=? WHERE id=?").run(passwordHash, new Date().toISOString(), userId);
  }

  setUserUsername(userId: string, username: string): void {
    this.sqlite.prepare("UPDATE users SET username=?,updated_at=? WHERE id=?").run(username, new Date().toISOString(), userId);
  }

  setUserStatus(userId: string, status: UserRow["status"]): void {
    this.sqlite.prepare("UPDATE users SET status=?,updated_at=? WHERE id=?").run(status, new Date().toISOString(), userId);
    if (status === "disabled") this.sqlite.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
  }

  deleteOtherUserSessions(userId: string, currentTokenHash: string): void {
    this.sqlite.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").run(userId, currentTokenHash);
  }

  listConversations(userId?: string): ConversationRow[] {
    if (userId) return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE user_id=? AND deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC`).all(userId) as ConversationRow[];
    return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC`).all() as ConversationRow[];
  }

  listPrimaryConversations(userId: string): ConversationRow[] {
    return this.sqlite.prepare(`
      SELECT ${conversationSelect} FROM conversations
      WHERE user_id=? AND deleted_at IS NULL AND archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM conversation_side_chats side WHERE side.conversation_id=conversations.id)
      ORDER BY updated_at DESC
    `).all(userId) as ConversationRow[];
  }

  listArchivedConversations(userId: string, query = ""): ConversationRow[] {
    const normalized = query.trim().slice(0, 100);
    if (!normalized) {
      return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE user_id=? AND deleted_at IS NULL AND archived_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversation_side_chats side WHERE side.conversation_id=conversations.id) ORDER BY archived_at DESC,id LIMIT 100`)
        .all(userId) as ConversationRow[];
    }
    const escaped = normalized.replace(/[\\%_]/g, "\\$&");
    return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE user_id=? AND deleted_at IS NULL AND archived_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM conversation_side_chats side WHERE side.conversation_id=conversations.id) AND title LIKE ? ESCAPE '\\' COLLATE NOCASE ORDER BY archived_at DESC,id LIMIT 100`)
      .all(userId, `%${escaped}%`) as ConversationRow[];
  }

  getConversation(id: string): ConversationRow | undefined {
    return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE id=?`).get(id) as ConversationRow | undefined;
  }

  getConversationForUser(id: string, userId: string): ConversationRow | undefined {
    return this.sqlite.prepare(`SELECT ${conversationSelect} FROM conversations WHERE id=? AND user_id=? AND deleted_at IS NULL`).get(id, userId) as ConversationRow | undefined;
  }

  createConversation(id: string, title: string, selection?: StoredAgentSelection, userId = LEGACY_USER_ID, workingDir?: string | null): ConversationRow {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO conversations(id,user_id,title,title_source,working_dir,agent_model,reasoning_effort,agent_provider,sandbox_mode,status,created_at,updated_at)
      VALUES(?,?,?,'default',?,?,?,?,?,'idle',?,?)
    `).run(
      id, userId, title, workingDir ?? null, selection?.model ?? null, selection?.reasoningEffort ?? null,
      selection?.provider ?? null, selection?.sandbox ?? "workspace-write", now, now,
    );
    return this.getConversation(id)!;
  }

  getSideConversation(parentConversationId: string, userId: string): ConversationRow | undefined {
    return this.sqlite.prepare(`
      SELECT ${conversationSelect} FROM conversations
      JOIN conversation_side_chats side ON side.conversation_id=conversations.id
      WHERE side.parent_conversation_id=? AND conversations.user_id=? AND conversations.deleted_at IS NULL
      ORDER BY side.last_opened_at DESC,side.created_at DESC
      LIMIT 1
    `).get(parentConversationId, userId) as ConversationRow | undefined;
  }

  listSideConversations(userId: string, parentConversationId?: string): SideConversationRow[] {
    const parentFilter = parentConversationId ? "AND side.parent_conversation_id=?" : "";
    const params = parentConversationId ? [userId, parentConversationId] : [userId];
    return this.sqlite.prepare(`
      SELECT ${conversationSelect},
        side.parent_conversation_id,
        parent.title AS parent_title,
        side.created_at AS side_created_at,
        side.last_opened_at
      FROM conversations
      JOIN conversation_side_chats side ON side.conversation_id=conversations.id
      JOIN conversations parent ON parent.id=side.parent_conversation_id
      WHERE conversations.user_id=?
        ${parentFilter}
        AND conversations.deleted_at IS NULL
        AND parent.deleted_at IS NULL
      ORDER BY side.last_opened_at DESC,side.created_at DESC,conversations.id
    `).all(...params) as SideConversationRow[];
  }

  createSideConversation(parent: ConversationRow, id: string, selection: StoredAgentSelection): ConversationRow {
    const now = new Date().toISOString();
    const title = `侧边聊天 · ${parent.title}`.slice(0, 80);
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare(`
        INSERT INTO conversations(id,user_id,title,title_source,working_dir,agent_model,reasoning_effort,agent_provider,sandbox_mode,status,created_at,updated_at)
        VALUES(?,?,?,'manual',?,?,?,?,?,'idle',?,?)
      `).run(
        id, parent.user_id, title, parent.working_dir, selection.model, selection.reasoningEffort,
        selection.provider ?? null, selection.sandbox ?? "workspace-write", now, now,
      );
      this.sqlite.prepare("INSERT INTO conversation_side_chats(parent_conversation_id,conversation_id,created_at,last_opened_at) VALUES(?,?,?,?)")
        .run(parent.id, id, now, now);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getConversation(id)!;
  }

  createForkSideConversation(input: {
    parent: ConversationRow;
    id: string;
    selection: StoredAgentSelection;
    sourceMessage: MessageRow;
    messages: MessageRow[];
  }): ConversationRow {
    if (!input.parent.codex_thread_id || !input.sourceMessage.codex_turn_id) throw new Error("线程分叉缺少 Codex turn 信息");
    const now = new Date().toISOString();
    const title = `分支 · ${input.parent.title}`.slice(0, 80);
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare(`
        INSERT INTO conversations(
          id,user_id,title,title_source,codex_thread_id,fork_source_thread_id,fork_last_turn_id,fork_source_message_id,
          working_dir,agent_model,reasoning_effort,agent_provider,sandbox_mode,status,created_at,updated_at
        )
        VALUES(?,?,?,'manual',NULL,?,?,?,?,?,?,?,?,'idle',?,?)
      `).run(
        input.id,
        input.parent.user_id,
        title,
        input.parent.codex_thread_id,
        input.sourceMessage.codex_turn_id,
        input.sourceMessage.id,
        input.parent.working_dir,
        input.selection.model,
        input.selection.reasoningEffort,
        input.selection.provider ?? null,
        input.selection.sandbox ?? "workspace-write",
        now,
        now,
      );
      this.sqlite.prepare("INSERT INTO conversation_side_chats(parent_conversation_id,conversation_id,created_at,last_opened_at) VALUES(?,?,?,?)")
        .run(input.parent.id, input.id, now, now);
      const insertMessage = this.sqlite.prepare(`
        INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,source_reference,codex_turn_id,superseded_at,superseded_by,created_at)
        VALUES(?,?,?, ?,?,?,NULL,NULL,NULL,?)
      `);
      for (const message of input.messages) {
        insertMessage.run(
          crypto.randomUUID(),
          input.id,
          message.role,
          message.content,
          message.quote_excerpt ?? null,
          message.source_reference ?? null,
          message.created_at,
        );
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getConversation(input.id)!;
  }

  touchSideConversation(conversationId: string, userId: string): ConversationRow | undefined {
    const conversation = this.getConversationForUser(conversationId, userId);
    if (!conversation || !this.getSideConversationParent(conversationId, userId)) return undefined;
    this.sqlite.prepare("UPDATE conversation_side_chats SET last_opened_at=? WHERE conversation_id=?")
      .run(new Date().toISOString(), conversationId);
    return conversation;
  }

  promoteSideConversationForUser(conversationId: string, userId: string): ConversationRow | undefined {
    let promoted = false;
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const eligible = this.sqlite.prepare(`
        SELECT conversations.id
        FROM conversations
        JOIN conversation_side_chats side ON side.conversation_id=conversations.id
        WHERE conversations.id=? AND conversations.user_id=?
          AND conversations.deleted_at IS NULL AND conversations.archived_at IS NULL
      `).get(conversationId, userId) as { id: string } | undefined;
      if (eligible) {
        promoted = this.sqlite.prepare("DELETE FROM conversation_side_chats WHERE conversation_id=?").run(conversationId).changes > 0;
        if (promoted) this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return promoted ? this.getConversationForUser(conversationId, userId) : undefined;
  }

  getSideConversationParent(conversationId: string, userId: string): ConversationRow | undefined {
    return this.sqlite.prepare(`
      SELECT ${conversationSelect} FROM conversations
      JOIN conversation_side_chats side ON side.parent_conversation_id=conversations.id
      WHERE side.conversation_id=? AND conversations.user_id=? AND conversations.deleted_at IS NULL
    `).get(conversationId, userId) as ConversationRow | undefined;
  }

  listCodexThreadIds(): string[] {
    return (this.sqlite.prepare(`
      SELECT codex_thread_id AS thread_id FROM conversations WHERE codex_thread_id IS NOT NULL
      UNION
      SELECT fork_source_thread_id AS thread_id FROM conversations WHERE fork_source_thread_id IS NOT NULL
    `).all() as Array<{ thread_id: string }>).map((row) => row.thread_id);
  }

  createImportedConversation(input: {
    id: string;
    userId: string;
    title: string;
    threadId: string;
    workingDir: string | null;
    createdAt: string;
    updatedAt: string;
    agentModel: string | null;
    reasoningEffort: string | null;
    messages: Array<{ role: "user" | "assistant"; content: string; turnId?: string | null; createdAt: string }>;
  }): ConversationRow {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare(`
        INSERT INTO conversations(id,user_id,title,title_source,codex_thread_id,working_dir,agent_model,reasoning_effort,agent_provider,sandbox_mode,status,created_at,updated_at)
        VALUES(?,?,?,'legacy',?,?,?,?,NULL,'workspace-write','idle',?,?)
      `).run(input.id, input.userId, input.title, input.threadId, input.workingDir, input.agentModel, input.reasoningEffort, input.createdAt, input.updatedAt);
      const insertMessage = this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,source_reference,codex_turn_id,created_at) VALUES(?,?,?, ?,NULL,NULL,?,?)");
      for (const message of input.messages) {
        insertMessage.run(crypto.randomUUID(), input.id, message.role, message.content, message.turnId ?? null, message.createdAt);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getConversation(input.id)!;
  }

  updateConversation(id: string, fields: {
    title?: string;
    titleSource?: ConversationTitleSource;
    codexThreadId?: string | null;
    forkSourceThreadId?: string | null;
    forkLastTurnId?: string | null;
    forkSourceMessageId?: string | null;
    workingDir?: string | null;
    agentSelection?: StoredAgentSelection;
    status?: "idle" | "running";
  }): void {
    if (fields.title !== undefined) this.sqlite.prepare("UPDATE conversations SET title=?, title_source=COALESCE(?,title_source), updated_at=? WHERE id=?")
      .run(fields.title, fields.titleSource ?? null, new Date().toISOString(), id);
    if (fields.codexThreadId !== undefined) this.sqlite.prepare("UPDATE conversations SET codex_thread_id=?, updated_at=? WHERE id=?").run(fields.codexThreadId, new Date().toISOString(), id);
    if (fields.forkSourceThreadId !== undefined) this.sqlite.prepare("UPDATE conversations SET fork_source_thread_id=?, updated_at=? WHERE id=?").run(fields.forkSourceThreadId, new Date().toISOString(), id);
    if (fields.forkLastTurnId !== undefined) this.sqlite.prepare("UPDATE conversations SET fork_last_turn_id=?, updated_at=? WHERE id=?").run(fields.forkLastTurnId, new Date().toISOString(), id);
    if (fields.forkSourceMessageId !== undefined) this.sqlite.prepare("UPDATE conversations SET fork_source_message_id=?, updated_at=? WHERE id=?").run(fields.forkSourceMessageId, new Date().toISOString(), id);
    if (fields.workingDir !== undefined) this.sqlite.prepare("UPDATE conversations SET working_dir=?, updated_at=? WHERE id=?").run(fields.workingDir, new Date().toISOString(), id);
    if (fields.agentSelection !== undefined) this.sqlite.prepare("UPDATE conversations SET agent_model=?, reasoning_effort=?, agent_provider=?, sandbox_mode=?, updated_at=? WHERE id=?").run(
      fields.agentSelection.model, fields.agentSelection.reasoningEffort, fields.agentSelection.provider ?? null, fields.agentSelection.sandbox ?? "workspace-write", new Date().toISOString(), id,
    );
    if (fields.status !== undefined) this.sqlite.prepare("UPDATE conversations SET status=?, updated_at=? WHERE id=?").run(fields.status, new Date().toISOString(), id);
  }

  markConversationResultSeenForUser(id: string, userId: string): ConversationRow | undefined {
    const conversation = this.getConversationForUser(id, userId);
    if (!conversation) return undefined;
    this.sqlite.prepare("UPDATE conversations SET has_unread_result=0 WHERE id=? AND user_id=? AND deleted_at IS NULL").run(id, userId);
    return this.getConversationForUser(id, userId);
  }

  archiveConversationForUser(id: string, userId: string): ConversationRow | undefined {
    const now = new Date().toISOString();
    let changed = false;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = this.sqlite.prepare(`
        UPDATE conversations SET archived_at=?
        WHERE id=? AND user_id=? AND deleted_at IS NULL AND archived_at IS NULL
      `).run(now, id, userId);
      changed = result.changes > 0;
      if (changed) {
        this.sqlite.prepare(`
          UPDATE conversations SET archived_at=?
          WHERE id IN (SELECT conversation_id FROM conversation_side_chats WHERE parent_conversation_id=?)
            AND user_id=? AND deleted_at IS NULL AND archived_at IS NULL
        `).run(now, id, userId);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return changed ? this.getConversationForUser(id, userId) : undefined;
  }

  restoreConversationForUser(id: string, userId: string): ConversationRow | undefined {
    const now = new Date().toISOString();
    let changed = false;
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = this.sqlite.prepare(`
        UPDATE conversations SET archived_at=NULL,updated_at=?
        WHERE id=? AND user_id=? AND deleted_at IS NULL AND archived_at IS NOT NULL
      `).run(now, id, userId);
      changed = result.changes > 0;
      if (changed) {
        this.sqlite.prepare(`
          UPDATE conversations SET archived_at=NULL,updated_at=?
          WHERE id IN (SELECT conversation_id FROM conversation_side_chats WHERE parent_conversation_id=?)
            AND user_id=? AND deleted_at IS NULL AND archived_at IS NOT NULL
        `).run(now, id, userId);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return changed ? this.getConversationForUser(id, userId) : undefined;
  }

  setConversationRolloutBytes(id: string, bytes: number | null): void {
    const normalized = bytes === null || !Number.isFinite(bytes) ? null : Math.max(0, Math.trunc(bytes));
    this.sqlite.prepare("UPDATE conversations SET rollout_bytes=? WHERE id=? AND deleted_at IS NULL").run(normalized, id);
  }

  setConversationContextUsage(id: string, usedTokens: number, contextWindow: number | null): void {
    const used = Number.isFinite(usedTokens) ? Math.max(0, Math.trunc(usedTokens)) : 0;
    const window = contextWindow === null || !Number.isFinite(contextWindow) ? null : Math.max(1, Math.trunc(contextWindow));
    this.sqlite.prepare("UPDATE conversations SET context_used_tokens=?,context_window=?,context_updated_at=? WHERE id=? AND deleted_at IS NULL")
      .run(used, window, new Date().toISOString(), id);
  }

  setAiConversationTitleIfDefault(id: string, title: string): boolean {
    return this.sqlite.prepare(`
      UPDATE conversations SET title=?,title_source='ai',updated_at=?
      WHERE id=? AND title_source='default' AND deleted_at IS NULL
    `).run(title, new Date().toISOString(), id).changes > 0;
  }

  isFirstUserMessage(conversationId: string, messageId: string): boolean {
    const first = this.sqlite.prepare("SELECT id FROM messages WHERE conversation_id=? AND role='user' AND superseded_at IS NULL ORDER BY created_at,id LIMIT 1")
      .get(conversationId) as { id: string } | undefined;
    return first?.id === messageId;
  }

  softDeleteConversation(id: string): void {
    const now = new Date().toISOString();
    this.sqlite.prepare("UPDATE conversations SET status='idle',deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL").run(now, now, id);
  }

  isCodexThreadUsedByAnotherActiveConversation(threadId: string, conversationId: string, excludedConversationIds: readonly string[] = []): boolean {
    const excludedIds = [...new Set([conversationId, ...excludedConversationIds])];
    const placeholders = excludedIds.map(() => "?").join(",");
    const row = this.sqlite.prepare(`
      SELECT 1 AS found FROM conversations
      WHERE id NOT IN (${placeholders}) AND deleted_at IS NULL AND (codex_thread_id=? OR fork_source_thread_id=?)
      LIMIT 1
    `).get(...excludedIds, threadId, threadId) as { found: number } | undefined;
    return Boolean(row);
  }

  addMessage(message: MessageRow): void {
    this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,source_reference,codex_turn_id,superseded_at,superseded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      message.id, message.conversation_id, message.role, message.content, message.quote_excerpt ?? null, message.source_reference ?? null, message.codex_turn_id ?? null, message.superseded_at ?? null, message.superseded_by ?? null, message.created_at,
    );
    this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(message.created_at, message.conversation_id);
  }

  getMessage(id: string): MessageRow | undefined {
    return this.sqlite.prepare("SELECT * FROM messages WHERE id=?").get(id) as MessageRow | undefined;
  }

  getMessageForUser(id: string, userId: string): MessageRow | undefined {
    return this.sqlite.prepare(`
      SELECT message.* FROM messages message
      JOIN conversations conversation ON conversation.id=message.conversation_id
      WHERE message.id=? AND conversation.user_id=? AND conversation.deleted_at IS NULL
    `).get(id, userId) as MessageRow | undefined;
  }

  updateMessageTurnId(id: string, turnId: string): void {
    if (!turnId.trim()) return;
    this.sqlite.prepare("UPDATE messages SET codex_turn_id=? WHERE id=?").run(turnId, id);
  }

  createEditedMessageJob(input: {
    sourceMessageId: string;
    messageId: string;
    jobId: string;
    conversationId: string;
    content: string;
    quoteExcerpt: string | null;
    sourceReference: string | null;
    forkBeforeTurnId: string;
    selection: StoredAgentSelection;
    retainedFileIds: string[];
    uploadedFiles: FileRow[];
  }): { message: MessageRow; job: JobRow } | undefined {
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const source = this.sqlite.prepare("SELECT * FROM messages WHERE id=?").get(input.sourceMessageId) as MessageRow | undefined;
      if (!source || source.conversation_id !== input.conversationId || source.role !== "user" || source.superseded_at || source.codex_turn_id !== input.forkBeforeTurnId) {
        this.sqlite.exec("ROLLBACK");
        return undefined;
      }
      const sourceFiles = this.sqlite.prepare("SELECT * FROM files WHERE message_id=? AND kind='upload' ORDER BY created_at,id").all(input.sourceMessageId) as FileRow[];
      const sourceFileIds = new Set(sourceFiles.map((file) => file.id));
      if (input.retainedFileIds.some((fileId) => !sourceFileIds.has(fileId))) throw new Error("编辑消息的附件状态已经变化，请刷新后重试。");
      for (const file of input.uploadedFiles) {
        if (file.conversation_id !== input.conversationId || file.message_id !== input.messageId || file.pending_prompt_id || file.composer_draft_id || file.kind !== "upload") {
          throw new Error("编辑消息的上传文件无效。");
        }
      }
      this.sqlite.prepare(
        "UPDATE messages SET superseded_at=?,superseded_by=? "
        + "WHERE conversation_id=? AND superseded_at IS NULL "
        + "AND (created_at>? OR (created_at=? AND id>=?))",
      ).run(now, input.messageId, input.conversationId, source.created_at, source.created_at, source.id);
      this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,source_reference,codex_turn_id,superseded_at,superseded_by,created_at) VALUES(?,?,'user',?,?,?,?,?,?,?)")
        .run(input.messageId, input.conversationId, input.content, input.quoteExcerpt, input.sourceReference, null, null, null, now);
      const insertFile = this.sqlite.prepare("INSERT INTO files(id,conversation_id,message_id,pending_prompt_id,composer_draft_id,original_name,relative_path,mime_type,size,kind,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
      const retainedFiles = sourceFiles.filter((file) => input.retainedFileIds.includes(file.id));
      for (const file of retainedFiles) {
        insertFile.run(crypto.randomUUID(), file.conversation_id, input.messageId, null, null, file.original_name, file.relative_path, file.mime_type, file.size, file.kind, now);
      }
      for (const file of input.uploadedFiles) {
        insertFile.run(file.id, file.conversation_id, input.messageId, null, null, file.original_name, normalizeStoredRelativePath(file.relative_path), file.mime_type, file.size, file.kind, file.created_at);
      }
      const next = this.sqlite.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS value FROM jobs").get() as { value: number };
      this.sqlite.prepare("INSERT INTO jobs(id,conversation_id,message_id,agent_model,reasoning_effort,agent_provider,sandbox_mode,fork_before_turn_id,queue_seq,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?)")
        .run(input.jobId, input.conversationId, input.messageId, input.selection.model, input.selection.reasoningEffort, input.selection.provider ?? null, input.selection.sandbox ?? "workspace-write", input.forkBeforeTurnId, next.value, now, now);
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, input.conversationId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return { message: this.getMessage(input.messageId)!, job: this.getJob(input.jobId)! };
  }

  listMessages(conversationId: string): Array<MessageRow & { files: FileRow[] }> {
    const messages = this.sqlite.prepare("SELECT * FROM messages WHERE conversation_id=? AND superseded_at IS NULL ORDER BY created_at,id").all(conversationId) as MessageRow[];
    const files = this.sqlite.prepare("SELECT * FROM files WHERE conversation_id=? ORDER BY created_at,id").all(conversationId) as FileRow[];
    return messages.map((message) => ({
      ...message,
      files: files.filter((file) => file.message_id === message.id && (file.kind === "upload" || isDeliverablePath(file.relative_path))),
    }));
  }

  listMessagesPage(conversationId: string, beforeMessageId?: string, limit = 30): MessagePage | undefined {
    const pageSize = Math.min(100, Math.max(1, Math.trunc(limit)));
    let newestFirst: MessageRow[];
    if (beforeMessageId) {
      const cursor = this.getMessage(beforeMessageId);
      if (!cursor || cursor.conversation_id !== conversationId) return undefined;
      newestFirst = this.sqlite.prepare(`
        SELECT * FROM messages
        WHERE conversation_id=? AND superseded_at IS NULL AND (created_at<? OR (created_at=? AND id<?))
        ORDER BY created_at DESC,id DESC LIMIT ?
      `).all(conversationId, cursor.created_at, cursor.created_at, cursor.id, pageSize + 1) as MessageRow[];
    } else {
      newestFirst = this.sqlite.prepare(`
        SELECT * FROM messages WHERE conversation_id=? AND superseded_at IS NULL
        ORDER BY created_at DESC,id DESC LIMIT ?
      `).all(conversationId, pageSize + 1) as MessageRow[];
    }

    const hasMore = newestFirst.length > pageSize;
    const messages = newestFirst.slice(0, pageSize).reverse();
    if (messages.length === 0) return { messages: [], hasMore: false, nextCursor: null };
    const placeholders = messages.map(() => "?").join(",");
    const files = this.sqlite.prepare(`
      SELECT * FROM files WHERE conversation_id=? AND message_id IN (${placeholders}) ORDER BY created_at,id
    `).all(conversationId, ...messages.map((message) => message.id)) as FileRow[];
    return {
      messages: messages.map((message) => ({
        ...message,
        files: files.filter((file) => file.message_id === message.id && (file.kind === "upload" || isDeliverablePath(file.relative_path))),
      })),
      hasMore,
      nextCursor: hasMore ? messages[0].id : null,
    };
  }

  addFile(file: FileRow): void {
    this.sqlite.prepare("INSERT INTO files(id,conversation_id,message_id,pending_prompt_id,composer_draft_id,original_name,relative_path,mime_type,size,kind,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
      file.id, file.conversation_id, file.message_id, file.pending_prompt_id ?? null, file.composer_draft_id ?? null, file.original_name, normalizeStoredRelativePath(file.relative_path), file.mime_type, file.size, file.kind, file.created_at,
    );
  }

  getFile(id: string): FileRow | undefined {
    return this.sqlite.prepare("SELECT * FROM files WHERE id=?").get(id) as FileRow | undefined;
  }

  getFileForUser(id: string, userId: string): FileRow | undefined {
    return this.sqlite.prepare("SELECT f.* FROM files f JOIN conversations c ON c.id=f.conversation_id WHERE f.id=? AND c.user_id=? AND c.deleted_at IS NULL").get(id, userId) as FileRow | undefined;
  }

  listFiles(conversationId?: string): FileRow[] {
    if (conversationId) return this.sqlite.prepare("SELECT * FROM files WHERE conversation_id=? ORDER BY created_at,id").all(conversationId) as FileRow[];
    return this.sqlite.prepare("SELECT * FROM files ORDER BY created_at,id").all() as FileRow[];
  }

  listFilesForMessage(messageId: string): FileRow[] {
    return this.sqlite.prepare("SELECT * FROM files WHERE message_id=? ORDER BY created_at,id").all(messageId) as FileRow[];
  }

  updateFilePath(id: string, relativePath: string): void {
    this.sqlite.prepare("UPDATE files SET relative_path=? WHERE id=?").run(normalizeStoredRelativePath(relativePath), id);
  }

  updateFileMime(id: string, mimeType: string): void {
    this.sqlite.prepare("UPDATE files SET mime_type=? WHERE id=?").run(mimeType, id);
  }

  ensureComposerDraft(conversationId: string): ComposerDraftWithFiles {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO composer_drafts(conversation_id,content,quote_excerpt,source_reference,created_at,updated_at)
      VALUES(?,'',NULL,NULL,?,?) ON CONFLICT(conversation_id) DO NOTHING
    `).run(conversationId, now, now);
    return this.getComposerDraft(conversationId)!;
  }

  saveComposerDraft(conversationId: string, content: string, quoteExcerpt: string | null, sourceReference: string | null = null): ComposerDraftWithFiles | undefined {
    const existing = this.getComposerDraft(conversationId);
    if (!content && !quoteExcerpt && !sourceReference && (!existing || existing.files.length === 0)) {
      if (existing) this.sqlite.prepare("DELETE FROM composer_drafts WHERE conversation_id=?").run(conversationId);
      return undefined;
    }
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO composer_drafts(conversation_id,content,quote_excerpt,source_reference,created_at,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET content=excluded.content,quote_excerpt=excluded.quote_excerpt,source_reference=excluded.source_reference,updated_at=excluded.updated_at
    `).run(conversationId, content, quoteExcerpt, sourceReference, now, now);
    return this.getComposerDraft(conversationId);
  }

  getComposerDraft(conversationId: string): ComposerDraftWithFiles | undefined {
    const draft = this.sqlite.prepare("SELECT * FROM composer_drafts WHERE conversation_id=?").get(conversationId) as ComposerDraftRow | undefined;
    if (!draft) return undefined;
    const files = this.sqlite.prepare("SELECT * FROM files WHERE composer_draft_id=? ORDER BY created_at,id").all(conversationId) as FileRow[];
    return { ...draft, files };
  }

  deleteComposerDraft(conversationId: string): boolean {
    return this.sqlite.prepare("DELETE FROM composer_drafts WHERE conversation_id=?").run(conversationId).changes > 0;
  }

  touchComposerDraft(conversationId: string): void {
    this.sqlite.prepare("UPDATE composer_drafts SET updated_at=? WHERE conversation_id=?").run(new Date().toISOString(), conversationId);
  }

  pruneEmptyComposerDraft(conversationId: string): void {
    this.sqlite.prepare(`
      DELETE FROM composer_drafts
      WHERE conversation_id=? AND content='' AND quote_excerpt IS NULL AND source_reference IS NULL
        AND NOT EXISTS (SELECT 1 FROM files WHERE composer_draft_id=?)
    `).run(conversationId, conversationId);
  }

  materializeComposerDraftAsPending(
    pendingId: string,
    conversationId: string,
    content: string,
    selection: StoredAgentSelection,
    quoteExcerpt: string | null,
    sourceReference: string | null = null,
    status: PendingPromptRow["status"] = "queued",
  ): PendingPromptWithFiles {
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const next = this.sqlite.prepare("SELECT COALESCE(MAX(position),0)+1 AS value FROM pending_prompts WHERE conversation_id=? AND status='queued'").get(conversationId) as { value: number };
      this.sqlite.prepare(`
        INSERT INTO pending_prompts(id,conversation_id,content,quote_excerpt,source_reference,agent_model,reasoning_effort,agent_provider,sandbox_mode,position,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(pendingId, conversationId, content, quoteExcerpt, sourceReference, selection.model, selection.reasoningEffort, selection.provider ?? null, selection.sandbox ?? "workspace-write", next.value, status, now, now);
      this.sqlite.prepare("UPDATE files SET pending_prompt_id=?,composer_draft_id=NULL WHERE conversation_id=? AND composer_draft_id=?")
        .run(pendingId, conversationId, conversationId);
      this.sqlite.prepare("DELETE FROM composer_drafts WHERE conversation_id=?").run(conversationId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getPendingPrompt(pendingId)!;
  }

  materializeComposerDraftAsJob(
    messageId: string,
    jobId: string,
    conversationId: string,
    content: string,
    selection: StoredAgentSelection,
    quoteExcerpt: string | null,
    sourceReference: string | null = null,
  ): JobRow {
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,source_reference,created_at) VALUES(?,?,'user',?,?,?,?)")
        .run(messageId, conversationId, content, quoteExcerpt, sourceReference, now);
      this.sqlite.prepare("UPDATE files SET message_id=?,composer_draft_id=NULL WHERE conversation_id=? AND composer_draft_id=?")
        .run(messageId, conversationId, conversationId);
      this.sqlite.prepare("DELETE FROM composer_drafts WHERE conversation_id=?").run(conversationId);
      const next = this.sqlite.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS value FROM jobs").get() as { value: number };
      this.sqlite.prepare(`
        INSERT INTO jobs(id,conversation_id,message_id,agent_model,reasoning_effort,agent_provider,sandbox_mode,queue_seq,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'queued',?,?)
      `).run(jobId, conversationId, messageId, selection.model, selection.reasoningEffort, selection.provider ?? null, selection.sandbox ?? "workspace-write", next.value, now, now);
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getJob(jobId)!;
  }

  createPendingPrompt(id: string, conversationId: string, content: string, selection: StoredAgentSelection, quoteExcerpt: string | null = null, sourceReference: string | null = null): PendingPromptWithFiles {
    const now = new Date().toISOString();
    const next = this.sqlite.prepare("SELECT COALESCE(MAX(position),0)+1 AS value FROM pending_prompts WHERE conversation_id=? AND status='queued'").get(conversationId) as { value: number };
    this.sqlite.prepare(`
      INSERT INTO pending_prompts(id,conversation_id,content,quote_excerpt,source_reference,agent_model,reasoning_effort,agent_provider,sandbox_mode,position,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?)
    `).run(id, conversationId, content, quoteExcerpt, sourceReference, selection.model, selection.reasoningEffort, selection.provider ?? null, selection.sandbox ?? "workspace-write", next.value, now, now);
    return this.getPendingPrompt(id)!;
  }

  getPendingPrompt(id: string): PendingPromptWithFiles | undefined {
    const prompt = this.sqlite.prepare("SELECT * FROM pending_prompts WHERE id=?").get(id) as PendingPromptRow | undefined;
    if (!prompt) return undefined;
    const files = this.sqlite.prepare("SELECT * FROM files WHERE pending_prompt_id=? ORDER BY created_at,id").all(id) as FileRow[];
    return { ...prompt, files };
  }

  getPendingPromptForUser(id: string, userId: string): PendingPromptWithFiles | undefined {
    const prompt = this.sqlite.prepare(`
      SELECT pending.* FROM pending_prompts pending
      JOIN conversations conversation ON conversation.id=pending.conversation_id
      WHERE pending.id=? AND conversation.user_id=? AND conversation.deleted_at IS NULL
    `).get(id, userId) as PendingPromptRow | undefined;
    if (!prompt) return undefined;
    return { ...prompt, files: this.sqlite.prepare("SELECT * FROM files WHERE pending_prompt_id=? ORDER BY created_at,id").all(id) as FileRow[] };
  }

  listPendingPrompts(conversationId: string, status: PendingPromptRow["status"] = "queued"): PendingPromptWithFiles[] {
    const prompts = this.sqlite.prepare("SELECT * FROM pending_prompts WHERE conversation_id=? AND status=? ORDER BY position,id").all(conversationId, status) as PendingPromptRow[];
    const files = this.sqlite.prepare("SELECT * FROM files WHERE conversation_id=? AND pending_prompt_id IS NOT NULL ORDER BY created_at,id").all(conversationId) as FileRow[];
    return prompts.map((prompt) => ({ ...prompt, files: files.filter((file) => file.pending_prompt_id === prompt.id) }));
  }

  beginEditingPendingPrompt(id: string): PendingPromptWithFiles | undefined {
    const prompt = this.getPendingPrompt(id);
    if (!prompt || prompt.status !== "queued") return undefined;
    this.sqlite.prepare("UPDATE pending_prompts SET status='editing',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(), id);
    return this.getPendingPrompt(id);
  }

  restorePendingPrompt(id: string): PendingPromptWithFiles | undefined {
    const now = new Date().toISOString();
    this.sqlite.prepare("UPDATE pending_prompts SET status='queued',updated_at=? WHERE id=? AND status='editing'").run(now, id);
    return this.getPendingPrompt(id);
  }

  updatePendingPrompt(id: string, content: string, selection: StoredAgentSelection, quoteExcerpt: string | null = null, sourceReference: string | null = null): PendingPromptWithFiles | undefined {
    const result = this.sqlite.prepare(`
      UPDATE pending_prompts SET content=?,quote_excerpt=?,source_reference=?,agent_model=?,reasoning_effort=?,agent_provider=?,sandbox_mode=?,status='queued',updated_at=? WHERE id=?
    `).run(content, quoteExcerpt, sourceReference, selection.model, selection.reasoningEffort, selection.provider ?? null, selection.sandbox ?? "workspace-write", new Date().toISOString(), id);
    return result.changes ? this.getPendingPrompt(id) : undefined;
  }

  updateEditingPendingPrompt(id: string, content: string, selection: StoredAgentSelection, quoteExcerpt: string | null = null, sourceReference: string | null = null): PendingPromptWithFiles | undefined {
    const result = this.sqlite.prepare(`
      UPDATE pending_prompts SET content=?,quote_excerpt=?,source_reference=?,agent_model=?,reasoning_effort=?,agent_provider=?,sandbox_mode=?,updated_at=? WHERE id=? AND status='editing'
    `).run(content, quoteExcerpt, sourceReference, selection.model, selection.reasoningEffort, selection.provider ?? null, selection.sandbox ?? "workspace-write", new Date().toISOString(), id);
    return result.changes ? this.getPendingPrompt(id) : undefined;
  }

  reorderPendingPrompts(conversationId: string, orderedIds: string[]): PendingPromptWithFiles[] {
    const current = this.listPendingPrompts(conversationId, "queued").map((prompt) => prompt.id);
    if (current.length !== orderedIds.length || new Set(current).size !== new Set(orderedIds).size || current.some((id) => !orderedIds.includes(id))) {
      throw new Error("待发送队列已经变化，请刷新后重试");
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const update = this.sqlite.prepare("UPDATE pending_prompts SET position=?,updated_at=? WHERE id=? AND conversation_id=? AND status='queued'");
      const now = new Date().toISOString();
      orderedIds.forEach((id, index) => update.run(index + 1, now, id, conversationId));
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.listPendingPrompts(conversationId);
  }

  removeFile(id: string): boolean {
    return this.sqlite.prepare("DELETE FROM files WHERE id=?").run(id).changes > 0;
  }

  deletePendingPrompt(id: string): boolean {
    return this.sqlite.prepare("DELETE FROM pending_prompts WHERE id=?").run(id).changes > 0;
  }

  deletePendingPromptsForConversation(conversationId: string): number {
    return Number(this.sqlite.prepare("DELETE FROM pending_prompts WHERE conversation_id=?").run(conversationId).changes);
  }

  getNextDispatchablePendingPrompt(): PendingPromptWithFiles | undefined {
    const prompt = this.sqlite.prepare(`
      SELECT pending.* FROM pending_prompts pending
      JOIN conversations conversation ON conversation.id=pending.conversation_id
      WHERE pending.status='queued' AND conversation.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM jobs active
          WHERE active.conversation_id=pending.conversation_id AND active.status IN ('queued','running')
        )
      -- Position is the user-controlled order within each conversation. Putting
      -- it first is essential: created_at would otherwise make drag reordering
      -- cosmetic while the original insertion order kept dispatching.
      ORDER BY pending.position,pending.created_at,pending.id
      LIMIT 1
    `).get() as PendingPromptRow | undefined;
    return prompt ? this.getPendingPrompt(prompt.id) : undefined;
  }

  materializePendingPrompt(pendingId: string, messageId: string, jobId: string): JobRow | undefined {
    const prompt = this.getPendingPrompt(pendingId);
    if (!prompt || prompt.status !== "queued") return undefined;
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,source_reference,created_at) VALUES(?,?,'user',?,?,?,?)")
        .run(messageId, prompt.conversation_id, prompt.content, prompt.quote_excerpt, prompt.source_reference, now);
      this.sqlite.prepare("UPDATE files SET message_id=?,pending_prompt_id=NULL WHERE pending_prompt_id=?").run(messageId, pendingId);
      this.sqlite.prepare("DELETE FROM pending_prompts WHERE id=?").run(pendingId);
      const next = this.sqlite.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS value FROM jobs").get() as { value: number };
      this.sqlite.prepare(`
        INSERT INTO jobs(id,conversation_id,message_id,agent_model,reasoning_effort,agent_provider,sandbox_mode,queue_seq,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,'queued',?,?)
      `).run(jobId, prompt.conversation_id, messageId, prompt.agent_model, prompt.reasoning_effort, prompt.agent_provider, prompt.sandbox_mode, next.value, now, now);
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, prompt.conversation_id);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getJob(jobId);
  }

  materializeSteeredPrompt(pendingId: string, messageId: string, turnId: string | null = null): MessageRow | undefined {
    const prompt = this.getPendingPrompt(pendingId);
    if (!prompt || prompt.status !== "queued") return undefined;
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("INSERT INTO messages(id,conversation_id,role,content,quote_excerpt,source_reference,codex_turn_id,created_at) VALUES(?,?,'user',?,?,?,?,?)")
        .run(messageId, prompt.conversation_id, prompt.content, prompt.quote_excerpt, prompt.source_reference, turnId, now);
      this.sqlite.prepare("UPDATE files SET message_id=?,pending_prompt_id=NULL WHERE pending_prompt_id=?").run(messageId, pendingId);
      this.sqlite.prepare("DELETE FROM pending_prompts WHERE id=?").run(pendingId);
      this.sqlite.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, prompt.conversation_id);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getMessage(messageId);
  }

  getAgentSelectionPreference(userId = LEGACY_USER_ID): StoredAgentSelection | undefined {
    const row = this.sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='agent_selection'").get(userId) as { value: string } | undefined;
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.value) as Partial<StoredAgentSelection>;
      if (typeof value.model === "string" && typeof value.reasoningEffort === "string") {
        return {
          model: value.model,
          reasoningEffort: value.reasoningEffort,
          provider: value.provider ?? null,
          sandbox: value.sandbox ?? "workspace-write",
        };
      }
    } catch {
      // Invalid or manually edited preference is repaired by the caller.
    }
    return undefined;
  }

  setAgentSelectionPreference(selection: StoredAgentSelection, userId = LEGACY_USER_ID): void {
    this.sqlite.prepare(`
      INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'agent_selection',?,?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(userId, JSON.stringify(selection), new Date().toISOString());
  }

  getProviderManagementEnabled(userId = LEGACY_USER_ID): boolean {
    const row = this.sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='provider_management_enabled'").get(userId) as { value: string } | undefined;
    return row?.value === "true";
  }

  setProviderManagementEnabled(enabled: boolean, userId = LEGACY_USER_ID): boolean {
    this.sqlite.prepare(`
      INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'provider_management_enabled',?,?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(userId, String(enabled), new Date().toISOString());
    return enabled;
  }

  getChatFontSize(userId = LEGACY_USER_ID): number {
    const row = this.sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='chat_font_size'").get(userId) as { value: string } | undefined;
    return normalizeChatFontSize(row?.value, CHAT_FONT_SIZE_DEFAULT);
  }

  setChatFontSize(value: unknown, userId = LEGACY_USER_ID): number {
    const fontSize = normalizeChatFontSize(value, CHAT_FONT_SIZE_DEFAULT);
    this.sqlite.prepare(`
      INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'chat_font_size',?,?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(userId, String(fontSize), new Date().toISOString());
    return fontSize;
  }

  getChatColumnWidth(userId = LEGACY_USER_ID): number {
    const row = this.sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='chat_column_width'").get(userId) as { value: string } | undefined;
    return normalizeChatColumnWidth(row?.value, CHAT_COLUMN_WIDTH_DEFAULT);
  }

  setChatColumnWidth(value: unknown, userId = LEGACY_USER_ID): number {
    const columnWidth = normalizeChatColumnWidth(value, CHAT_COLUMN_WIDTH_DEFAULT);
    this.sqlite.prepare(`
      INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'chat_column_width',?,?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(userId, String(columnWidth), new Date().toISOString());
    return columnWidth;
  }

  listProviders(userId: string): ProviderRow[] {
    return this.sqlite.prepare("SELECT * FROM providers WHERE user_id=? ORDER BY created_at,id").all(userId) as unknown as ProviderRow[];
  }

  listEnabledProviders(userId: string): ProviderRow[] {
    return this.sqlite.prepare("SELECT * FROM providers WHERE user_id=? AND enabled=1 ORDER BY created_at,id").all(userId) as unknown as ProviderRow[];
  }

  getProvider(userId: string, id: string): ProviderRow | undefined {
    return this.sqlite.prepare("SELECT * FROM providers WHERE user_id=? AND id=?").get(userId, id) as ProviderRow | undefined;
  }

  createProvider(input: {
    userId: string;
    id: string;
    name: string;
    baseUrl: string;
    apiKey?: string | null;
    modelsFile?: string | null;
    autoReviewModelOverride?: string | null;
    extraConfig?: Record<string, unknown> | null;
    wireApi?: ProviderRow["wire_api"];
    requiresOpenaiAuth?: boolean;
    enabled?: boolean;
  }): ProviderRow {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO providers(user_id,id,name,base_url,api_key,models_file,auto_review_model_override,extra_config,wire_api,requires_openai_auth,enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      input.userId, input.id, input.name.trim(), input.baseUrl.trim(), input.apiKey?.trim() || null,
      input.modelsFile?.trim() || null,
      input.autoReviewModelOverride?.trim() || null,
      input.extraConfig ? JSON.stringify(input.extraConfig) : null,
      input.wireApi ?? "responses", input.requiresOpenaiAuth ? 1 : 0, input.enabled === false ? 0 : 1, now, now,
    );
    return this.getProvider(input.userId, input.id)!;
  }

  updateProvider(
    userId: string,
    id: string,
    fields: {
      name?: string;
      baseUrl?: string;
      apiKey?: string | null;
      modelsFile?: string | null;
      autoReviewModelOverride?: string | null;
      extraConfig?: Record<string, unknown> | null;
      wireApi?: ProviderRow["wire_api"];
      requiresOpenaiAuth?: boolean;
      enabled?: boolean;
    },
  ): ProviderRow | undefined {
    const existing = this.getProvider(userId, id);
    if (!existing) return undefined;
    const next = {
      name: fields.name?.trim() || existing.name,
      baseUrl: fields.baseUrl?.trim() || existing.base_url,
      apiKey: fields.apiKey === undefined ? existing.api_key : fields.apiKey?.trim() || null,
      modelsFile: fields.modelsFile === undefined ? existing.models_file : fields.modelsFile?.trim() || null,
      autoReviewModelOverride: fields.autoReviewModelOverride === undefined ? existing.auto_review_model_override : fields.autoReviewModelOverride?.trim() || null,
      extraConfig: fields.extraConfig === undefined ? existing.extra_config : fields.extraConfig ? JSON.stringify(fields.extraConfig) : null,
      wireApi: fields.wireApi ?? existing.wire_api,
      requiresOpenaiAuth: fields.requiresOpenaiAuth ?? Boolean(existing.requires_openai_auth),
      enabled: fields.enabled ?? Boolean(existing.enabled),
    };
    this.sqlite.prepare(`
      UPDATE providers SET name=?,base_url=?,api_key=?,models_file=?,auto_review_model_override=?,extra_config=?,wire_api=?,requires_openai_auth=?,enabled=?,updated_at=?
      WHERE user_id=? AND id=?
    `).run(next.name, next.baseUrl, next.apiKey, next.modelsFile, next.autoReviewModelOverride, next.extraConfig, next.wireApi, next.requiresOpenaiAuth ? 1 : 0, next.enabled ? 1 : 0, new Date().toISOString(), userId, id);
    return this.getProvider(userId, id);
  }

  deleteProvider(userId: string, id: string): boolean {
    return this.sqlite.prepare("DELETE FROM providers WHERE user_id=? AND id=?").run(userId, id).changes > 0;
  }

  isProviderReferenced(userId: string, id: string): boolean {
    const conversation = this.sqlite.prepare(
      "SELECT 1 AS found FROM conversations WHERE user_id=? AND agent_provider=? AND deleted_at IS NULL LIMIT 1",
    ).get(userId, id) as { found: number } | undefined;
    if (conversation) return true;
    const pending = this.sqlite.prepare(`
      SELECT 1 AS found FROM pending_prompts prompt
      JOIN conversations conversation ON conversation.id=prompt.conversation_id
      WHERE conversation.user_id=? AND prompt.agent_provider=? AND conversation.deleted_at IS NULL LIMIT 1
    `).get(userId, id) as { found: number } | undefined;
    if (pending) return true;
    const activeJob = this.sqlite.prepare(`
      SELECT 1 AS found FROM jobs job
      JOIN conversations conversation ON conversation.id=job.conversation_id
      WHERE conversation.user_id=? AND job.agent_provider=? AND job.status IN ('queued','running') LIMIT 1
    `).get(userId, id) as { found: number } | undefined;
    return Boolean(activeJob);
  }

  listProviderModels(userId: string, providerId?: string): ProviderModelRow[] {
    if (providerId) {
      return this.sqlite.prepare("SELECT * FROM provider_models WHERE user_id=? AND provider_id=? ORDER BY priority,created_at,id").all(userId, providerId) as unknown as ProviderModelRow[];
    }
    return this.sqlite.prepare("SELECT * FROM provider_models WHERE user_id=? ORDER BY provider_id,priority,created_at,id").all(userId) as unknown as ProviderModelRow[];
  }

  getProviderModel(userId: string, id: string): ProviderModelRow | undefined {
    return this.sqlite.prepare("SELECT * FROM provider_models WHERE user_id=? AND id=?").get(userId, id) as ProviderModelRow | undefined;
  }

  getProviderModelBySlug(userId: string, providerId: string, slug: string): ProviderModelRow | undefined {
    return this.sqlite.prepare("SELECT * FROM provider_models WHERE user_id=? AND provider_id=? AND slug=?").get(userId, providerId, slug) as ProviderModelRow | undefined;
  }

  createProviderModel(input: {
    userId: string;
    id: string;
    providerId: string;
    modelId: string;
    slug: string;
    displayName: string;
    description?: string;
    reasoningEfforts?: string[];
    inputModalities?: string[];
    modelContextWindow?: number | null;
    autoCompactTokenLimit?: number | null;
    priority?: number;
    visible?: boolean;
  }): ProviderModelRow {
    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO provider_models(user_id,id,provider_id,model_id,slug,display_name,description,reasoning_efforts,input_modalities,model_context_window,auto_compact_token_limit,priority,visible,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      input.userId, input.id, input.providerId, input.modelId.trim(), input.slug,
      input.displayName.trim() || input.modelId.trim(),
      input.description?.trim() ?? "",
      JSON.stringify(input.reasoningEfforts ?? ["low", "medium", "high", "xhigh"]),
      JSON.stringify(input.inputModalities ?? ["text", "image"]),
      input.modelContextWindow === null ? null : Number.isFinite(input.modelContextWindow) ? Math.max(1, Math.trunc(input.modelContextWindow ?? 0)) : null,
      input.autoCompactTokenLimit === null ? null : Number.isFinite(input.autoCompactTokenLimit) ? Math.max(1, Math.trunc(input.autoCompactTokenLimit ?? 0)) : null,
      Number.isFinite(input.priority) ? Math.max(0, Math.trunc(input.priority ?? 0)) : 0,
      input.visible === false ? 0 : 1,
      now, now,
    );
    return this.getProviderModel(input.userId, input.id)!;
  }

  updateProviderModel(
    userId: string,
    id: string,
    fields: {
      modelId?: string;
      slug?: string;
      displayName?: string;
      description?: string;
      reasoningEfforts?: string[];
      inputModalities?: string[];
      modelContextWindow?: number | null;
      autoCompactTokenLimit?: number | null;
      priority?: number;
      visible?: boolean;
    },
  ): ProviderModelRow | undefined {
    const existing = this.getProviderModel(userId, id);
    if (!existing) return undefined;
    const next = {
      modelId: fields.modelId?.trim() || existing.model_id,
      slug: fields.slug?.trim() || existing.slug,
      displayName: fields.displayName?.trim() || existing.display_name,
      description: fields.description?.trim() ?? existing.description,
      reasoningEfforts: fields.reasoningEfforts ? JSON.stringify(fields.reasoningEfforts) : existing.reasoning_efforts,
      inputModalities: fields.inputModalities ? JSON.stringify(fields.inputModalities) : existing.input_modalities,
      modelContextWindow: fields.modelContextWindow === undefined ? existing.model_context_window : fields.modelContextWindow,
      autoCompactTokenLimit: fields.autoCompactTokenLimit === undefined ? existing.auto_compact_token_limit : fields.autoCompactTokenLimit,
      priority: Number.isFinite(fields.priority) ? Math.max(0, Math.trunc(fields.priority ?? 0)) : existing.priority,
      visible: fields.visible ?? Boolean(existing.visible),
    };
    this.sqlite.prepare(`
      UPDATE provider_models SET model_id=?,slug=?,display_name=?,description=?,reasoning_efforts=?,input_modalities=?,model_context_window=?,auto_compact_token_limit=?,priority=?,visible=?,updated_at=?
      WHERE user_id=? AND id=?
    `).run(
      next.modelId, next.slug, next.displayName, next.description, next.reasoningEfforts, next.inputModalities, next.modelContextWindow, next.autoCompactTokenLimit,
      next.priority, next.visible ? 1 : 0, new Date().toISOString(), userId, id,
    );
    return this.getProviderModel(userId, id);
  }

  updateProviderModelSlugs(userId: string, entries: Array<{ id: string; slug: string }>): void {
    const update = this.sqlite.prepare("UPDATE provider_models SET slug=?,updated_at=? WHERE user_id=? AND id=?");
    const now = new Date().toISOString();
    for (const entry of entries) update.run(entry.slug, now, userId, entry.id);
  }

  deleteProviderModel(userId: string, id: string): boolean {
    return this.sqlite.prepare("DELETE FROM provider_models WHERE user_id=? AND id=?").run(userId, id).changes > 0;
  }

  addApiUsage(row: Omit<ApiUsageRow, "created_at"> & { created_at?: string }): void {
    this.sqlite.prepare(`
      INSERT INTO api_usage(id,user_id,job_id,conversation_id,provider_id,model_id,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      row.id, row.user_id, row.job_id, row.conversation_id, row.provider_id, row.model_id,
      row.input_tokens, row.cached_input_tokens, row.cache_write_input_tokens, row.output_tokens,
      row.reasoning_output_tokens, row.created_at ?? new Date().toISOString(),
    );
  }

  listApiUsage(userId: string, since: string): ApiUsageRow[] {
    return this.sqlite.prepare("SELECT * FROM api_usage WHERE user_id=? AND created_at>=? ORDER BY created_at DESC,id DESC").all(userId, since) as ApiUsageRow[];
  }

  listPricingRules(userId: string): PricingRuleRow[] {
    return this.sqlite.prepare("SELECT * FROM pricing_rules WHERE user_id=? ORDER BY provider_id,model_id").all(userId) as PricingRuleRow[];
  }

  listPricingRuleHistory(userId: string): PricingRuleHistoryRow[] {
    return this.sqlite.prepare("SELECT * FROM pricing_rule_history WHERE user_id=? ORDER BY effective_from DESC,id DESC").all(userId) as PricingRuleHistoryRow[];
  }

  clearPricingRuleHistory(userId: string): number {
    return Number(this.sqlite.prepare("DELETE FROM pricing_rule_history WHERE user_id=?").run(userId).changes);
  }

  getPricingRule(userId: string, providerId: string, modelId: string): PricingRuleRow | undefined {
    return this.sqlite.prepare("SELECT * FROM pricing_rules WHERE user_id=? AND provider_id=? AND model_id=?").get(userId, providerId, modelId) as PricingRuleRow | undefined;
  }

  upsertPricingRule(input: Omit<PricingRuleRow, "updated_at" | "peak_enabled" | "peak_input_per_million" | "peak_cached_input_per_million" | "peak_cache_write_per_million" | "peak_output_per_million" | "peak_start_minute" | "peak_end_minute" | "peak_weekdays" | "timezone"> & {
    peak_enabled?: number;
    peak_input_per_million?: number | null;
    peak_cached_input_per_million?: number | null;
    peak_cache_write_per_million?: number | null;
    peak_output_per_million?: number | null;
    peak_start_minute?: number | null;
    peak_end_minute?: number | null;
    peak_weekdays?: string;
    timezone?: string;
    updated_at?: string;
  }): PricingRuleRow {
    const updatedAt = input.updated_at ?? new Date().toISOString();
    const existing = this.getPricingRule(input.user_id, input.provider_id, input.model_id);
    const next = {
      inputPerMillion: input.input_per_million,
      cachedInputPerMillion: input.cached_input_per_million,
      cacheWritePerMillion: input.cache_write_per_million,
      outputPerMillion: input.output_per_million,
      currency: input.currency,
      peakEnabled: input.peak_enabled ?? existing?.peak_enabled ?? 0,
      peakInputPerMillion: input.peak_input_per_million !== undefined ? input.peak_input_per_million : existing?.peak_input_per_million ?? null,
      peakCachedInputPerMillion: input.peak_cached_input_per_million !== undefined ? input.peak_cached_input_per_million : existing?.peak_cached_input_per_million ?? null,
      peakCacheWritePerMillion: input.peak_cache_write_per_million !== undefined ? input.peak_cache_write_per_million : existing?.peak_cache_write_per_million ?? null,
      peakOutputPerMillion: input.peak_output_per_million !== undefined ? input.peak_output_per_million : existing?.peak_output_per_million ?? null,
      peakStartMinute: input.peak_start_minute !== undefined ? input.peak_start_minute : existing?.peak_start_minute ?? null,
      peakEndMinute: input.peak_end_minute !== undefined ? input.peak_end_minute : existing?.peak_end_minute ?? null,
      peakWeekdays: input.peak_weekdays !== undefined ? input.peak_weekdays : existing?.peak_weekdays ?? "1,2,3,4,5",
      timezone: input.timezone !== undefined ? input.timezone : existing?.timezone ?? "Asia/Shanghai",
    };
    const pricingChanged = !existing || existing.input_per_million !== next.inputPerMillion
      || existing.cached_input_per_million !== next.cachedInputPerMillion
      || existing.cache_write_per_million !== next.cacheWritePerMillion
      || existing.output_per_million !== next.outputPerMillion
      || existing.currency !== next.currency
      || existing.peak_enabled !== next.peakEnabled
      || existing.peak_input_per_million !== next.peakInputPerMillion
      || existing.peak_cached_input_per_million !== next.peakCachedInputPerMillion
      || existing.peak_cache_write_per_million !== next.peakCacheWritePerMillion
      || existing.peak_output_per_million !== next.peakOutputPerMillion
      || existing.peak_start_minute !== next.peakStartMinute
      || existing.peak_end_minute !== next.peakEndMinute
      || existing.peak_weekdays !== next.peakWeekdays
      || existing.timezone !== next.timezone;
    const effectiveAt = existing && !pricingChanged ? existing.updated_at : updatedAt;
    if (existing && pricingChanged && Date.parse(updatedAt) > Date.parse(existing.updated_at)) {
      this.sqlite.prepare(`
        INSERT INTO pricing_rule_history(user_id,provider_id,model_id,input_per_million,cached_input_per_million,cache_write_per_million,output_per_million,currency,source,pricing_url,peak_enabled,peak_input_per_million,peak_cached_input_per_million,peak_cache_write_per_million,peak_output_per_million,peak_start_minute,peak_end_minute,peak_weekdays,timezone,effective_from,effective_to)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        existing.user_id, existing.provider_id, existing.model_id, existing.input_per_million, existing.cached_input_per_million,
        existing.cache_write_per_million, existing.output_per_million, existing.currency, existing.source, existing.pricing_url,
        existing.peak_enabled, existing.peak_input_per_million, existing.peak_cached_input_per_million, existing.peak_cache_write_per_million,
        existing.peak_output_per_million, existing.peak_start_minute, existing.peak_end_minute, existing.peak_weekdays, existing.timezone,
        existing.updated_at, updatedAt,
      );
    }
    this.sqlite.prepare(`
      INSERT INTO pricing_rules(user_id,provider_id,model_id,input_per_million,cached_input_per_million,cache_write_per_million,output_per_million,currency,source,pricing_url,peak_enabled,peak_input_per_million,peak_cached_input_per_million,peak_cache_write_per_million,peak_output_per_million,peak_start_minute,peak_end_minute,peak_weekdays,timezone,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,provider_id,model_id) DO UPDATE SET
        input_per_million=excluded.input_per_million,
        cached_input_per_million=excluded.cached_input_per_million,
        cache_write_per_million=excluded.cache_write_per_million,
        output_per_million=excluded.output_per_million,
        currency=excluded.currency,
        source=excluded.source,
        pricing_url=excluded.pricing_url,
        peak_enabled=excluded.peak_enabled,
        peak_input_per_million=excluded.peak_input_per_million,
        peak_cached_input_per_million=excluded.peak_cached_input_per_million,
        peak_cache_write_per_million=excluded.peak_cache_write_per_million,
        peak_output_per_million=excluded.peak_output_per_million,
        peak_start_minute=excluded.peak_start_minute,
        peak_end_minute=excluded.peak_end_minute,
        peak_weekdays=excluded.peak_weekdays,
        timezone=excluded.timezone,
        updated_at=excluded.updated_at
    `).run(
      input.user_id, input.provider_id, input.model_id, input.input_per_million, input.cached_input_per_million,
      input.cache_write_per_million, input.output_per_million, input.currency, input.source, input.pricing_url,
      next.peakEnabled, next.peakInputPerMillion, next.peakCachedInputPerMillion, next.peakCacheWritePerMillion,
      next.peakOutputPerMillion, next.peakStartMinute, next.peakEndMinute, next.peakWeekdays, next.timezone,
      effectiveAt,
    );
    return this.getPricingRule(input.user_id, input.provider_id, input.model_id)!;
  }

  getFavoriteWorkingDirectories(userId = LEGACY_USER_ID): WorkingDirectoryFavorite[] {
    const row = this.sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='favorite_working_dirs'").get(userId) as { value: string } | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.value) as unknown;
      if (!Array.isArray(parsed)) return [];
      const favorites: WorkingDirectoryFavorite[] = [];
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const record = item as Partial<WorkingDirectoryFavorite>;
        if (typeof record.path !== "string" || !record.path || typeof record.label !== "string") continue;
        favorites.push({
          path: record.path,
          label: record.label,
          added_at: typeof record.added_at === "string" ? record.added_at : new Date(0).toISOString(),
        });
      }
      return favorites;
    } catch {
      return [];
    }
  }

  setFavoriteWorkingDirectories(favorites: WorkingDirectoryFavorite[], userId = LEGACY_USER_ID): void {
    const safe = favorites.map((favorite) => ({
      path: favorite.path,
      label: favorite.label,
      added_at: favorite.added_at,
    }));
    this.sqlite.prepare(`
      INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'favorite_working_dirs',?,?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(userId, JSON.stringify(safe), new Date().toISOString());
  }

  getDefaultWorkingDir(userId = LEGACY_USER_ID): string | null {
    const row = this.sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='default_working_dir'").get(userId) as { value: string } | undefined;
    return row?.value || null;
  }

  setDefaultWorkingDir(workingDir: string | null, userId = LEGACY_USER_ID): void {
    if (workingDir === null) {
      this.sqlite.prepare("DELETE FROM user_settings WHERE user_id=? AND key='default_working_dir'").run(userId);
      return;
    }
    this.sqlite.prepare(`
      INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'default_working_dir',?,?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(userId, workingDir, new Date().toISOString());
  }

  getTaskListCategorySettings(userId = LEGACY_USER_ID): TaskListCategorySettings {
    const row = this.sqlite.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='task_list_categories'").get(userId) as { value: string } | undefined;
    if (!row) return { customCategories: [], pinned: [], hidden: [], conversationOrders: {} };
    try {
      const parsed = JSON.parse(row.value) as Partial<TaskListCategorySettings> | null;
      if (!parsed || typeof parsed !== "object") return { customCategories: [], pinned: [], hidden: [], conversationOrders: {} };
      const customCategories: TaskListCustomCategory[] = [];
      if (Array.isArray(parsed.customCategories)) {
        for (const item of parsed.customCategories.slice(0, 100)) {
          if (!item || typeof item !== "object") continue;
          const record = item as Partial<TaskListCustomCategory>;
          if (typeof record.id !== "string" || !record.id || typeof record.name !== "string" || !record.name.trim()) continue;
          const assignedDirs = Array.isArray(record.assignedDirs)
            ? [...new Set(record.assignedDirs.filter((dir): dir is string => typeof dir === "string" && dir.startsWith("/")))].slice(0, 500)
            : [];
          customCategories.push({ id: record.id, name: record.name.trim().slice(0, 100), assignedDirs });
        }
      }
      const pinned = Array.isArray(parsed.pinned)
        ? [...new Set(parsed.pinned.filter((key): key is string => typeof key === "string" && key.length > 0))].slice(0, 100)
        : [];
      const hidden = Array.isArray(parsed.hidden)
        ? [...new Set(parsed.hidden.filter((key): key is string => typeof key === "string" && key.length > 0))].slice(0, 100)
        : [];
      const conversationOrders: Record<string, string[]> = {};
      if (parsed.conversationOrders && typeof parsed.conversationOrders === "object" && !Array.isArray(parsed.conversationOrders)) {
        const entries = Object.entries(parsed.conversationOrders as Record<string, unknown>);
        for (const [categoryKey, rawIds] of entries.slice(0, 200)) {
          if (!categoryKey || !Array.isArray(rawIds)) continue;
          const ids = [...new Set(rawIds.filter((id): id is string => typeof id === "string" && id.length > 0))].slice(0, 2000);
          if (ids.length) conversationOrders[categoryKey] = ids;
        }
      }
      return { customCategories, pinned, hidden, conversationOrders };
    } catch {
      return { customCategories: [], pinned: [], hidden: [], conversationOrders: {} };
    }
  }

  setTaskListCategorySettings(settings: TaskListCategorySettings, userId = LEGACY_USER_ID): void {
    const safe: TaskListCategorySettings = {
      customCategories: settings.customCategories.slice(0, 100).map((category) => ({
        id: category.id,
        name: category.name.trim().slice(0, 100),
        assignedDirs: [...new Set(category.assignedDirs.filter((dir) => dir.startsWith("/")))].slice(0, 500),
      })),
      pinned: [...new Set(settings.pinned.filter((key) => key.length > 0))].slice(0, 100),
      hidden: [...new Set(settings.hidden.filter((key) => key.length > 0))].slice(0, 100),
      conversationOrders: Object.fromEntries(
        Object.entries(settings.conversationOrders ?? {})
          .slice(0, 200)
          .map(([categoryKey, ids]) => [
            categoryKey,
            [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))].slice(0, 2000),
          ])
          .filter(([, ids]) => (ids as string[]).length > 0),
      ),
    };
    this.sqlite.prepare(`
      INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'task_list_categories',?,?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(userId, JSON.stringify(safe), new Date().toISOString());
  }

  listPresetPrompts(userId = LEGACY_USER_ID): PresetPromptRow[] {
    return this.sqlite.prepare("SELECT * FROM preset_prompts WHERE user_id=? ORDER BY position,created_at,id").all(userId) as PresetPromptRow[];
  }

  getPresetPrompt(userId: string, id: string): PresetPromptRow | undefined {
    return this.sqlite.prepare("SELECT * FROM preset_prompts WHERE user_id=? AND id=?").get(userId, id) as PresetPromptRow | undefined;
  }

  createPresetPrompt(userId: string, id: string, name: string, content: string, defaultEnabled = false): PresetPromptRow {
    const now = new Date().toISOString();
    const next = this.sqlite.prepare("SELECT COALESCE(MAX(position),-1)+1 AS value FROM preset_prompts WHERE user_id=?").get(userId) as { value: number };
    this.sqlite.prepare("INSERT INTO preset_prompts(id,user_id,name,content,position,default_enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, userId, name, content, next.value, defaultEnabled ? 1 : 0, now, now);
    return this.getPresetPrompt(userId, id)!;
  }

  updatePresetPrompt(userId: string, id: string, fields: { name?: string; content?: string; position?: number; defaultEnabled?: boolean }): PresetPromptRow | undefined {
    const current = this.getPresetPrompt(userId, id);
    if (!current) return undefined;
    const now = new Date().toISOString();
    this.sqlite.prepare("UPDATE preset_prompts SET name=?,content=?,position=?,default_enabled=?,updated_at=? WHERE user_id=? AND id=?")
      .run(
        fields.name ?? current.name,
        fields.content ?? current.content,
        fields.position ?? current.position,
        fields.defaultEnabled === undefined ? current.default_enabled : (fields.defaultEnabled ? 1 : 0),
        now,
        userId,
        id,
      );
    return this.getPresetPrompt(userId, id);
  }

  deletePresetPrompt(userId: string, id: string): boolean {
    return this.sqlite.prepare("DELETE FROM preset_prompts WHERE user_id=? AND id=?").run(userId, id).changes > 0;
  }

  getConversationPresetPromptIds(conversationId: string): string[] {
    const rows = this.sqlite.prepare(`
      SELECT link.preset_prompt_id AS id
      FROM conversation_preset_prompts link
      JOIN preset_prompts preset ON preset.id=link.preset_prompt_id
      WHERE link.conversation_id=?
      ORDER BY link.position,preset.position,link.preset_prompt_id
    `).all(conversationId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  setConversationPresetPrompts(conversationId: string, userId: string, presetPromptIds: string[]): string[] | null {
    const conversation = this.getConversationForUser(conversationId, userId);
    if (!conversation) return null;
    const uniqueIds = [...new Set(presetPromptIds)];
    if (uniqueIds.length > MAX_CONVERSATION_PRESET_PROMPTS) return null;
    const validIds: string[] = [];
    for (const id of uniqueIds) {
      if (!this.getPresetPrompt(userId, id)) return null;
      validIds.push(id);
    }
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("DELETE FROM conversation_preset_prompts WHERE conversation_id=?").run(conversationId);
      const insert = this.sqlite.prepare("INSERT INTO conversation_preset_prompts(conversation_id,preset_prompt_id,position,created_at) VALUES(?,?,?,?)");
      validIds.forEach((id, index) => insert.run(conversationId, id, index, now));
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return validIds;
  }

  applyDefaultPresetPrompts(conversationId: string, userId: string): string[] {
    const defaultIds = this.listPresetPrompts(userId)
      .filter((preset) => preset.default_enabled)
      .slice(0, MAX_CONVERSATION_PRESET_PROMPTS)
      .map((preset) => preset.id);
    if (defaultIds.length === 0) return [];
    return this.setConversationPresetPrompts(conversationId, userId, defaultIds) ?? [];
  }

  listEnabledPresetPrompts(conversationId: string): EnabledPresetPrompt[] {
    return this.sqlite.prepare(`
      SELECT preset.id,preset.name,preset.content,link.position
      FROM conversation_preset_prompts link
      JOIN preset_prompts preset ON preset.id=link.preset_prompt_id
      WHERE link.conversation_id=?
      ORDER BY link.position,preset.position,preset.id
    `).all(conversationId) as EnabledPresetPrompt[];
  }

  createJob(id: string, conversationId: string, messageId?: string, selection?: StoredAgentSelection, forkBeforeTurnId: string | null = null): JobRow {
    const now = new Date().toISOString();
    const next = this.sqlite.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 AS value FROM jobs").get() as { value: number };
    this.sqlite.prepare("INSERT INTO jobs(id,conversation_id,message_id,agent_model,reasoning_effort,agent_provider,sandbox_mode,fork_before_turn_id,queue_seq,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?)").run(
      id, conversationId, messageId ?? null, selection?.model ?? null, selection?.reasoningEffort ?? null,
      selection?.provider ?? null, selection?.sandbox ?? "workspace-write", forkBeforeTurnId, next.value, now, now,
    );
    return this.getJob(id)!;
  }

  getJob(id: string): JobRow | undefined {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow | undefined;
  }

  getJobForUser(id: string, userId: string): JobRow | undefined {
    return this.sqlite.prepare("SELECT j.* FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.id=? AND c.user_id=? AND c.deleted_at IS NULL").get(id, userId) as JobRow | undefined;
  }

  getRunningJob(): JobRow | undefined {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE status='running' ORDER BY queue_seq LIMIT 1").get() as JobRow | undefined;
  }

  runningJobCount(): number {
    return Number((this.sqlite.prepare("SELECT count(1) AS count FROM jobs WHERE status='running'").get() as { count: number }).count);
  }

  getNextQueuedJob(): JobRow | undefined {
    return this.sqlite.prepare("SELECT j.* FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.status='queued' AND c.deleted_at IS NULL ORDER BY j.queue_seq LIMIT 1").get() as JobRow | undefined;
  }

  getNextSkipQueueJob(): JobRow | undefined {
    return this.sqlite.prepare(`
      SELECT j.* FROM jobs j JOIN conversations c ON c.id=j.conversation_id
      WHERE j.status='queued' AND j.skip_queue=1 AND c.deleted_at IS NULL
      ORDER BY j.queue_seq
      LIMIT 1
    `).get() as JobRow | undefined;
  }

  getNextRunnableQueuedJob(): JobRow | undefined {
    return this.sqlite.prepare(`
      SELECT queued.* FROM jobs queued JOIN conversations conversation ON conversation.id=queued.conversation_id
      WHERE queued.status='queued'
        AND conversation.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM jobs running
          JOIN conversations running_conversation ON running_conversation.id=running.conversation_id
          WHERE running.status='running'
            AND (
              running.conversation_id=queued.conversation_id
              OR (
                running_conversation.working_dir IS NOT NULL
                AND running_conversation.working_dir=conversation.working_dir
              )
            )
        )
      ORDER BY queued.queue_seq
      LIMIT 1
    `).get() as JobRow | undefined;
  }

  listQueuedJobs(): JobRow[] {
    return this.sqlite.prepare("SELECT j.* FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.status='queued' AND c.deleted_at IS NULL ORDER BY j.queue_seq").all() as JobRow[];
  }

  getActiveJob(): JobRow | undefined {
    return this.sqlite.prepare("SELECT j.* FROM jobs j JOIN conversations c ON c.id=j.conversation_id WHERE j.status IN ('running','queued') AND c.deleted_at IS NULL ORDER BY CASE j.status WHEN 'running' THEN 0 ELSE 1 END,j.queue_seq LIMIT 1").get() as JobRow | undefined;
  }

  getActiveJobForConversation(conversationId: string): JobRow | undefined {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE conversation_id=? AND status IN ('queued','running') ORDER BY created_at DESC,id DESC LIMIT 1").get(conversationId) as JobRow | undefined;
  }

  listActiveJobsForConversation(conversationId: string): JobRow[] {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE conversation_id=? AND status IN ('queued','running') ORDER BY queue_seq,id").all(conversationId) as JobRow[];
  }

  listActiveJobsForWorkingDir(workingDir: string): JobRow[] {
    return this.sqlite.prepare(`
      SELECT job.* FROM jobs job
      JOIN conversations conversation ON conversation.id=job.conversation_id
      WHERE job.status IN ('queued','running')
        AND conversation.deleted_at IS NULL
        AND conversation.working_dir=?
      ORDER BY job.queue_seq,job.id
    `).all(workingDir) as JobRow[];
  }

  getLatestJobForConversation(conversationId: string): JobRow | undefined {
    return this.sqlite.prepare("SELECT * FROM jobs WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(conversationId) as JobRow | undefined;
  }

  getQueuePosition(jobId: string): number | undefined {
    const job = this.getJob(jobId);
    if (!job || !["queued", "running"].includes(job.status)) return undefined;
    if (job.status === "running") return 0;
    const conversation = this.getConversation(job.conversation_id);
    if (!conversation) return undefined;
    // Shared working directories serialize jobs across conversations, so the
    // visible queue position must count every active job in that directory,
    // not only the jobs of the current conversation. Standalone workspaces
    // stay scoped to their own conversation.
    const active = conversation.working_dir
      ? this.listActiveJobsForWorkingDir(conversation.working_dir)
      : this.listActiveJobsForConversation(conversation.id);
    const runningAhead = active.filter((candidate) => candidate.status === "running").length;
    const queuedAhead = active
      .filter((candidate) => candidate.status === "queued" && candidate.id !== job.id)
      .sort((left, right) => Number(right.skip_queue) - Number(left.skip_queue) || left.queue_seq - right.queue_seq)
      .filter((candidate) => {
        if (candidate.skip_queue === 1) return job.skip_queue === 1 ? candidate.queue_seq < job.queue_seq : true;
        return job.skip_queue === 1 ? false : candidate.queue_seq < job.queue_seq;
      }).length;
    return runningAhead + queuedAhead + 1;
  }

  updateJob(id: string, status: JobStatus, error: string | null = null): void {
    this.sqlite.prepare("UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?").run(status, error, new Date().toISOString(), id);
  }

  markJobSkipQueue(id: string): boolean {
    const result = this.sqlite.prepare("UPDATE jobs SET skip_queue=1,updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  startJobImmediately(id: string): JobRow | undefined {
    const job = this.getJob(id);
    if (!job || job.status !== "queued") return undefined;
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = this.sqlite.prepare("UPDATE jobs SET status='running',skip_queue=1,updated_at=? WHERE id=? AND status='queued'").run(now, id);
      if (result.changes === 0) {
        this.sqlite.exec("ROLLBACK");
        return undefined;
      }
      this.sqlite.prepare("UPDATE conversations SET status='running',updated_at=? WHERE id=?").run(now, job.conversation_id);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
    return this.getJob(id);
  }

  cancelQueuedJob(id: string): boolean {
    const result = this.sqlite.prepare("UPDATE jobs SET status='cancelled',error='任务已停止',updated_at=? WHERE id=? AND status='queued'").run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  finishJob(id: string, conversationId: string, status: Exclude<JobStatus, "queued" | "running">, error: string | null = null): void {
    const now = new Date().toISOString();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.prepare("UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?").run(status, error, now, id);
      this.sqlite.prepare(`
        UPDATE conversations
        SET status='idle', has_unread_result=CASE WHEN ?='completed' THEN 1 ELSE has_unread_result END, updated_at=?
        WHERE id=?
      `).run(status, now, conversationId);
      this.sqlite.exec("COMMIT");
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  appendEvent(jobId: string, eventType: string, payload: unknown): number {
    const row = this.sqlite.prepare("SELECT COALESCE(MAX(seq),0)+1 AS seq FROM job_events WHERE job_id=?").get(jobId) as { seq: number };
    const now = new Date().toISOString();
    this.sqlite.prepare("INSERT INTO job_events(job_id,seq,event_type,payload,created_at) VALUES(?,?,?,?,?)").run(jobId, row.seq, eventType, JSON.stringify(payload), now);
    this.sqlite.prepare("UPDATE jobs SET updated_at=? WHERE id=?").run(now, jobId);
    return row.seq;
  }

  listEvents(jobId: string, after = 0): JobEventRow[] {
    return this.sqlite.prepare("SELECT seq,event_type,payload,created_at FROM job_events WHERE job_id=? AND seq>? ORDER BY seq").all(jobId, after) as JobEventRow[];
  }

  createSession(tokenHash: string, csrfToken: string, expiresAt: string, userId = LEGACY_USER_ID): void {
    const now = new Date().toISOString();
    this.sqlite.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now);
    this.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES(?,?,?,?,?)").run(tokenHash, userId, csrfToken, now, expiresAt);
  }

  getSession(tokenHash: string): SessionRow | undefined {
    return this.sqlite.prepare(`
      SELECT s.token_hash,s.csrf_token,s.expires_at,s.user_id,u.username,u.display_name,u.role
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'
    `).get(tokenHash, new Date().toISOString()) as SessionRow | undefined;
  }

  deleteSession(tokenHash: string): void {
    this.sqlite.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
  }

  close(): void {
    this.sqlite.close();
  }
}
