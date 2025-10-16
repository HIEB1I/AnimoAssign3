// vite.config.ts
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const base = env.VITE_BASE
    ? (env.VITE_BASE.endsWith("/") ? env.VITE_BASE : env.VITE_BASE + "/")
    : "/";

  return {
    plugins: [react()],
    base,
    resolve: {
      alias: { "@": path.resolve(__dirname, "./src") }, // so "@/assets/..." works
    },
    server: {
      host: true,
      port: 5173,
      proxy: {
        // strip /api to mirror Nginx prod
        "/api": {
          target: "http://localhost:8000",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ""),
        },
        // strip /analytics to mirror Nginx prod
        "/analytics": {
          target: "http://localhost:8100",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/analytics/, ""),
        },
      },
    },
  };
});
