# Deployment

## Local Docker deployment

Follow the root README. Docker named volumes persist the SQLite database, tenant workspaces, Codex login/thread state, and the seeded Codex CLI runtime.

Useful checks:

```bash
docker compose ps
docker compose logs --tail=200 app
curl --fail http://127.0.0.1:37821/codex-web/api/health
```

Back up all three named volumes before upgrades. Keep `.env` outside source control.

Docker grants the application up to 30 minutes after `SIGTERM` to drain active Codex work. New dispatch stops immediately, queued jobs stay persisted, and the container exits once active executions finish. Avoid overriding `stop_grace_period` with a shorter value unless you accept interrupted jobs.

## Reusing the host Codex login

A personal deployment can reuse the host user's existing Codex login instead of
running `codex login --device-auth` inside the container. Mount the host Codex
home read-only and let the supervisor seed the owner tenant on startup:

```yaml
# compose.override.yaml (kept out of git)
services:
  app:
    environment:
      HOST_CODEX_HOME: /host-codex
    volumes:
      - /home/<user>/.codex:/host-codex:ro
```

When `HOST_CODEX_HOME` is set, the supervisor copies `config.toml`,
`auth.json`, `models.json`, and (when present) `rightcode_auth.json` and
`models_cache.json` into the owner tenant's codex home, rewrites `~/.codex/`
paths to the tenant-absolute location, and fixes ownership to the tenant worker
UID. No manual `codex login` is required, and restarting the container refreshes
the tenant copies from the host. The mount is read-only, and the tenant workers
cannot traverse the host home directory.

The web model picker reads `models_cache.json`; when the CLI has not created one
yet, the supervisor seeds it from the host `models.json` catalog so text-only
custom providers (for example DeepSeek) appear in the UI.

## Adding tenants

Every tenant shares the host Codex config seeded above, so adding a user is a
single container command (no image rebuild):

```bash
docker compose exec app node scripts/add-tenant.mjs <username> <password> [display-name]
```

The script inserts the user into SQLite, assigns the next tenant Unix UID
(stored in `DATA_ROOT/tenant-identities.json`), creates the tenant directories,
applies the same ACLs as startup, and seeds the host Codex config for the new
tenant. The new user logs in with the username and password at the same web
URL. Tasks for each tenant run under its own Unix UID with isolated
`/app/tenants/<user-id>/` state.

Because every tenant shares one host Codex config, all tenants use the same
model provider credentials and Codex login. Only grant accounts to people you
trust; the container is not a complete security boundary for hostile
workloads.

## Host mode: machine users as tenants

For a personal or small-team deployment on one machine, Codex Web can run
directly on the host without Docker. Every machine user is then a Codex Web
tenant: tasks run under that user's Unix identity, `CODEX_HOME` points at the
user's real `~/.codex` (global skills, `config.toml`, credentials and model
catalogs included), and the agent sandbox is `danger-full-access` so it can use
host tools such as Caddy/frp publishing. The server process runs as root and
drops privileges into the tenant user for every task.

Start the service:

```bash
npm ci
npm run build
./scripts/setup-python.sh          # shared Python runtime under data/python
HOST_MODE=true \
  APP_USERNAME=<your-system-username> \
  APP_DISPLAY_NAME="Owner" \
  node dist-server/server/index.js
```

`APP_USERNAME` must be a real system account in host mode; that account is the
owner tenant. Keep `CONTAINERIZED` and `TENANT_WORKER_ISOLATION` unset (host
mode forces direct execution). `HOST`, `PORT`, `BASE_PATH`, `DATA_ROOT` and
`TENANT_ROOT` behave as in the container deployment; web data still lives
under `DATA_ROOT`/`TENANT_ROOT`, while `~/.codex` stays in each user's home.

Add a tenant with one command (root required):

```bash
sudo node scripts/add-tenant.mjs <username> <password> [display-name]
```

- If `<username>` has no system account, the script creates it with
  `useradd --create-home` and copies a `.codex` template into the new home
  from `$CODEX_TEMPLATE_HOME`, or `/etc/skel/.codex` when the variable is not
  set. Use a clean template; the copy includes whatever credentials the
  template contains.
- If the system user already exists, the script leaves its existing
  `~/.codex` untouched and the user configures Codex themselves.
- The script then creates the web account, prepares tenant storage under
  `TENANT_ROOT/<user-id>`, and prints whether the user's `~/.codex` is
  configured.

Removing a tenant reverses the process (root required; `--system` also deletes
the machine user and its home, `--force` proceeds despite queued/running jobs):

```bash
sudo node scripts/remove-tenant.mjs <username> --system
```

The web UI shows a persistent banner when a user's `~/.codex` is missing
`config.toml` or usable credentials (`auth.json`, `rightcode_auth.json`, or an
inline `experimental_bearer_token` in `config.toml`), and sending tasks is
blocked with the same hint until it is configured.

Security trade-off: this mode runs the web service as root and gives each
tenant full host access under its own Unix identity. Only add users you trust;
this is not a boundary for hostile workloads.

### Custom working directory (host mode)

In host mode, a new task can choose the Codex working directory. Click the
arrow next to **新建任务** to pick a saved favorite or type any absolute path
the machine user can access; a **目录** menu in the conversation header
changes the directory later. Each user has a favorite list and an optional
default directory, stored in the web database (`user_settings`); each
conversation remembers its own directory (`conversations.working_dir`).

Behavior and limits:

- Attachments, `outputs/` deliverables, and the temporary runtime area stay in
  the conversation's own workspace; only the Codex `cwd` moves to the selected
  host directory. Deliverable persistence and deletion semantics are
  unchanged.
- The directory must exist, be an absolute path, and must not point at the
  application's own `DATA_ROOT`, `TENANT_ROOT`, or `WORKSPACE_ROOT`.
- The task sidebar groups conversations by working directory and supports
  custom categories, per-directory assignment, and pinned categories. Category
  definitions and pin order are stored per user in `user_settings`; collapse
  and “show all” states are stored in browser `localStorage`.
- Deleting or archiving a conversation never removes the selected host
  directory, and the application never overwrites `AGENTS.md` files inside it.
- Tasks that share the same working directory run one at a time; the next task
  waits until the current one finishes, avoiding concurrent writes to the
  same repository.
- The feature is unavailable in the isolated tenant deployment (non-host
  mode); there each conversation keeps its own workspace.

### Systemd autostart (host mode)

The repository ships a systemd unit template at
`deploy/codex-web.service`. Replace `<user>` with the account that owns the
checkout and the host Codex CLI location, then install it:

```bash
sudo cp deploy/codex-web.service /etc/systemd/system/codex-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-web
journalctl -u codex-web -f
```

`CODEX_RUNTIME_PATH` must point to a Codex CLI that every tenant Unix user can
traverse and execute. A CLI inside the checkout owner's home is not usable:
when the home directory is mode `0700`, tenant workers (for example a machine
user named `zzlei`) fail with `spawn .../codex EACCES`. Prefer a system-wide
install such as `/usr/bin/codex` (the `npm install -g` prefix), or verify that
every directory on the CLI path is world-searchable.

Stop any manually started `node dist-server/server/index.js` process first,
otherwise the new service fails to bind the port (the unit restarts and binds
as soon as the port frees up). `TimeoutStopSec=1800` preserves the graceful
30-minute drain for in-flight Codex jobs on shutdown/restart.

### On-demand rebuild and restart (host mode)

The checkout owner can trigger a rebuild and restart without switching to
root. A small root service listens on loopback port `37822`, runs
`npm run build` in the checkout, and only restarts `codex-web.service` after a
successful build. The request is authenticated with a random token generated
at install time.

Install it once as root:

```bash
sudo ./deploy/install-codex-web-reloader.sh
```

The installer reads `WorkingDirectory` and the service `PATH` from
`/etc/systemd/system/codex-web.service`, writes the token and service
configuration under `/etc/codex-web-reloader`, installs
`codex-web-reloader.service`, and starts it. Afterwards the checkout owner
runs:

```bash
npm run reload
```

The reloader answers `GET /status` and authenticated `POST /restart` on
`http://127.0.0.1:37822`. It returns HTTP 409 while a rebuild/restart is
already running, and HTTP 500 with the build log when compilation fails
(leaving the running service untouched). The token file
`/etc/codex-web-reloader/token` is readable only by root and the checkout
owner. To uninstall, stop and disable the unit and remove
`/etc/codex-web-reloader`.

Before building or restarting, the reloader runs
`scripts/check-codex-web-idle.mjs`, which queries the service database for
running jobs. If any job is still running (or the database cannot be
verified), it returns HTTP 409 with state `busy`, skips the build and the
restart, and the client prints that the reload was skipped. Re-run
`npm run reload` after the tasks finish. The database path comes from the
unit's `DATA_ROOT` (defaulting to `<WorkingDirectory>/data`) and is written
into `/etc/codex-web-reloader/env` by the installer.

The config directory is owned by `root` with the checkout owner's group and
mode `0750`, so only root and the checkout owner can enter it and read the
token.

## Reverse proxy

Terminate TLS at your reverse proxy and forward `/codex-web/` to `http://127.0.0.1:37821/codex-web/`. Preserve the path prefix, pass the original host and protocol headers, disable response buffering for event streams, and use a long read timeout for active tasks.

Set `PUBLIC_BASE_URL` to the final URL. When the frp server uses a non-80
`vhostHTTPPort`, include that port in the URL (for example
`http://proxy-html.gyli.site:8088/codex-web`). Do not publish container port
37821 directly to the internet.

For optional voice transcription, keep `DASHSCOPE_API_KEY` only in `.env`. The default context budget is 500 approximate tokens, two images, and 2 MiB per image. Adjust `TRANSCRIPTION_CONTEXT_TOKEN_BUDGET`, `TRANSCRIPTION_CONTEXT_MAX_IMAGES`, and `TRANSCRIPTION_CONTEXT_MAX_IMAGE_BYTES` only after considering request cost and data exposure.

## Updating

```bash
git pull --ff-only
docker compose up -d --build
```

The container seeds a newer bundled Codex CLI into the persistent runtime volume on startup. Existing login and thread state remain in the tenant volume.

After upgrading, verify that archived conversations remain listed under personal settings and that any job interrupted by an ungraceful previous stop has a visible interruption message instead of being retried.
