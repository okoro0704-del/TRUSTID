import type { FastifyReply, FastifyRequest } from "fastify";
import {
  TRUST_ID_ACCESS_LEVELS,
  type TrustIdAccessLevel,
} from "@trustid/shared";
import { clientMeta } from "../../lib/auth-context.js";
import { getDashboardIdentity } from "../identity/service.js";
import { createSession } from "../sessions/service.js";
import { biometricMatcher, type BiometricMatchResult } from "./matcher.js";
import type { BiometricPayload } from "./schemas.js";

export type BiometricAuthContext = {
  userId: string;
  trustId: string;
  accessLevel: TrustIdAccessLevel;
  isMasterDevice: boolean;
  similarity?: number;
  match: BiometricMatchResult;
};

declare module "fastify" {
  interface FastifyRequest {
    biometricAuth?: BiometricAuthContext;
  }
}

/**
 * Identity-first gate: 1:N cloud biometric match.
 * Attaches `req.biometricAuth` on success; 401 on no match.
 */
export async function validateBiometricIdentity(
  req: FastifyRequest,
  reply: FastifyReply,
  biometric: BiometricPayload,
  requireMasterAccess = false,
) {
  const match = await biometricMatcher.matchOneToMany({
    biometric,
    requireMasterAccess,
    ...clientMeta(req),
  });

  if (!match.matched || !match.userId || !match.trustId) {
    return reply.code(401).send({
      error: "biometric_no_match",
      message: "No Trust ID identity matched this biometric on the central registry",
    });
  }

  if (requireMasterAccess && match.accessLevel !== TRUST_ID_ACCESS_LEVELS.MASTER) {
    return reply.code(403).send({
      error: "master_device_required",
      message:
        "This action requires approval from your bound Master Device. Issue a step-up challenge.",
      trustId: match.trustId,
      accessLevel: match.accessLevel,
    });
  }

  req.biometricAuth = {
    userId: match.userId,
    trustId: match.trustId,
    accessLevel: match.accessLevel,
    isMasterDevice: match.isMasterDevice,
    similarity: match.similarity,
    match,
  };
}

/**
 * Secondary layer: ensure the requesting terminal is the registered Master Device.
 */
export async function checkMasterDeviceBinding(
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const auth = req.biometricAuth;
  if (!auth) {
    return reply.code(401).send({
      error: "unauthorized",
      message: "Biometric identity validation required first",
    });
  }
  if (!auth.isMasterDevice || auth.accessLevel !== TRUST_ID_ACCESS_LEVELS.MASTER) {
    return reply.code(403).send({
      error: "master_device_required",
      message: "Operation requires the bound Master Device",
      trustId: auth.trustId,
    });
  }
}

/** Full verify flow: 1:N match + optional session for universal access. */
export async function verifyBiometricAndSession(input: {
  biometric: BiometricPayload;
  requireMasterAccess?: boolean;
  ip?: string;
  userAgent?: string;
}) {
  const match = await biometricMatcher.matchOneToMany({
    biometric: input.biometric,
    requireMasterAccess: input.requireMasterAccess,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  if (!match.matched || !match.userId || !match.trustId) {
    return { matched: false as const, match };
  }

  if (
    input.requireMasterAccess &&
    match.accessLevel !== TRUST_ID_ACCESS_LEVELS.MASTER
  ) {
    return {
      matched: true as const,
      match,
      masterRequired: true as const,
      trustId: match.trustId,
      accessLevel: match.accessLevel,
    };
  }

  const identity = await getDashboardIdentity(match.userId);
  const { token } = await createSession({
    userId: match.userId,
    kind: match.isMasterDevice ? "master" : "biometric",
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    matched: true as const,
    match,
    sessionToken: token,
    identity,
    trustId: match.trustId,
    accessLevel: match.accessLevel,
    isMasterDevice: match.isMasterDevice,
  };
}
