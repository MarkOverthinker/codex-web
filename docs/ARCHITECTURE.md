# Architecture

Codex Web is a single-owner self-hosted application. Express serves the API and built React assets. SQLite stores users, sessions, conversations, messages, job events, settings, and server-side queue state.

The web process runs as UID 10001. A local supervisor launches Codex work as UID 11001 with a tenant-specific `HOME`, `CODEX_HOME`, conversation workspace, and library. The worker has no access to the application database. Files shared between the web process and worker use explicit filesystem ACLs.

Each conversation has an `uploads`, `outputs`, and temporary runtime area. Generated deliverables are copied to durable application storage. Archiving only hides an idle conversation and keeps its complete history and files available for restoration. Deleting is separate: it cancels queued/running jobs, removes the workspace and deliverables, and soft-deletes the database row so messages and events remain available for administrative diagnosis.

A primary conversation can own one hidden sidecar conversation through `conversation_side_chats`. The sidecar is otherwise a normal conversation row, so it keeps an independent Codex thread, model/reasoning selection, messages, drafts, queue, files, and events without introducing a second persistence path. Primary and archived lists exclude sidecars. Archive/restore updates both rows, and deleting the primary cleans both workspaces, thread files, pending work, and soft-delete records.

Structured message references are stored in `messages.source_reference`, `composer_drafts.source_reference`, and `pending_prompts.source_reference`. For side-chat quotes the server resolves the selected excerpt against the authenticated tenant's `sessions/` and `archived_sessions/` rollout files, preferring `response_item` message records and using role, complete message text, excerpt containment, and timestamp distance to disambiguate candidates. The browser receives only the Codex-Home-relative JSONL path plus one-based line, byte offset, JSON Pointer, item ID, and half-open text character range. If no persisted rollout record exists yet, the strict side-reference API returns `source-jsonl-pending` instead of fabricating a locator.

In host mode (`HOST_MODE=true`), a conversation may instead run Codex with its
working directory pointed at a host path the tenant machine user can access:
per-user favorites and a default directory are persisted in `user_settings`,
and each conversation stores its own `working_dir`. Uploads, outputs, and the
temporary runtime area remain in the conversation's own workspace, and
deliverable persistence is unchanged. Deleting a conversation never touches
the selected host directory. Tasks sharing the same directory are serialized
so concurrent Codex sessions cannot write the same project repository at once.
While a job is queued, the UI can promote it to start immediately with an
explicit confirmation; this intentionally bypasses the serialization guard,
so the user accepts that two sessions may write the same directory at once.
Task-list categories are also persisted per user in `user_settings`: custom
category names, which directories they contain, the pinned-category order, and
hidden-category keys. Without an explicit task drag, conversations inside each
category are ordered by `updated_at` with the most recently active task first.
The browser derives the grouped sidebar view from conversations, favorites, and
that settings record; only expanded/collapsed state is kept in `localStorage`.
The first startup after the task-order fix removes legacy persisted drag orders
once, because older accidental gestures could otherwise continue to override
the activity order after an upgrade. New explicit drags remain persistent.
The working-dir feature is host-mode only; isolated tenants keep the
per-conversation workspace model and the tenant boundary is unchanged.

The browser keeps the long-running task view responsive by batching SSE
progress events into short render frames and by memoizing the message list,
individual Markdown messages, and conversation rows. Conversation polling
compares list fields before replacing state, search uses a deferred value, and
off-screen sidebar rows and user message cards use `content-visibility` so
idle tasks do not repaint the whole sidebar on every progress event and long
chat threads stay cheap to scroll on slower devices. Assistant replies stay
fully laid out: their real height can be far larger than the 320px off-screen
placeholder, and reserving less than the real height collapses `scrollHeight`
and makes the browser clamp the viewport back to an earlier message while
scrolling toward the top of a reply.

The composer textarea is intentionally non-controlled so typing does not
rerender the workspace on every keystroke. `inputRef` owns the live DOM value;
restoring, editing, and clearing text use the separate `composerInputRevision`
counter to force the external-sync layout effect even when the React `input`
state already contains the same value. Any future external composer mutation
must go through `applyExternalComposerText`. A successful send also marks the
current conversation as having an empty loaded draft before `reconcile`; an
older in-flight conversation response must not restore the submitted text.

Task rows inside a category use a long-press gesture for reordering so that
normal vertical swipes still scroll the list on touch devices. Rows keep
`touch-action: pan-y`; a 350ms press arms the drag, locks the container's
touch action, and expands the category for live reordering, while moving more
than 10px before the press completes cancels it and lets the scroll proceed.
Only a press that actually crosses another row persists the new order.

Markdown rendering uses GFM, KaTeX for math, and static highlight.js token
styling for fenced code blocks. Math accepts `$...$`/`$$...$$` as well as
LaTeX `\(...\)`/`\[...\]` and bare `[`/`]` display-math lines, which are
normalized to the `$`/`$$` forms before rendering; malformed math falls back
to readable text instead of breaking the message.

Assistant replies that mention `file:line` references are rendered as
clickable code references. The web process serves bounded line windows around
the referenced line from files the conversation can already reach: the
conversation workspace, registered deliverables, the tenant library, or (in
host mode) the conversation's selected working directory. Paths are
revalidated with `resolveInside`, traversal is rejected, and scrolling the
preview lazily requests adjacent windows.

Local Codex CLI sessions can be imported into the web UI. The importer scans the executor's Codex Home (`sessions/` and `archived_sessions/`), reads each rollout's user turns and final agent replies, and creates a conversation whose `codex_thread_id` points at the existing thread. The rollout file stays the single source of truth: imported history is readable in the browser and later web turns resume the same thread; deleting the imported conversation removes the underlying rollout files just like any other conversation.

In host mode the importer also recovers the rollout's recorded `cwd` into the
conversation's `working_dir` (with the same canonicalization and safety checks
as user-selected directories), so imported sessions join working-directory
categories automatically. If that directory is missing or now points into
managed storage, the conversation is imported without a working directory
instead of failing.

Queued prompts and their attachments are stored by the server. The browser is only a view of that state. A queued prompt can be reordered, edited, deleted, or converted into a live steering instruction for the currently running Codex turn. Running and queued states are derived independently so an idle-but-queued conversation is not presented as actively executing.

Already-created queued jobs carry a durable `skip_queue` flag when promoted.
The dispatcher gives promoted jobs priority on restart, and the promotion API
atomically moves the job into the running state so the immediate start works
even while the regular queue pump is busy.

Queue positions are computed per shared working directory: every running job
and every queued job that precedes the current one in that directory counts as
work ahead, so the UI can show both the remaining jobs and the current place
in line. Standalone workspaces stay scoped to their own conversation.

On graceful shutdown, dispatch stops first and the process waits for active Codex executions to finish; queued work remains durable. If the process disappears while a job is running, startup marks that job interrupted and appends a visible message/event. It does not automatically retry a possibly side-effecting turn.

Conversation detail checks the current Codex rollout file size without loading the file. The UI warns at 500 MiB and points the user toward archiving the completed conversation and starting a fresh task.

Optional voice transcription receives a bounded context envelope. The budget is shared across the current draft, attachment names, small heads of text attachments, recent messages, technical terms, and at most a few validated images. Temporary audio remains HMAC-signed and short-lived.

The public edition deliberately excludes host-root execution, Docker socket access, host filesystem mounts, private network routing, and multi-user provisioning.
