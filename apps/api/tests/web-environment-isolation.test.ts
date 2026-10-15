/**
 * Web build environment isolation (apps/web/src/lib/web-environment.ts):
 *   F1  no ElfCom request can reach production from a staging / development build,
 *   F3  the native-shell update banner only links an approved APK for this environment's app.
 * The build-time constant __TRUSTID_WEB_ENV__ is provided per test on globalThis.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  approvedApkDownloadUrl,
  defaultElfcomBaseUrl,
  expectedAndroidPackage,
  pickElfcomBaseUrl,
  safeElfcomBaseUrl,
  updateDownloadTarget,
  type WebEnvironment,
} from "../../web/src/lib/web-environment.js";

const PROD_ELFCOM = "https://elfcomnode-production.up.railway.app";
const STAGING_ELFCOM = "https://elfcom-staging.example.app";
const setEnv = (env: WebEnvironment) => ((globalThis as Record<string, unknown>).__TRUSTID_WEB_ENV__ = env);
afterEach(() => delete (globalThis as Record<string, unknown>).__TRUSTID_WEB_ENV__);

describe("F1: ElfCom endpoint isolation", () => {
  it("production keeps its production ElfCom default; staging and development have none", () => {
    setEnv("production");
    expect(defaultElfcomBaseUrl()).toBe(PROD_ELFCOM);
    for (const env of ["staging", "development"] as const) {
      setEnv(env);
      expect(defaultElfcomBaseUrl(), env).toBeNull();
    }
  });

  it("missing staging configuration resolves to no ElfCom at all (features disabled), never production", () => {
    setEnv("staging");
    expect(pickElfcomBaseUrl({ server: undefined, build: undefined, fallback: defaultElfcomBaseUrl() }, "staging")).toBeNull();
    // the staging API advertises its unbound default (http://localhost:8791): refused
    expect(pickElfcomBaseUrl({ server: "http://localhost:8791", fallback: defaultElfcomBaseUrl() }, "staging")).toBeNull();
  });

  it("a production ElfCom URL is refused outside production from every source (server, build, fallback)", () => {
    for (const env of ["staging", "development"] as const) {
      expect(pickElfcomBaseUrl({ server: PROD_ELFCOM }, env), env).toBeNull();
      expect(pickElfcomBaseUrl({ build: `${PROD_ELFCOM}/` }, env), env).toBeNull();
      expect(pickElfcomBaseUrl({ fallback: PROD_ELFCOM }, env), env).toBeNull();
      expect(safeElfcomBaseUrl("https://LUCID-integrity-PRODUCTION.up.railway.app", env), env).toBeNull();
    }
    expect(pickElfcomBaseUrl({ fallback: PROD_ELFCOM }, "production")).toBe(PROD_ELFCOM);
  });

  it("an explicit staging ElfCom is used; an unsafe candidate is skipped, not repaired", () => {
    expect(pickElfcomBaseUrl({ server: STAGING_ELFCOM }, "staging")).toBe(STAGING_ELFCOM);
    expect(pickElfcomBaseUrl({ server: "http://elfcom-staging.example.app", build: STAGING_ELFCOM }, "staging")).toBe(STAGING_ELFCOM);
    for (const bad of [
      "http://elfcom-staging.example.app",
      "https://user:pass@elfcom-staging.example.app",
      "https://elfcom-staging.example.app/path",
      "https://elfcom-staging.example.app/?x=1",
      "javascript:alert(1)",
      "not a url",
      "",
      "   ",
    ]) {
      expect(safeElfcomBaseUrl(bad, "staging"), bad).toBeNull();
    }
  });

  it("plain http is only for localhost in development", () => {
    expect(safeElfcomBaseUrl("http://localhost:8791", "development")).toBe("http://localhost:8791");
    expect(safeElfcomBaseUrl("http://localhost:8791", "staging")).toBeNull();
    expect(safeElfcomBaseUrl("http://localhost:8791", "production")).toBeNull();
    expect(safeElfcomBaseUrl("https://localhost:8791", "production")).toBeNull();
  });
});

describe("F3: native-shell update banner", () => {
  const prodManifest = { applicationId: "com.trustid.device", versionName: "1.3" };

  it("production: the approved production APK for a production manifest", () => {
    setEnv("production");
    const url = approvedApkDownloadUrl();
    expect(url).toBe("https://main--trustedid.netlify.app/releases/TrustID.apk");
    expect(updateDownloadTarget(prodManifest, "production", url)).toEqual({ url, versionName: "1.3" });
  });

  it("staging: no approved APK exists, so the banner never shows, even for a production manifest", () => {
    setEnv("staging");
    expect(approvedApkDownloadUrl()).toBeNull();
    expect(updateDownloadTarget(prodManifest, "staging", approvedApkDownloadUrl())).toBeNull();
    expect(updateDownloadTarget({ applicationId: "com.trustid.device.staging", versionName: "1.3" }, "staging", null)).toBeNull();
  });

  it("development and missing or foreign manifests: no banner", () => {
    setEnv("development");
    expect(approvedApkDownloadUrl()).toBeNull();
    expect(expectedAndroidPackage("development")).toBeNull();
    const url = "https://main--trustedid.netlify.app/releases/TrustID.apk";
    expect(updateDownloadTarget(null, "production", url)).toBeNull();
    expect(updateDownloadTarget({ applicationId: "com.trustid.device" }, "production", url)).toBeNull();
    expect(updateDownloadTarget({ applicationId: "com.trustid.device.staging", versionName: "1.3" }, "production", url)).toBeNull();
    expect(updateDownloadTarget({ applicationId: "com.evil.app", versionName: "9" }, "production", url)).toBeNull();
  });
});
