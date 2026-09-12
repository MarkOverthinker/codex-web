# Web terminal

## Usage

Open a task and choose **Terminal** in the task toolbar (inside **Conversation tools** on mobile). A docked terminal panel expands below the chat workspace and connects automatically, focusing the input when ready. It participates in the page layout: the chat and composer remain visible and usable above it, with no modal or backdrop. There is no separate start button or command toolbar; only the panel collapse control remains. The mobile back action also collapses the panel. Commands start in the task's selected host working directory, or its conversation workspace in tenant mode.

This is an interactive Bash PTY, not a Codex command proposal. It supports ANSI output, Unicode, shell history within the live session, Tab completion, Ctrl+C, interactive programs and terminal resizing. Use keyboard shortcuts directly: Ctrl+C interrupts, Tab completes, Ctrl+L clears and `exit` or Ctrl+D ends the shell. Escape is forwarded to terminal programs rather than collapsing the panel. Bash starts without loading profile/rc files; source trusted configuration explicitly if required. Automatic Bash history-file persistence is disabled with `HISTFILE=/dev/null`. The initial PATH is `/usr/local/bin:/usr/bin:/bin`; user-specific runtime managers are not automatically loaded.

Collapsing the panel or refreshing the page leaves the shell alive. Reopening automatically attaches to the same running shell and replays its bounded output. Transient connection failures trigger up to three automatic retries; the existing cursor is preserved while reconnecting to the same shell, and uncertain/unsent input is not replayed. Persistent errors remain visible; close and reopen the panel to retry. End the shell with `exit` or Ctrl+D. Archiving or deleting a task also closes its terminals before completing the operation. Exiting the shell allows a new shell to be started. Changing the task's working-directory setting does not move an already running shell; exit the shell and reopen the panel.

## Security boundary

- Every operation requires the existing authenticated web session and task ownership. Open, input, resize and close additionally require the existing CSRF and origin checks. Output is never cached.
- Host mode requires a mapped non-root system account distinct from the web service UID; root and shared web identities are refused. The worker drops to that account before loading the native PTY module. Tenant mode delegates to the existing privileged supervisor, which resolves a fixed tenant UID/GID and workspace itself. The web UID is never used as the tenant executor. Non-isolated, non-host development deployments deliberately return an unavailable error.
- Commands run immediately with that account's filesystem and network permissions. **Codex sandbox modes and approval policies do not apply to this terminal.** A working directory is not a filesystem sandbox. The container/Unix account boundary remains the protection against other tenants and host access; review that boundary before enabling untrusted accounts.
- The worker starts with an allowlisted environment rather than inherited web/database/provider secrets. It does not load Bash startup files automatically. This does not prevent the account from accessing credentials already readable by that same account on disk.
- Browser output uses xterm without clipboard or link addons. Terminal data is not inserted as HTML or added to persistent chat history, application logs, or the database.

## Lifetime and deployment

Linux and `/bin/bash` are required. `node-pty` supplies the PTY and xterm renders it. Install dependencies and rebuild both frontend and server; restart the supervisor as well in tenant mode. On platforms without a matching native prebuild, `npm ci` needs Python 3, make and a C++ compiler (included in the Docker build stage).

There is one live terminal per task, at most three retained terminals per user and 64 per backend process. Sessions with no requests for 30 minutes are killed; hidden browser tabs pause reads, and collapsing the panel cancels its pending read. Startup has a ten-second deadline. Replay retains at most 1,048,576 UTF-16 code units and returns at most 65,536 per read; a missing old portion resets the browser display before replay. Input is limited to 8,192 code units per API call with a bounded worker stdin backlog. The browser batches keystrokes for 4ms, merges subsequent input behind the single in-flight write rather than queuing one HTTP request per key, preserves surrogate pairs across chunks, and bounds queued input to 32,768 code units.

Shell state and replay are in-memory only: service/supervisor restarts end them. Files written by commands remain on disk. Explicitly daemonized/reparented processes are not guaranteed to be descendants when cleanup runs; use the deployment's cgroup/container limits for hard resource and process containment. Output uses event-driven HTTP long polling on the existing same-origin API: an empty read may wait up to ten seconds but returns immediately when PTY output or exit arrives. The next read starts immediately, with no 100ms/1000ms browser polling delay. At most eight reads may wait per terminal; client cancellation releases the local or supervisor-side waiter. No WebSocket proxy upgrade is required. Network RTT and terminal rendering still contribute to latency.

## Verification

- `node --import tsx --test tests/terminal.test.ts tests/terminal-api.test.ts tests/terminal-input.test.ts`: real PTY, persistent cwd, Unicode, environment filtering, resize, Ctrl+C, descendant cleanup, expiry/quotas, protocol validation, authentication/CSRF/origin/ownership unavailable-mode behavior, event-driven wakeup latency, cancelled-reader cleanup and input batching/backpressure.
- `npx playwright test tests/browser/terminal.spec.ts`: desktop/mobile automatic dock connection, absence of command buttons, focused keyboard input, resize, panel collapse/reopen, non-overlapping chat/composer layout and mobile back and automatic reconnect without duplicated output or input, using mocked transport.
- `npm test` and `npm run lint`: complete server regression suite and frontend type checks.

Real-PTY tests require Linux process/PTY access; HTTP tests require local listening sockets. Root CI executes the PTY tests as UID/GID 65534, never as root.
