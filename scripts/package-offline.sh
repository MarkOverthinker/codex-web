#!/usr/bin/env bash
# Build a self-contained, offline-ready codex-web bundle for Linux x64.
#
# The bundle includes:
#   - the production build (dist + dist-server)
#   - production node_modules (including the bundled Codex CLI for linux-x64)
#   - a bundled Node.js runtime (optional, enabled by default)
#   - the shared Python runtime (uv + managed Python + wheels cache)
#   - start.sh, which generates .env, repairs the Python runtime offline, and
#     starts the service in host mode
#
# It intentionally excludes .env, data (except data/python), tenants,
# workspaces, git metadata and every user's conversation state.
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM="linux-x64"
NODE_VERSION="${NODE_VERSION:-22.21.0}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/tmp/offline-package-output}"
PACKAGE_DIR="codex-web"

SKIP_BUILD=0
SKIP_NODE=0
KEEP_STAGING=0
STAGING_ROOT="${STAGING_ROOT:-$REPO_ROOT/tmp/offline-package-staging}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-node)
      SKIP_NODE=1
      shift
      ;;
    --keep-staging)
      KEEP_STAGING=1
      shift
      ;;
    --node-version)
      NODE_VERSION="$2"
      shift 2
      ;;
    --staging-root)
      STAGING_ROOT="$2"
      shift 2
      ;;
    *)
      echo "usage: $0 [--output-dir DIR] [--skip-build] [--skip-node] [--node-version X.Y.Z] [--keep-staging]" >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$REPO_ROOT/server" || ! -d "$REPO_ROOT/scripts" ]]; then
  echo "error: REPO_ROOT does not look like a codex-web checkout: $REPO_ROOT" >&2
  exit 1
fi

rm -rf "$STAGING_ROOT"
mkdir -p "$STAGING_ROOT/$PACKAGE_DIR/app" "$STAGING_ROOT/$PACKAGE_DIR/node"
STAGING="$STAGING_ROOT/$PACKAGE_DIR"
WORK="$(mktemp -d "$REPO_ROOT/tmp/offline-work.XXXXXX")"
trap 'if [[ "$KEEP_STAGING" -ne 1 ]]; then rm -rf "$STAGING_ROOT"; fi; rm -rf "$WORK"' EXIT

echo "==> copying source tree (without git/data/tenants/node_modules)"
tar -C "$REPO_ROOT" \
  --exclude='.git' \
  --exclude='.github' \
  --exclude='.env' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='dist-server' \
  --exclude='dist-unusable-*' \
  --exclude='data' \
  --exclude='tenants' \
  --exclude='workspaces' \
  --exclude='tmp' \
  --exclude='*.sqlite*' \
  --exclude='*.log' \
  --exclude='coverage' \
  -cf - . | tar -C "$STAGING/app" -xf -

echo "==> copying node_modules and pruning dev dependencies"
cp -a "$REPO_ROOT/node_modules" "$STAGING/app/node_modules"

if [[ "$SKIP_BUILD" -ne 1 ]]; then
  echo "==> building inside the staging tree"
  (cd "$STAGING/app" && npm run build)
else
  echo "==> copying existing production build"
  for required in dist dist-server; do
    if [[ ! -d "$REPO_ROOT/$required" ]]; then
      echo "error: missing $required; run npm run build (or omit --skip-build)" >&2
      exit 1
    fi
  done
  cp -a "$REPO_ROOT/dist" "$STAGING/app/dist"
  cp -a "$REPO_ROOT/dist-server" "$STAGING/app/dist-server"
fi

(cd "$STAGING/app" && npm prune --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)

echo "==> copying shared Python runtime (uv + pythons + wheels cache)"
mkdir -p "$STAGING/app/data"
cp -a "$REPO_ROOT/data/python" "$STAGING/app/data/python"

if [[ "$SKIP_NODE" -ne 1 ]]; then
  echo "==> bundling Node.js $NODE_VERSION ($PLATFORM)"
  node_url="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
  shasum_url="https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  curl -fsSL -o "$WORK/node-v$NODE_VERSION-linux-x64.tar.xz" "$node_url"
  curl -fsSL -o "$WORK/SHASUMS256.txt" "$shasum_url"
  (cd "$WORK" && grep "node-v$NODE_VERSION-linux-x64.tar.xz" SHASUMS256.txt | sha256sum -c -)
  tar -C "$STAGING/node" -xJf "$WORK/node-v$NODE_VERSION-linux-x64.tar.xz" --strip-components=1
else
  rmdir "$STAGING/node"
fi

echo "==> writing launchers"
mkdir -p "$STAGING/bin"
cat > "$STAGING/autostart.sh" <<'EOF'
#!/usr/bin/env bash
# Rootless background daemon entry point. Delegates to the bundled launcher.
set -Eeuo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/app/scripts/autostart.sh" "$@"
EOF
chmod +x "$STAGING/autostart.sh"
if [[ "$SKIP_NODE" -ne 1 ]]; then
  cat > "$STAGING/bin/codex" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$PACKAGE_ROOT/node/bin/node" "$PACKAGE_ROOT/app/node_modules/@openai/codex/bin/codex.js" "$@"
EOF
else
  cat > "$STAGING/bin/codex" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$PACKAGE_ROOT/app/node_modules/@openai/codex/bin/codex.js" "$@"
EOF
fi
chmod +x "$STAGING/bin/codex"

cat > "$STAGING/start.sh" <<'EOF'
#!/usr/bin/env bash
# Start codex-web from the offline bundle in user-level host mode.
# No root is required: the web service and task processes both run as the
# current user. First run generates .env, asks for the web login password and
# repairs the shared Python runtime using only the wheels bundled inside the
# package.
set -Eeuo pipefail

PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$PACKAGE_ROOT/app"

if [[ -x "$PACKAGE_ROOT/node/bin/node" ]]; then
  NODE_BIN="$PACKAGE_ROOT/node/bin/node"
  export PATH="$PACKAGE_ROOT/node/bin:$PATH"
else
  NODE_BIN="${NODE_BIN:-node}"
  if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    echo "error: no Node.js found; install Node >=22.13 or unpack with bundled node" >&2
    exit 1
  fi
fi

if [[ ! -f "$APP_ROOT/.env" ]]; then
  cp "$APP_ROOT/.env.example" "$APP_ROOT/.env"
  if command -v openssl >/dev/null 2>&1; then
    secret="$(openssl rand -hex 32)"
  else
    secret="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  fi
  sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$secret/" "$APP_ROOT/.env"
  sed -i "s/^APP_USERNAME=.*/APP_USERNAME=$(id -un)/" "$APP_ROOT/.env"
  echo "Generated $APP_ROOT/.env (random SESSION_SECRET, APP_USERNAME=$(id -un))."
fi

if grep -q '^APP_PASSWORD_HASH=replace-with-bcrypt-hash' "$APP_ROOT/.env"; then
  echo "Set the web login password (at least 12 characters):"
  read -r -s password
  echo
  if [[ ${#password} -lt 12 ]]; then
    echo "error: password must be at least 12 characters" >&2
    exit 1
  fi
  hash="$("$NODE_BIN" "$APP_ROOT/scripts/hash-password.mjs" "$password")"
  sed -i "s|^APP_PASSWORD_HASH=.*|APP_PASSWORD_HASH=$hash|" "$APP_ROOT/.env"
fi

if [[ ! -x "$APP_ROOT/data/python/shared/bin/python" ]] \
  || ! "$APP_ROOT/data/python/shared/bin/python" -c 'import pandas, openpyxl, docx, pptx, pypdf, PIL' >/dev/null 2>&1; then
  echo "Repairing the bundled Python runtime from the offline wheels cache..."
  (
    cd "$APP_ROOT"
    UV_OFFLINE=1 PYTHON_RUNTIME_ROOT="$APP_ROOT/data/python" ./scripts/setup-python.sh
  )
fi

export HOST_MODE=true
export APP_USERNAME="${APP_USERNAME:-$(id -un)}"
export CODEX_RUNTIME_PATH="${CODEX_RUNTIME_PATH:-$PACKAGE_ROOT/bin/codex}"

echo "Starting codex-web at http://127.0.0.1:${PORT:-37821}${BASE_PATH:-/codex-web}/"
cd "$APP_ROOT"
exec "$NODE_BIN" dist-server/server/index.js
EOF
chmod +x "$STAGING/start.sh"

echo "==> copying upgrade script"
cp "$REPO_ROOT/scripts/upgrade.sh" "$STAGING/upgrade.sh"
chmod +x "$STAGING/upgrade.sh"

cat > "$STAGING/README-OFFLINE.md" <<'EOF'
# Codex Web 离线便携包

本目录是 codex-web 的 Linux x86_64 便携包：解压后运行 `./start.sh` 即可启动
Web 服务。包内已内置 Node.js、生产依赖（含 Codex CLI）和共享 Python 运行时；
首次启动会生成 `.env`、引导设置登录密码，并在必要时用包内 wheels 缓存离线重建
Python 运行时。

## 启动

```bash
tar --zstd -xf codex-web-offline-linux-x64-node-*.tar.zst
cd codex-web
./start.sh
```

浏览器打开 http://127.0.0.1:37821/codex-web/ 。首次运行会要求输入至少 12 位
的登录密码。

## 无需 root，用户级运行

把包解压到自己的用户目录即可直接运行，不需要 root，也不需要 systemd 或
`sudo`。服务进程和 Codex 任务进程都使用启动 `start.sh` 的用户身份；代码在
非 root 下会自动跳过 `chown`/`setpriv` 特权路径（这些只在 root 服务向其他
系统用户降权时才使用）。`APP_USERNAME` 默认是当前系统用户，保持默认即可；
如确实需要让任务以另一个系统账号运行，才需要额外配置。

## 局域网访问（可选，需明确开启）

默认只监听 `127.0.0.1`。需要让局域网内其他设备访问时，编辑 `app/.env`：

```env
HOST=0.0.0.0
ALLOW_HOST_PUBLIC_BIND=true
```

这是安全敏感选项：Web 界面会暴露到所有网卡，没有 TLS 时登录密码和会话
Cookie 以明文传输。只建议在可信局域网使用，并保持 `PUBLIC_BASE_URL` 与
浏览器实际访问地址一致；更稳妥的做法是监听回环 + 反向代理 + HTTPS。

## 长期运行与重启后自动启动（无需 root）

日常前台运行用 `./start.sh`。需要后台常驻、崩溃自动重启，并在机器重启后
自动恢复时，使用 `autostart.sh`：

```bash
./autostart.sh            # 后台启动守护进程（崩溃后 3 秒自动拉起）
./autostart.sh status     # 查看状态
./autostart.sh stop       # 停止守护进程与服务
```

守护日志在 `app/data/logs/autostart.log`，重复运行 `autostart.sh` 不会启动
第二个实例。首次使用前先运行一次 `./start.sh` 完成 `.env` 初始化。

开机自启二选一：

方案 A：用户 crontab（推荐，通常不需要任何特权）

```bash
crontab -e
```

添加一行（改成你的实际绝对路径）：

```
@reboot /home/你的用户名/codex-web/autostart.sh
```

目标机需要已安装并运行系统 cron 服务；`@reboot` 会在开机时以你的用户身份
执行，不依赖登录。

方案 B：systemd --user

```bash
mkdir -p ~/.config/systemd/user
cp app/deploy/codex-web-user.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now codex-web
loginctl enable-linger "$USER"
```

最后一行是“重启后不登录也自动启动”的关键；普通用户能否自行执行取决于
发行版的 polkit 策略，被拒绝时需要 root 执行一次。没有 linger 时，
systemd --user 服务只会在用户登录后启动。

## 目标机器前置条件

- Linux x86_64，glibc 2.17+（Node.js 官方二进制的要求；Codex CLI 本身是
  musl 静态构建）；
- `bash`、`tar`、`zstd`（解压）、`git`（任务工作区初始化）、`openssl` 或
  `od`（首次生成随机 SESSION_SECRET）；
- 不需要预装 Node.js、npm 或系统 Python。

可选工具：

- `ffmpeg`：语音转写（还需在 `.env` 配置 `DASHSCOPE_API_KEY` 和网络）；
- `setpriv`：宿主模式任务进程恢复用户的完整补充组；
- 若省略 `--skip-node`，包内已带 Node.js，目标机无需安装。

## 使用 Codex 任务的前提

Web 服务可以完全离线启动，但 Codex 任务本身还需要：

1. 目标系统用户的 `~/.codex` 可用（`config.toml` 以及 `auth.json`、
   `rightcode_auth.json` 或 config.toml 中的 `experimental_bearer_token`）；
2. Codex 模型 API 可达（公网，或通过 `config.toml` 指向内网/代理端点）。

两者缺一不可；完全断网且没有本地模型端点时，任务无法执行。

## 数据与安全

- 运行数据保存在 `app/data`（SQLite、日志、Python 运行时）与 `app/tenants`
  （会话、附件、输出）；备份这两个目录即可迁移。
- 本包不包含 `.env`、任何用户数据或 `~/.codex` 凭据；请勿把目标机的
  `.env`、`tenants/`、`data/*.sqlite*` 或凭据文件重新分发给其他人。
- 在宿主模式（本包默认）下，任务进程以 `.env` 中 `APP_USERNAME` 对应的系统
  用户身份运行，可访问该用户的宿主工具与 `~/.codex`。只应在可信机器上使用。

## 重新打包

在 codex-web 仓库中运行：

```bash
scripts/package-offline.sh --output-dir /path/to/outputs
```

常用参数：`--skip-build` 复用现有构建产物；`--skip-node` 不内置 Node.js；
`--node-version 22.21.0` 指定内置 Node 版本；`--keep-staging` 保留中间目录。

## 升级已部署的实例

把新版本的离线包放到目标机任意位置，然后在旧安装目录中运行：

```bash
./upgrade.sh --archive /path/to/codex-web-offline-linux-x64-node-*.tar.zst
```

脚本会校验新包的 SHA256（旁边有 `.sha256` 时）、停止正在运行的 autostart
守护、把 `app/data`、`app/tenants` 和 `app/.env*` 备份到安装目录旁边的
`codex-web-backup-<时间戳>/`，然后解压新包、保留这些状态并原地替换。完成后
按提示运行 `./start.sh`（前台）或 `./autostart.sh`（后台守护，原有
cron/systemd 自启条目无需修改）即可。默认会删除旧代码目录（用户数据已有
备份）；需要保留旧代码目录时加 `--keep-old`。若服务是前台 `./start.sh`
启动的，请先自行停止再运行升级。
EOF

echo "==> checking bundled Codex CLI"
if [[ "$SKIP_NODE" -ne 1 ]]; then
  "$STAGING/node/bin/node" "$STAGING/app/node_modules/@openai/codex/bin/codex.js" --version
else
  node "$STAGING/app/node_modules/@openai/codex/bin/codex.js" --version
fi

mkdir -p "$OUTPUT_DIR"
archive="$OUTPUT_DIR/codex-web-offline-$PLATFORM-node$([[ "$SKIP_NODE" -eq 1 ]] && echo "-noembeddednode" || echo "")-$(date +%Y%m%d).tar.zst"
echo "==> compressing to $archive"
tar --zstd -C "$STAGING_ROOT" -cf "$archive" "$PACKAGE_DIR"
sha256sum "$archive" | tee "$archive.sha256"
du -h "$archive"

if [[ "$KEEP_STAGING" -eq 1 ]]; then
  echo "staging kept at: $STAGING"
else
  rm -rf "$STAGING_ROOT"
fi
echo "done"
