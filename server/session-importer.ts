import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";
import type { AppDatabase } from "./db.js";
import { findCodexThreadFiles, newId } from "./paths.js";
import { sanitizeAgentMarkdown } from "../src/agent-content.js";

/** Sessions larger than this are refused because parsing them into messages is impractical. */
export const SESSION_IMPORT_MAX_BYTES = 256 * 1024 * 1024;
/** Discovery only reads the head of each rollout to stay cheap on huge session files. */
export const SESSION_DISCOVERY_HEAD_BYTES = 96 * 1024;
/** Full import refuses to scan more than this many lines. */
export const SESSION_IMPORT_MAX_LINES = 500_000;
const SESSION_MAX_LINE_BYTES = 8 * 1024 * 1024;
const THREAD_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

export type ParsedSessionUserMessage = { content: string; createdAt: string };
export type ParsedSessionAssistantMessage = { content: string; createdAt: string };
export type ParsedSessionTurn = {
  user: ParsedSessionUserMessage;
  assistant?: ParsedSessionAssistantMessage;
};

type SessionScan = {
  threadId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  cwd: string | null;
  originator: string | null;
  model: string | null;
  reasoningEffort: string | null;
  firstUserMessage: string | null;
  turns: ParsedSessionTurn[];
};

function isInjectedUserContext(content: string): boolean {
  const trimmed = content.trimStart();
  return trimmed.startsWith("# AGENTS.md instructions for")
    || trimmed.startsWith("<permissions instructions>")
    || trimmed.startsWith("<collaboration_mode>");
}

async function scanSessionFile(filePath: string, options: { maxBytes?: number; maxLines?: number; collectTurns: boolean }): Promise<SessionScan> {
  const scan: SessionScan = {
    threadId: null, createdAt: null, updatedAt: null, cwd: null, originator: null,
    model: null, reasoningEffort: null, firstUserMessage: null, turns: [],
  };
  const userStarts: Array<{ content: string; createdAt: string; event: boolean }> = [];
  const assistantCompletions: Array<{ content: string; createdAt: string }> = [];
  let consumedBytes = 0;
  let consumedLines = 0;
  const lines = readline.createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    consumedLines += 1;
    consumedBytes += Buffer.byteLength(line, "utf8") + 1;
    if (options.maxLines && consumedLines > options.maxLines) throw new Error("会话文件行数超过导入上限");
    if (Buffer.byteLength(line, "utf8") > SESSION_MAX_LINE_BYTES) continue; // giant tool outputs carry no UI history
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const item = record as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";
    const timestamp = typeof item.timestamp === "string" ? item.timestamp : null;
    const payload = item.payload && typeof item.payload === "object" ? item.payload as Record<string, unknown> : {};
    if (timestamp) scan.updatedAt = timestamp;
    if (type === "session_meta") {
      if (!scan.threadId && typeof payload.id === "string") scan.threadId = payload.id;
      if (!scan.createdAt && typeof payload.timestamp === "string") scan.createdAt = payload.timestamp;
      if (typeof payload.cwd === "string") scan.cwd = payload.cwd;
      if (typeof payload.originator === "string") scan.originator = payload.originator;
    } else if (type === "turn_context") {
      if (!scan.model && typeof payload.model === "string") scan.model = payload.model;
      if (!scan.reasoningEffort) {
        const mode = payload.collaboration_mode;
        if (mode && typeof mode === "object") {
          const settings = (mode as Record<string, unknown>).settings;
          if (settings && typeof settings === "object" && typeof (settings as Record<string, unknown>).reasoning_effort === "string") {
            scan.reasoningEffort = (settings as Record<string, unknown>).reasoning_effort as string;
          }
        }
      }
    } else if (type === "event_msg") {
      const eventType = typeof payload.type === "string" ? payload.type : "";
      if (eventType === "user_message") {
        const content = typeof payload.message === "string" ? payload.message : "";
        if (content && timestamp) {
          userStarts.push({ content, createdAt: timestamp, event: true });
        }
      } else if (eventType === "task_complete") {
        const content = typeof payload.last_agent_message === "string" ? payload.last_agent_message : "";
        if (content && timestamp) assistantCompletions.push({ content, createdAt: timestamp });
      }
    } else if (type === "response_item") {
      const itemType = typeof payload.type === "string" ? payload.type : "";
      const role = typeof payload.role === "string" ? payload.role : "";
      if (itemType === "message" && role === "user" && timestamp) {
        const content = extractContentText(payload.content);
        if (content) userStarts.push({ content, createdAt: timestamp, event: false });
      } else if (itemType === "message" && role === "assistant" && timestamp) {
        const content = extractContentText(payload.content);
        if (content) assistantCompletions.push({ content, createdAt: timestamp });
      }
    }
    if (options.maxBytes && consumedBytes >= options.maxBytes) break;
  }
  const eventUsers = userStarts.filter((user) => user.event);
  const fallbackUsers = userStarts.filter((user) => !user.event && !isInjectedUserContext(user.content));
  const effectiveUsers = (eventUsers.length > 0 ? eventUsers : fallbackUsers)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.event === b.event ? 0 : a.event ? -1 : 1));
  scan.firstUserMessage = effectiveUsers[0]?.content ?? null;
  if (options.collectTurns) {
    for (let index = 0; index < effectiveUsers.length; index += 1) {
      const user = effectiveUsers[index];
      const windowEnd = index + 1 < effectiveUsers.length ? effectiveUsers[index + 1].createdAt : null;
      const candidates = assistantCompletions.filter((candidate) =>
        candidate.createdAt >= user.createdAt && (windowEnd === null || candidate.createdAt < windowEnd),
      );
      const assistant = candidates.length > 0
        ? candidates.reduce((latest, candidate) => candidate.createdAt >= latest.createdAt ? candidate : latest)
        : undefined;
      scan.turns.push({ user, ...(assistant ? { assistant } : {}) });
    }
  }
  return scan;
}

function extractContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
      parts.push((part as Record<string, unknown>).text as string);
    }
  }
  return parts.join("\n").trim();
}

function threadIdFromFileName(fileName: string): string | null {
  const match = fileName.match(THREAD_ID_PATTERN);
  return match ? match[0].toLowerCase() : null;
}

export function deriveImportedTitle(firstUserMessage: string | null): string {
  const clean = (firstUserMessage ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "导入的历史会话";
  return Array.from(clean).slice(0, 30).join("");
}

/**
 * Discover Codex CLI rollouts that are not linked to any web conversation yet.
 * Only the head of each file is scanned, so discovery stays cheap even when the
 * tenant's Codex Home holds many multi-hundred-megabyte sessions.
 */
export async function discoverImportableSessions(codexHome: string, existingThreadIds: ReadonlySet<string>): Promise<ImportableSession[]> {
  const sessions: ImportableSession[] = [];
  for (const directoryName of ["sessions", "archived_sessions"]) {
    const root = path.resolve(codexHome, directoryName);
    if (!fs.existsSync(root)) continue;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.resolve(directory, entry.name);
        if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error("Refusing to inspect unexpected Codex session path");
        if (entry.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        const threadId = threadIdFromFileName(entry.name);
        if (!threadId || existingThreadIds.has(threadId)) continue;
        const stat = fs.statSync(absolute);
        if (stat.size > SESSION_IMPORT_MAX_BYTES) continue;
        const scan = await scanSessionFile(absolute, { maxBytes: SESSION_DISCOVERY_HEAD_BYTES, collectTurns: false });
        const effectiveThreadId = scan.threadId ?? threadId;
        if (existingThreadIds.has(effectiveThreadId)) continue;
        sessions.push({
          threadId: effectiveThreadId,
          title: deriveImportedTitle(scan.firstUserMessage),
          createdAt: scan.createdAt ?? new Date(stat.birthtimeMs).toISOString(),
          updatedAt: scan.updatedAt ?? new Date(stat.mtimeMs).toISOString(),
          fileSize: stat.size,
          cwd: scan.cwd,
          originator: scan.originator,
          model: scan.model,
        });
      }
    };
    await visit(root);
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sessions;
}

/**
 * Import one Codex thread as a web conversation. The rollout file is reused as
 * the single source of truth: the conversation records the thread id and a
 * readable user/assistant message history so the UI can list and open it, while
 * later turns continue the same thread inside the executor's Codex Home.
 */
export async function importSessionThread(db: AppDatabase, codexHome: string, threadId: string, userId: string) {
  const files = findCodexThreadFiles(codexHome, threadId).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  if (files.length === 0) return null;
  const filePath = files[0];
  const stat = fs.statSync(filePath);
  if (stat.size > SESSION_IMPORT_MAX_BYTES) throw new Error("会话文件过大，无法导入");
  const scan = await scanSessionFile(filePath, { maxLines: SESSION_IMPORT_MAX_LINES, collectTurns: true });
  if (scan.turns.length === 0) throw new Error("会话中没有可导入的对话记录");
  const messages = scan.turns.flatMap((turn) => [
    { role: "user" as const, content: turn.user.content, createdAt: turn.user.createdAt },
    ...(turn.assistant ? [{ role: "assistant" as const, content: sanitizeAgentMarkdown(turn.assistant.content, []), createdAt: turn.assistant.createdAt }] : []),
  ]);
  return db.createImportedConversation({
    id: newId(),
    userId,
    title: deriveImportedTitle(scan.firstUserMessage ?? messages[0]?.content ?? null),
    threadId,
    createdAt: scan.createdAt ?? messages[0]?.createdAt ?? new Date(stat.birthtimeMs).toISOString(),
    updatedAt: scan.updatedAt ?? messages[messages.length - 1]?.createdAt ?? new Date(stat.mtimeMs).toISOString(),
    agentModel: scan.model,
    reasoningEffort: scan.reasoningEffort,
    messages,
  });
}
