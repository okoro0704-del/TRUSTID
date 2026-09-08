import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * onnxruntime-web dynamically imports `${wasmPaths}*.mjs`.
 * In Vite dev, those become `*.mjs?import` and miss `public/ort` (SPA HTML).
 * Serve /ort/* as plain static files even when ?import is present.
 */
function ortPublicWasm(): Plugin {
  return {
    name: "trustid-ort-public-wasm",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && req.url.startsWith("/ort/") && req.url.includes("?")) {
          req.url = req.url.replace(/\?.*$/, "");
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    ortPublicWasm(),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      workbox: {
        // onnxruntime-web WASM is large — served from /ort (copied at build); do not precache
        globIgnores: ["**/*.wasm", "**/ort*.mjs", "**/ort*.js", "**/ort/**"],
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
      // ORT wasm is served from /public/ort via copy-ort-wasm.mjs
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
