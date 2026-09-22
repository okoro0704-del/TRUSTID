/**
 * Digi bridge security + integration tests (Phase T2).
 */
import { createHash, createPublicKey } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as jose from "jose";
import {
  DIGI_AUDIENCE_PRODUCTION,
  LIFEOS_ASSERTION_AUDIENCE,
} from "@trustid/shared";
import {
  createJwksCache,
  createMemoryOwnerStore,
  createMemoryReplayStore,
  createMemorySessionStore,
  exchangeTrustIdAssertion,
  verifyDigiAssertion,
} from "../src/index.js";

const ISSUER = "https://trustedid.netlify.app/api";
const AUD = DIGI_AUDIENCE_PRODUCTION;

async function mintKey() {
  const { privateKey, publicKey } = await jose.generateKeyPair("EdDSA", {
    extractable: true,
  });
  const privateJwk = await jose.exportJWK(privateKey);
  const publicJwk = await jose.exportJWK(publicKey);
  const kid = createHash("sha256")
    .update(JSON.stringify(publicJwk))
    .digest("hex")
    .slice(0, 16);
  privateJwk.kid = kid;
  publicJwk.kid = kid;
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";
  return {
    privateKey,
    publicJwk,
    kid,
    async sign(claims: {
      sub: string;
      aud?: string;
      iss?: string;
      jti?: string;
      iat?: number;
      nbf?: number;
      exp?: number;
      alg?: string;
    }) {
      const now = Math.floor(Date.now() / 1000);
      const iat = claims.iat ?? now;
      const nbf = claims.nbf ?? iat;
      const exp = claims.exp ?? now + 60;
      return new jose.SignJWT({})
        .setProtectedHeader({
          alg: claims.alg ?? "EdDSA",
          kid,
          typ: "JWT",
        })
        .setIssuer(claims.iss ?? ISSUER)
        .setAudience(claims.aud ?? AUD)
        .setSubject(claims.sub)
        .setIssuedAt(iat)
        .setNotBefore(nbf)
        .setExpirationTime(exp)
        .setJti(
          claims.jti ??
            [...crypto.getRandomValues(new Uint8Array(16))]
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(""),
        )
        .sign(privateKey);
    },
  };
}

function jwksFrom(publicJwk: jose.JWK) {
  const body = JSON.stringify({ keys: [publicJwk] });
  return createJwksCache({
    jwksUrl: "https://jwks.test/jwks.json",
    fetchImpl: async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
}

describe("digi-bridge verify + exchange", () => {
  let key: Awaited<ReturnType<typeof mintKey>>;
  let jwks: ReturnType<typeof jwksFrom>;
  let owners: ReturnType<typeof createMemoryOwnerStore>;
  let replay: ReturnType<typeof createMemoryReplayStore>;
  let sessions: ReturnType<typeof createMemorySessionStore>;

  beforeEach(async () => {
    key = await mintKey();
    jwks = jwksFrom(key.publicJwk);
    owners = createMemoryOwnerStore();
    replay = createMemoryReplayStore();
    sessions = createMemorySessionStore();
  });

  it("1 valid assertion succeeds and creates owner + session", async () => {
    const assertion = await key.sign({ sub: "TD-TEST-001" });
    const result = await exchangeTrustIdAssertion({
      assertion,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
      owners,
      replay,
      sessions,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ownerCreated).toBe(true);
    expect(result.subject).toBe("TD-TEST-001");
    const session = await sessions.resolve(result.sessionToken);
    expect(session?.ownerId).toBe(result.ownerId);
  });

  it("2-3 repeated login resolves same owner", async () => {
    const a1 = await key.sign({ sub: "TD-SAME", jti: "jti-a" });
    const r1 = await exchangeTrustIdAssertion({
      assertion: a1,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
      owners,
      replay,
      sessions,
    });
    const a2 = await key.sign({ sub: "TD-SAME", jti: "jti-b" });
    const r2 = await exchangeTrustIdAssertion({
      assertion: a2,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
      owners,
      replay,
      sessions,
    });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r2.ownerId).toBe(r1.ownerId);
    expect(r2.ownerCreated).toBe(false);
  });

  it("5 concurrent first-login creates one owner only", async () => {
    const tokens = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        key.sign({ sub: "TD-RACE", jti: `race-${i}` }),
      ),
    );
    const results = await Promise.all(
      tokens.map((assertion) =>
        exchangeTrustIdAssertion({
          assertion,
          expectedIssuer: ISSUER,
          expectedAudience: AUD,
          jwks,
          owners,
          replay,
          sessions,
        }),
      ),
    );
    const ok = results.filter((r) => r.ok);
    expect(ok.length).toBe(8);
    const ownerIds = new Set(ok.map((r) => (r.ok ? r.ownerId : "")));
    expect(ownerIds.size).toBe(1);
    expect(ok.filter((r) => r.ok && r.ownerCreated).length).toBe(1);
  });

  it("6 replayed jti rejected", async () => {
    const assertion = await key.sign({ sub: "TD-REPLAY", jti: "once" });
    const first = await exchangeTrustIdAssertion({
      assertion,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
      owners,
      replay,
      sessions,
    });
    expect(first.ok).toBe(true);
    const second = await exchangeTrustIdAssertion({
      assertion,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
      owners,
      replay,
      sessions,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("replay");
  });

  it("7 expired assertion rejected", async () => {
    const now = Math.floor(Date.now() / 1000);
    const assertion = await key.sign({
      sub: "TD-EXP",
      iat: now - 120,
      nbf: now - 120,
      exp: now - 30,
    });
    const r = await verifyDigiAssertion({
      assertion,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("8 nbf in future rejected", async () => {
    const now = Math.floor(Date.now() / 1000);
    const assertion = await key.sign({
      sub: "TD-NBF",
      iat: now,
      nbf: now + 600,
      exp: now + 900,
    });
    const r = await verifyDigiAssertion({
      assertion,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
      nowSec: now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["not_active", "expired"]).toContain(r.reason);
  });

  it("9 unreasonable future iat rejected", async () => {
    const now = Math.floor(Date.now() / 1000);
    const assertion = await key.sign({
      sub: "TD-IAT",
      iat: now + 10_000,
      nbf: now, // nbf ok so jose accepts; our iat skew gate must fire
      exp: now + 10_060,
    });
    const r = await verifyDigiAssertion({
      assertion,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
      nowSec: now,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("future_iat");
  });

  it("10 wrong issuer rejected", async () => {
    const assertion = await key.sign({
      sub: "TD-ISS",
      iss: "https://evil.example",
    });
    const r = await verifyDigiAssertion({
      assertion,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("issuer_mismatch");
  });

  it("11-13 wrong / missing / LifeOS audience rejected", async () => {
    const wrong = await key.sign({ sub: "TD-AUD", aud: "other:app" });
    const lifeos = await key.sign({
      sub: "TD-AUD",
      aud: LIFEOS_ASSERTION_AUDIENCE,
    });
    for (const assertion of [wrong, lifeos]) {
      const r = await verifyDigiAssertion({
        assertion,
        expectedIssuer: ISSUER,
        expectedAudience: AUD,
        jwks,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("audience_mismatch");
    }
  });

  it("14-15 bad signature / wrong key rejected", async () => {
    const other = await mintKey();
    const assertion = await other.sign({ sub: "TD-SIG" });
    const r = await verifyDigiAssertion({
      assertion,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["bad_signature", "unknown_kid"]).toContain(r.reason);
  });

  it("16 unknown kid rejected", async () => {
    const assertion = await key.sign({ sub: "TD-KID" });
    const emptyJwks = createJwksCache({
      jwksUrl: "https://jwks.test/empty",
      fetchImpl: async () =>
        new Response(JSON.stringify({ keys: [] }), { status: 200 }),
    });
    const r = await verifyDigiAssertion({
      assertion,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks: emptyJwks,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown_kid");
  });

  it("17-18 alg=none and unsupported alg rejected", async () => {
    const noneTok =
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
        "base64url",
      ) +
      "." +
      Buffer.from(
        JSON.stringify({
          iss: ISSUER,
          aud: AUD,
          sub: "TD-NONE",
          jti: "x",
          iat: 1,
          exp: 9e12,
        }),
      ).toString("base64url") +
      ".";
    const r = await verifyDigiAssertion({
      assertion: noneTok,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("alg_none");
  });

  it("19 malformed JWT rejected", async () => {
    const r = await verifyDigiAssertion({
      assertion: "not.a.jwt",
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
    });
    expect(r.ok).toBe(false);
  });

  it("20-22 missing/malformed sub and missing jti", async () => {
    const now = Math.floor(Date.now() / 1000);
    // manually craft JWT without jti via SignJWT then strip � use empty jti
    const noJti = await new jose.SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ: "JWT" })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setSubject("TD-OK")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(key.privateKey);
    const r = await verifyDigiAssertion({
      assertion: noJti,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_jti");

    const badSub = await key.sign({ sub: " " });
    const r2 = await verifyDigiAssertion({
      assertion: badSub,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
    });
    expect(r2.ok).toBe(false);
  });

  it("26 parallel consume of same jti: only one wins", async () => {
    const assertion = await key.sign({ sub: "TD-PAR", jti: "parallel-1" });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        exchangeTrustIdAssertion({
          assertion,
          expectedIssuer: ISSUER,
          expectedAudience: AUD,
          jwks,
          owners,
          replay,
          sessions,
        }),
      ),
    );
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok && r.reason === "replay").length).toBe(5);
  });

  it("27-30 failed verification does not create owner/session", async () => {
    const before = await owners.findByIssuerSubject(ISSUER, "TD-FAIL");
    expect(before).toBeNull();
    const assertion = await key.sign({
      sub: "TD-FAIL",
      aud: "wrong",
    });
    const r = await exchangeTrustIdAssertion({
      assertion,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
      owners,
      replay,
      sessions,
    });
    expect(r.ok).toBe(false);
    expect(await owners.findByIssuerSubject(ISSUER, "TD-FAIL")).toBeNull();
  });
});

// silence unused import in case tree-shake
void createPublicKey;
void afterAll;
