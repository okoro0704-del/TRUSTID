import { describe, expect, it } from "vitest";
import {
  commitContact,
  contactLookupHash,
  openJson,
  sealJson,
  identitySecretForUser,
  zkNullifier,
} from "../src/lib/crypto.js";
import { config } from "../src/lib/config.js";
import {
  proveTrustTierGte,
  verifyTrustTierGte,
} from "@trustid/zk";
import { getIdentityForUser } from "../src/modules/identity/service.js";
import { SCOPES } from "@trustid/shared";
import { createZeroPiiUser } from "./helpers/zero-pii-user.js";
import { resetTables } from "./helpers/db.js";
import { prisma } from "../src/db/client.js";
import { beforeEach, afterAll } from "vitest";

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
