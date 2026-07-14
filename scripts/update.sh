#!/usr/bin/env bash
# Runeforge - D4 Damage Calculator - update script
#
# Pulls the latest commit, rebuilds, and restarts the service — without
# touching apt packages, Node.js, or the systemd unit (that's install.sh's
# job). If the build fails or the service doesn't come back up healthy,
# it automatically rolls back to the previously running version.
#
# Usage:
#   ./scripts/update.sh            # update if there's anything new
#   ./scripts/update.sh --force    # rebuild + restart even if already up to date
#
set -euo pipefail

SERVICE_NAME="runeforge"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORCE=false
[ "${1:-}" = "--force" ] && FORCE=true

log() { echo "==> $*"; }
err() { echo "ERROR: $*" >&2; }

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  command -v sudo >/dev/null 2>&1 || { err "This script needs sudo (or run as root) to restart the service."; exit 1; }
  SUDO="sudo"
fi

cd "$APP_DIR"

command -v git >/dev/null 2>&1 || { err "git not found."; exit 1; }
command -v npm >/dev/null 2>&1 || { err "npm not found — run scripts/install.sh first."; exit 1; }
[ -d .git ] || { err "$APP_DIR is not a git repository."; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  err "Local changes detected in $APP_DIR — commit, stash, or discard them before updating:"
  git status --short
  exit 1
fi

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SERVICE_INSTALLED=false
[ -f "$SERVICE_FILE" ] && SERVICE_INSTALLED=true

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
PREV_COMMIT="$(git rev-parse HEAD)"

log "Fetching latest changes on branch $BRANCH"
git fetch origin "$BRANCH"
NEW_COMMIT="$(git rev-parse "origin/$BRANCH")"

if [ "$PREV_COMMIT" = "$NEW_COMMIT" ] && [ "$FORCE" = false ]; then
  log "Already up to date (${PREV_COMMIT:0:7}). Nothing to do (use --force to rebuild anyway)."
  exit 0
fi

log "Updating: ${PREV_COMMIT:0:7} -> ${NEW_COMMIT:0:7}"

PREV_LOCK_HASH="$(md5sum package-lock.json 2>/dev/null | awk '{print $1}' || true)"
git merge --ff-only "origin/$BRANCH"
NEW_LOCK_HASH="$(md5sum package-lock.json 2>/dev/null | awk '{print $1}' || true)"

# work out which port the running service actually uses, so the health
# check hits the right place
PORT=4173
if [ "$SERVICE_INSTALLED" = true ]; then
  DETECTED_PORT="$(grep -oP 'http\.server\s+\K[0-9]+' "$SERVICE_FILE" || true)"
  [ -n "$DETECTED_PORT" ] && PORT="$DETECTED_PORT"
fi

ROLLED_BACK=false
rollback() {
  trap - ERR
  ROLLED_BACK=true
  err "Update failed — rolling back to ${PREV_COMMIT:0:7}"
  git reset --hard "$PREV_COMMIT"
  if [ -d dist.prev ]; then
    rm -rf dist
    mv dist.prev dist
    log "Restored previous build output"
  else
    log "No previous build cached, rebuilding ${PREV_COMMIT:0:7} from source"
    npm install
    npm run build
  fi
  if [ "$SERVICE_INSTALLED" = true ]; then
    $SUDO systemctl restart "${SERVICE_NAME}" || true
  fi
  err "Rolled back. Still running ${PREV_COMMIT:0:7}."
}
trap rollback ERR

if [ "$PREV_LOCK_HASH" != "$NEW_LOCK_HASH" ]; then
  log "package-lock.json changed, running npm install"
  npm install
else
  log "Dependencies unchanged, skipping npm install"
fi

rm -rf dist.prev
[ -d dist ] && mv dist dist.prev

log "Building new version"
npm run build

if [ "$SERVICE_INSTALLED" = true ]; then
  log "Restarting service"
  $SUDO systemctl restart "${SERVICE_NAME}"

  if command -v curl >/dev/null 2>&1; then
    log "Health check on port ${PORT}"
    ATTEMPTS=0
    HEALTHY=false
    until [ "$HEALTHY" = true ]; do
      if curl -fsS "http://127.0.0.1:${PORT}" >/dev/null 2>&1; then
        HEALTHY=true
        break
      fi
      ATTEMPTS=$((ATTEMPTS + 1))
      if [ "$ATTEMPTS" -ge 10 ]; then
        rollback
        break
      fi
      sleep 1
    done
  else
    log "curl not found, skipping health check (service was restarted)"
  fi
else
  log "Service not installed yet — run scripts/install.sh to serve this build."
fi

trap - ERR

if [ "$ROLLED_BACK" = true ]; then
  exit 1
fi

rm -rf dist.prev
log "Update successful. Now running ${NEW_COMMIT:0:7}."
if [ "$SERVICE_INSTALLED" = true ]; then
  $SUDO systemctl --no-pager status "${SERVICE_NAME}" || true
fi
