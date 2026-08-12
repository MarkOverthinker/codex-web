# Architecture

Codex Web is a single-owner self-hosted application. Express serves the API and built React assets. SQLite stores users, sessions, conversations, messages, job events, settings, and server-side queue state.

The web process runs as UID 10001. A local supervisor launches Codex work as UID 11001 with a tenant-specific `HOME`, `CODEX_HOME`, conversation workspace, and library. The worker has no access to the application database. Files shared between the web process and worker use explicit filesystem ACLs.

Each conversation has an `uploads`, `outputs`, and temporary runtime area. Generated deliverables are copied to durable application storage. Archiving only hides an idle conversation and keeps its complete history and files available for restoration. Deleting is separate: it cancels queued/running jobs, removes the workspace and deliverables, and soft-deletes the database row so messages and events remain available for administrative diagnosis.

In host mode (`HOST_MODE=true`), a conversation may instead run Codex with its
working directory pointed at a host path the tenant machine user can access:
per-user favorites and a default directory are persisted in `user_settings`,
and each conversation stores its own `working_dir`. Uploads, outputs, and the
temporary runtime area remain in the conversation's own workspace, and
deliverable persistence is unchanged. Deleting a conversation never touches
the selected host directory. Tasks sharing the same directory are serialized
so concurrent Codex sessions cannot write the same project repository at once.
Task-list categories are also persisted per user in `user_settings`: custom
category names, which directories they contain, the pinned-category order, and
hidden-category keys. The browser derives the grouped sidebar view from
conversations, favorites, and that settings record; only expanded/collapsed
state is kept in `localStorage`.
The working-dir feature is host-mode only; isolated tenants keep the
per-conversation workspace model and the tenant boundary is unchanged.

The browser keeps the long-running task view responsive by batching SSE
progress events into short render frames and by memoizing the message list,
individual Markdown messages, and conversation rows. Conversation polling
compares list fields before replacing state, search uses a deferred value, and
off-screen sidebar rows use `content-visibility` so idle tasks do not repaint
the whole sidebar on every progress event.

Local Codex CLI sessions can be imported into the web UI. The importer scans the executor's Codex Home (`sessions/` and `archived_sessions/`), reads each rollout's user turns and final agent replies, and creates a conversation whose `codex_thread_id` points at the existing thread. The rollout file stays the single source of truth: imported history is readable in the browser and later web turns resume the same thread; deleting the imported conversation removes the underlying rollout files just like any other conversation.

In host mode the importer also recovers the rollout's recorded `cwd` into the
conversation's `working_dir` (with the same canonicalization and safety checks
as user-selected directories), so imported sessions join working-directory
categories automatically. If that directory is missing or now points into
managed storage, the conversation is imported without a working directory
instead of failing.

Queued prompts and their attachments are stored by the server. The browser is only a view of that state. A queued prompt can be reordered, edited, deleted, or converted into a live steering instruction for the currently running Codex turn. Running and queued states are derived independently so an idle-but-queued conversation is not presented as actively executing.

On graceful shutdown, dispatch stops first and the process waits for active Codex executions to finish; queued work remains durable. If the process disappears while a job is running, startup marks that job interrupted and appends a visible message/event. It does not automatically retry a possibly side-effecting turn.

Conversation detail checks the current Codex rollout file size without loading the file. The UI warns at 500 MiB and points the user toward archiving the completed conversation and starting a fresh task.

Optional voice transcription receives a bounded context envelope. The budget is shared across the current draft, attachment names, small heads of text attachments, recent messages, technical terms, and at most a few validated images. Temporary audio remains HMAC-signed and short-lived.

The public edition deliberately excludes host-root execution, Docker socket access, host filesystem mounts, private network routing, and multi-user provisioning.
