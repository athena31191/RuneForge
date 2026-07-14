#!/usr/bin/env bash
# Runeforge - D4 Damage Calculator - homelab installer
#
# Designed to run on a MINIMAL Ubuntu Server install. Installs everything
# needed (git, curl, python3, Node.js), builds the app, and installs it as
# a systemd service. Safe to re-run — every step checks before installing.
#
# Usage:
#   ./scripts/install.sh [port]
#
set -euo pipefail

PORT="${1:-4173}"
SERVICE_NAME="runeforge"
NODE_MAJOR_WANTED=20
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { echo "==> $*"; }
err() { echo "ERROR: $*" >&2; }

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  command -v sudo >/dev/null 2>&1 || { err "This script needs sudo (or run as root)."; exit 1; }
  SUDO="sudo"
fi

log "Runeforge dir: $APP_DIR"
log "Target port:   $PORT"
echo

# ---------------------------------------------------------------------------
# 1. OS check
# ---------------------------------------------------------------------------
if [ -r /etc/os-release ]; then
  . /etc/os-release
  if [ "${ID:-}" != "ubuntu" ] && [ "${ID_LIKE:-}" != "debian" ]; then
    echo "Warning: this script targets Ubuntu/Debian. Detected: ${PRETTY_NAME:-unknown}."
    echo "Continuing anyway, but apt-based steps may fail."
  fi
else
  echo "Warning: /etc/os-release not found — can't confirm this is Ubuntu. Continuing."
fi

# ---------------------------------------------------------------------------
# 2. Base packages (git, curl, ca-certificates, python3)
# ---------------------------------------------------------------------------
log "Updating apt and installing base packages (git, curl, python3)"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -y
$SUDO apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git python3

# ---------------------------------------------------------------------------
# 3. Node.js (via NodeSource — Ubuntu's default apt repo is often too old)
# ---------------------------------------------------------------------------
need_node_install=true
if command -v node >/dev/null 2>&1; then
  current_major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$current_major" -ge 18 ]; then
    need_node_install=false
    log "Node.js $(node -v) already installed, skipping"
  else
    log "Node.js $(node -v) found but is too old (need 18+), upgrading"
  fi
fi

if [ "$need_node_install" = true ]; then
  log "Installing Node.js ${NODE_MAJOR_WANTED}.x via NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_WANTED}.x" | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

command -v node >/dev/null 2>&1 || { err "Node.js install failed."; exit 1; }
command -v npm  >/dev/null 2>&1 || { err "npm not found after Node.js install."; exit 1; }
log "Using Node $(node -v) / npm v$(npm -v)"

# ---------------------------------------------------------------------------
# 4. Build the app
# ---------------------------------------------------------------------------
cd "$APP_DIR"

log "Installing npm dependencies"
npm install

log "Building production bundle"
npm run build

# ---------------------------------------------------------------------------
# 5. systemd service
# ---------------------------------------------------------------------------
log "Installing systemd service"
if command -v systemctl >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
  RUN_USER="${SUDO_USER:-$(whoami)}"

  $SUDO tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null << EOF
[Unit]
Description=Runeforge D4 Damage Calculator
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}/dist
ExecStart=${PYTHON_BIN} -m http.server ${PORT} --bind 0.0.0.0
Restart=on-failure
User=${RUN_USER}

[Install]
WantedBy=multi-user.target
EOF

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now "${SERVICE_NAME}"
  $SUDO systemctl restart "${SERVICE_NAME}"
  $SUDO systemctl --no-pager status "${SERVICE_NAME}" || true
else
  echo
  echo "systemd not found. Start it manually instead:"
  echo "  cd ${APP_DIR}/dist && python3 -m http.server ${PORT} --bind 0.0.0.0"
fi

# ---------------------------------------------------------------------------
# 6. Firewall (only touches it if ufw is already active)
# ---------------------------------------------------------------------------
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  log "ufw is active, allowing port ${PORT}/tcp"
  $SUDO ufw allow "${PORT}/tcp" >/dev/null
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
log "Done."
echo "    Open it at:    http://${IP:-<server-ip>}:${PORT}"
echo "    Check status:  sudo systemctl status ${SERVICE_NAME}"
echo "    View logs:     sudo journalctl -u ${SERVICE_NAME} -f"
echo "    Restart:       sudo systemctl restart ${SERVICE_NAME}"
echo
echo "To update later: git pull && npm run build && sudo systemctl restart ${SERVICE_NAME}"
