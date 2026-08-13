#!/usr/bin/env bash
# In-place upgrade for a deployed codex-web offline bundle.
#
# Usage:
#   upgrade.sh [--archive /path/to/codex-web-offline-*.tar.zst] [--yes] [--keep-old]
#
# Behavior:
#   - locates the bundle root (the directory containing start.sh)
#   - verifies the new archive and its .sha256 file when present
#   - stops the autostart daemon when it is running
#   - backs up app/data, app/tenants and app/.env* next to the install
#   - extracts the new bundle and moves the preserved state into it
#   - swaps the new bundle into the old install path
#   - keeps the previous install root only with --keep-old
set -Eeuo pipefail

ROOT=""
{
  _dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while :; do
    if [[ -f "$_dir/start.sh" && -d "$_dir/app" ]]; then
      ROOT="$_dir"
      break
    fi
    [[ "$_dir" == "/" ]] && break
    _dir="$(dirname "$_dir")"
  done
}
if [[ -z "$ROOT" ]]; then
  echo "error: cannot locate the codex-web bundle root (start.sh) from $0" >&2
  exit 1
fi

ARCHIVE=""
ASSUME_YES=0
KEEP_OLD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --archive)
      ARCHIVE="$2"
      shift 2
      ;;
    --yes)
      ASSUME_YES=1
      shift
      ;;
    --keep-old)
      KEEP_OLD=1
      shift
      ;;
    *)
      echo "usage: $0 [--archive PATH] [--yes] [--keep-old]" >&2
      exit 2
      ;;
  esac
done

PARENT="$(dirname "$ROOT")"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ -z "$ARCHIVE" ]]; then
  ARCHIVE="$(ls -t "$PARENT"/codex-web-offline-*.tar.zst "$ROOT"/codex-web-offline-*.tar.zst 2>/dev/null | head -n 1 || true)"
fi
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "error: no upgrade archive found; pass --archive /path/to/codex-web-offline-*.tar.zst" >&2
  exit 1
fi
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"

if [[ -f "$ARCHIVE.sha256" ]]; then
  echo "==> verifying $ARCHIVE"
  (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256")
fi

if [[ -x "$ROOT/autostart.sh" ]] && "$ROOT/autostart.sh" status >/dev/null 2>&1; then
  echo "==> stopping the running autostart daemon"
  "$ROOT/autostart.sh" stop
else
  if pgrep -f "$ROOT/app/dist-server/server/index.js" >/dev/null 2>&1; then
    echo "warning: a codex-web service appears to be running from $ROOT" >&2
    if [[ "$ASSUME_YES" -ne 1 ]]; then
      read -r -p "Stop it first, then press Enter to continue (or Ctrl-C to abort): " _
    fi
  fi
fi

BACKUP="$PARENT/codex-web-backup-$STAMP"
mkdir -p "$BACKUP"
echo "==> backing up data/tenants/.env to $BACKUP"
if [[ -d "$ROOT/app/data" ]]; then
  cp -a "$ROOT/app/data" "$BACKUP/data"
fi
if [[ -d "$ROOT/app/tenants" ]]; then
  cp -a "$ROOT/app/tenants" "$BACKUP/tenants"
fi
if compgen -G "$ROOT/app/.env*" >/dev/null 2>&1; then
  cp -a "$ROOT"/app/.env* "$BACKUP/"
fi

WORK="$(mktemp -d "$PARENT/codex-web-upgrade.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
echo "==> extracting $ARCHIVE"
tar --zstd -xf "$ARCHIVE" -C "$WORK"
NEW_ROOT="$WORK/codex-web"
if [[ ! -f "$NEW_ROOT/start.sh" ]]; then
  NEW_ROOT="$(find "$WORK" -maxdepth 3 -type f -name start.sh -exec dirname {} \; | head -n 1 || true)"
fi
if [[ -z "$NEW_ROOT" || ! -f "$NEW_ROOT/start.sh" ]]; then
  echo "error: archive does not look like a codex-web offline bundle (start.sh missing)" >&2
  exit 1
fi

echo "==> moving preserved state into the new bundle"
mkdir -p "$NEW_ROOT/app"
if [[ -d "$BACKUP/data" ]]; then
  cp -a "$BACKUP/data/." "$NEW_ROOT/app/data/"
fi
if [[ -d "$BACKUP/tenants" ]]; then
  mkdir -p "$NEW_ROOT/app/tenants"
  cp -a "$BACKUP/tenants/." "$NEW_ROOT/app/tenants/"
fi
for env_file in "$BACKUP"/.env*; do
  [[ -e "$env_file" ]] && cp -a "$env_file" "$NEW_ROOT/app/"
done

echo "==> swapping in the new bundle at $ROOT"
cd /
OLD_ASIDE="$PARENT/codex-web-old-$STAMP"
mv "$ROOT" "$OLD_ASIDE"
mv "$NEW_ROOT" "$ROOT"
if [[ "$KEEP_OLD" -eq 1 ]]; then
  echo "previous install kept at $OLD_ASIDE"
else
  rm -rf "$OLD_ASIDE"
fi

echo
echo "upgrade complete. Next steps:"
echo "  cd $ROOT"
echo "  ./start.sh        # foreground"
echo "  ./autostart.sh    # background daemon (existing cron/systemd entries still point here)"
echo "backup kept at: $BACKUP"
