# Runeforge — Diablo IV Damage Calculator

A self-hosted damage calculator for Diablo IV. Models the game's actual
damage buckets (additive damage, crit, vulnerable, attack speed, and
independent named multiplicative buckets like "Berserking" or "Close") and
lets you build out an item library, equip gear per slot, and see the live
DPS delta of swapping any item in or out before you commit.

## Features

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

```bash
git clone <this-repo-url> runeforge
cd runeforge
chmod +x scripts/install.sh
./scripts/install.sh 4173
```

This builds a static production bundle and installs a systemd service
(`runeforge`) that serves it with `python3 -m http.server` on the port you
choose (default `4173`). You'll be prompted for `sudo` once, to write the
systemd unit file.

Useful commands afterward:

```bash
sudo systemctl status runeforge
sudo journalctl -u runeforge -f
sudo systemctl restart runeforge
```

Then visit `http://<your-server-ip>:4173`.

### Updating

```bash
git pull
npm run build
sudo systemctl restart runeforge
```

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
