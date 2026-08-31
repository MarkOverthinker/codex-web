import fs, { createReadStream } from "node:fs";
import path from "node:path";
import { normalizeSourceExcerpt, type MessageSourceLocation } from "../src/message-source.js";
import { findCodexThreadFiles } from "./paths.js";

const MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024;

type Candidate = MessageSourceLocation & {
  role: "user" | "assistant";
  content: string;
  timestamp: string | null;
  preferred: boolean;
};

type JsonlLine = {
  text: string;
  line: number;
  byteOffset: number;
};

async function* readJsonlLines(filePath: string): AsyncGenerator<JsonlLine> {
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let line = 0;
  let lineStartOffset = 0;
  let bytesBeforeChunk = 0;
  let oversized = false;

  for await (const rawChunk of createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor);
      const end = newline < 0 ? chunk.length : newline;
      const segment = chunk.subarray(cursor, end);
      if (!oversized) {
        if (fragmentBytes + segment.length <= MAX_JSONL_LINE_BYTES) {
          fragments.push(segment);
          fragmentBytes += segment.length;
        } else {
          fragments = [];
          fragmentBytes = 0;
          oversized = true;
        }
      }
      if (newline < 0) break;
      line += 1;
      if (!oversized) {
        let value = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, fragmentBytes);
        if (value.at(-1) === 0x0d) value = value.subarray(0, value.length - 1);
        yield { text: value.toString("utf8"), line, byteOffset: lineStartOffset };
      }
      fragments = [];
      fragmentBytes = 0;
      oversized = false;
      cursor = newline + 1;
      lineStartOffset = bytesBeforeChunk + cursor;
    }
    bytesBeforeChunk += chunk.length;
  }

  if (!oversized && fragmentBytes > 0) {
    line += 1;
    let value = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, fragmentBytes);
    if (value.at(-1) === 0x0d) value = value.subarray(0, value.length - 1);
    yield { text: value.toString("utf8"), line, byteOffset: lineStartOffset };
  }
}

function messageCandidates(
  record: Record<string, unknown>,
  relativePath: string,
  line: number,
  byteOffset: number,
  threadId: string,
): Candidate[] {
  const recordType = record.type;
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? record.payload as Record<string, unknown>
    : null;
  if (!payload) return [];
  if (recordType === "event_msg") {
    const eventType = payload.type;
    const role = eventType === "user_message" ? "user" : eventType === "agent_message" || eventType === "task_complete" ? "assistant" : null;
    const key = eventType === "task_complete" ? "last_agent_message" : "message";
    const content = role && typeof payload[key] === "string" ? payload[key] as string : "";
    if (!role || !content) return [];
    return [{
      kind: "codex-rollout", threadId, path: relativePath, line, byteOffset,
      recordType: "event_msg", jsonPointer: `/payload/${key}`, itemId: null,
      textStart: 0, textEnd: content.length, role, content, timestamp, preferred: false,
    }];
  }
  if (recordType !== "response_item" || payload.type !== "message") return [];
  const role = payload.role === "user" || payload.role === "assistant" ? payload.role : null;
  if (!role || !Array.isArray(payload.content)) return [];
  const itemId = typeof payload.id === "string" ? payload.id : null;
  return payload.content.flatMap((part, index) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const text = (part as Record<string, unknown>).text;
    if (typeof text !== "string" || !text) return [];
    return [{
      kind: "codex-rollout" as const, threadId, path: relativePath, line, byteOffset,
      recordType: "response_item" as const, jsonPointer: `/payload/content/${index}/text`, itemId,
      textStart: 0, textEnd: text.length, role, content: text, timestamp, preferred: true,
    }];
  });
}

function normalizedTextWithOffsets(value: string): { text: string; offsets: number[] } {
  let text = "";
  const offsets: number[] = [];
  let pendingSpace = false;
  let pendingOffset = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (/\s/u.test(character)) {
      if (text && !pendingSpace) pendingOffset = index;
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && text) {
      text += " ";
      offsets.push(pendingOffset);
    }
    pendingSpace = false;
    text += character;
    offsets.push(index);
  }
  return { text, offsets };
}

function excerptRange(content: string, excerpt: string): { start: number; end: number } | null {
  const direct = content.indexOf(excerpt);
  if (direct >= 0) return { start: direct, end: direct + excerpt.length };
  const haystack = normalizedTextWithOffsets(content);
  const needle = normalizedTextWithOffsets(excerpt).text;
  const normalizedIndex = needle ? haystack.text.indexOf(needle) : -1;
  if (normalizedIndex < 0) return null;
  return {
    start: haystack.offsets[normalizedIndex],
    end: haystack.offsets[normalizedIndex + needle.length - 1] + 1,
  };
}

export async function locateMessageInCodexRollout(input: {
  codexHome: string;
  threadId: string;
  role: "user" | "assistant";
  messageContent: string;
  messageCreatedAt: string;
  excerpt: string;
}): Promise<MessageSourceLocation | null> {
  const excerpt = normalizeSourceExcerpt(input.excerpt);
  if (!excerpt) return null;
  const messageText = normalizeSourceExcerpt(input.messageContent);
  const expectedTime = Date.parse(input.messageCreatedAt);
  let best: { candidate: Candidate; score: number; distance: number } | null = null;
  const files = findCodexThreadFiles(input.codexHome, input.threadId)
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);

  for (const filePath of files) {
    const relativePath = path.relative(input.codexHome, filePath).split(path.sep).join("/");
    for await (const entry of readJsonlLines(filePath)) {
      let record: unknown;
      try { record = JSON.parse(entry.text); } catch { continue; }
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      for (const candidate of messageCandidates(record as Record<string, unknown>, relativePath, entry.line, entry.byteOffset, input.threadId)) {
        if (candidate.role !== input.role) continue;
        const range = excerptRange(candidate.content, excerpt);
        if (!range) continue;
        const normalizedCandidate = normalizeSourceExcerpt(candidate.content);
        const score = (candidate.preferred ? 20 : 0) + (normalizedCandidate === messageText ? 100 : 0) + (candidate.content.includes(excerpt) ? 10 : 0);
        const timestamp = candidate.timestamp ? Date.parse(candidate.timestamp) : Number.NaN;
        const distance = Number.isFinite(expectedTime) && Number.isFinite(timestamp) ? Math.abs(timestamp - expectedTime) : Number.MAX_SAFE_INTEGER;
        if (!best || score > best.score || (score === best.score && distance < best.distance)) {
          best = { candidate: { ...candidate, textStart: range.start, textEnd: range.end }, score, distance };
        }
      }
    }
  }

  if (!best) return null;
  const { role: _role, content: _content, timestamp: _timestamp, preferred: _preferred, ...location } = best.candidate;
  return location;
}
