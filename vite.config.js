import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev/preview servers intentionally bind to localhost only. They are for
// local development, not production serving — the systemd service set up
// by scripts/install.sh serves the built static files instead. If you need
// to reach the dev server from another device on your LAN, run:
//   npm run dev -- --host 127.0.0.1   (default, safest)
//   npm run dev -- --host <your-lan-ip>   (explicit opt-in only)
export default defineConfig({
  plugins: [react()],
});
