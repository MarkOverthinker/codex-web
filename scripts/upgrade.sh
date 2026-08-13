#!/usr/bin/env bash
# codex-web 离线便携包增量升级脚本
#
# 只更新程序文件，完整保留目标机已有的运行数据：
#   app/.env、app/data（SQLite / deliverables / logs / voice-input / python）、
#   app/tenants、app/workspaces
#
# 用法:
#   ./upgrade.sh <离线包.tar.zst> [部署根] [--no-start]
#
# 示例:
#   ./upgrade.sh codex-web-offline-linux-x64-node-20260813.tar.zst /home/user/codex-web
#
# 部署根默认为当前目录，脚本会向上自动查找含 start.sh 的目录。
# 升级前会自动停止服务（autostart 守护 / systemd 服务均可识别），
# 并将运行数据备份到部署根同级 codex-web-backups/ 目录。
set -Eeuo pipefail

NO_START=0
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-start)
      NO_START=1
      shift
      ;;
    -h|--help)
      sed -n '1,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

ARCHIVE="${POSITIONAL[0]:-}"
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "用法: $0 <离线包.tar.zst> [部署根] [--no-start]" >&2
  echo "示例: $0 codex-web-offline-linux-x64-node-20260813.tar.zst /home/user/codex-web" >&2
  exit 2
fi
ARCHIVE="$(readlink -f "$ARCHIVE")"

DEPLOY_ROOT="${POSITIONAL[1]:-}"
if [[ -z "$DEPLOY_ROOT" ]]; then
  DEPLOY_ROOT="$(pwd)"
  while :; do
    if [[ -f "$DEPLOY_ROOT/start.sh" ]]; then
      break
    fi
    [[ "$DEPLOY_ROOT" == "/" ]] && { DEPLOY_ROOT=""; break; }
    DEPLOY_ROOT="$(dirname "$DEPLOY_ROOT")"
  done
  if [[ -z "$DEPLOY_ROOT" ]]; then
    echo "错误: 无法从当前目录向上找到部署根（缺少 start.sh），请显式传入部署根。" >&2
    exit 2
  fi
fi
DEPLOY_ROOT="$(readlink -f "$DEPLOY_ROOT")"

for tool in tar zstd; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "错误: 目标机缺少 $tool" >&2
    exit 1
  fi
done

if [[ ! -f "$DEPLOY_ROOT/start.sh" ]]; then
  echo "错误: $DEPLOY_ROOT 不是有效的部署根（未找到 start.sh）" >&2
  exit 1
fi

APP_ROOT="$DEPLOY_ROOT/app"

# 校验包 SHA256（同目录存在 .sha256 时自动校验）
if [[ -f "$ARCHIVE.sha256" ]] && command -v sha256sum >/dev/null 2>&1; then
  echo "==> 校验离线包 SHA256"
  (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256")
fi

read_env_key() {
  local key="$1" fallback="$2" value
  value="$(sed -n "s/^${key}=//p" "$APP_ROOT/.env" 2>/dev/null | tail -n1)"
  printf '%s\n' "${value:-$fallback}"
}

PORT="$(read_env_key PORT 37821)"
BASE_PATH="$(read_env_key BASE_PATH /codex-web)"
HEALTH_URL="http://127.0.0.1:${PORT}${BASE_PATH}/api/health"

health_ok() {
  local node_bin
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 3 -O /dev/null "$HEALTH_URL" >/dev/null 2>&1
  else
    node_bin="$DEPLOY_ROOT/node/bin/node"
    [[ -x "$node_bin" ]] || node_bin="$(command -v node || true)"
    [[ -z "$node_bin" ]] && return 1
    "$node_bin" -e "fetch('$HEALTH_URL').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
  fi
}

echo "==> 部署根: $DEPLOY_ROOT"
echo "==> 升级包: $ARCHIVE"
echo "==> 健康检查: $HEALTH_URL"

# 停止服务
STOP_METHOD=none
if [[ -x "$DEPLOY_ROOT/autostart.sh" ]] && "$DEPLOY_ROOT/autostart.sh" status >/dev/null 2>&1; then
  echo "==> 停止 autostart 守护进程"
  if ! "$DEPLOY_ROOT/autostart.sh" stop >/dev/null; then
    echo "错误: 无法停止 autostart 守护进程，请先手动执行 $DEPLOY_ROOT/autostart.sh stop。" >&2
    exit 1
  fi
  STOP_METHOD=autostart
elif command -v systemctl >/dev/null 2>&1 && systemctl --user is-active codex-web >/dev/null 2>&1; then
  echo "==> 停止 systemd --user 服务 codex-web"
  if ! systemctl --user stop codex-web; then
    echo "错误: 无法停止 systemd --user 服务 codex-web，请先手动执行 systemctl --user stop codex-web。" >&2
    exit 1
  fi
  STOP_METHOD=systemd-user
elif command -v systemctl >/dev/null 2>&1 && systemctl is-active codex-web >/dev/null 2>&1; then
  echo "==> 停止系统服务 codex-web"
  if ! systemctl stop codex-web; then
    echo "错误: 无法停止系统服务 codex-web（可能需要 root）。请先手动停止后再运行升级。" >&2
    exit 1
  fi
  STOP_METHOD=systemd-system
elif health_ok; then
  echo "错误: 检测到服务正在前台运行（健康检查可达）。" >&2
  echo "请先停止 start.sh / autostart.sh 相关进程后再运行升级。" >&2
  exit 1
fi

if health_ok; then
  echo "==> 等待服务完全停止"
  for _ in $(seq 1 30); do
    health_ok || break
    sleep 1
  done
  if health_ok; then
    echo "错误: 服务在 30 秒内未停止。" >&2
    exit 1
  fi
fi

# 备份运行数据（data/python 由包内共享运行时管理，体积大且可离线重建，不纳入备份）
BACKUP_DIR="$(dirname "$DEPLOY_ROOT")/codex-web-backups"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/codex-web-backup-$STAMP.tar.zst"
echo "==> 备份运行数据到: $BACKUP_FILE"

backup_entries=()
for entry in app/.env app/data app/tenants app/workspaces; do
  [[ -e "$DEPLOY_ROOT/$entry" ]] && backup_entries+=("$entry")
done
if [[ ${#backup_entries[@]} -eq 0 ]]; then
  echo "    (未发现 .env / data / tenants / workspaces，跳过备份)"
  : >"$BACKUP_FILE"
else
  (
    cd "$DEPLOY_ROOT"
    tar --zstd --exclude='app/data/python' -cf "$BACKUP_FILE" "${backup_entries[@]}"
  )
fi

# 解压新包到临时目录，定位包根
TMP_ROOT="$(mktemp -d "$(dirname "$DEPLOY_ROOT")/.upgrade-tmp.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT
echo "==> 解压新离线包"
tar --zstd -C "$TMP_ROOT" -xf "$ARCHIVE"
NEW_ROOT=""
for candidate in "$TMP_ROOT"/*; do
  if [[ -d "$candidate" && -f "$candidate/start.sh" ]]; then
    NEW_ROOT="$candidate"
    break
  fi
done
if [[ -z "$NEW_ROOT" ]]; then
  echo "错误: 离线包内未找到含 start.sh 的包根。" >&2
  exit 1
fi

# 只同步程序文件；.env / data / tenants / workspaces 全部保留目标机现状
echo "==> 同步程序文件到部署根（保留 .env / data / tenants / workspaces）"
tar -C "$NEW_ROOT" \
  --exclude='./app/.env' \
  --exclude='./app/data' \
  --exclude='./app/tenants' \
  --exclude='./app/workspaces' \
  -cf - . | tar -C "$DEPLOY_ROOT" -xf -

# 启动服务
if [[ "$NO_START" -eq 1 ]]; then
  echo "==> 已跳过自动启动（--no-start），请手动启动："
  echo "    $DEPLOY_ROOT/start.sh      # 前台运行"
  echo "    $DEPLOY_ROOT/autostart.sh  # 后台守护"
elif [[ "$STOP_METHOD" == "systemd-user" ]]; then
  echo "==> 启动 systemd --user 服务 codex-web"
  systemctl --user start codex-web
elif [[ "$STOP_METHOD" == "systemd-system" ]]; then
  echo "==> 启动系统服务 codex-web"
  systemctl start codex-web
elif [[ -x "$DEPLOY_ROOT/autostart.sh" ]]; then
  echo "==> 启动 autostart 守护进程"
  "$DEPLOY_ROOT/autostart.sh"
else
  echo "==> 请手动启动: $DEPLOY_ROOT/start.sh"
fi

if [[ "$NO_START" -eq 0 ]]; then
  echo "==> 等待服务就绪"
  ready=0
  for _ in $(seq 1 30); do
    if health_ok; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ready" -eq 1 ]]; then
    echo "==> 服务已就绪: $HEALTH_URL"
  else
    echo "警告: 30 秒内未检测到健康响应，请检查 $APP_ROOT/data/logs/app.log" >&2
    exit 1
  fi
fi

echo
echo "==> 升级完成"
echo "    包 SHA256: $(sha256sum "$ARCHIVE" | awk '{print $1}')"
echo "    数据备份: $BACKUP_FILE"
echo "    回滚命令: $DEPLOY_ROOT/autostart.sh stop && tar --zstd -xf '$BACKUP_FILE' -C '$DEPLOY_ROOT' && $DEPLOY_ROOT/autostart.sh"
echo "    提示: 若新版本 .env.example 新增了配置项，请对比后手动补充到 $APP_ROOT/.env"
