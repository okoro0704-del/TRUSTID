import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AUDIT_EVENTS,
  IDENTITY_STATUS,
  IMPERSONATION_REPORT_TYPES,
  PORTRAIT_STATUS,
  VERIFICATION_LEVELS,
} from "@trustid/shared";
import { PrismaClient } from "@prisma/client";
import { resetTables } from "./helpers/db.js";
import { setIdentityVerificationProvider } from "../src/modules/identity-verification/service.js";
import { MockIdentityVerificationProvider } from "../src/modules/identity-verification/mock-provider.js";
import {
  completeIdentityVerification,
  startIdentityVerification,
} from "../src/modules/identity-verification/service.js";
import {
  issueIdentityAssertion,
  verifyIdentityAssertion,
} from "../src/modules/verified-identity/assertions.js";
import { createImpersonationReport } from "../src/modules/verified-identity/impersonation.js";
import {
  getPortraitForOwner,
  getVerifiedPortraitForAudience,
  uploadIdentityPortrait,
} from "../src/modules/verified-identity/portrait.js";
import {
  ensureVerifiedIdentityProfile,
  getVerifiedIdentityProfileView,
} from "../src/modules/verified-identity/profile.js";
import { getIdentityForUser } from "../src/modules/identity/service.js";
import { SCOPES } from "@trustid/shared";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZeroPiiUser } from "./helpers/zero-pii-user.js";

const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Minimal valid-looking JPEG bytes (not a real decode — enough for storage tests). */
function fakeJpeg(seed: string) {
  const payload = Buffer.from(`trustid-portrait-fixture-${seed}-${"x".repeat(200)}`);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), payload, Buffer.from([0xff, 0xd9])]);
}

async function createUser(email: string, name = "John Smith") {
  return createZeroPiiUser(email, {
    name,
    trustId: `TD-${createHash("sha256").update(email).digest("hex").slice(0, 8).toUpperCase()}`,
  });
}

describe("Verified identity portrait & anti-impersonation", () => {
  beforeAll(() => {
    setIdentityVerificationProvider(new MockIdentityVerificationProvider());
    const mediaRoot = path.join(__dirname, "../data/test-media");
    fs.mkdirSync(mediaRoot, { recursive: true });
  });

  beforeEach(async () => {
    await resetTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates unverified profile on ensure — photo alone is not verified", async () => {
    const user = await createUser("a@example.com");
    const profile = await ensureVerifiedIdentityProfile(user.id);
    expect(profile.identityStatus).toBe(IDENTITY_STATUS.UNVERIFIED);
    expect(profile.verificationLevel).toBe(VERIFICATION_LEVELS.NONE);
    expect(profile.portraitVersion).toBe(0);

    const uploaded = await uploadIdentityPortrait({
      userId: user.id,
      bytes: fakeJpeg("u1"),
      mimeType: "image/jpeg",
    });
    expect(uploaded.portrait.status).toBe(PORTRAIT_STATUS.USER_UPLOADED);
    expect(uploaded.portrait.isVerifiedIdentityPortrait).toBe(false);

    const view = await getVerifiedIdentityProfileView(user.id);
    expect(view.isVerifiedIdentity).toBe(false);
    expect(view.hasVerifiedIdentityPortrait).toBe(false);
    expect(view.identityPortraitRef).toBeNull();
  });

  it("issues verified portrait only after successful verification", async () => {
    const user = await createUser("v@example.com");
    const { portrait } = await uploadIdentityPortrait({
      userId: user.id,
      bytes: fakeJpeg("v1"),
      mimeType: "image/jpeg",
    });
    const started = await startIdentityVerification({
      userId: user.id,
      portraitId: portrait.id,
    });
    expect(started.status).toBe("pending");
    expect(started.isMock).toBe(true);

    await expect(
      completeIdentityVerification({
        userId: user.id,
        verificationId: started.verificationId,
        providerPayload: { mockApprove: false },
      }),
    ).rejects.toMatchObject({ code: "verification_failed" });

    const started2 = await startIdentityVerification({
      userId: user.id,
      portraitId: (
        await uploadIdentityPortrait({
          userId: user.id,
          bytes: fakeJpeg("v2"),
          mimeType: "image/jpeg",
        })
      ).portrait.id,
    });
    const done = await completeIdentityVerification({
      userId: user.id,
      verificationId: started2.verificationId,
      providerPayload: { mockApprove: true },
    });
    expect(done.status).toBe("verified");
    expect(done.isMock).toBe(true);

    const view = await getVerifiedIdentityProfileView(user.id);
    expect(view.isVerifiedIdentity).toBe(true);
    expect(view.hasVerifiedIdentityPortrait).toBe(true);
    expect(view.verificationLevel).toBe(VERIFICATION_LEVELS.MOCK);
    expect(view.portraitVersion).toBeGreaterThan(0);
  });

  it("versions portraits and invalidates old verified refs", async () => {
    const user = await createUser("ver@example.com");
    const first = await uploadIdentityPortrait({
      userId: user.id,
      bytes: fakeJpeg("p1"),
      mimeType: "image/jpeg",
    });
    const s1 = await startIdentityVerification({
      userId: user.id,
      portraitId: first.portrait.id,
    });
    await completeIdentityVerification({
      userId: user.id,
      verificationId: s1.verificationId,
      providerPayload: { mockApprove: true },
    });
    const v1 = await getVerifiedIdentityProfileView(user.id);

    const second = await uploadIdentityPortrait({
      userId: user.id,
      bytes: fakeJpeg("p2"),
      mimeType: "image/jpeg",
    });
    const s2 = await startIdentityVerification({
      userId: user.id,
      portraitId: second.portrait.id,
    });
    await completeIdentityVerification({
      userId: user.id,
      verificationId: s2.verificationId,
      providerPayload: { mockApprove: true },
    });
    const v2 = await getVerifiedIdentityProfileView(user.id);
    expect(v2.portraitVersion).toBeGreaterThan(v1.portraitVersion);
    expect(v2.profileVersion).toBeGreaterThan(v1.profileVersion);
    expect(v2.identityPortraitRef).not.toBe(v1.identityPortraitRef);

    const old = await prisma.identityPortrait.findUnique({
      where: { id: first.portrait.id },
    });
    expect(old?.status).toBe(PORTRAIT_STATUS.REVOKED);
  });

  it("does not merge accounts on duplicate name or photograph", async () => {
    const a = await createUser("john.a@example.com", "John Smith");
    const b = await createUser("john.b@example.com", "John Smith");
    const bytes = fakeJpeg("same-photo");

    const upA = await uploadIdentityPortrait({
      userId: a.id,
      bytes,
      mimeType: "image/jpeg",
    });
    const s = await startIdentityVerification({
      userId: a.id,
      portraitId: upA.portrait.id,
    });
    await completeIdentityVerification({
      userId: a.id,
      verificationId: s.verificationId,
      providerPayload: { mockApprove: true },
    });

    const upB = await uploadIdentityPortrait({
      userId: b.id,
      bytes, // same bytes → same content hash
      mimeType: "image/jpeg",
    });
    expect(upB.hashCollisionDetected).toBe(true);
    expect(upB.portrait.isVerifiedIdentityPortrait).toBe(false);

    const viewB = await getVerifiedIdentityProfileView(b.id);
    expect(viewB.isVerifiedIdentity).toBe(false);
    expect(viewB.hasVerifiedIdentityPortrait).toBe(false);
    expect(viewB.trustId).not.toBe((await getVerifiedIdentityProfileView(a.id)).trustId);
  });

  it("blocks cross-user portrait access (IDOR)", async () => {
    const a = await createUser("idor.a@example.com");
    const b = await createUser("idor.b@example.com");
    const up = await uploadIdentityPortrait({
      userId: a.id,
      bytes: fakeJpeg("idor"),
      mimeType: "image/jpeg",
    });
    const s = await startIdentityVerification({
      userId: a.id,
      portraitId: up.portrait.id,
    });
    await completeIdentityVerification({
      userId: a.id,
      verificationId: s.verificationId,
      providerPayload: { mockApprove: true },
    });

    const owner = await getPortraitForOwner(a.id);
    expect(owner?.isVerifiedIdentityPortrait).toBe(true);

    await expect(
      getVerifiedPortraitForAudience({
        subjectUserId: b.id,
        audience: "lifeos_mock_public",
      }),
    ).rejects.toMatchObject({ code: "portrait_not_verified" });

    // B cannot load A's portrait as owner
    const other = await getPortraitForOwner(b.id, up.portrait.id);
    expect(other).toBeNull();
  });

  it("issues and verifies signed assertions with audience + replay protection", async () => {
    const user = await createUser("assert@example.com");
    const up = await uploadIdentityPortrait({
      userId: user.id,
      bytes: fakeJpeg("assert"),
      mimeType: "image/jpeg",
    });
    const s = await startIdentityVerification({
      userId: user.id,
      portraitId: up.portrait.id,
    });
    await completeIdentityVerification({
      userId: user.id,
      verificationId: s.verificationId,
      providerPayload: { mockApprove: true },
    });

    const issued = await issueIdentityAssertion({
      userId: user.id,
      audience: "lifeos_mock_public",
    });
    expect(issued.assertion.split(".")).toHaveLength(3);

    const claims = await verifyIdentityAssertion({
      assertion: issued.assertion,
      expectedAudience: "lifeos_mock_public",
      consumeJti: true,
    });
    expect(claims.trustId).toBeTruthy();
    expect(claims.hasVerifiedIdentityPortrait ?? claims.portraitRef).toBeTruthy();

    await expect(
      verifyIdentityAssertion({
        assertion: issued.assertion,
        expectedAudience: "lifeos_mock_public",
        consumeJti: true,
      }),
    ).rejects.toThrow(/already used/i);

    await expect(
      verifyIdentityAssertion({
        assertion: issued.assertion,
        expectedAudience: "wrong_audience",
        consumeJti: false,
      }),
    ).rejects.toThrow();
  });

  it("scopes hide unverified portraits from applications", async () => {
    const user = await createUser("scope@example.com");
    await uploadIdentityPortrait({
      userId: user.id,
      bytes: fakeJpeg("scope"),
      mimeType: "image/jpeg",
    });
    const scoped = await getIdentityForUser(user.id, [
      SCOPES.OPENID,
      SCOPES.IDENTITY_PORTRAIT,
      SCOPES.IDENTITY_VERIFICATION_STATUS,
    ]);
    // Zero-PII default: portrait attributes omitted unless ALLOW_LEGACY_PII_SCOPES
    expect(scoped?.hasVerifiedIdentityPortrait ?? false).toBe(false);
    expect(scoped?.portraitRef ?? null).toBeNull();
  });

  it("records impersonation reports without merging", async () => {
    const a = await createUser("rep.a@example.com");
    const b = await createUser("rep.b@example.com");
    const report = await createImpersonationReport({
      reporterUserId: a.id,
      type: IMPERSONATION_REPORT_TYPES.IDENTITY_IMPERSONATION,
      reason: "Someone is using my photograph",
      subjectTrustId: (await prisma.user.findUniqueOrThrow({ where: { id: b.id } })).trustId,
    });
    expect(report.id).toBeTruthy();
    const audit = await prisma.auditEvent.findFirst({
      where: { type: AUDIT_EVENTS.IDENTITY_IMPERSONATION_REPORTED, userId: a.id },
    });
    expect(audit).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });

  it("writes biometric-isolation friendly assertion claims (no embeddings)", async () => {
    const user = await createUser("bio@example.com");
    const up = await uploadIdentityPortrait({
      userId: user.id,
      bytes: fakeJpeg("bio"),
      mimeType: "image/jpeg",
    });
    const s = await startIdentityVerification({
      userId: user.id,
      portraitId: up.portrait.id,
    });
    await completeIdentityVerification({
      userId: user.id,
      verificationId: s.verificationId,
      providerPayload: { mockApprove: true },
    });
    const issued = await issueIdentityAssertion({
      userId: user.id,
      audience: "token_network_placeholder",
    });
    const payload = JSON.parse(
      Buffer.from(issued.assertion.split(".")[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(payload.embedding).toBeUndefined();
    expect(payload.biometric).toBeUndefined();
    expect(payload.faceTemplate).toBeUndefined();
    expect(payload.liveness).toBeUndefined();
    expect(payload.trustId).toBeTruthy();
  });
});
