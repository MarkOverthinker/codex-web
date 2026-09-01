# Side Chat Design

## Goal

Add a persistent right-side chat workspace with multiple saved side threads. Each side chat is an independent Codex thread linked to the primary conversation that created it, while the currently open side thread can remain pinned as the user navigates other primary tasks.

The interaction borrows the Windows app's split-workspace idea: keep the main task visible, open a focused secondary conversation beside it, and let the user switch models without changing the main thread.

## User flow

1. Open a primary conversation and toggle **侧边聊天** from its header.
2. When the pane opens, restore the most recently used side thread created from that primary conversation; if none exists, show an empty state without creating data.
3. Create additional side threads with **新建**, or choose any active side thread from the history selector.
4. Keep the selected side thread open while navigating to another primary task.
5. On a completed primary-conversation user message, choose **Fork 到侧边聊天**. The server creates a new sidecar, copies the visible history through that turn, and stores the source thread/turn without changing the primary conversation.
6. Select text in the currently visible primary-conversation message and choose **侧边提问**.
7. The side composer receives a structured source reference containing:
   - source conversation and message IDs;
   - source thread ID;
   - rollout-relative JSONL path;
   - one-based line number and exact byte offset (including CRLF line endings);
   - JSON Pointer to the text field;
   - character offsets for the selected excerpt.
8. Send the side question. The copied excerpt remains useful model context, while the locator provides an auditable path back to the exact JSONL record.

## Persistence model

- `conversation_side_chats` maps one primary conversation to multiple sidecar conversations and stores `last_opened_at` for task-aware reopening.
- A sidecar remains a normal `conversations` row, so messages, jobs, events, drafts, files, Codex thread IDs, and model settings keep using existing durable storage.
- Primary conversation lists exclude sidecars; the side-chat history API exposes active sidecars with their originating task title.
- Archiving, restoring, or deleting a primary conversation applies to all sidecars created from it.
- `pending_prompts.source_reference` preserves structured references when a side message waits in the queue.
- A Fork-created sidecar stores `fork_source_thread_id`, `fork_last_turn_id`, and `fork_source_message_id` while `codex_thread_id` remains empty until the first send.

## JSONL resolution

The server resolves a selected excerpt against rollout files under the authenticated user's Codex home. Matching prefers `response_item` message records, then falls back to `event_msg` records, and uses role, text containment, and timestamp distance to disambiguate repeated text.

Only a relative rollout path is returned to the browser. Absolute Codex-home paths and unrelated JSONL content are never exposed.

If the source message has not reached a persisted Codex rollout yet, creating a side reference fails explicitly instead of fabricating a location.

## Interface

- Desktop: a right pane beside the main conversation; drag its left edge to adjust the width, and preserve the setting locally for the next visit.
- Context shortcut: click **引用主对话上下文** to snapshot all persisted user and assistant messages from the primary conversation into the side composer; this is separate from selecting text in one message.
- Primary message actions expose **Fork 到侧边聊天** for completed user turns with a persisted Codex turn; the pane shows a pending-fork banner until the new thread is created.
- Mobile: a full-height overlay pane.
- Header: origin-task label, history selector, new-thread action, close action, independent model/reasoning selectors, and running state.
- Body: compact message history using the existing Markdown safety/rendering rules.
- Composer: one active source card, location metadata, textarea, and send/stop action.
