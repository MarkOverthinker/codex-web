import type { Message } from "./api";

export type ChronologicalMessage = { id: string; created_at: string };

export function mergeMessagePages<T extends ChronologicalMessage>(...pages: ReadonlyArray<readonly T[]>): T[] {
  const messages = new Map<string, T>();
  for (const page of pages) {
    for (const message of page) messages.set(message.id, message);
  }
  return [...messages.values()].sort((left, right) => (
    left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
  ));
}

/**
 * A detail refresh re-parses the transcript JSON, so every refetched message
 * arrives as a new object and memoized message cards would re-render their
 * markdown even when nothing changed. When a refreshed message still describes
 * the same rendered content, keep the previous object identity. When the whole
 * page is unchanged, return the previous array itself so consumers memoized on
 * the list identity (citation files, markdown bodies) also skip rework.
 */
export function reuseUnchangedMessages(previous: readonly Message[], next: readonly Message[]): Message[] {
  if (previous.length === 0) return [...next];
  const byId = new Map(previous.map((message) => [message.id, message]));
  let unchanged = previous.length === next.length;
  const reused = next.map((message, index) => {
    const prior = byId.get(message.id);
    const chosen = prior && sameRenderedMessage(prior, message) ? prior : message;
    if (chosen !== previous[index]) unchanged = false;
    return chosen;
  });
  return unchanged ? (previous as Message[]) : reused;
}

function sameRenderedMessage(left: Message, right: Message): boolean {
  return left.role === right.role
    && left.content === right.content
    && left.created_at === right.created_at
    && left.can_edit === right.can_edit
    && (left.quote_excerpt ?? null) === (right.quote_excerpt ?? null)
    && JSON.stringify(left.files) === JSON.stringify(right.files)
    && JSON.stringify(left.source_reference) === JSON.stringify(right.source_reference);
}

export function preservePrependedScrollTop(previousTop: number, previousHeight: number, nextHeight: number): number {
  return Math.max(0, previousTop + nextHeight - previousHeight);
}
