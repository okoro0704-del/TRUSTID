import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  commitContact,
  contactLookupHash,
  openJson,
  sealJson,
  identitySecretForUser,
  zkNullifier,
  hashSecret,
  randomToken,
} from "../src/lib/crypto.js";
import { config } from "../src/lib/config.js";
import {
  proveTrustTierGte,
  proveComplianceTier,
  proveUniqueness,
  proveAuthorization,
  verifyTrustTierGte,
  verifyZkClaimBundle,
  verifyZkClaimBundles,
} from "@trustid/zk";
import { getIdentityForUser } from "../src/modules/identity/service.js";
import { SCOPES, DEFAULT_APP_SCOPES } from "@trustid/shared";
import { createZeroPiiUser } from "./helpers/zero-pii-user.js";
import { resetTables } from "./helpers/db.js";
import { prisma } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { grantAuthorization, registerApplication } from "../src/modules/authorization/service.js";
import { DEVICE_STATUS, DEVICE_TRUST_LEVELS } from "@trustid/shared";

async function createOAuthAccessToken(input: {
  userId: string;
  applicationId: string;
  scopes?: string[];
}) {
  const token = randomToken(32);
  const scopes = input.scopes ?? [...DEFAULT_APP_SCOPES];
  await prisma.oAuthAccessToken.create({
    data: {
      tokenHash: hashSecret(token),
      userId: input.userId,
      applicationId: input.applicationId,
      scopes: JSON.stringify(scopes),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return { token, scopes };
}

describe("Zero-PII crypto & ZK claims", () => {
  beforeEach(async () => {
    await resetTables(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("commits contacts without storing plaintext", () => {
    const a = commitContact("email", "Alice@Example.com");
    const b = commitContact("email", "alice@example.com", a.salt);
    expect(a.lookupHash).toBe(contactLookupHash("email", "alice@example.com"));
    expect(a.lookupHash).toBe(b.lookupHash);
    expect(a.commitment).toBe(b.commitment);
    expect(JSON.stringify(a)).not.toMatch(/alice/i);
  });

  it("seals and opens session presentation JSON", () => {
    const sealed = sealJson({ firstName: "Ada", contactValue: "a@b.co" });
    expect(sealed).not.toContain("Ada");
    const open = openJson<{ firstName: string }>(sealed);
    expect(open.firstName).toBe("Ada");
  });

  it("proves and verifies trust_tier_gte without PII", () => {
    const secret = identitySecretForUser("user-fixture-1");
    const nullifier = zkNullifier(secret, "lifeos_mock_public");
    const proof = proveTrustTierGte({
      tier: 2,
      minTier: 1,
      nullifier,
      issuerSecret: config.sealKey,
    });
    expect(proof.claim.satisfied).toBe(true);
    expect(proof.claim.nullifier).toBe(nullifier);
    const verified = verifyTrustTierGte({
      proof: proof.proof,
      publicSignals: proof.publicSignals,
      issuerSecret: config.sealKey,
    });
    expect(verified.valid).toBe(true);

    const fail = proveTrustTierGte({
      tier: 0,
      minTier: 2,
      nullifier,
      issuerSecret: config.sealKey,
    });
    expect(fail.claim.satisfied).toBe(false);
  });

  it("proves and verifies LifeOS multi-claim bundles", () => {
    const secret = identitySecretForUser("user-fixture-multi");
    const nullifier = zkNullifier(secret, "lifeos_mock_public");
    const issuedAt = new Date().toISOString();
    const audience = "lifeos_mock_public";

    const compliance = proveComplianceTier({
      tier: 2,
      minTier: 1,
      nullifier,
      audience,
      issuerSecret: config.sealKey,
      issuedAt,
    });
    const uniqueness = proveUniqueness({
      nullifier,
      audience,
      issuerSecret: config.sealKey,
      issuedAt,
    });
    const authorization = proveAuthorization({
      clientId: "lifeos_mock_public",
      scopes: [SCOPES.IDENTITY_ZK_CLAIMS],
      authorized: true,
      nullifier,
      audience,
      issuerSecret: config.sealKey,
      issuedAt,
    });

    const batch = verifyZkClaimBundles(
      [compliance, uniqueness, authorization],
      config.sealKey,
    );
    expect(batch.valid).toBe(true);
    expect(batch.results).toHaveLength(3);
    expect(compliance.claimType).toBe("compliance_tier");
    expect(uniqueness.claimType).toBe("uniqueness");
    expect(authorization.claimType).toBe("authorization");
    expect(compliance.disclosed?.trustTier).toBe(2);
    expect(authorization.disclosed?.authorized).toBe(true);

    expect(
      verifyZkClaimBundle(compliance, config.sealKey).valid,
    ).toBe(true);
  });

  it("POST /zk/prove with claimTypes returns non-empty claims bundle", async () => {
    const app = await buildApp();
    const user = await createZeroPiiUser("zk-prove@example.com");
    await prisma.device.create({
      data: {
        userId: user.id,
        name: "Primary",
        status: DEVICE_STATUS.ACTIVE,
        trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
      },
    });

    const registered = await registerApplication({
      name: "LifeOS Test",
      redirectUris: ["http://localhost/callback"],
      allowedScopes: [...DEFAULT_APP_SCOPES],
    });
    await grantAuthorization({
      userId: user.id,
      applicationId: registered.id,
      scopes: [...DEFAULT_APP_SCOPES],
    });
    const { token } = await createOAuthAccessToken({
      userId: user.id,
      applicationId: registered.id,
    });

    const res = await app.inject({
      method: "POST",
      url: "/zk/prove",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: {
        claimTypes: ["compliance_tier", "uniqueness", "authorization"],
        audience: registered.clientId,
        minTier: 1,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      claims: Array<{ claimType: string; proof: unknown; publicSignals: string[] }>;
      issuedAt: number;
      audience: string;
    };
    expect(Array.isArray(body.claims)).toBe(true);
    expect(body.claims.length).toBe(3);
    expect(body.audience).toBe(registered.clientId);
    expect(typeof body.issuedAt).toBe("number");
    expect(body.claims.map((c) => c.claimType)).toEqual([
      "compliance_tier",
      "uniqueness",
      "authorization",
    ]);
    for (const claim of body.claims) {
      expect(claim.proof).toBeTruthy();
      expect(claim.publicSignals.length).toBeGreaterThan(0);
    }

    await app.close();
  });

  it("POST /zk/verify validates multi-claim bundle from /zk/prove", async () => {
    const app = await buildApp();
    const user = await createZeroPiiUser("zk-verify@example.com");
    await prisma.device.create({
      data: {
        userId: user.id,
        name: "Primary",
        status: DEVICE_STATUS.ACTIVE,
        trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
      },
    });

    const registered = await registerApplication({
      name: "LifeOS Verify",
      redirectUris: ["http://localhost/callback"],
      allowedScopes: [...DEFAULT_APP_SCOPES],
    });
    await grantAuthorization({
      userId: user.id,
      applicationId: registered.id,
      scopes: [...DEFAULT_APP_SCOPES],
    });
    const { token } = await createOAuthAccessToken({
      userId: user.id,
      applicationId: registered.id,
    });

    const proveRes = await app.inject({
      method: "POST",
      url: "/zk/prove",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: {
        claimTypes: ["compliance_tier", "uniqueness", "authorization"],
        audience: registered.clientId,
        minTier: 1,
      },
    });
    const proved = proveRes.json() as { claims: unknown[] };

    for (const claim of proved.claims) {
      const single = await app.inject({
        method: "POST",
        url: "/zk/verify",
        headers: { "content-type": "application/json" },
        payload: claim,
      });
      expect(single.statusCode).toBe(200);
      expect(single.json()).toMatchObject({ valid: true });
    }

    const batch = await app.inject({
      method: "POST",
      url: "/zk/verify",
      headers: { "content-type": "application/json" },
      payload: { claims: proved.claims },
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json()).toMatchObject({ valid: true });

    await app.close();
  });

  it("POST /zk/prove legacy trust_tier_gte remains backward compatible", async () => {
    const app = await buildApp();
    const user = await createZeroPiiUser("zk-legacy@example.com");
    await prisma.device.create({
      data: {
        userId: user.id,
        name: "Primary",
        status: DEVICE_STATUS.ACTIVE,
        trustLevel: DEVICE_TRUST_LEVELS.PRIMARY,
      },
    });

    const registered = await registerApplication({
      name: "Legacy Client",
      redirectUris: ["http://localhost/callback"],
      allowedScopes: [...DEFAULT_APP_SCOPES],
    });
    const { token } = await createOAuthAccessToken({
      userId: user.id,
      applicationId: registered.id,
    });

    const res = await app.inject({
      method: "POST",
      url: "/zk/prove",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: {
        claim: "trust_tier_gte",
        minTier: 1,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      claim: { type: string };
      trustIdNullifier: string;
      stars: number;
    };
    expect(body.claim.type).toBe("trust_tier_gte");
    expect(body.trustIdNullifier).toBeTruthy();
    expect(body.stars).toBeGreaterThanOrEqual(0);
    expect((body as { claims?: unknown }).claims).toBeUndefined();

    await app.close();
  });

  it("userinfo omits email and profile by default", async () => {
    const user = await createZeroPiiUser("zk-userinfo@example.com");
    const info = await getIdentityForUser(user.id, [
      SCOPES.OPENID,
      SCOPES.IDENTITY_BASIC,
      SCOPES.IDENTITY_EMAIL,
      SCOPES.IDENTITY_PROFILE,
      SCOPES.IDENTITY_ZK_CLAIMS,
      SCOPES.IDENTITY_TRUST_LEVEL,
    ]);
    expect(info?.trustId).toBe(user.trustId);
    expect(info?.zk).toBeTruthy();
    expect(info?.contacts).toBeUndefined();
    expect((info as { profile?: unknown })?.profile).toBeUndefined();
    expect(info?.trustLevel).toBeTruthy();
  });
});
