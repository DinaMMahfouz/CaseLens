import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The web app talks only to Supabase; it has no server-side API of its own.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    watch: process.env.CHOKIDAR_USEPOLLING ? { usePolling: true, interval: 500 } : undefined,
  },
});
