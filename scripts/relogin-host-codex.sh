#!/usr/bin/env bash
# Report and repair the ChatGPT OAuth login of host-mode Web Codex Homes.
#
# Host mode gives every Web user a private home at
# TENANT_ROOT/<user-id>/host-codex-home. Its auth.json starts as a bootstrap
# copy of the machine user's ~/.codex/auth.json, so both homes begin on the
# same ChatGPT refresh-token lineage. ChatGPT rotates the refresh token on
# every refresh and rejects a token that is presented twice, so the first home
# to refresh permanently invalidates the other one:
#   Your access token could not be refreshed because your refresh token was
#   revoked.
# Signing in again in ~/.codex never repairs the Web home: the Web home is only
# imported once, before its config.toml exists. The Web home needs its own
# login, and `codex login` first removes the credential of the CODEX_HOME it
# runs against, so this script signs in inside a scratch home and only installs
# the file after the login actually succeeded.
#
# Run as the checkout owner (not with sudo):
#   ./scripts/relogin-host-codex.sh                    # report every tenant
#   ./scripts/relogin-host-codex.sh --device <user-id> # headless device code
#   ./scripts/relogin-host-codex.sh --browser <user-id># loopback callback
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tenant_root="${TENANT_ROOT:-$repo_root/tenants}"
# Past this age the access token is long expired, so the next task must
# refresh; a refresh that fails means the stored refresh token is spent.
stale_after_days="${CODEX_WEB_RELOGIN_STALE_DAYS:-3}"

mode="status"
tenant=""
while (( $# > 0 )); do
  case "$1" in
    --device) mode="device"; shift ;;
    --browser) mode="login"; shift ;;
    --status) mode="status"; shift ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) echo "未知参数：$1" >&2; exit 2 ;;
    *) tenant="$1"; shift ;;
  esac
done

if [[ ! -d "$tenant_root" ]]; then
  echo "找不到租户根目录 $tenant_root；如使用自定义路径请设置 TENANT_ROOT。" >&2
  exit 2
fi
codex_bin="$(command -v codex || true)"
if [[ -z "$codex_bin" ]]; then
  echo "未找到 codex；请先安装 Codex CLI。" >&2
  exit 2
fi

# ChatGPT 的授权端点会拒绝受限地区的直连（403
# unsupported_country_region_territory）。sudo 和 su 都会重置环境变量，把调用方
# 的代理设置丢掉，因此这里做三件事：必要时从调用方进程恢复、显式传给登录进程、
# 登录前先探测一次端点。
proxy_vars=(
  HTTPS_PROXY HTTP_PROXY ALL_PROXY SOCKS_PROXY NO_PROXY
  https_proxy http_proxy all_proxy socks_proxy no_proxy
)

# 被 `sudo ./scripts/...` 启动时，本进程的环境已经被 sudo 清空；调用方 shell
# 里仍有代理设置，而此刻我们是 root，可以从 /proc/<pid>/environ 读回来。
recover_proxy_from_caller() {
  [[ "$(id -u)" -eq 0 && -n "${SUDO_UID:-}" ]] || return 0
  local pid="${PPID}" depth=0 dump name value
  while [[ "$pid" =~ ^[0-9]+$ && "$pid" -gt 1 && "$depth" -lt 6 ]]; do
    if [[ -r "/proc/$pid/environ" && "$(stat -c %u "/proc/$pid" 2>/dev/null)" == "$SUDO_UID" ]]; then
      dump="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null || true)"
      if [[ "$dump" == *"proxy="* || "$dump" == *"PROXY="* ]]; then
        for name in "${proxy_vars[@]}"; do
          value="$(printf '%s\n' "$dump" | sed -n "s/^${name}=//p" | head -n 1)"
          if [[ -n "$value" ]]; then export "$name=$value"; fi
        done
        return 0
      fi
    fi
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    depth=$((depth + 1))
  done
}

collect_proxy_env() {
  proxy_env=()
  local name
  for name in "${proxy_vars[@]}"; do
    if [[ -n "${!name:-}" ]]; then proxy_env+=("$name=${!name}"); fi
  done
}

recover_proxy_from_caller
collect_proxy_env

# 预检：该端点只接受 POST，可达时会返回 405；受限地区直连返回 403。
probe_auth_endpoint() {
  command -v curl >/dev/null 2>&1 || return 0
  local result code body
  result="$(curl -s -m 15 -w $'\n%{http_code}' https://auth.openai.com/api/accounts/deviceauth/token 2>/dev/null || true)"
  code="${result##*$'\n'}"
  body="${result%$'\n'*}"
  [[ "$code" == "403" ]] || return 0
  if [[ "$body" == *unsupported_country_region_territory* ]]; then
    echo "预检失败：请求 auth.openai.com 时直连出口被地区限制拒绝（unsupported_country_region_territory）。" >&2
    if [[ "${#proxy_env[@]}" -eq 0 ]]; then
      echo "当前进程没有代理变量（sudo/su 会清空环境）。请在本机带 HTTPS_PROXY/HTTP_PROXY 的 shell 中运行，或改用：" >&2
      echo "  sudo --preserve-env=HTTPS_PROXY,HTTP_PROXY,ALL_PROXY,SOCKS_PROXY -- $0 ${tenant:-<user-id>} --device" >&2
      echo "也可以先以仓库属主身份（不加 sudo）运行本脚本，脚本内部会按需调用 sudo。" >&2
    else
      echo "已检测到代理变量但仍被拒，请检查代理是否可用。" >&2
    fi
    exit 1
  fi
  echo "提示：auth.openai.com 预检返回 403，继续尝试登录。" >&2
}


sudo_ready=false

# Read a tenant file that may be owned by another tenant UID.
read_owned_file() {
  local file="$1"
  if [[ -r "$file" ]]; then
    cat "$file"
    return
  fi
  if [[ "$sudo_ready" == true ]] && sudo -n cat "$file" 2>/dev/null; then
    return
  fi
  return 1
}

# Print: <auth_mode> <last_refresh> <state>
describe_auth() {
  local raw
  if ! raw="$(read_owned_file "$1")"; then
    echo "- - unreadable"
    return
  fi
  printf '%s' "$raw" | node -e '
    const limit = Number(process.argv[1]) * 86_400_000;
    let mode = "-", last = "-", state = "invalid";
    try {
      const auth = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      mode = auth.auth_mode ?? "-";
      last = auth.last_refresh ?? "-";
      const age = Date.parse(last);
      if (!auth.tokens?.refresh_token) state = "no-refresh-token";
      else if (Number.isNaN(age)) state = "unknown-age";
      else state = Date.now() - age > limit ? "stale" : "ok";
    } catch { state = "invalid"; }
    console.log(`${mode} ${last} ${state}`);
  ' "$stale_after_days"
}

tenant_owner() {
  stat -c '%u:%g' "${tenant_root}/$1/host-codex-home"
}

report_tenant() {
  local id="$1" owner
  owner="$(tenant_owner "$id")"
  printf '%s uid=%s gid=%s user=%s %s\n' \
    "$id" "${owner%%:*}" "${owner##*:}" \
    "$(getent passwd "${owner%%:*}" | cut -d: -f1 || true)" \
    "$(describe_auth "${tenant_root}/$id/host-codex-home/auth.json")"
}

if [[ "$mode" == "status" ]]; then
  if [[ -n "$tenant" ]]; then
    [[ -d "${tenant_root}/$tenant/host-codex-home" ]] || { echo "找不到租户 $tenant。" >&2; exit 2; }
    report_tenant "$tenant"
    exit 0
  fi
  found=false
  for dir in "$tenant_root"/*/; do
    [[ -d "${dir}host-codex-home" ]] || continue
    found=true
    report_tenant "$(basename "$dir")"
  done
  [[ "$found" == true ]] || echo "$tenant_root 下没有找到 host-codex-home。" >&2
  echo "state=stale 只表示访问令牌已过期；若任务报 refresh token revoked / already used，请用 --device 或 --browser 重新登录该租户。" >&2
  echo "其他租户的 auth.json 属于各自的系统用户，unreadable 表示需要 sudo 才能读取。" >&2
  exit 0
fi

if [[ -z "$tenant" ]]; then
  echo "--device/--browser 需要一个租户 user-id；先运行本脚本不带参数查看列表。" >&2
  exit 2
fi

probe_auth_endpoint
tenant_home="${tenant_root}/$tenant/host-codex-home"
[[ -d "$tenant_home" ]] || { echo "找不到 $tenant_home。" >&2; exit 2; }
owner="$(tenant_owner "$tenant")"
owner_uid="${owner%%:*}"; owner_gid="${owner##*:}"

if [[ "$owner_uid" -ne "$(id -u)" ]]; then
  [[ "$(id -u)" -eq 0 ]] || echo "请以仓库属主身份运行；脚本会用 sudo 切换到租户用户 $owner_uid。" >&2
  command -v sudo >/dev/null 2>&1 || { echo "未找到 sudo。" >&2; exit 2; }
  sudo -v
  sudo_ready=true
fi

# codex login deletes the credential of the CODEX_HOME it runs against, so a
# failed or abandoned login must not be able to log the tenant out. The
# scratch home lives outside TENANT_ROOT because that directory is root-owned.
# A Codex Web task sets TMPDIR inside its own job runtime, which is reclaimed
# with the job; a scratch home must outlive the process that started it.
staging_root="${TMPDIR:-/tmp}"
if [[ "$staging_root" == *"/.runtime/jobs/"* ]]; then staging_root="/tmp"; fi
staging="$(mktemp -d "$staging_root/codex-web-relogin-$tenant-XXXXXX" 2>/dev/null \
  || mktemp -d "/tmp/codex-web-relogin-$tenant-XXXXXX")"
chmod 700 "$staging"
if [[ "$owner_uid" -ne "$(id -u)" ]]; then
  if [[ "$(id -u)" -eq 0 ]]; then
    chown -R "$owner_uid:$owner_gid" "$staging"
  else
    sudo chown -R "$owner_uid:$owner_gid" "$staging"
  fi
fi

login_args=("$codex_bin" login)
if [[ "$mode" == "device" ]]; then login_args+=(--device-auth); fi
echo "租户 $tenant 当前登录：$(describe_auth "$tenant_home/auth.json")"
echo "本次登录使用临时 CODEX_HOME $staging，成功后才会覆盖 $tenant_home/auth.json；桌面端 ~/.codex 不受影响。"

run_login() {
  local cmd=(env "CODEX_HOME=$staging" "${proxy_env[@]}" "${login_args[@]}")
  if [[ "$owner_uid" -eq "$(id -u)" ]]; then
    "${cmd[@]}"
  else
    sudo -u "#$owner_uid" -H "${cmd[@]}"
  fi
}
if ! run_login; then
  echo "" >&2
  echo "登录未完成，$tenant_home/auth.json 保持原样。" >&2
  if [[ "${#proxy_env[@]}" -eq 0 ]]; then
    echo "当前环境未设置代理变量。若报 403 unsupported_country_region_territory，说明请求是直连出去的（本机直连 ChatGPT 授权端点会被拒），请先 export HTTPS_PROXY/HTTP_PROXY 再重试。" >&2
  else
    echo "已按当前代理设置重试仍失败时，可改用本机浏览器回调：$0 --browser $tenant。" >&2
  fi
  exit 1
fi

node -e '
  const auth = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (auth.auth_mode !== "chatgpt" || !auth.tokens?.refresh_token) process.exit(1);
' "$staging/auth.json" || { echo "登录未产生可用的 ChatGPT 凭据，已保留 $tenant_home/auth.json 不变。" >&2; exit 1; }

if [[ "$owner_uid" -eq "$(id -u)" ]]; then
  install -m 600 "$staging/auth.json" "$tenant_home/auth.json"
elif [[ "$(id -u)" -eq 0 ]]; then
  install -m 600 -o "$owner_uid" -g "$owner_gid" "$staging/auth.json" "$tenant_home/auth.json"
else
  sudo install -m 600 -o "$owner_uid" -g "$owner_gid" "$staging/auth.json" "$tenant_home/auth.json"
fi
echo "已验证凭据，已写入 $tenant_home/auth.json（临时目录 $staging 可删除）。"
echo "租户 $tenant 登录结果：$(describe_auth "$tenant_home/auth.json")"
echo "无需重启 codex-web：app-server 会在下一次任务时重新读取 auth.json。"
