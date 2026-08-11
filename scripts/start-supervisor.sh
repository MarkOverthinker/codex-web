#!/bin/bash
set -Eeuo pipefail

/app/scripts/migrate-tenant-permissions.sh

runtime_root=/opt/codex-runtime
baked_root=/opt/codex-baked
mkdir -p "$runtime_root/releases"

baked_version="$($baked_root/bin/codex --version | awk '{print $NF}')"
[[ "$baked_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]
current_version=""
if [[ -x "$runtime_root/current/bin/codex" ]]; then
  current_version="$(CODEX_RUNTIME_PATH="$runtime_root/current/bin/codex" /usr/local/bin/codex --version | awk '{print $NF}')"
fi

should_seed=0
if [[ -z "$current_version" ]]; then
  should_seed=1
elif [[ "$(printf '%s\n%s\n' "$current_version" "$baked_version" | sort -V | tail -n 1)" == "$baked_version" && "$current_version" != "$baked_version" ]]; then
  should_seed=1
fi

if [[ "$should_seed" -eq 1 ]]; then
  release="$runtime_root/releases/$baked_version"
  if [[ ! -x "$release/bin/codex" ]]; then
    staging="$runtime_root/releases/.seed-$baked_version-$$"
    rm -rf -- "$staging"
    cp -a "$baked_root" "$staging"
    chmod -R a+rX "$staging"
    mv "$staging" "$release"
  fi
  next_link="$runtime_root/.current-$$"
  ln -s "releases/$baked_version" "$next_link"
  mv -Tf "$next_link" "$runtime_root/current"
fi

test -x "$runtime_root/current/bin/codex"

# Reuse the host Codex login and model catalog for the owner tenant instead of
# requiring an interactive `codex login --device-auth` inside the container.
# HOST_CODEX_HOME is an optional read-only mount of the host ~/.codex.
seed_host_codex() {
  local host_home="${HOST_CODEX_HOME:-}"
  local owner_id="00000000-0000-4000-8000-000000000001"
  local tenant_home="/app/tenants/$owner_id/codex-home"
  if [[ -z "$host_home" || ! -d "$host_home" ]]; then
    return 0
  fi
  mkdir -p "$tenant_home"
  local name source dest
  for name in config.toml auth.json models.json rightcode_auth.json models_cache.json; do
    source="$host_home/$name"
    dest="$tenant_home/$name"
    if [[ ! -f "$source" ]]; then
      continue
    fi
    if [[ "$name" == "config.toml" ]]; then
      # The tenant worker's HOME is the tenant root, not the codex home, so
      # rewrite ~/.codex/ references to the tenant-absolute location.
      sed "s|~/.codex/|$tenant_home/|g" "$source" > "$dest"
    else
      cp -a "$source" "$dest"
    fi
    chown 11001:11001 "$dest"
    if [[ "$name" == "models.json" || "$name" == "models_cache.json" ]]; then
      chmod 0644 "$dest"
    else
      chmod 0600 "$dest"
    fi
  done
  # The web model picker reads models_cache.json; derive it from the host
  # catalog when the CLI has not produced its own cache yet.
  if [[ ! -f "$tenant_home/models_cache.json" && -f "$tenant_home/models.json" ]]; then
    cp -a "$tenant_home/models.json" "$tenant_home/models_cache.json"
    chown 11001:11001 "$tenant_home/models_cache.json"
    chmod 0644 "$tenant_home/models_cache.json"
  fi
}
seed_host_codex

exec node dist-server/server/supervisor.js
