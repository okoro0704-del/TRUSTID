import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { config } from "../src/lib/config.js";

afterEach(() => vi.unstubAllEnvs());
describe("Foundation production configuration", () => {
  it("fails before database bootstrap when production cookie secret is absent", async () => {
    vi.stubEnv("NODE_ENV","production"); vi.stubEnv("COOKIE_SECRET",""); vi.stubEnv("SESSION_SECRET","");
    await expect(buildApp()).rejects.toThrow(/COOKIE_SECRET/);
  });
  it("does not implicitly allow development origins in production", () => {
    vi.stubEnv("NODE_ENV","production"); vi.stubEnv("CORS_ORIGINS",""); expect(config.corsOrigins).toEqual([]);
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
