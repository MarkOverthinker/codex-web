#!/usr/bin/env bash
# Repair a host-mode Codex Web deployment after provider imports created
# root-owned Codex files or a stale models_cache.json.
#
# Run this script as the checkout owner (not with sudo):
#   ./scripts/repair-host-provider-sources.sh
#
# Optional arguments replace the default model-file mappings, for example:
#   ./scripts/repair-host-provider-sources.sh \
#     --models-file deepseek=models.json \
#     --models-file sssaicodeapi=sssaicodeapi-models.json
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_user="$(id -un)"
target_uid="$(id -u)"
target_gid="$(id -g)"
target_home="$(getent passwd "$target_user" | awk -F: 'NR == 1 { print $6 }')"

if [[ "${EUID}" -eq 0 ]]; then
  echo "请以仓库属主的普通用户运行此脚本，不要使用 sudo 直接启动。" >&2
  exit 2
fi
if [[ -z "$target_home" || ! -d "$target_home" ]]; then
  echo "无法解析当前用户 $target_user 的主目录。" >&2
  exit 2
fi
if ! command -v sudo >/dev/null 2>&1; then
  echo "未找到 sudo；请安装 sudo，或按脚本内容手动执行 root 步骤。" >&2
  exit 2
fi

sudo -v

service_unit="${CODEX_WEB_SERVICE_UNIT:-codex-web.service}"
reloader_token_file="${CODEX_WEB_RELOADER_TOKEN_FILE:-/etc/codex-web-reloader/token}"
node_bin="$(command -v node)"

models_args=(
  --models-file "deepseek=models.json"
  --models-file "sssaicodeapi=sssaicodeapi-models.json"
)
if (( $# > 0 )); then
  models_args=("$@")
fi

service_exists=false
service_was_active=false
if command -v systemctl >/dev/null 2>&1 && sudo systemctl cat "$service_unit" >/dev/null 2>&1; then
  service_exists=true
  if sudo systemctl is-active --quiet "$service_unit"; then
    service_was_active=true
    sudo systemctl stop "$service_unit"
  fi
fi

restart_after_failure() {
  if [[ "$service_exists" == true && "$service_was_active" == true ]]; then
    echo "操作失败，尝试恢复 $service_unit ..." >&2
    sudo systemctl start "$service_unit" || true
  fi
}
trap restart_after_failure ERR

# init-provider-sources prepares and repairs only each tenant's Web home.
# The desktop ~/.codex is a read-only source, including its file permissions.

# Older root-mode builds can leave generated artifacts undeletable by the
# checkout owner. They are disposable build outputs, so repair only these
# exact directories before running npm build.
for build_dir in "$repo_root/dist" "$repo_root/dist-server"; do
  if [[ -d "$build_dir" ]]; then
    sudo chown -R "$target_uid:$target_gid" "$build_dir"
  fi
done

cd "$repo_root"
echo "构建前端和服务端 ..."
npm run build

echo "导入 Provider 并重新生成 config.toml/models_cache.json ..."
sudo "$node_bin" scripts/init-provider-sources.mjs "${models_args[@]}"

if [[ -r "$reloader_token_file" ]]; then
  echo "通过 codex-web-reloader 重建并重启服务 ..."
  npm run reload
elif [[ "$service_exists" == true ]]; then
  echo "未找到 $reloader_token_file，直接重启 $service_unit ..."
  sudo systemctl restart "$service_unit"
else
  echo "未找到 reloader 或 $service_unit；配置已生成，请手动启动服务。" >&2
fi

trap - ERR
echo "修复完成。生成配置仅保存在各租户的 host-codex-home；桌面端 ~/.codex 未修改。"
