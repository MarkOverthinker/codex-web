# Side Chat Design

## Goal

Add a persistent right-side chat for each primary conversation. The side chat is an independent Codex thread with its own model selection, while remaining linked to the primary conversation for navigation and quoted context.

The interaction borrows the Windows app's split-workspace idea: keep the main task visible, open a focused secondary conversation beside it, and let the user switch models without changing the main thread.

## User flow

1. Open a primary conversation and toggle **侧边聊天** from its header.
2. The server lazily creates one hidden sidecar conversation with the same working directory and initial agent settings.
3. Select text in a main-conversation message and choose **侧边提问**.
4. The side composer receives a structured source reference containing:
   - source conversation and message IDs;
   - source thread ID;
   - rollout-relative JSONL path;
   - one-based line number and exact byte offset (including CRLF line endings);
   - JSON Pointer to the text field;
   - character offsets for the selected excerpt.
5. Send the side question. The copied excerpt remains useful model context, while the locator provides an auditable path back to the exact JSONL record.

## Persistence model

- `conversation_side_chats` maps one primary conversation to one sidecar conversation.
- A sidecar remains a normal `conversations` row, so messages, jobs, events, drafts, files, Codex thread IDs, and model settings keep using existing durable storage.
- Primary conversation lists exclude sidecars; sidecars are opened only through their parent.
- Deleting a primary conversation also deletes its sidecar's runtime files and marks both rows deleted.
- `pending_prompts.source_reference` preserves structured references when a side message waits in the queue.

## JSONL resolution

The server resolves a selected excerpt against rollout files under the authenticated user's Codex home. Matching prefers `response_item` message records, then falls back to `event_msg` records, and uses role, text containment, and timestamp distance to disambiguate repeated text.

Only a relative rollout path is returned to the browser. Absolute Codex-home paths and unrelated JSONL content are never exposed.

If the source message has not reached a persisted Codex rollout yet, creating a side reference fails explicitly instead of fabricating a location.

## Interface

- Desktop: a right pane beside the main conversation; drag its left edge to adjust the width, and preserve the setting locally for the next visit.
- Mobile: a full-height overlay pane.
- Header: close action, independent model and reasoning selectors, and running state.
- Body: compact message history using the existing Markdown safety/rendering rules.
- Composer: one active source card, location metadata, textarea, and send/stop action.
