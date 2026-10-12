/**
 * Gate 2: CORS for the Portal relying parties, on a production-configured app.
 * CORS is not authentication: these tests only prove which browser origins may
 * read responses and whether credentials are allowed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { config, isProductionSafeOrigin } from "../src/lib/config.js";
import { resetTables } from "./helpers/db.js";
import { portalUser } from "./helpers/portal-oauth.js";

const FIRST_PARTY = "https://trustedid.netlify.app";
const PORTALS = ["https://getlifeos.app", "https://admin.getlifeos.app", "https://business.getlifeos.app"];

function production(corsOrigins: string) {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("COOKIE_SECRET", "cors-test-not-a-secret-value-32chars");
  vi.stubEnv("SESSION_SECRET", "cors-test-not-a-secret-value-32chars");
  vi.stubEnv("PII_PEPPER", "cors-test-pepper");
  vi.stubEnv("SEAL_KEY", "cors-test-seal");
  vi.stubEnv("CORS_ORIGINS", corsOrigins);
}

const preflight = (app: Awaited<ReturnType<typeof buildApp>>, origin: string, url = "/oauth/token") =>
  app.inject({
    method: "OPTIONS",
    url,
    headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,authorization" },
  });

afterEach(() => vi.unstubAllEnvs());

describe("Gate 2: production CORS", () => {
  it("allows exactly the three Portal origins, without credentials, alongside existing origins", async () => {
    production(`${FIRST_PARTY},https://lifeosapp.getlifeos.app`);
    expect(config.corsOrigins).toEqual(expect.arrayContaining([FIRST_PARTY, "https://lifeosapp.getlifeos.app", ...PORTALS]));
    const app = await buildApp();
    for (const origin of PORTALS) {
      const res = await preflight(app, origin);
      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(origin);
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
      const actual = await app.inject({ method: "POST", url: "/oauth/token", headers: { origin, "content-type": "application/json" }, payload: {} });
      expect(actual.headers["access-control-allow-origin"]).toBe(origin);
      expect(actual.headers["access-control-allow-credentials"]).toBeUndefined();
    }
    const first = await preflight(app, FIRST_PARTY);
    expect(first.headers["access-control-allow-origin"]).toBe(FIRST_PARTY);
    expect(first.headers["access-control-allow-credentials"]).toBe("true");
    await app.close();
  });

  it("rejects unregistered subdomains, look-alikes, wildcard, null, http and localhost", async () => {
    production(`${FIRST_PARTY},https://lifeosapp.getlifeos.app,*,null,http://localhost:5173,https://*.getlifeos.app,http://getlifeos.app`);
    const app = await buildApp();
    for (const origin of [
      "https://evil.getlifeos.app",
      "https://getlifeos.app.evil.com",
      "https://wwwgetlifeos.app",
      "http://getlifeos.app",
      "null",
      "http://localhost:5173",
      "https://localhost",
      "*",
    ]) {
      const res = await preflight(app, origin);
      expect(res.statusCode, origin).toBe(403);
      expect(res.headers["access-control-allow-origin"], origin).toBeUndefined();
      const actual = await app.inject({ method: "GET", url: "/health", headers: { origin } });
      expect(actual.statusCode, origin).toBe(403);
      expect(actual.json()).toMatchObject({ error: "origin_not_allowed" });
    }
    expect(config.corsOrigins.some((o) => o.includes("localhost") || o === "*" || o === "null" || o.startsWith("http:"))).toBe(false);
    await app.close();
  });

  it("production origin rule", () => {
    expect(isProductionSafeOrigin("https://getlifeos.app")).toBe(true);
    for (const bad of ["*", "null", "https://*.getlifeos.app", "http://getlifeos.app", "https://localhost", "https://127.0.0.1", "https://getlifeos.app/", "https://getlifeos.app/path", "not a url"]) {
      expect(isProductionSafeOrigin(bad), bad).toBe(false);
    }
  });

  it("a Portal-origin request never authenticates with the TrustID session cookie", async () => {
    // Session tokens are hashed with environment secrets: create it under the production config.
    production(`${FIRST_PARTY},https://lifeosapp.getlifeos.app`);
    await resetTables(prisma);
    const app = await buildApp();
    const { sessionToken } = await portalUser();
    const withCookie = (origin?: string) =>
      app.inject({
        method: "GET",
        url: "/v1/step-up/pending",
        headers: origin ? { origin } : {},
        cookies: { [config.sessionCookieName]: sessionToken },
      });
    expect((await withCookie()).statusCode).toBe(200);
    expect((await withCookie(FIRST_PARTY)).statusCode).toBe(200);
    for (const origin of PORTALS) expect((await withCookie(origin)).statusCode, origin).toBe(401);
    await app.close();
  });
});
