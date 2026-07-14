#!/usr/bin/env bash
# Runeforge - D4 Damage Calculator - homelab installer
#
# Designed to run on a MINIMAL Ubuntu Server install. Installs everything
# needed (git, curl, python3, Node.js), builds the app, and installs it as
# a systemd service running under a dedicated unprivileged user with a
# sandboxed unit. Safe to re-run — every step checks before installing.
#
# The built app is deployed to a dedicated directory (SERVE_DIR) rather
# than served straight out of the git checkout. That means the service
# account never needs read access to your source tree, node_modules, or
# .git — only to the static files it actually serves.
#
# Usage:
#   ./scripts/install.sh [port]
#
set -euo pipefail

PORT="${1:-4173}"
SERVICE_NAME="runeforge"
SERVICE_USER="runeforge"
SERVE_DIR="/var/www/${SERVICE_NAME}"
NODE_MAJOR_WANTED=24     # Active LTS. Node 20 reached EOL in April 2026 —
                         # this is intentionally kept current; bump it as
                         # newer LTS lines are promoted.
NODE_MAJOR_FLOOR=22      # oldest still-supported (Maintenance LTS) line
                         # we'll accept without reinstalling
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { echo "==> $*"; }
warn() { echo "WARNING: $*" >&2; }
err() { echo "ERROR: $*" >&2; }

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  command -v sudo >/dev/null 2>&1 || { err "This script needs sudo (or run as root)."; exit 1; }
  SUDO="sudo"
fi

log "Runeforge dir: $APP_DIR"
log "Serve dir:     $SERVE_DIR"
log "Target port:   $PORT"
echo

# Defense in depth: the systemd unit's ProtectHome=true already hides /home
# from the sandboxed service entirely, but strip "other" access from the
# repo root too so the isolation doesn't depend solely on that one setting
# (e.g. if the unit is ever edited) or on your home directory's own
# permissions. Doesn't affect your own access — only removes access for
# unrelated accounts such as the service user.
$SUDO chmod o-rwx "$APP_DIR" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 1. OS check
# ---------------------------------------------------------------------------
if [ -r /etc/os-release ]; then
  . /etc/os-release
  if [ "${ID:-}" != "ubuntu" ] && [ "${ID_LIKE:-}" != "debian" ]; then
    warn "This script targets Ubuntu/Debian. Detected: ${PRETTY_NAME:-unknown}."
    warn "Continuing anyway, but apt-based steps may fail."
  fi
else
  warn "/etc/os-release not found — can't confirm this is Ubuntu. Continuing."
fi

# ---------------------------------------------------------------------------
# 2. Base packages
# ---------------------------------------------------------------------------
log "Updating apt and installing base packages (git, curl, gnupg, python3)"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -y
$SUDO apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git python3

# ---------------------------------------------------------------------------
# 3. Node.js — installed via a GPG-verified apt repo, not a piped shell
#    script. NodeSource's own "curl | bash" one-liner runs arbitrary code
#    as root with no chance to inspect it first; adding their signing key
#    and repo entry directly gives the same result through apt's normal
#    signature verification instead.
# ---------------------------------------------------------------------------
need_node_install=true
if command -v node >/dev/null 2>&1; then
  current_major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$current_major" -ge "$NODE_MAJOR_FLOOR" ]; then
    need_node_install=false
    log "Node.js $(node -v) already installed and supported, skipping"
  else
    log "Node.js $(node -v) is end-of-life or unsupported, upgrading to ${NODE_MAJOR_WANTED}.x LTS"
  fi
fi

if [ "$need_node_install" = true ]; then
  log "Installing Node.js ${NODE_MAJOR_WANTED}.x LTS (GPG-verified apt repo)"
  $SUDO mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | $SUDO gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR_WANTED}.x nodistro main" \
    | $SUDO tee /etc/apt/sources.list.d/nodesource.list > /dev/null
  $SUDO apt-get update -y
  $SUDO apt-get install -y nodejs
fi

command -v node >/dev/null 2>&1 || { err "Node.js install failed."; exit 1; }
command -v npm  >/dev/null 2>&1 || { err "npm not found after Node.js install."; exit 1; }

# ---------------------------------------------------------------------------
# 4. npm itself — Node ships whatever npm was current when that Node build
#    was cut, which drifts out of date independently. Pin it to latest.
# ---------------------------------------------------------------------------
log "Updating npm to latest ($(npm -v) -> latest)"
$SUDO npm install -g npm@latest
hash -r
log "Using Node $(node -v) / npm v$(npm -v)"

# ---------------------------------------------------------------------------
# 5. Dedicated unprivileged user to run the service — never run app code
#    as the deploying/admin account or as root. It never gets a login
#    shell, a home directory, or any access to the git checkout.
# ---------------------------------------------------------------------------
if ! getent group "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating dedicated system group '${SERVICE_USER}'"
  $SUDO groupadd --system "$SERVICE_USER"
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "Creating dedicated system user '${SERVICE_USER}' (no login, no home dir)"
  $SUDO useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$SERVICE_USER" "$SERVICE_USER"
else
  log "System user '${SERVICE_USER}' already exists, reusing it"
  # Some distros default useradd to a shared group (e.g. "nogroup") rather
  # than creating a same-named one, even with --system. If that happened
  # on an earlier run, the later chown steps would silently reference a
  # group that doesn't exist — fix it here rather than let that surface
  # as a cryptic "chown: invalid group" failure mid-deploy.
  current_gid_name="$(id -gn "$SERVICE_USER" 2>/dev/null || true)"
  if [ "$current_gid_name" != "$SERVICE_USER" ]; then
    log "Fixing '${SERVICE_USER}' user's primary group (was '${current_gid_name}')"
    $SUDO usermod -g "$SERVICE_USER" "$SERVICE_USER"
  fi
fi

# ---------------------------------------------------------------------------
# 6. Build the app (in the git checkout, as the deploying user — not root,
#    not the service user)
# ---------------------------------------------------------------------------
cd "$APP_DIR"

log "Installing npm dependencies (npm ci — exact versions from package-lock.json)"
if [ -f package-lock.json ]; then
  npm ci
else
  warn "No package-lock.json found, falling back to npm install"
  npm install
fi

log "Auditing dependencies for known vulnerabilities (informational — not blocking)"
npm audit --omit=dev || warn "npm audit reported issues above. Review them; re-run 'npm audit' anytime."

log "Building production bundle"
npm run build

# ---------------------------------------------------------------------------
# 7. Deploy the build to an isolated serve directory, owned by the service
#    user and completely separate from the source tree. The service never
#    needs to see your repo, node_modules, .git, or anything under $HOME.
# ---------------------------------------------------------------------------
log "Deploying build to ${SERVE_DIR}"
$SUDO mkdir -p "$SERVE_DIR"
$SUDO find "$SERVE_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
$SUDO cp -r "$APP_DIR/dist/." "$SERVE_DIR/"
$SUDO chown -R "root:${SERVICE_USER}" "$SERVE_DIR"
$SUDO find "$SERVE_DIR" -type d -exec chmod 750 {} \;
$SUDO find "$SERVE_DIR" -type f -exec chmod 640 {} \;

# ---------------------------------------------------------------------------
# 8. systemd service — sandboxed, unprivileged, read-only everywhere except
#    the one directory it needs to read, with no visibility into /home at
#    all (it doesn't need any).
# ---------------------------------------------------------------------------
log "Installing systemd service"
if command -v systemctl >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"

  CAP_LINE="CapabilityBoundingSet="
  AMBIENT_LINE="AmbientCapabilities="
  if [ "$PORT" -lt 1024 ]; then
    warn "Port ${PORT} is a privileged port (<1024) — granting CAP_NET_BIND_SERVICE only."
    warn "A port >= 1024 (e.g. the default 4173) avoids needing this entirely."
    CAP_LINE="CapabilityBoundingSet=CAP_NET_BIND_SERVICE"
    AMBIENT_LINE="AmbientCapabilities=CAP_NET_BIND_SERVICE"
  fi

  $SUDO tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null << EOF
[Unit]
Description=Runeforge D4 Damage Calculator
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${SERVE_DIR}
ExecStart=${PYTHON_BIN} -m http.server ${PORT} --bind 0.0.0.0 --directory ${SERVE_DIR}
Restart=on-failure

# --- sandboxing ---
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictNamespaces=true
RestrictRealtime=true
LockPersonality=true
MemoryDenyWriteExecute=true
RemoveIPC=true
${CAP_LINE}
${AMBIENT_LINE}
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
ReadOnlyPaths=${SERVE_DIR}

[Install]
WantedBy=multi-user.target
EOF

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now "${SERVICE_NAME}"
  $SUDO systemctl restart "${SERVICE_NAME}"
  $SUDO systemctl --no-pager status "${SERVICE_NAME}" || true
else
  echo
  warn "systemd not found. Start it manually instead (as an unprivileged user):"
  echo "  cd ${SERVE_DIR} && python3 -m http.server ${PORT} --bind 0.0.0.0"
fi

# ---------------------------------------------------------------------------
# 9. Firewall (only touches it if ufw is already active)
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
echo "    Serving from:  ${SERVE_DIR}"
echo "    Running as:    ${SERVICE_USER} (unprivileged, sandboxed, no access to your repo)"
echo "    Check status:  sudo systemctl status ${SERVICE_NAME}"
echo "    View logs:     sudo journalctl -u ${SERVICE_NAME} -f"
echo "    Restart:       sudo systemctl restart ${SERVICE_NAME}"
echo
echo "To update later, use ./scripts/update.sh — do not re-run this installer"
echo "for routine updates, it touches system packages and the systemd unit."
