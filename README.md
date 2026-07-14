# Runeforge — Diablo IV Damage Calculator

A self-hosted damage calculator for Diablo IV. Models the game's actual
damage buckets (additive damage, crit, vulnerable, attack speed, and
independent named multiplicative buckets like "Berserking" or "Close") and
lets you build out an item library, equip gear per slot, and see the live
DPS delta of swapping any item in or out before you commit.

## Features

- Character silhouette equipment editor — click any body slot to jump to
  it if it's filled, or add gear straight into it if it's empty
- Scan an item from a screenshot: upload an image of a tooltip and it's
  OCR'd and auto-parsed into a draft item (name, slot, rarity guess, and
  affixes classified into the right stat fields) for you to review and
  correct before saving. Runs **entirely in your browser** — the image is
  never uploaded anywhere, see [Security](#security)
- Collapsible "How to find your exact values" tutorial with illustrative
  diagrams, showing exactly where each stat lives in your game UI — sits
  above the calculator and stays hidden once you dismiss it
- Character base-stat panel (weapon damage, attack speed, crit, vulnerable,
  additive damage, skill multiplier)
- Item library with slot rules (one weapon/helm/etc., two rings, unlimited
  "Other" for paragon glyphs or standalone buffs)
- Live "+X% dps if equipped" / "-X% dps if removed" badge on every item card
- Named multiplicative buckets so unique-tagged multipliers stack correctly
  against each other instead of just being lumped into one pile
- Auto-saves your build to the browser (localStorage) — no database needed

## Running it locally (dev mode)

```bash
npm install
npm run dev
```

Visit the printed local URL.

## Deploying on a homeserver

Works on a **minimal Ubuntu Server install** — the script installs everything
it needs (git, curl, python3, Node.js) before building the app. You don't
need to pre-install anything except `git` to clone the repo itself.

```bash
sudo apt-get update && sudo apt-get install -y git
git clone <this-repo-url> runeforge
cd runeforge
chmod +x scripts/install.sh
./scripts/install.sh 4173
```

This bootstraps prerequisites, builds a static production bundle, deploys it
to `/var/www/runeforge` (not served out of the git checkout — see
[Security](#security) below), and installs a systemd service (`runeforge`)
that serves it with `python3 -m http.server` on the port you choose (default
`4173`), running as a dedicated unprivileged user. It's idempotent — safe to
re-run if it fails partway through or if you're updating. You'll be prompted
for `sudo` once for the package installs, the service account, and the
systemd unit.

If `ufw` is already active on the box, the script also opens the chosen
port automatically.

Useful commands afterward:

```bash
sudo systemctl status runeforge
sudo journalctl -u runeforge -f
sudo systemctl restart runeforge
```

Then visit `http://<your-server-ip>:4173`.

### Updating

```bash
./scripts/update.sh
```

This is the safe way to deploy new commits — prefer it over re-running
`install.sh`, which reinstalls system packages and touches the systemd unit
every time. `update.sh` only does what's needed to move to the latest
commit:

- Refuses to run if you have uncommitted local changes (so it never clobbers
  anything)
- Pulls the latest commit on your current branch
- Only runs `npm install` if `package-lock.json` actually changed
- Rebuilds, keeping a copy of the previous `dist/` on the side
- Restarts the service and checks it actually responds
- If the build fails, or the service doesn't come back up healthy, it
  **automatically rolls back** — resetting the git checkout and restoring the
  previous build — so a bad update never leaves the site down

```bash
./scripts/update.sh --force   # rebuild + restart even if already up to date
```

If the service isn't installed yet, `update.sh` will still pull and build,
then tell you to run `scripts/install.sh` to actually serve it.

### Notes / limitations

- Your build is saved per-browser via `localStorage`, not synced across
  devices. Open it from the same browser to see your saved gear again.
- The damage model is simplified: it treats attacks/sec as a flat rate and
  doesn't account for cast times, damage-over-time ticks, or cooldown-gated
  burst windows. It's built for comparing gear on a steady-state basis
  rather than modeling an exact rotation.

## Security

This gets more attention than a typical homelab toy, since it runs
unattended on a server with a real network presence. What's actually in
place:

**Runtime isolation**
- The service runs as a dedicated, unprivileged system account
  (`runeforge`) with no login shell, no home directory, and no membership
  in any group that can reach your source tree.
- It serves from `/var/www/runeforge`, a directory populated only with the
  built static output — not from the git checkout. The service account has
  no read access to your repo, `node_modules`, `.git`, or anything under
  your home directory, both via standard Unix permissions on the repo
  itself and via the systemd sandbox below. Belt and suspenders
  intentionally: either one failing doesn't expose the other.
- The systemd unit is sandboxed with `ProtectSystem=strict`,
  `ProtectHome=true`, `NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`,
  `RestrictSUIDSGID`, `RestrictNamespaces`, `LockPersonality`,
  `MemoryDenyWriteExecute`, a syscall filter, and an empty capability set
  (only `CAP_NET_BIND_SERVICE` if you deliberately choose a port below
  1024). Run `systemd-analyze security runeforge` after installing to see
  the resulting exposure score.

**Supply chain**
- Node.js is installed by adding NodeSource's GPG-signed apt repository
  directly, rather than piping their setup script into `bash` as root.
- Dependencies install via `npm ci`, which installs the exact versions
  recorded in `package-lock.json` rather than letting ranges in
  `package.json` silently drift to newer (and unaudited) releases between
  installs.
- Both `install.sh` and `update.sh` run `npm audit` after installing
  dependencies and print the results. It's informational, not blocking —
  a below-threshold advisory shouldn't brick your update — but you'll
  always see it. Run `npm run audit` any time to check on demand.
- `npm` itself is explicitly upgraded to latest during install, since the
  copy that ships bundled with a given Node.js release drifts out of date
  independently of Node itself.

**Runtime target**
- Targets Node.js 24 (current Active LTS). Node 20 — an earlier install
  script's target — reached end of life in April 2026 and no longer
  receives security patches, which is worth knowing if you're running an
  older deployment. `install.sh` won't downgrade a newer Node you already
  have, but will upgrade anything below Maintenance LTS (currently Node
  22).

**Update safety**
- `update.sh` refuses to run over uncommitted local changes, so it can
  never silently clobber something.
- Every update is staged and health-checked before it's considered
  successful. If the build fails or the service doesn't respond after
  restart, it automatically rolls back both the git checkout and the
  deployed copy to the last known-good version — see
  [Updating](#updating) above.

**Image scanning (OCR)**
- The "Scan item" feature runs entirely client-side using
  [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache 2.0). The
  worker script, WASM engine, and English language data are all bundled
  in `public/tesseract/` and served from your own deployment — not fetched
  from Tesseract's or anyone else's CDN at runtime, and not sent to any
  API. The screenshot you upload never leaves your browser.
- Parsing raw OCR text into stat fields is a best-effort heuristic (see
  `parseItemFromOcrText` in `src/App.jsx`). It always lands in the
  editable form for you to check against the "raw scanned text" panel
  before saving — nothing is applied automatically without a chance to
  correct it.

**Known accepted risk**
- `npm audit` will report a moderate-severity advisory in `esbuild` (via
  Vite's dev-server tooling). The fix requires a major-version jump to
  Vite 8, which is a breaking migration I didn't want to push through
  silently as part of a routine dependency bump. The vulnerability itself
  only affects `vite dev` / `vite preview` — arbitrary websites being able
  to query the *development* server — and has zero exposure in the actual
  deployed app, which is a prebuilt static bundle served by
  `python3 -m http.server`, not the Vite dev server. `vite.config.js`
  additionally binds the dev server to localhost only by default, so it
  isn't reachable from your LAN even during local development unless you
  explicitly pass `--host`. Ask if you'd like the Vite 8 migration done
  as its own tested change.

**What this doesn't cover**
- Traffic is plain HTTP, not HTTPS. Fine on a trusted LAN; if you expose
  this beyond your home network, put it behind a reverse proxy (Caddy,
  nginx, or Traefik) that terminates TLS — don't port-forward
  `python3 -m http.server` directly to the internet.
- There's no authentication. Anyone who can reach the port can use the
  calculator and see/edit whatever build data is stored in their own
  browser's `localStorage` — there's no shared backend or database to
  break into, but there's also no login wall.

## Tech stack

Vite + React + Tailwind CSS + lucide-react icons + Tesseract.js (client-side
OCR, for the scan-item feature). No backend, no database — just a static
site. The bundled OCR assets (`public/tesseract/`) add roughly 8-9MB to the
repo and the deployed build; they're only downloaded by a visitor's browser
the first time they actually use "Scan item," not on initial page load.

## License

MIT
