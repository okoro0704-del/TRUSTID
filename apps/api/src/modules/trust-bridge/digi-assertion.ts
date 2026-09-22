/**
 * Digi-targeted subject assertion mint (Phase T2).
 * Minimal claims only — never embeds biometrics, passkeys, or internal DB ids.
 */
import { createHash, randomUUID } from "node:crypto";
import * as jose from "jose";
import {
  AUDIT_EVENTS,
  DIGI_ASSERTION_TTL_SECONDS,
  resolveDigiAudience,
} from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { openJson, sealJson } from "../../lib/crypto.js";
import { recordAudit } from "../audit/service.js";

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
      privateJwkSealed: sealJson(privateJwk),
      publicJwk: JSON.stringify(publicJwk),
      algorithm: "EdDSA",
      active: true,
    },
  });
}

/** Issuance rate limit: max N Digi assertions per user per window. */
const ISSUE_WINDOW_MS = 60_000;
const ISSUE_MAX_PER_WINDOW = 10;
const issueHits = new Map<string, number[]>();

function assertIssuanceRateLimit(userId: string) {
  const now = Date.now();
  const prev = (issueHits.get(userId) ?? []).filter(
    (t) => now - t < ISSUE_WINDOW_MS,
  );
  if (prev.length >= ISSUE_MAX_PER_WINDOW) {
    throw Object.assign(new Error("Too many Digi assertion requests"), {
      statusCode: 429,
      code: "rate_limited",
    });
  }
  prev.push(now);
  issueHits.set(userId, prev);
}

/**
 * Mint a Digi bridge assertion for an authenticated TrustID session.
 * `sub` is always User.trustId — never caller-supplied.
 */
export async function issueDigiSubjectAssertion(input: {
  userId: string;
  trustId: string;
  ip?: string;
  userAgent?: string;
}) {
  assertIssuanceRateLimit(input.userId);

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, trustId: true, status: true },
  });
  if (!user || user.trustId !== input.trustId) {
    throw Object.assign(new Error("Session subject mismatch"), {
      statusCode: 401,
      code: "unauthorized",
    });
  }
  if (user.status === "revoked") {
    throw Object.assign(new Error("Identity revoked"), {
      statusCode: 403,
      code: "identity_revoked",
    });
  }

  const audience = resolveDigiAudience(config.nodeEnv);
  const issuer = config.oidcIssuer;
  const ttl = DIGI_ASSERTION_TTL_SECONDS;
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((nowSec + ttl) * 1000);
  const jti = randomUUID();

  const keyRow = await ensureSigningKey();
  const privateKey = await jose.importJWK(
    openJson<jose.JWK>(keyRow.privateJwkSealed),
    keyRow.algorithm,
  );

  // Minimal claim set — identity proof only.
  const token = await new jose.SignJWT({
    typ: "trustid+digi",
  })
    .setProtectedHeader({
      alg: "EdDSA",
      kid: keyRow.kid,
      typ: "JWT",
    })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(user.trustId)
    .setIssuedAt(nowSec)
    .setNotBefore(nowSec)
    .setExpirationTime(nowSec + ttl)
    .setJti(jti)
    .sign(privateKey);

  await prisma.assertionJti.create({
    data: {
      jti,
      userId: user.id,
      audience,
      expiresAt,
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.TRUST_ASSERTION_ISSUED,
    userId: user.id,
    actorType: "user",
    actorId: user.id,
    metadata: {
      audience,
      issuer,
      jti,
      // never log token
      subHash: createHash("sha256").update(user.trustId).digest("hex").slice(0, 16),
      ttlSeconds: ttl,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    assertion: token,
    token_type: "urn:trustid:digi_subject_assertion",
    expires_in: ttl,
    expiresAt: expiresAt.toISOString(),
    issuer,
    audience,
    jti,
  };
}

export function __resetDigiAssertionRateLimitForTests() {
  issueHits.clear();
}
