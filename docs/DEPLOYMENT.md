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

### Binding beyond loopback (host mode)

The service refuses to bind `0.0.0.0` by default. Host mode can opt in with
`ALLOW_HOST_PUBLIC_BIND=true` plus `HOST=0.0.0.0`, which exposes the web UI
(login form, sessions, uploads) on every network interface. Without TLS the
password and session cookie travel in plaintext, so prefer a loopback reverse
proxy with HTTPS; use this option only on trusted LANs and keep
`PUBLIC_BASE_URL` in sync with the address browsers use.

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

Host-mode task processes load the system user's full supplementary group
membership, not just the primary uid/gid: the root service drops privileges
through `setpriv --reuid ... --regid ... --init-groups` (util-linux), so a task
shell sees the same groups as a normal login (for example group-owned host
tools like `htmlmounts`). When `setpriv` is unavailable, the service falls back
to the legacy uid/gid-only spawn and task processes keep an empty supplementary
group set.

Provider records and model catalogs are scoped by the Web user ID. The root web
process writes only that user's provider configuration into the matching host
user's `~/.codex` (`config.toml` and `models_cache.json`), then repairs the home
directory and hands ownership of those files back to the host user. The
directory is kept at 0700, `config.toml` at 0600, and `models_cache.json` at
0644. This keeps the dropped-privilege Codex CLI readable and lets it refresh
the catalog; never work around access errors by chmodding `~/.codex` to 777.

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
`http://127.0.0.1:37822`. It returns HTTP 409 while another rebuild/restart
is already running (unless that run is queued, in which case it returns 202),
and HTTP 500 with the build log when compilation fails (leaving the running
service untouched). The token file `/etc/codex-web-reloader/token` is readable
only by root and the checkout owner. To uninstall, stop and disable the unit
and remove `/etc/codex-web-reloader`.

Before building or restarting, the reloader runs
`scripts/check-codex-web-idle.mjs`, which queries the service database for
running jobs. If jobs are still running, the reload is queued: the request
returns HTTP 202 with state `waiting`, and once the jobs finish the reloader
automatically builds and restarts `codex-web.service`. The queue waits up to
30 minutes by default (`CODEX_WEB_RELOADER_WAIT_TIMEOUT_MS`); on timeout the
state becomes `wait-timeout` and no restart happens. If the database cannot be
verified, the reloader refuses with HTTP 409 instead of risking an
interruption. The database path comes from the unit's `DATA_ROOT` (defaulting
to `<WorkingDirectory>/data`) and is written into
`/etc/codex-web-reloader/env` by the installer.

The web UI polls `/codex-web/api/reload-status`, which proxies the reloader's
`/status` endpoint. It shows queued, building, restarting, failed, and
successful states; after a successful restart it displays a banner asking the
user to refresh the page to load the new version.

The config directory is owned by `root` with the checkout owner's group and
mode `0750`, so only root and the checkout owner can enter it and read the
token.

## Offline bundle (host mode)

For a Linux x86_64 machine without a checkout or npm registry access, build a
self-contained archive that includes the production build, production
node_modules (with the bundled Codex CLI), a Node.js runtime, and the shared
Python runtime:

```bash
scripts/package-offline.sh --output-dir /path/to/outputs
```

The bundle contains `start.sh`, which generates `.env` on first run, asks for
the web login password, and repairs the Python runtime from the bundled wheels
cache when the unpack path differs from the build machine. It deliberately
excludes `.env`, `data` (except `data/python`), `tenants`, workspaces and git
metadata.

The bundle is designed for rootless, single-user use: unpack it into a
user-writable directory and run `./start.sh` as that user. Both the web
service and Codex task processes then run as the same user; the chown/setpriv
privilege paths are only exercised when the service itself runs as root.

For long-running rootless deployments, the bundle ships
`scripts/autostart.sh` (background daemon with crash auto-restart, duplicate
guard, `status`/`stop` subcommands) and `deploy/codex-web-user.service` (a
`systemd --user` unit template). Reboot persistence works without root
through a user crontab entry:

```
@reboot /absolute/path/to/codex-web/autostart.sh
```

or through `systemctl --user enable --now codex-web` plus
`loginctl enable-linger "$USER"` (the linger step may require root once,
depending on the distribution's polkit policy; without it the user service
only starts after the user logs in).

To upgrade an already deployed bundle, copy the new offline archive (and its
`.sha256`) to the target machine and run
`./upgrade.sh codex-web-offline-*.tar.zst` from the old install directory
(pass the install path as a second argument when the script runs elsewhere).
The script verifies the checksum, stops the service (autostart daemon or
systemd), backs up `app/.env`, `app/data` (minus the rebuildable
`data/python`), `app/tenants` and `app/workspaces` to `codex-web-backups/`,
then syncs only program files and restarts the service; `--no-start` skips
the automatic restart. See the generated `README-OFFLINE.md` inside the bundle
for details.

The web service itself starts fully offline, but Codex tasks still require a
configured `~/.codex` for the `APP_USERNAME` system user and network reach to
the model API (or an internal endpoint configured in `config.toml`). Optional
voice transcription additionally needs `ffmpeg` and DashScope access. See the
generated `README-OFFLINE.md` inside the bundle for details.

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
