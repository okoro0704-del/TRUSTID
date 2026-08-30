import {
  proveClaimBundle,
  proveTrustTierGte,
  verifyTrustTierGte,
  verifyZkClaimBundle,
  verifyZkClaimBundles,
  type LegacyTrustTierProveResponse,
  type ZkClaimBundle,
  type ZkProveBundleResponse,
  type ZkVerifyBatchResult,
  type ZkVerifyClaimResult,
} from "@trustid/zk";
import { SCOPES } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { config } from "../../lib/config.js";
import { identitySecretForUser, zkNullifier } from "../../lib/crypto.js";
import { computeTrustLevel } from "../trust/service.js";
import { isBundleProveRequest, type ZkProveRequest, type ZkVerifyRequest } from "./schemas.js";

export class ZkProveError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code = "invalid_request",
  ) {
    super(message);
    this.name = "ZkProveError";
  }
}

function assertZkScopes(scopes: string[]) {
  if (
    !scopes.includes(SCOPES.IDENTITY_ZK_CLAIMS) &&
    !scopes.includes(SCOPES.IDENTITY_TRUST_LEVEL)
  ) {
    throw new ZkProveError(
      "Missing identity.zk_claims or identity.trust_level scope",
      403,
      "forbidden",
    );
  }
}

async function resolveAudience(
  userId: string,
  applicationId: string | undefined,
  requestedAudience?: string,
): Promise<{ audience: string; clientId: string }> {
  const appRow = applicationId
    ? await prisma.application.findUnique({ where: { id: applicationId } })
    : null;
  const clientId = appRow?.clientId ?? "lifeos";
  const audience = requestedAudience ?? clientId;
  return { audience, clientId };
}

async function isAuthorizedForApplication(
  userId: string,
  applicationId: string | undefined,
  scopes: string[],
): Promise<boolean> {
  if (!applicationId) return false;
  const auth = await prisma.authorization.findFirst({
    where: { userId, applicationId, status: "active" },
    include: { scopes: true },
  });
  if (!auth) return false;
  const granted = new Set(auth.scopes.map((s) => s.scope));
  return scopes.some((s) => granted.has(s));
}

export async function proveZk(input: {
  userId: string;
  applicationId?: string;
  scopes: string[];
  body: ZkProveRequest;
}): Promise<ZkProveBundleResponse | LegacyTrustTierProveResponse> {
  assertZkScopes(input.scopes);

  const { audience, clientId } = await resolveAudience(
    input.userId,
    input.applicationId,
    input.body.audience,
  );
  const trust = await computeTrustLevel(input.userId);
  const secret = identitySecretForUser(input.userId);
  const nullifier = zkNullifier(secret, audience);
  const authorized = await isAuthorizedForApplication(
    input.userId,
    input.applicationId,
    input.scopes,
  );

  if (isBundleProveRequest(input.body)) {
    const issuedAtIso = new Date().toISOString();
    const claims: ZkClaimBundle[] = [];

    for (const claimType of input.body.claimTypes!) {
      if (claimType === "identity_status") {
        continue;
      }
      const bundle = proveClaimBundle({
        claimType,
        tier: trust.tier,
        minTier: input.body.minTier,
        nullifier,
        audience,
        clientId,
        scopes: input.scopes,
        authorized,
        issuerSecret: config.sealKey,
        issuedAt: issuedAtIso,
      });
      if (bundle) claims.push(bundle);
    }

    if (!claims.length) {
      throw new ZkProveError("No supported claim types requested", 400);
    }

    return {
      claims,
      issuedAt: Date.parse(issuedAtIso),
      audience,
    };
  }

  const proved = proveTrustTierGte({
    tier: trust.tier,
    minTier: input.body.minTier,
    nullifier,
    issuerSecret: config.sealKey,
  });

  return {
    ...proved,
    trustIdNullifier: nullifier,
    stars: trust.stars,
    maxStars: trust.maxStars,
    label: trust.label,
  };
}

export function verifyZk(input: ZkVerifyRequest): ZkVerifyClaimResult | ZkVerifyBatchResult {
  if ("claims" in input && Array.isArray(input.claims)) {
    return verifyZkClaimBundles(input.claims, config.sealKey);
  }

  if ("claimType" in input && input.claimType) {
    return verifyZkClaimBundle(input, config.sealKey);
  }

  if ("proof" in input && "publicSignals" in input) {
    return verifyTrustTierGte({
      proof: input.proof,
      publicSignals: input.publicSignals,
      issuerSecret: config.sealKey,
    });
  }

  throw Object.assign(new Error("Invalid ZK verify payload"), {
    statusCode: 400,
  });
}
