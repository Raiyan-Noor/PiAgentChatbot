import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // .env.local (VITE_CONVEX_URL, written by `npx convex dev`) lives at the repo root.
  envDir: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/web", emptyOutDir: true },
});
