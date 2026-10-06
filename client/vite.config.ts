import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes, req) => {
            if (req.url?.includes("/admin/events")) {
              proxyRes.headers["cache-control"] = "no-cache";
              proxyRes.headers["x-accel-buffering"] = "no";
            }
          });
        }
      },
      "/ug": { target: "http://127.0.0.1:8080", changeOrigin: true },
      "/avatars": { target: "http://127.0.0.1:8080", changeOrigin: true },
      "/hub-sdk.js": { target: "http://127.0.0.1:8080", changeOrigin: true },
      "/sample-clicker.html": { target: "http://127.0.0.1:8080", changeOrigin: true }
    }
  }
});
