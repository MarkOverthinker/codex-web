#!/bin/bash
set -Eeuo pipefail

node /app/scripts/apply-tenant-permissions.mjs

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

# Reuse the host Codex login and model catalog for every tenant instead of
# requiring an interactive `codex login --device-auth` inside the container.
# HOST_CODEX_HOME is an optional read-only mount of the host ~/.codex.
node /app/scripts/seed-host-codex.mjs

exec node dist-server/server/supervisor.js
