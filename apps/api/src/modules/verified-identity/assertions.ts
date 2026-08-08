import { createHash, randomUUID } from "node:crypto";
import * as jose from "jose";
import {
  AUDIT_EVENTS,
  IDENTITY_STATUS,
  PORTRAIT_STATUS,
  SCOPES,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { recordAudit } from "../audit/service.js";
import { ensureVerifiedIdentityProfile } from "./profile.js";

const ISSUER = () =>
  process.env.ASSERTION_ISSUER ||
  config.webauthn.origin ||
  "https://trustedid.netlify.app";

async function ensureSigningKey() {
  const active = await prisma.assertionSigningKey.findFirst({
    where: { active: true },
    orderBy: { createdAt: "desc" },
  });
  if (active) return active;

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
  privateJwk.alg = "EdDSA";
  publicJwk.kid = kid;
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";

  return prisma.assertionSigningKey.create({
    data: {
      kid,
      privateJwk: JSON.stringify(privateJwk),
      publicJwk: JSON.stringify(publicJwk),
      algorithm: "EdDSA",
      active: true,
    },
  });
}

export async function getJwks() {
  const keys = await prisma.assertionSigningKey.findMany({
    where: { OR: [{ active: true }, { retiredAt: { not: null } }] },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  if (!keys.length) {
    const created = await ensureSigningKey();
    keys.push(created);
  }
  return {
    keys: keys.map((k) => JSON.parse(k.publicJwk) as jose.JWK),
  };
}

/**
 * Issue a signed, audience-bound, time-bound identity assertion.
 * Never includes biometric templates, embeddings, or raw documents.
 */
export async function issueIdentityAssertion(input: {
  userId: string;
  audience: string;
  scopes?: string[];
  ttlSeconds?: number;
  ip?: string;
  userAgent?: string;
}) {
  const profile = await ensureVerifiedIdentityProfile(input.userId);
  if (
    profile.status === "revoked" ||
    profile.identityStatus === IDENTITY_STATUS.REVOKED
  ) {
    throw Object.assign(new Error("Identity revoked"), {
      statusCode: 403,
      code: "identity_revoked",
    });
  }

  const keyRow = await ensureSigningKey();
  const privateKey = await jose.importJWK(
    JSON.parse(keyRow.privateJwk) as jose.JWK,
    keyRow.algorithm,
  );

  const jti = randomUUID();
  const ttl = input.ttlSeconds ?? 300;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const scopes = input.scopes ?? [
    SCOPES.OPENID,
    SCOPES.IDENTITY_BASIC,
    SCOPES.IDENTITY_PROFILE,
    SCOPES.IDENTITY_VERIFICATION_STATUS,
  ];

  const portrait =
    profile.identityPortraitId &&
    profile.identityStatus === IDENTITY_STATUS.VERIFIED
      ? await prisma.identityPortrait.findFirst({
          where: {
            id: profile.identityPortraitId,
            status: PORTRAIT_STATUS.VERIFIED,
          },
        })
      : null;

  const claims: Record<string, unknown> = {
    trustId: profile.trustId,
    displayName: profile.displayName,
    identityStatus: profile.identityStatus,
    verificationLevel: profile.verificationLevel,
    profileVersion: profile.profileVersion,
    portraitVersion: profile.portraitVersion,
    portraitRef: portrait ? portrait.id : null,
    hasVerifiedIdentityPortrait: Boolean(portrait),
    scope: scopes.join(" "),
  };

  // Only include portrait claim when verified — never leak uploads
  if (!portrait) {
    claims.portraitRef = null;
    claims.portraitVersion = 0;
  }

  const token = await new jose.SignJWT(claims)
    .setProtectedHeader({ alg: keyRow.algorithm, kid: keyRow.kid, typ: "JWT" })
    .setIssuer(ISSUER())
    .setAudience(input.audience)
    .setSubject(profile.trustId)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .setJti(jti)
    .sign(privateKey);

  await prisma.assertionJti.create({
    data: {
      jti,
      userId: input.userId,
      audience: input.audience,
      expiresAt,
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.ASSERTION_ISSUED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      audience: input.audience,
      jti,
      identityStatus: profile.identityStatus,
      profileVersion: profile.profileVersion,
      portraitVersion: portrait?.version ?? 0,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    assertion: token,
    token_type: "urn:trustid:identity_assertion",
    expires_in: ttl,
    expiresAt: expiresAt.toISOString(),
    issuer: ISSUER(),
    audience: input.audience,
    jti,
  };
}

export async function verifyIdentityAssertion(input: {
  assertion: string;
  expectedAudience: string;
  /** When true, mark jti as used (replay protection for one-time consume) */
  consumeJti?: boolean;
}) {
  const jwks = jose.createLocalJWKSet(await getJwks());
  let payload: jose.JWTPayload;
  try {
    const verified = await jose.jwtVerify(input.assertion, jwks, {
      issuer: ISSUER(),
      audience: input.expectedAudience,
    });
    payload = verified.payload;
  } catch {
    await recordAudit({
      type: AUDIT_EVENTS.ASSERTION_REJECTED,
      userId: null,
      actorType: "system",
      actorId: null,
      metadata: { reason: "signature_or_claims_invalid" },
    });
    throw Object.assign(new Error("Invalid identity assertion"), {
      statusCode: 401,
      code: "unauthorized",
    });
  }

  const jti = String(payload.jti ?? "");
  if (!jti) {
    throw Object.assign(new Error("Invalid identity assertion"), {
      statusCode: 401,
      code: "unauthorized",
    });
  }

  const row = await prisma.assertionJti.findUnique({ where: { jti } });
  if (!row) {
    // Still accept if signature valid but track missing row carefully —
    // require known jti for replay protection
    throw Object.assign(new Error("Invalid identity assertion"), {
      statusCode: 401,
      code: "unauthorized",
    });
  }
  if (row.audience !== input.expectedAudience) {
    throw Object.assign(new Error("Audience mismatch"), {
      statusCode: 401,
      code: "unauthorized",
    });
  }
  if (row.usedAt && input.consumeJti !== false) {
    await recordAudit({
      type: AUDIT_EVENTS.ASSERTION_REJECTED,
      userId: row.userId,
      actorType: "system",
      actorId: null,
      metadata: { reason: "replay", jti },
    });
    throw Object.assign(new Error("Assertion already used"), {
      statusCode: 401,
      code: "unauthorized",
    });
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw Object.assign(new Error("Assertion expired"), {
      statusCode: 401,
      code: "unauthorized",
    });
  }

  if (input.consumeJti) {
    await prisma.assertionJti.update({
      where: { jti },
      data: { usedAt: new Date() },
    });
  }

  // Stale portrait / revoked identity check
  const profile = await prisma.verifiedIdentityProfile.findUnique({
    where: { userId: row.userId },
  });
  if (
    !profile ||
    profile.status === "revoked" ||
    profile.identityStatus === IDENTITY_STATUS.REVOKED
  ) {
    throw Object.assign(new Error("Identity revoked"), {
      statusCode: 403,
      code: "identity_revoked",
    });
  }
  const claimedProfileVersion = Number(payload.profileVersion ?? 0);
  if (claimedProfileVersion !== profile.profileVersion) {
    throw Object.assign(new Error("Stale identity assertion"), {
      statusCode: 401,
      code: "unauthorized",
    });
  }

  await recordAudit({
    type: AUDIT_EVENTS.ASSERTION_VERIFIED,
    userId: row.userId,
    actorType: "system",
    actorId: input.expectedAudience,
    metadata: { jti, audience: input.expectedAudience },
  });

  return {
    trustId: payload.trustId,
    displayName: payload.displayName,
    identityStatus: payload.identityStatus,
    verificationLevel: payload.verificationLevel,
    portraitRef: payload.portraitRef ?? null,
    portraitVersion: payload.portraitVersion ?? 0,
    profileVersion: payload.profileVersion,
    audience: input.expectedAudience,
    issuedAt: payload.iat
      ? new Date(Number(payload.iat) * 1000).toISOString()
      : null,
    expiresAt: payload.exp
      ? new Date(Number(payload.exp) * 1000).toISOString()
      : null,
    jti,
  };
}
