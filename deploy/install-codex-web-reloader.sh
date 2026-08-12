#!/bin/bash
# Install the root codex-web-reloader service and its loopback-only control
# endpoint. Run as root once; afterwards the checkout owner can trigger a
# rebuild + restart with `npm run reload`.
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "install-codex-web-reloader.sh must run as root" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
service_unit="${CODEX_WEB_SERVICE_UNIT:-/etc/systemd/system/codex-web.service}"
reloader_unit="/etc/systemd/system/codex-web-reloader.service"
config_dir="/etc/codex-web-reloader"
node_bin="${CODEX_WEB_NODE_BIN:-/usr/bin/node}"
client_user="${CODEX_WEB_CLIENT_USER:-$(stat -c '%U' "$repo_root")}"

if [[ ! -f "$service_unit" ]]; then
  echo "cannot find $service_unit; set CODEX_WEB_SERVICE_UNIT to the installed unit" >&2
  exit 1
fi

service_path="$(sed -n 's/^WorkingDirectory=//p' "$service_unit" | head -n 1)"
service_env_path="$(sed -n 's/^Environment=PATH=//p' "$service_unit" | head -n 1)"
service_data_root="$(sed -n 's/^Environment=DATA_ROOT=//p' "$service_unit" | head -n 1)"
if [[ -z "$service_path" ]]; then
  echo "no WorkingDirectory= found in $service_unit" >&2
  exit 1
fi
if [[ -z "$service_env_path" ]]; then
  service_env_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
fi
if [[ -z "$service_data_root" ]]; then
  service_data_root="$service_path/data"
fi
if [[ "$repo_root" != "$service_path" ]]; then
  echo "warning: repo root ($repo_root) differs from codex-web.service WorkingDirectory ($service_path)" >&2
fi
if ! id "$client_user" >/dev/null 2>&1; then
  echo "client user $client_user does not exist; set CODEX_WEB_CLIENT_USER" >&2
  exit 1
fi

mkdir -p "$config_dir"
chown root:"$client_user" "$config_dir"
chmod 0750 "$config_dir"

token="$(openssl rand -hex 32)"
if [[ -z "$token" ]]; then
  echo "failed to generate a token" >&2
  exit 1
fi

umask 077
printf 'CODEX_WEB_RELOADER_TOKEN=%s\n' "$token" > "$config_dir/env"
printf 'CODEX_WEB_RELOADER_ROOT=%s\n' "$repo_root" >> "$config_dir/env"
printf 'CODEX_WEB_RELOADER_IDLE_CHECK_CMD="node scripts/check-codex-web-idle.mjs"\n' >> "$config_dir/env"
printf 'CODEX_WEB_DATA_ROOT=%s\n' "$service_data_root" >> "$config_dir/env"
printf 'CODEX_WEB_RELOADER_BUILD_CMD="npm run build"\n' >> "$config_dir/env"
printf 'CODEX_WEB_RELOADER_RESTART_CMD="systemctl restart codex-web.service"\n' >> "$config_dir/env"
chown root:root "$config_dir/env"
chmod 0600 "$config_dir/env"

printf '%s\n' "$token" > "$config_dir/token"
chown "root:$client_user" "$config_dir/token"
chmod 0440 "$config_dir/token"

sed -e "s#__WORKING_DIRECTORY__#$repo_root#g" \
    -e "s#__PATH__#$service_env_path#g" \
    -e "s#__NODE_BIN__#$node_bin#g" \
    "$repo_root/deploy/codex-web-reloader.service" > "$reloader_unit"
chmod 0644 "$reloader_unit"

systemctl daemon-reload
systemctl enable --now codex-web-reloader.service

echo "codex-web-reloader.service installed and started."
echo "Trigger a rebuild + restart with: npm run reload"
