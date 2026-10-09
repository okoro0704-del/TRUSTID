import { afterEach, describe, expect, it, vi } from "vitest";
import { PORTAL_ORIGINS } from "../src/lib/portal-oauth-clients.js";
import { buildApp } from "../src/app.js";
import {
  assertCanonicalLifeOsCors,
  CANONICAL_LIFEOS_WEB_ORIGIN,
  config,
} from "../src/lib/config.js";

afterEach(() => vi.unstubAllEnvs());
describe("Foundation production configuration", () => {
  it("fails before database bootstrap when production cookie secret is absent", async () => {
    vi.stubEnv("NODE_ENV","production"); vi.stubEnv("COOKIE_SECRET",""); vi.stubEnv("SESSION_SECRET","");
    await expect(buildApp()).rejects.toThrow(/COOKIE_SECRET/);
  });
  it("does not implicitly allow development origins in production", () => {
    // Only the code-registered Portal relying parties remain; no development origin is implied.
    vi.stubEnv("NODE_ENV","production"); vi.stubEnv("CORS_ORIGINS","");
    expect(config.credentialedCorsOrigins).toEqual([]);
    expect(config.corsOrigins).toEqual([...PORTAL_ORIGINS]);
  });
  it("refuses production boot when the canonical LifeOS origin is omitted", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_SECRET", "cors-regression-guard-not-a-secret-value");
    vi.stubEnv("SESSION_SECRET", "cors-regression-guard-not-a-secret-value");
    vi.stubEnv("PII_PEPPER", "cors-regression-guard-pepper");
    vi.stubEnv("SEAL_KEY", "cors-regression-guard-seal");
    vi.stubEnv("CORS_ORIGINS", "https://lifeos011.netlify.app,https://trustedid.netlify.app");
    await expect(buildApp()).rejects.toThrow(CANONICAL_LIFEOS_WEB_ORIGIN);
  });
  it("accepts production CORS when the canonical LifeOS origin is present", () => {
    expect(() =>
      assertCanonicalLifeOsCors(
        ["https://lifeos011.netlify.app", CANONICAL_LIFEOS_WEB_ORIGIN],
        false,
      ),
    ).not.toThrow();
    expect(() =>
      assertCanonicalLifeOsCors(["https://lifeos011.netlify.app"], true),
    ).not.toThrow();
  });
  it("allows configured credentials and rejects unknown actual and preflight origins", async () => {
    vi.stubEnv("CORS_ORIGINS","https://trustedid.netlify.app,http://localhost:5173");
    const app=await buildApp();
    try {
      const good=await app.inject({method:"GET",url:"/health",headers:{origin:"https://trustedid.netlify.app"}});
      expect(good.statusCode).toBe(200); expect(good.headers["access-control-allow-origin"]).toBe("https://trustedid.netlify.app");
      expect(good.headers["access-control-allow-credentials"]).toBe("true");
      for(const origin of ["https://evil.invalid","null","https://trustedid.netlify.app.evil.invalid"]) {
        const bad=await app.inject({method:"GET",url:"/health",headers:{origin}}); expect(bad.statusCode).toBe(403);
        expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
        const preflight=await app.inject({method:"OPTIONS",url:"/auth/session",headers:{origin,"access-control-request-method":"POST"}});
        expect(preflight.statusCode).toBe(403);
        expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
      }
      const local=await app.inject({method:"GET",url:"/health",headers:{origin:"http://localhost:5173"}});expect(local.statusCode).toBe(200);
    } finally { await app.close(); }
  });
  it("reports uncalibrated biometrics and HMAC attestation truthfully", async () => {
    const app=await buildApp(); try {
      const health=(await app.inject({method:"GET",url:"/health"})).json();
      expect(health.identityFoundation.thresholdStatus).toBe("UNCALIBRATED");
      expect(health.identityFoundation.threshold).toBe(0.35);
      expect(health.identityFoundation.padStatus).toBe("INCOMPLETE");
      expect(health.trustTierProof).toEqual({implementation:"hmac-sha256-attestation",zeroKnowledge:false,groth16:false});
    } finally { await app.close(); }
  });
});
