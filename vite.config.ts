import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Frontend lives in web/ and builds into dist/public/ (served by Fastify).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiPort = env.ICLAW_SERVER_PORT || "3000";
  return {
    root: "web",
    plugins: [react()],
    build: {
      outDir: "../dist/public",
      emptyOutDir: true,
    },
    server: {
      proxy: {
        "/api": `http://localhost:${apiPort}`,
      },
    },
  };
});
