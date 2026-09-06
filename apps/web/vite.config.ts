import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      workbox: {
        // onnxruntime-web WASM is ~24MB — load from CDN at runtime, do not precache
        globIgnores: ["**/*.wasm", "**/ort*.mjs", "**/ort*.js"],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      manifest: {
        name: "TrustID",
        short_name: "TrustID",
        description: "One identity for your ecosystem.",
        theme_color: "#0B3D3A",
        background_color: "#071E1C",
        display: "standalone",
        start_url: "/",
        // Helps Android Chrome Credential Manager associate passkeys with this PWA.
        id: "/",
        scope: "/",
        icons: [
          {
            src: "/pwa-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/pwa-512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
    }),
  ],
  optimizeDeps: {
    exclude: ["onnxruntime-web"],
  },
  build: {
    rollupOptions: {
      // Keep ORT wasm out of the critical path when possible; runtime sets CDN wasmPaths
      external: [],
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
