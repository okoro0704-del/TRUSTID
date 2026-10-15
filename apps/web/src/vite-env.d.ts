/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Build-time environment (scripts/trustid-web-environment.mjs), compiled in by vite.config.ts. */
declare const __TRUSTID_WEB_ENV__: "production" | "staging" | "development";

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Optional CDN base serving biometric/<sha16>/<file>[.gz] with CORS for this origin. */
  readonly VITE_TRUSTID_BIOMETRIC_ASSET_BASE?: string;
}
