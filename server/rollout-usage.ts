import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { type ApiUsageRow, type AppDatabase, type RolloutUsageCursorRow } from "./db.js";
import { BUILTIN_PROVIDER_ID, type TokenUsage } from "./billing.js";
import { hostTenantFor } from "./host-mode.js";
import { tenantPaths } from "./paths.js";

const SESSION_DIRECTORIES = ["sessions", "archived_sessions"] as const;
const MAX_USAGE_LINE_BYTES = 2 * 1024 * 1024;
const DEFAULT_SCAN_INTERVAL_MS = 60_000;
const THREAD_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type UsageLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
};

type RolloutSource = { userId: string; root: string; sourceId: string };
type CursorState = Omit<RolloutUsageCursorRow, "user_id" | "source_id" | "file_key" | "relative_path" | "byte_offset" | "file_size" | "updated_at">;

export type RolloutUsageSyncResult = {
  filesScanned: number;
  inserted: number;
  updated: number;
  unchanged: number;
};

function emptyUsage(): TokenUsage {
  return { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
}

function emptyState(fileName: string): CursorState {
  return {
    thread_id: fileName.match(THREAD_ID_PATTERN)?.[0]?.toLowerCase() ?? null,
    originator: null,
    provider_id: null,
    turn_id: null,
    model_id: null,
    turn_started_at: null,
    last_usage_at: null,
    ...emptyUsage(),
  };
}

function stateFromCursor(cursor: RolloutUsageCursorRow | undefined, fileName: string): CursorState {
  if (!cursor) return emptyState(fileName);
  return {
    thread_id: cursor.thread_id,
    originator: cursor.originator,
    provider_id: cursor.provider_id,
    turn_id: cursor.turn_id,
    model_id: cursor.model_id,
    turn_started_at: cursor.turn_started_at,
    last_usage_at: cursor.last_usage_at,
    input_tokens: cursor.input_tokens,
    cached_input_tokens: cursor.cached_input_tokens,
    cache_write_input_tokens: cursor.cache_write_input_tokens,
    output_tokens: cursor.output_tokens,
    reasoning_output_tokens: cursor.reasoning_output_tokens,
  };
}

function nonNegativeInteger(value: unknown): number {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function parseUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"];
  if (!keys.some((key) => key in record)) return null;
  return {
    input_tokens: nonNegativeInteger(record.input_tokens),
    cached_input_tokens: nonNegativeInteger(record.cached_input_tokens),
    cache_write_input_tokens: nonNegativeInteger(record.cache_write_input_tokens),
    output_tokens: nonNegativeInteger(record.output_tokens),
    reasoning_output_tokens: nonNegativeInteger(record.reasoning_output_tokens),
  };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    cache_write_input_tokens: left.cache_write_input_tokens + right.cache_write_input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    reasoning_output_tokens: left.reasoning_output_tokens + right.reasoning_output_tokens,
  };
}

async function sessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(absolute);
    }
  };
  for (const name of SESSION_DIRECTORIES) await visit(path.join(root, name));
  return files;
}

async function readCompleteLines(filePath: string, start: number, onLine: (line: Buffer) => void): Promise<number> {
  let pending = Buffer.alloc(0);
  let offset = start;
  const input = fs.createReadStream(filePath, { start, highWaterMark: 256 * 1024 });
  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    let newline = data.indexOf(0x0a);
    while (newline >= 0) {
      const line = data.subarray(0, newline > 0 && data[newline - 1] === 0x0d ? newline - 1 : newline);
      onLine(line);
      offset += newline + 1;
      data = data.subarray(newline + 1);
      newline = data.indexOf(0x0a);
    }
    pending = data;
  }
  return offset;
}

function sourceId(root: string): string {
  return crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24);
}

function sourcesFor(config: AppConfig, db: AppDatabase, requestedUserId?: string): RolloutSource[] {
  const sources: RolloutSource[] = [];
  const seen = new Set<string>();
  for (const user of db.listUsers()) {
    if (user.status !== "active" || (requestedUserId && user.id !== requestedUserId)) continue;
    const roots = config.hostMode
      ? (() => {
          const host = hostTenantFor(config, db, user.id);
          return host ? [host.sourceCodexHome, host.codexHome] : [];
        })()
      : [tenantPaths(config.tenantRoot, user.id).codexHome];
    for (const root of roots) {
      const resolved = path.resolve(root);
      const key = `${user.id}:${resolved}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ userId: user.id, root: resolved, sourceId: sourceId(resolved) });
    }
  }
  return sources;
}

export class RolloutUsageSynchronizer {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly active = new Set<Promise<unknown>>();
  private readonly userScans = new Map<string, Promise<RolloutUsageSyncResult>>();
  private readonly webCutoff: number;

  constructor(
    private readonly config: AppConfig,
    private readonly db: AppDatabase,
    private readonly logger?: UsageLogger,
    private readonly intervalMs = DEFAULT_SCAN_INTERVAL_MS,
  ) {
    this.webCutoff = Date.parse(db.rolloutUsageCutoff());
  }

  start(): void {
    if (this.timer || this.stopped) return;
    setImmediate(() => this.track(this.scanAll()));
    this.timer = setInterval(() => this.track(this.scanAll()), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.active]);
  }

  async scanAll(): Promise<RolloutUsageSyncResult> {
    const total: RolloutUsageSyncResult = { filesScanned: 0, inserted: 0, updated: 0, unchanged: 0 };
    if (this.stopped) return total;
    for (const user of this.db.listUsers()) {
      if (user.status !== "active") continue;
      const result = await this.scanUser(user.id);
      total.filesScanned += result.filesScanned;
      total.inserted += result.inserted;
      total.updated += result.updated;
      total.unchanged += result.unchanged;
    }
    if (total.inserted || total.updated) this.logger?.info(total, "Codex rollout usage synchronized");
    return total;
  }

  scanUser(userId: string): Promise<RolloutUsageSyncResult> {
    const total: RolloutUsageSyncResult = { filesScanned: 0, inserted: 0, updated: 0, unchanged: 0 };
    if (this.stopped) return Promise.resolve(total);
    const existing = this.userScans.get(userId);
    if (existing) return existing;
    const scan = this.scanUserUnlocked(userId).finally(() => {
      this.userScans.delete(userId);
      this.active.delete(scan);
    });
    this.userScans.set(userId, scan);
    this.active.add(scan);
    return scan;
  }

  private async scanUserUnlocked(userId: string): Promise<RolloutUsageSyncResult> {
    const total: RolloutUsageSyncResult = { filesScanned: 0, inserted: 0, updated: 0, unchanged: 0 };
    for (const source of sourcesFor(this.config, this.db, userId)) {
      for (const filePath of await sessionFiles(source.root)) {
        try {
          const result = await this.scanFile(source, filePath);
          total.filesScanned += 1;
          total.inserted += result.inserted;
          total.updated += result.updated;
          total.unchanged += result.unchanged;
        } catch (error) {
          this.logger?.warn({ userId, file: path.relative(source.root, filePath), error: error instanceof Error ? error.message : String(error) }, "Failed to scan Codex rollout usage");
        }
      }
    }
    return total;
  }

  private track(promise: Promise<unknown>): void {
    this.active.add(promise);
    void promise.catch((error) => {
      this.logger?.warn({ error: error instanceof Error ? error.message : String(error) }, "Codex rollout usage synchronization failed");
    }).finally(() => this.active.delete(promise));
  }

  private async scanFile(source: RolloutSource, filePath: string): Promise<Omit<RolloutUsageSyncResult, "filesScanned">> {
    const fileKey = path.basename(filePath);
    const relativePath = path.relative(source.root, filePath);
    const stat = await fs.promises.stat(filePath);
    const saved = this.db.getRolloutUsageCursor(source.userId, source.sourceId, fileKey);
    const reset = !saved || stat.size < saved.byte_offset;
    const start = reset ? 0 : saved.byte_offset;
    if (!reset && stat.size === start) return { inserted: 0, updated: 0, unchanged: 0 };
    let state = reset ? emptyState(fileKey) : stateFromCursor(saved, fileKey);
    const pending = new Map<string, Omit<ApiUsageRow, "id">>();

    const offset = await readCompleteLines(filePath, start, (line) => {
      if (line.length === 0 || line.length > MAX_USAGE_LINE_BYTES) return;
      let parsed: unknown;
      try { parsed = JSON.parse(line.toString("utf8")); }
      catch { return; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const record = parsed as Record<string, unknown>;
      const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
        ? record.payload as Record<string, unknown> : {};
      const timestamp = typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp)) ? record.timestamp : null;
      if (record.type === "session_meta") {
        if (typeof payload.id === "string" && THREAD_ID_PATTERN.test(payload.id)) state.thread_id = payload.id.toLowerCase();
        if (typeof payload.originator === "string" && payload.originator.trim()) state.originator = payload.originator.trim();
        if (typeof payload.model_provider === "string" && payload.model_provider.trim()) state.provider_id = payload.model_provider.trim();
        return;
      }
      if (record.type === "turn_context") {
        const turnId = typeof payload.turn_id === "string" && payload.turn_id.trim() ? payload.turn_id.trim() : null;
        if (turnId && turnId !== state.turn_id) {
          state = {
            ...state,
            turn_id: turnId,
            model_id: typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : null,
            turn_started_at: timestamp,
            last_usage_at: null,
            ...emptyUsage(),
          };
        } else if (typeof payload.model === "string" && payload.model.trim()) {
          state.model_id = payload.model.trim();
        }
        return;
      }
      if (record.type !== "event_msg" || payload.type !== "token_count") return;
      const info = payload.info && typeof payload.info === "object" && !Array.isArray(payload.info)
        ? payload.info as Record<string, unknown> : null;
      const usage = parseUsage(info?.last_token_usage);
      if (!usage || !state.thread_id || !state.turn_id || !state.model_id) return;
      const aggregate = addUsage(state, usage);
      Object.assign(state, aggregate);
      state.last_usage_at = timestamp ?? state.last_usage_at ?? state.turn_started_at;
      const isHistoricalWeb = state.originator?.toLowerCase() === "codex-web"
        && (!state.last_usage_at || Date.parse(state.last_usage_at) < this.webCutoff);
      if (isHistoricalWeb) return;
      pending.set(state.turn_id, {
        user_id: source.userId,
        job_id: null,
        conversation_id: null,
        provider_id: state.provider_id ?? BUILTIN_PROVIDER_ID,
        model_id: state.model_id,
        source_kind: "rollout",
        originator: state.originator ?? "codex-cli",
        thread_id: state.thread_id,
        turn_id: state.turn_id,
        input_tokens: state.input_tokens,
        cached_input_tokens: state.cached_input_tokens,
        cache_write_input_tokens: state.cache_write_input_tokens,
        output_tokens: state.output_tokens,
        reasoning_output_tokens: state.reasoning_output_tokens,
        created_at: state.last_usage_at ?? state.turn_started_at ?? stat.mtime.toISOString(),
      });
    });

    const result = { inserted: 0, updated: 0, unchanged: 0 };
    for (const usage of pending.values()) result[this.db.upsertApiUsage(usage)] += 1;
    const finalStat = await fs.promises.stat(filePath);
    this.db.upsertRolloutUsageCursor({
      user_id: source.userId,
      source_id: source.sourceId,
      file_key: fileKey,
      relative_path: relativePath,
      byte_offset: offset,
      file_size: finalStat.size,
      ...state,
    });
    return result;
  }
}
