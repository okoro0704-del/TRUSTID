/**
 * Environment policy for the TrustID web app (see scripts/trustid-web-environment.mjs).
 *
 * __TRUSTID_WEB_ENV__ is a build-time constant. Production-only endpoints are written only inside
 * `__TRUSTID_WEB_ENV__ === "production"` branches, so staging, preview and development bundles do not
 * contain them at all: no fallback can reach production from a non-production build.
 */
export type WebEnvironment = "production" | "staging" | "development";

export function webEnvironment(): WebEnvironment {
  return __TRUSTID_WEB_ENV__;
}

/** Production ElfCom node; present in production builds only. */
export function defaultElfcomBaseUrl(): string | null {
  return __TRUSTID_WEB_ENV__ === "production" ? "https://elfcomnode-production.up.railway.app" : null;
}

/**
 * Approved Android APK download for the one-time native-shell update banner; production builds only.
 * The Netlify branch host is deliberate: Capacitor opens other hosts in the system browser, which
 * hands the download to Android's package installer.
 */
export function approvedApkDownloadUrl(): string | null {
  return __TRUSTID_WEB_ENV__ === "production" ? "https://main--trustedid.netlify.app/releases/TrustID.apk" : null;
}

/** The Android package this environment's update manifest must describe. */
export function expectedAndroidPackage(env: WebEnvironment = webEnvironment()): string | null {
  return env === "production" ? "com.trustid.device" : env === "staging" ? "com.trustid.device.staging" : null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A safe ElfCom base URL for `env`, or null. Accepts only an exact origin (no path, query, fragment or
 * credentials): https anywhere, plain http only for localhost in development. Production hosts
 * (`*-production.up.railway.app`) are refused outside production.
 */
export function safeElfcomBaseUrl(raw: string | null | undefined, env: WebEnvironment): string | null {
  const value = raw?.trim().replace(/\/+$/, "");
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) return null;
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol === "http:" && !(local && env === "development")) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (local && env !== "development") return null;
  if (env !== "production" && /-production\.up\.railway\.app$/i.test(url.hostname)) return null;
  return url.origin;
}

/**
 * The ElfCom base URL to use: the server-advertised one, else the build-time VITE_ELFCOM_BASE_URL,
 * else (production builds only) the production default. Each candidate must pass safeElfcomBaseUrl;
 * an unsafe candidate is skipped, never "fixed". Null means ElfCom features stay disabled.
 */
export function pickElfcomBaseUrl(
  candidates: { server?: string | null; build?: string | null; fallback?: string | null },
  env: WebEnvironment,
): string | null {
  for (const raw of [candidates.server, candidates.build, candidates.fallback]) {
    const safe = safeElfcomBaseUrl(raw, env);
    if (safe) return safe;
  }
  return null;
}

/**
 * Where the native-shell update banner may send the user, or null (banner hidden): only when this
 * environment has an approved download and the manifest describes this environment's app.
 */
export function updateDownloadTarget(
  manifest: { applicationId?: string; versionName?: string } | null,
  env: WebEnvironment,
  approvedUrl: string | null,
): { url: string; versionName: string } | null {
  const pkg = expectedAndroidPackage(env);
  if (!approvedUrl || !pkg || !manifest?.versionName || manifest.applicationId !== pkg) return null;
  return { url: approvedUrl, versionName: manifest.versionName };
}
