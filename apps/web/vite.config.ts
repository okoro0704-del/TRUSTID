import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * public/releases holds the published Android OTA APK + manifest for Netlify.
 * The device (Capacitor) bundle must never embed the previous APK inside itself.
 */
function dropOtaReleasesFromDeviceBundle(mode: string): Plugin {
  let outDir = "dist";
  return {
    name: "trustid-drop-ota-releases",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (mode !== "device") return;
      rmSync(resolve(outDir, "releases"), { recursive: true, force: true });
      dropDuplicateBiometricBinaries(outDir);
    },
  };
}

/**
 * The app ships the biometric engine once, as decoded files under
 * biometric/<sha16>/ (served locally to the live web app). The .gz.bin copies
 * exist only for network delivery, and the legacy /models, /ort and
 * /mediapipe binaries are duplicates, so neither goes into the APK.
 */
function dropDuplicateBiometricBinaries(outDir: string): void {
  const walk = (dir: string, drop: (name: string) => boolean) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, drop);
      else if (drop(name)) rmSync(p, { force: true });
    }
  };
  walk(join(outDir, "biometric"), (n) => n.endsWith(".gz.bin"));
  walk(join(outDir, "models", "trustid"), (n) => n.endsWith(".onnx") || n.endsWith(".task"));
  walk(join(outDir, "ort"), (n) => n.endsWith(".wasm"));
  walk(join(outDir, "mediapipe"), (n) => n.endsWith(".wasm"));
}

/**
 * onnxruntime-web dynamically imports `${wasmPaths}*.mjs`.
 * In Vite dev, those become `*.mjs?import` and miss `public/ort` (SPA HTML).
 * Serve /ort/* and /biometric/* as plain static files even when ?import is present.
 */
function ortPublicWasm(): Plugin {
  return {
    name: "trustid-ort-public-wasm",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && (req.url.startsWith("/ort/") || req.url.startsWith("/biometric/")) && req.url.includes("?")) {
          req.url = req.url.replace(/\?.*$/, "");
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    ortPublicWasm(),
    dropOtaReleasesFromDeviceBundle(mode),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      workbox: {
        // Biometric runtimes are never precached: a runtime's JS loader and its
        // .wasm must come from the same release, and the .wasm is not precached.
        globIgnores: [
          "**/*.wasm",
          "**/ort*.mjs",
          "**/ort*.js",
          "**/ort/**",
          "**/mediapipe/**",
          "**/biometric/**",
          "releases/**",
        ],
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
    exclude: ["onnxruntime-web", "onnxruntime-web/wasm"],
  },
  build: {
    rollupOptions: {
      // ORT wasm is served from /public/ort/<version> via copy-ort-wasm.mjs
      external: [],
      // Device verification builds only (TRUSTID_DEVICE_DIAG=1): also emit the
      // engine diagnostics page. Never set for production builds.
      ...(mode === "device" && process.env.TRUSTID_DEVICE_DIAG === "1"
        ? {
            input: {
              main: resolve(__dirname, "index.html"),
              diag: resolve(__dirname, "diag-engine.html"),
            },
          }
        : {}),
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
}));
