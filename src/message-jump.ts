export type JumpDirection = "previous" | "next";

export type JumpMessage = { id: string; role: string };

/**
 * Find the nearest user message strictly before (previous) or after (next)
 * the anchored message. When the anchor is not part of the loaded page,
 * previous falls back to the last user message and next to the first one.
 */
export function findUserMessageJump(messages: readonly JumpMessage[], anchorId: string, direction: JumpDirection): string | null {
  const index = messages.findIndex((message) => message.id === anchorId);
  const step = direction === "previous" ? -1 : 1;
  const start = index >= 0 ? index + step : direction === "previous" ? messages.length - 1 : 0;
  for (let cursor = start; cursor >= 0 && cursor < messages.length; cursor += step) {
    if (messages[cursor].role === "user") return messages[cursor].id;
  }
  return null;
}

/** Locate the message nearest the vertical center of the scroll viewport. */
export function findViewportAnchorMessageId(container: {
  scrollTop: number;
  clientHeight: number;
  querySelectorAll(selector: string): NodeListOf<HTMLElement>;
}): string | null {
  const center = container.scrollTop + container.clientHeight / 2;
  let anchor: HTMLElement | null = null;
  for (const element of container.querySelectorAll("[data-message-id]")) {
    if (element.offsetTop <= center) {
      anchor = element;
    } else {
      break;
    }
  }
  return anchor?.dataset.messageId ?? null;
}
