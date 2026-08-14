import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend lives in web/ and builds into dist/public/ (served by Fastify).
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
