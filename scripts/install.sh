#!/usr/bin/env bash
# Runeforge - D4 Damage Calculator - homelab installer
# Run this from inside the cloned repo. Builds the static app and serves it
# with python3's http.server under systemd.
set -euo pipefail

PORT="${1:-4173}"
SERVICE_NAME="runeforge"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Runeforge dir: $APP_DIR"
echo "==> Will serve on port: $PORT"
echo

command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js is required (v18+)."; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "ERROR: npm is required."; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required to serve the built files."; exit 1; }

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node 18+ required, found $(node -v)."
  exit 1
fi

cd "$APP_DIR"

echo "==> Installing dependencies"
npm install

echo "==> Building production bundle"
npm run build

echo "==> Installing systemd service (requires sudo)"
if command -v systemctl >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
  sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null << EOF
[Unit]
Description=Runeforge D4 Damage Calculator
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}/dist
ExecStart=${PYTHON_BIN} -m http.server ${PORT} --bind 0.0.0.0
Restart=on-failure
User=$(whoami)

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable --now "${SERVICE_NAME}"
  sudo systemctl --no-pager status "${SERVICE_NAME}" || true

  echo
  echo "==> Done. Runeforge is running as a systemd service."
  echo "    Check status:  sudo systemctl status ${SERVICE_NAME}"
  echo "    View logs:     sudo journalctl -u ${SERVICE_NAME} -f"
  echo "    Restart:       sudo systemctl restart ${SERVICE_NAME}"
else
  echo
  echo "==> systemd not found. Start it manually instead:"
  echo "    cd ${APP_DIR}/dist && python3 -m http.server ${PORT} --bind 0.0.0.0"
fi

echo
echo "==> Open it at: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}"
echo "    (or http://localhost:${PORT} if you're on the server itself)"
echo
echo "If you use a firewall (ufw/firewalld), remember to allow port ${PORT}."
echo "To update later: git pull, then re-run this script (or npm run build && sudo systemctl restart ${SERVICE_NAME})."
