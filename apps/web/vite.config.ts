/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin API in development (cookies + CSRF behave as in production behind nginx).
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET ?? "http://localhost:4000",
        changeOrigin: false,
      },
    },
  },
  build: {
    sourcemap: true,
    outDir: "dist",
    rollupOptions: {
      output: {
        // Long-lived vendor chunks cache well across app releases.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/](react|react-dom|react-router|scheduler)[\\/]/.test(id)) return "react";
          if (/[\\/](zod|@tanstack)[\\/]/.test(id)) return "data";
          return "vendor";
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
