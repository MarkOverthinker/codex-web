#!/usr/bin/env bash
# Rootless background daemon for the codex-web offline bundle.
#
# Usage:
#   autostart.sh            start the service in the background, with crash
#                           auto-restart and a duplicate-run guard
#   autostart.sh status     show whether the daemon is alive
#   autostart.sh stop       stop the daemon and its service process
#   autostart.sh --loop     internal: restart loop (do not call directly)
#   autostart.sh --foreground
#                           internal: run the service in the foreground
#                           (used by the systemd --user unit)
#
# Reboot persistence without root: add this line to your user crontab
# (crontab -e); the system cron daemon runs it as your user at boot:
#
#   @reboot /absolute/path/to/codex-web/autostart.sh
set -Eeuo pipefail

PACKAGE_ROOT=""
{
  _dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while :; do
    if [[ -f "$_dir/start.sh" ]]; then
      PACKAGE_ROOT="$_dir"
      break
    fi
    [[ "$_dir" == "/" ]] && break
    _dir="$(dirname "$_dir")"
  done
}
if [[ -z "$PACKAGE_ROOT" ]]; then
  echo "error: cannot locate the bundle root (start.sh) from $0" >&2
  exit 1
fi
APP_ROOT="$PACKAGE_ROOT/app"
DATA_ROOT="$APP_ROOT/data"
LOG_DIR="$DATA_ROOT/logs"
LOG_FILE="$LOG_DIR/autostart.log"
PID_FILE="$DATA_ROOT/codex-web-autostart.pid"
mkdir -p "$LOG_DIR"

daemon_is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" && "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

read_env() {
  # dotenv-style lookup for the few values the launcher itself needs.
  local key="$1"
  local fallback="$2"
  local value
  value="$(sed -n "s/^$key=//p" "$APP_ROOT/.env" 2>/dev/null | tail -n 1)"
  printf '%s\n' "${value:-$fallback}"
}

if [[ "${1:-}" == "--loop" ]]; then
  child=""
  trap 'if [[ -n "$child" ]]; then kill "$child" 2>/dev/null || true; fi; exit 0' TERM INT
  while true; do
    echo "$(date -Is) starting service" >>"$LOG_FILE"
    "$PACKAGE_ROOT/start.sh" &
    child=$!
    set +e
    wait "$child"
    status=$?
    set -e
    echo "$(date -Is) service exited (status=$status); restarting in 3s" >>"$LOG_FILE"
    sleep 3
  done
fi

if [[ "${1:-}" == "--foreground" ]]; then
  exec "$PACKAGE_ROOT/start.sh"
fi

if [[ "${1:-}" == "stop" ]]; then
  if daemon_is_running; then
    kill -TERM "$(cat "$PID_FILE")" 2>/dev/null || true
    for _ in $(seq 1 30); do
      daemon_is_running || break
      sleep 1
    done
    if daemon_is_running; then
      echo "error: daemon did not stop within 30s" >&2
      exit 1
    fi
  fi
  echo "stopped"
  exit 0
fi

if [[ "${1:-}" == "status" ]]; then
  if daemon_is_running; then
    echo "running (pid $(cat "$PID_FILE"))"
    exit 0
  fi
  echo "not running"
  exit 1
fi

if daemon_is_running; then
  echo "already running (pid $(cat "$PID_FILE"))"
  exit 0
fi

if ! grep -q '^APP_PASSWORD_HASH=\$2' "$APP_ROOT/.env" 2>/dev/null; then
  echo "error: .env is not initialized; run ./start.sh once to set the login password" >&2
  exit 1
fi

export PORT
PORT="${PORT:-$(read_env PORT 37821)}"
export BASE_PATH
BASE_PATH="${BASE_PATH:-$(read_env BASE_PATH /codex-web)}"

nohup "$0" --loop >>"$LOG_FILE" 2>&1 </dev/null &
echo "$!" >"$PID_FILE"
echo "started daemon pid $(cat "$PID_FILE"); log: $LOG_FILE"

node_bin="$PACKAGE_ROOT/node/bin/node"
if [[ ! -x "$node_bin" ]]; then
  node_bin="$(command -v node || true)"
fi
if [[ -n "$node_bin" ]]; then
  for _ in $(seq 1 30); do
    if "$node_bin" -e "fetch('http://127.0.0.1:${PORT}${BASE_PATH}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      echo "healthy at http://127.0.0.1:${PORT}${BASE_PATH}/"
      exit 0
    fi
    sleep 1
  done
  echo "warning: daemon started but health did not respond within 30s; check $LOG_FILE" >&2
fi
