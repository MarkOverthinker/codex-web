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
