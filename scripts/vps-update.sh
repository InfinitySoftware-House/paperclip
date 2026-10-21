#!/usr/bin/env bash
# Update a Paperclip install on a Linux host from the latest GitHub release of
# this fork: download, verify the checksum, back up the data, swap the tree,
# restart the systemd service and roll back if it does not come up healthy.
#
#   bash vps-update.sh            update to the latest release
#   bash vps-update.sh --check    only report whether an update is available
#   bash vps-update.sh --tag linux-x64-4
#   bash vps-update.sh --no-backup
set -euo pipefail

REPO="${PAPERCLIP_REPO:-InfinitySoftware-House/paperclip}"
INSTALL_DIR="${PAPERCLIP_INSTALL_DIR:-$HOME/paperclip-ai}"
DATA_DIR="${PAPERCLIP_DATA_DIR:-$HOME/.paperclip}"
SERVICE="${PAPERCLIP_SERVICE:-paperclip}"
PORT="${PAPERCLIP_PORT:-3100}"
WORK_DIR="${PAPERCLIP_UPDATE_DIR:-$HOME/paperclip-updates}"
TAG=""
CHECK_ONLY=0
BACKUP=1

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:?--tag needs a value}"; shift ;;
    --check) CHECK_ONLY=1 ;;
    --no-backup) BACKUP=0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
for tool in curl tar sha256sum; do command -v "$tool" >/dev/null || die "$tool is required"; done

installed_commit() {
  sed -n 's/.*"commit": *"\([0-9a-f]*\)".*/\1/p' "$INSTALL_DIR/server/dist/build-info.json" 2>/dev/null | head -1
}

if [ -n "$TAG" ]; then
  API="https://api.github.com/repos/$REPO/releases/tags/$TAG"
else
  API="https://api.github.com/repos/$REPO/releases/latest"
fi
RELEASE_JSON="$(curl -fsSL "$API")" || die "cannot read the release ($API)"
TAG="$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
ASSETS="$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"name": *"\(paperclip-linux-x64-[^"]*\)".*/\1/p')"
[ -n "$TAG" ] && [ -n "$ASSETS" ] || die "no Linux build found in this release"
TARGET="$(printf '%s\n' "$ASSETS" | sed -n 's/^paperclip-linux-x64-\([0-9a-f]\{8\}\).*/\1/p' | head -1)"
CURRENT="$(installed_commit || true)"

echo "Installed: ${CURRENT:-unknown}"
echo "Release:   $TAG (commit $TARGET)"
if [ -n "$CURRENT" ] && [ "${CURRENT:0:8}" = "$TARGET" ]; then echo "Already up to date."; exit 0; fi
if [ "$CHECK_ONLY" = 1 ]; then echo "An update is available."; exit 0; fi

command -v sudo >/dev/null || die "sudo is required to restart the service"
STAMP="$(date +%Y%m%d-%H%M%S)"
NEW_DIR="$INSTALL_DIR.new"
OLD_DIR="$INSTALL_DIR.old.$STAMP"
BACKUP_FILE="$HOME/paperclip-data-backup-$STAMP.tgz"

log "Downloading $TAG"
mkdir -p "$WORK_DIR/$TAG"
cd "$WORK_DIR/$TAG"
BASE="https://github.com/$REPO/releases/download/$TAG"
for asset in $ASSETS SHA256SUMS; do curl -fL -o "$asset" "$BASE/$asset"; done
sha256sum -c SHA256SUMS
if ls paperclip-linux-x64-*.part* >/dev/null 2>&1; then
  cat paperclip-linux-x64-*.part* > "paperclip-linux-x64-$TARGET.tar.gz"
fi

log "Unpacking"
rm -rf "$NEW_DIR"
mkdir -p "$NEW_DIR"
tar xzf "paperclip-linux-x64-$TARGET.tar.gz" -C "$NEW_DIR"
[ -f "$NEW_DIR/server/dist-runtime/index.mjs" ] || die "the archive has no server runtime bundle"

log "Stopping $SERVICE"
sudo systemctl stop "$SERVICE"
if [ "$BACKUP" = 1 ] && [ -d "$DATA_DIR" ]; then
  tar czf "$BACKUP_FILE" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
  echo "Data backup: $BACKUP_FILE"
fi

rollback() {
  log "Update failed: rolling back"
  sudo systemctl unset-environment PAPERCLIP_MIGRATION_AUTO_APPLY || true
  sudo systemctl stop "$SERVICE" || true
  rm -rf "$INSTALL_DIR.failed.$STAMP"; mv "$INSTALL_DIR" "$INSTALL_DIR.failed.$STAMP"
  mv "$OLD_DIR" "$INSTALL_DIR"
  if [ -f "$BACKUP_FILE" ]; then
    mv "$DATA_DIR" "$DATA_DIR.failed.$STAMP"
    tar xzf "$BACKUP_FILE" -C "$(dirname "$DATA_DIR")"
  fi
  sudo systemctl start "$SERVICE" || true
  die "rolled back to the previous version. Check: sudo journalctl -u $SERVICE -n 50 --no-pager"
}

log "Switching to the new version"
mv "$INSTALL_DIR" "$OLD_DIR"
mv "$NEW_DIR" "$INSTALL_DIR"
# The service cannot answer the migration prompt; the backup above makes it safe
# to apply pending migrations on this one start.
sudo systemctl set-environment PAPERCLIP_MIGRATION_AUTO_APPLY=true
sudo systemctl start "$SERVICE" || rollback

log "Waiting for the server"
healthy=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q "\"commit\": *\"$TARGET"; then healthy=1; break; fi
  sleep 2
done
sudo systemctl unset-environment PAPERCLIP_MIGRATION_AUTO_APPLY || true
[ "$healthy" = 1 ] || rollback

log "Cleaning up"
rm -rf "$WORK_DIR/$TAG"
ls -dt "$INSTALL_DIR".old.* 2>/dev/null | tail -n +3 | xargs -r rm -rf
ls -t "$HOME"/paperclip-data-backup-*.tgz 2>/dev/null | tail -n +4 | xargs -r rm -f
echo "Updated to $TAG (commit $TARGET). Previous version kept in $OLD_DIR"
