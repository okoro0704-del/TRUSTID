/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Optional CDN base serving biometric/<sha16>/<file>[.gz] with CORS for this origin. */
  readonly VITE_TRUSTID_BIOMETRIC_ASSET_BASE?: string;
}
