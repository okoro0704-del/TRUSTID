/**
 * Digi RP production composition: durable stores or fail closed.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as jose from "jose";
import { DIGI_AUDIENCE_PRODUCTION } from "@trustid/shared";
import { createJwksCache } from "@trustid/digi-bridge";
import { buildDigiRp } from "../src/app.js";
import { composeDigiRuntime } from "../src/runtime.js";

const PG_URL = process.env.DIGI_CORE_TEST_DATABASE_URL;
const ISSUER = "https://trustedid.netlify.app/api";
const AUD = DIGI_AUDIENCE_PRODUCTION;
const COOKIE = "test-only-strong-cookie-secret-32-chars";

function assertDisposable(url: string) {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Digi RP Postgres tests only run against a local disposable database");
  }
}

async function mint() {
  const { privateKey, publicKey } = await jose.generateKeyPair("EdDSA", { extractable: true });
  const privateJwk = await jose.exportJWK(privateKey);
  const publicJwk = await jose.exportJWK(publicKey);
  const kid = createHash("sha256").update(JSON.stringify(publicJwk)).digest("hex").slice(0, 16);
  privateJwk.kid = kid;
  publicJwk.kid = kid;
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";
  const jwksBody = JSON.stringify({ keys: [publicJwk] });
  const jwks = createJwksCache({
    jwksUrl: "https://jwks.test/jwks.json",
    fetchImpl: async () => new Response(jwksBody, { status: 200 }),
  });
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new jose.SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUD)
    .setSubject("human-subject-1")
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 60)
    .setJti(crypto.randomUUID())
    .sign(privateKey);
  return { privateJwk, jwks, assertion, fetchImpl: async () => new Response(jwksBody, { status: 200 }) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Digi RP durable composition", () => {
  it("fails closed in production without PostgreSQL", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DIGI_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    await expect(composeDigiRuntime({ databaseUrl: "" })).rejects.toThrow(/refusing memory owner, replay, session, and authority stores/);
  });

  it("does not fall back to memory when PostgreSQL is unreachable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DIGI_COOKIE_SECRET", COOKIE);
    const databaseUrl = "postgres://digi:super-secret-db-password@127.0.0.1:1/digi_core";
    try {
      await composeDigiRuntime({ databaseUrl });
      throw new Error("startup should have failed");
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      expect(message).toMatch(/refusing memory fallback/);
      expect(message).not.toContain("super-secret-db-password");
    }
  });

  it("uses memory stores only for explicit development without a database URL", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DIGI_DATABASE_URL", "");
    vi.stubEnv("DATABASE_URL", "");
    const runtime = await composeDigiRuntime({ databaseUrl: "" });
    try {
      expect(runtime.corePersistence).toBe("memory");
      expect(runtime.persistence).toBe("memory");
      expect(runtime.owners.durability).toBe("memory");
      expect(runtime.replay.durability).toBe("memory");
      expect(runtime.sessions.durability).toBe("memory");
      const health = await runtime.app.inject({ method: "GET", url: "/health" });
      expect(health.json().core.persistence).toBe("memory");
    } finally {
      await runtime.close();
      await runtime.app.close();
    }
  });

  it("returns unavailable and no owner when a durable store fails during exchange", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const minted = await mint();
    vi.stubEnv("DIGI_AUTHORITY_PRIVATE_JWK", JSON.stringify(minted.privateJwk));
    const { app } = await buildDigiRp({
      trustIdIssuer: ISSUER,
      jwksUrl: "https://jwks.test/jwks.json",
      digiAudience: AUD,
      cookieSecret: COOKIE,
      fetchImpl: minted.fetchImpl,
      owners: {
        durability: "postgres",
        async findByIssuerSubject() {
          return null;
        },
        async listForOwner() {
          return [];
        },
        async resolveOrCreate() {
          throw new Error("owner store down");
        },
      },
      replay: {
        durability: "postgres",
        async tryConsume() {
          return true;
        },
      },
      sessions: {
        durability: "postgres",
        async create() {
          throw new Error("session store down");
        },
        async resolve() {
          return null;
        },
        async revoke() {
          return undefined;
        },
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/auth/trustid/exchange",
        payload: { assertion: minted.assertion },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "unavailable" });
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.body.includes(minted.assertion)).toBe(false);
      const grants = await app.inject({ method: "GET", url: "/authority/grants/active" });
      expect(grants.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!PG_URL)("Digi RP production PostgreSQL runtime", () => {
  it("starts on PostgreSQL, exchanges one owner, and creates no authority grant", async () => {
    assertDisposable(PG_URL!);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DIGI_COOKIE_SECRET", COOKIE);
    vi.stubEnv("TRUSTID_ISSUER", ISSUER);
    vi.stubEnv("DIGI_AUDIENCE", AUD);
    const minted = await mint();
    vi.stubEnv("DIGI_AUTHORITY_PRIVATE_JWK", JSON.stringify(minted.privateJwk));
    const runtime = await composeDigiRuntime({
      databaseUrl: PG_URL,
      schema: "digi_rp_accept",
      fetchImpl: minted.fetchImpl,
    });
    try {
      const health = await runtime.app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json().core.persistence).toBe("postgres");
      expect(health.json().authority.persistence).toBe("postgres");
      const first = await runtime.app.inject({
        method: "POST",
        url: "/auth/trustid/exchange",
        payload: { assertion: minted.assertion },
      });
      expect(first.statusCode).toBe(200);
      const body = first.json() as { ok: boolean; ownerId: string; sessionToken: string; sessionId: string };
      expect(body.ok).toBe(true);
      expect(body.ownerId.startsWith("own_")).toBe(true);
      expect(body.ownerId).not.toBe("human-subject-1");
      expect(Object.keys(body)).not.toContain("grantId");
      expect(JSON.stringify(body).toLowerCase()).not.toContain("pdi");
      const replay = await runtime.app.inject({
        method: "POST",
        url: "/auth/trustid/exchange",
        payload: { assertion: minted.assertion },
      });
      expect(replay.statusCode).toBe(401);
      const me = await runtime.app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${body.sessionToken}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json().ownerId).toBe(body.ownerId);
      expect(me.json().subject).toBe("human-subject-1");
      const grants = await runtime.app.inject({
        method: "GET",
        url: "/authority/grants/active",
        headers: { authorization: `Bearer ${body.sessionToken}` },
      });
      expect(grants.statusCode).toBe(200);
      expect(grants.json()).toEqual({ grants: [] });
      await runtime.app.close();
      await runtime.close();
      const restarted = await composeDigiRuntime({
        databaseUrl: PG_URL,
        schema: "digi_rp_accept",
        fetchImpl: minted.fetchImpl,
      });
      try {
        const again = await restarted.app.inject({
          method: "GET",
          url: "/me",
          headers: { authorization: `Bearer ${body.sessionToken}` },
        });
        expect(again.statusCode).toBe(200);
        expect(again.json().ownerId).toBe(body.ownerId);
        expect(again.json().subject).toBe("human-subject-1");
      } finally {
        await restarted.close();
        await restarted.app.close();
      }
    } finally {
      await runtime.close().catch(() => undefined);
      await runtime.app.close().catch(() => undefined);
    }
  });
});
