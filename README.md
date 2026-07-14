# Runeforge — Diablo IV Damage Calculator

A self-hosted damage calculator for Diablo IV. Models the game's actual
damage buckets (additive damage, crit, vulnerable, attack speed, and
independent named multiplicative buckets like "Berserking" or "Close") and
lets you build out an item library, equip gear per slot, and see the live
DPS delta of swapping any item in or out before you commit.

## Features

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
it needs (git, curl, python3, Node.js via NodeSource) before building the app.
You don't need to pre-install anything except `git` to clone the repo itself.

```bash
sudo apt-get update && sudo apt-get install -y git
git clone <this-repo-url> runeforge
cd runeforge
chmod +x scripts/install.sh
./scripts/install.sh 4173
```

This bootstraps prerequisites, builds a static production bundle, and
installs a systemd service (`runeforge`) that serves it with
`python3 -m http.server` on the port you choose (default `4173`). It's
idempotent — safe to re-run if it fails partway through or if you're
updating. You'll be prompted for `sudo` once for the package installs and
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

## Tech stack

Vite + React + Tailwind CSS + lucide-react icons. No backend, no database —
just a static site.

## License

MIT
