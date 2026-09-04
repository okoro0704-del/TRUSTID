import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../lib/config.js";
import {
  clientMeta,
  requireSession,
  setSessionCookie,
} from "../lib/auth-context.js";
import {
  approveMasterChallengeSchema,
  issueMasterChallengeSchema,
  registerMasterDeviceSchema,
  verifyBiometricRequestSchema,
  verifyMasterDeviceSchema,
  ambientSignInRequestSchema,
  faceLookupRequestSchema,
  registerTrustIdRequestSchema,
  registerPushTokenSchema,
  installUnlockSchema,
} from "../modules/trust-id/schemas.js";
import {
  approveMasterChallenge,
  ambientSignInAndSession,
  biometricMatcher,
  issueMasterChallenge,
  registerMasterDevice,
  verifyBiometricAndSession,
  verifyMasterDeviceBinding,
} from "../modules/trust-id/index.js";
import {
  registerTrustIdWithMasterDevice,
  unlockSessionForBoundInstall,
} from "../modules/trust-id/register.js";
import { handleFastVectorMatch } from "../modules/trust-id/fast-vector-match.js";
import { registerDevicePushToken } from "../modules/notifications/push.js";
import { BIOMETRIC_MODALITIES } from "@trustid/shared";

function httpError(err: unknown, reply: import("fastify").FastifyReply) {
  const e = err as { statusCode?: number; message?: string; code?: string };
  const code = e.statusCode ?? 500;
  return reply.code(code).send({
    error: e.code ?? (code === 500 ? "server_error" : "invalid_request"),
    message: e.message ?? "Unexpected error",
  });
}

function sessionBody(token: string | undefined) {
  if (config.exposeSessionTokenInBody && token) {
    return { sessionToken: token };
  }
  return {};
}

export async function trustIdRoutes(app: FastifyInstance) {
  /**
   * Ultra-fast edge-vector match — client sends ONLY a 512-D float array (~2KB).
   * Dual-path: cachedTrustId → 1:1 direct; otherwise 1:N HNSW global search.
   */
  app.post("/v1/auth/fast-vector-match", async (req, reply) => {
    try {
      return await handleFastVectorMatch(req, reply);
    } catch (err) {
      if (err && typeof err === "object" && "issues" in err) {
        return reply.code(400).send({
          error: "invalid_vector",
          message: "Valid 512-dimensional vector required.",
        });
      }
      return httpError(err, reply);
    }
  });

  /** Alias for biometric-login clients (same dual-path handler). */
  app.post("/v1/auth/biometric-login", async (req, reply) => {
    try {
      return await handleFastVectorMatch(req, reply);
    } catch (err) {
      if (err && typeof err === "object" && "issues" in err) {
        return reply.code(400).send({
          error: "invalid_vector",
          message: "Valid 512-dimensional vector required.",
        });
      }
      return httpError(err, reply);
    }
  });

  /**
   * Launch lookup only — never enrolls.
   * MATCH_FOUND may issue a session (or master-approval pending).
   * NOT_FOUND requires explicit client consent before ambient enroll.
   */
  app.post("/v1/identity/face-lookup", async (req, reply) => {
    const body = faceLookupRequestSchema.parse(req.body ?? {});
    const face = body.face ?? {
      modality: BIOMETRIC_MODALITIES.FACE,
      vector: body.faceVector,
      confidence: body.confidence,
      modelName: body.modelName,
      modelVersion: body.modelVersion,
      deviceFingerprint: body.deviceFingerprint,
    };

    if (!face.vector && !("embedding" in face && face.embedding)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "Biometric vector payload missing.",
      });
    }

    try {
      const result = await ambientSignInAndSession({
        payload: {
          face: {
            modality: BIOMETRIC_MODALITIES.FACE,
            vector: face.vector,
            embedding: "embedding" in face ? face.embedding : undefined,
            confidence: face.confidence,
            modelName: face.modelName,
            modelVersion: face.modelVersion,
            deviceFingerprint: face.deviceFingerprint ?? body.deviceFingerprint,
          },
        },
        allowAutoEnroll: false,
        installId: body.installId,
        ...clientMeta(req),
      });

      if (!result.matched) {
        if (result.error && /no face/i.test(result.error)) {
          return reply.code(400).send({
            error: "no_face",
            message: result.error,
          });
        }
        return {
          status: "NOT_FOUND" as const,
          message: "No Trust ID record matches this facial scan.",
          canRegister: true,
        };
      }

      if (result.needsMasterApproval) {
        return {
          status: "PENDING_MASTER_APPROVAL" as const,
          trustId: result.trustId,
          approvalPollToken: result.approvalPollToken,
          approvalRequestId: result.approvalRequestId,
          user: result.trustId
            ? { trustId: result.trustId, displayName: result.trustId }
            : undefined,
        };
      }

      if (result.sessionToken) {
        setSessionCookie(reply, result.sessionToken);
      }

      return {
        status: "MATCH_FOUND" as const,
        trustId: result.trustId,
        user: {
          trustId: result.trustId,
          displayName: result.trustId,
        },
        identity: result.identity,
        isMasterDevice: result.isMasterDevice,
        ...sessionBody(result.sessionToken),
        token: config.exposeSessionTokenInBody ? result.sessionToken : undefined,
      };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  /**
   * Create Trust ID after user consent — binds this terminal as Master Device.
   */
  app.post("/v1/identity/register-trust-id", async (req, reply) => {
    const body = registerTrustIdRequestSchema.parse(req.body ?? {});
    try {
      const { installId, deviceName, pushToken, pushPlatform, ...payload } =
        body;
      const result = await registerTrustIdWithMasterDevice({
        payload,
        installId,
        deviceName,
        pushToken,
        pushPlatform,
        ...clientMeta(req),
      });
      setSessionCookie(reply, result.sessionToken);
      return {
        success: true,
        matched: true,
        enrolled: true,
        trustId: result.trustId,
        user: result.user,
        device: result.device,
        isMasterDevice: true,
        identity: result.identity,
        ...sessionBody(result.sessionToken),
        token: config.exposeSessionTokenInBody ? result.token : undefined,
      };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  /**
   * After local fingerprint / device PIN succeeds on a bound install,
   * re-issue the cloud session without requiring a face rematch.
   */
  app.post("/v1/auth/install-unlock", async (req, reply) => {
    const body = installUnlockSchema.parse(req.body ?? {});
    if (!body.localAuthOk) {
      return reply.code(401).send({
        error: "local_auth_required",
        message: "Device biometric or PIN verification required",
      });
    }
    try {
      const result = await unlockSessionForBoundInstall({
        installId: body.installId,
        ...clientMeta(req),
      });
      setSessionCookie(reply, result.sessionToken);
      return {
        status: "MATCH_FOUND" as const,
        authenticatedVia: result.authenticatedVia,
        trustId: result.trustId,
        identity: result.identity,
        isMasterDevice: result.isMasterDevice,
        ...sessionBody(result.sessionToken),
        token: config.exposeSessionTokenInBody ? result.token : undefined,
      };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  /** Register FCM / Web Push token for heads-up approval alerts. */
  app.post("/v1/devices/push-token", async (req, reply) => {
    await requireSession(req, reply);
    if (!req.auth) return;
    const body = registerPushTokenSchema.parse(req.body ?? {});
    try {
      const row = await registerDevicePushToken({
        userId: req.auth.userId,
        token: body.token,
        platform: body.platform,
        deviceId: body.deviceId ?? req.auth.deviceId,
        channelId: body.channelId,
      });
      return { ok: true, ...row };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  /** Zero-UI ambient multi-modal sign-in with fusion matching. */
  app.post("/v1/trust-id/ambient-signin", async (req, reply) => {
    const body = ambientSignInRequestSchema.parse(req.body ?? {});
    try {
      const { allowAutoEnroll, installId, ...payload } = body;
      const result = await ambientSignInAndSession({
        payload,
        allowAutoEnroll,
        installId,
        ...clientMeta(req),
      });

      if (!result.matched) {
        return reply.code(401).send({
          error: "ambient_no_match",
          message: "No Trust ID identity matched this biometric",
          fusionScore: result.fusion.fusionScore,
          faceMatchScore: result.fusion.faceMatchScore,
          fingerprintMatchScore: result.fusion.fingerprintMatchScore,
        });
      }

      if (result.needsMasterApproval) {
        return {
          matched: true,
          enrolled: false,
          trustId: result.trustId,
          accessLevel: result.accessLevel,
          isMasterDevice: false,
          needsMasterApproval: true,
          approvalPollToken: result.approvalPollToken,
          approvalRequestId: result.approvalRequestId,
          offerSaveDeviceKey: result.offerSaveDeviceKey ?? true,
          matchedModality: result.matchedModality,
          isFaceMatched: result.isFaceMatched,
          isFingerprintMatched: result.isFingerprintMatched,
          fusionScore: result.fusionScore,
          faceMatchScore: result.faceMatchScore,
          fingerprintMatchScore: result.fingerprintMatchScore,
        };
      }

      if (result.sessionToken) {
        setSessionCookie(reply, result.sessionToken);
      }
      return {
        matched: true,
        enrolled: result.enrolled,
        trustId: result.trustId,
        accessLevel: result.accessLevel,
        isMasterDevice: result.isMasterDevice,
        needsMasterApproval: false,
        offerSaveDeviceKey: result.offerSaveDeviceKey ?? false,
        matchedModality: result.matchedModality,
        isFaceMatched: result.isFaceMatched,
        isFingerprintMatched: result.isFingerprintMatched,
        fusionScore: result.fusionScore,
        faceMatchScore: result.faceMatchScore,
        fingerprintMatchScore: result.fingerprintMatchScore,
        identity: result.identity,
        ...sessionBody(result.sessionToken),
      };
    } catch (err) {
      return httpError(err, reply);
    }
  });

  /**
   * Client captures biometric on any terminal and streams embedding here.
   */
  app.post("/v1/trust-id/verify-biometric", async (req, reply) => {
    const body = verifyBiometricRequestSchema.parse(req.body ?? {});
    try {
      const result = await verifyBiometricAndSession({
        biometric: body.biometric,
        requireMasterAccess: body.requireMasterAccess,
        ...clientMeta(req),
      });

      if (!result.matched) {
        return reply.code(401).send({
          error: "biometric_no_match",
          message: "No Trust ID identity matched this biometric",
        });
      }

      if ("masterRequired" in result && result.masterRequired) {
        return reply.code(403).send({
          error: "master_device_required",
          trustId: result.trustId,
          accessLevel: result.accessLevel,
          message: "Matched identity requires Master Device step-up for this action",
        });
      }

      if ("sessionToken" in result && result.sessionToken) {
        setSessionCookie(reply, result.sessionToken);
        return {
          matched: true,
          trustId: result.trustId,
          accessLevel: result.accessLevel,
          isMasterDevice: result.isMasterDevice,
          similarity: result.match.similarity,
          identity: result.identity,
          ...sessionBody(result.sessionToken),
        };
      }

      return result;
    } catch (err) {
      return httpError(err, reply);
    }
  });

  /** Enroll encrypted biometric template for 1:N matching (post-registration). */
  app.post("/v1/trust-id/enroll-biometric", async (req, reply) => {
    await requireSession(req, reply);
    if (!req.auth) return;
    const body = z
      .object({ biometric: verifyBiometricRequestSchema.shape.biometric })
      .parse(req.body ?? {});
    try {
      const enrolled = await biometricMatcher.enrollTemplate({
        userId: req.auth.userId,
        biometric: body.biometric,
        ...clientMeta(req),
      });
      return enrolled;
    } catch (err) {
      return httpError(err, reply);
    }
  });

  /** Register or refresh Master Device binding (secure enclave public key). */
  app.post("/v1/trust-id/master-device/register", async (req, reply) => {
    await requireSession(req, reply);
    if (!req.auth) return;
    const body = registerMasterDeviceSchema.parse(req.body ?? {});
    try {
      return await registerMasterDevice({
        userId: req.auth.userId,
        deviceFingerprint: body.deviceFingerprint,
        publicKey: body.publicKey,
        deviceId: body.deviceId ?? req.auth.deviceId ?? undefined,
        ...clientMeta(req),
      });
    } catch (err) {
      return httpError(err, reply);
    }
  });

  /** Verify Master Device signature for an issued challenge. */
  app.post("/v1/trust-id/master-device/verify", async (req, reply) => {
    await requireSession(req, reply);
    if (!req.auth) return;
    const body = verifyMasterDeviceSchema.parse(req.body ?? {});
    try {
      return await verifyMasterDeviceBinding({
        userId: req.auth.userId,
        deviceFingerprint: body.deviceFingerprint,
        challengeId: body.challengeId,
        signature: body.signature,
        ...clientMeta(req),
      });
    } catch (err) {
      return httpError(err, reply);
    }
  });

  /**
   * Step-up: issue cryptographic challenge to Master Device for sensitive actions
   * initiated on a secondary/unrecognized terminal.
   */
  app.post("/v1/trust-id/challenges/issue", async (req, reply) => {
    const body = issueMasterChallengeSchema.parse(req.body ?? {});
    try {
      return await issueMasterChallenge({
        userId: body.userId,
        action: body.action,
        payload: body.payload,
        requesterFingerprint: body.requesterFingerprint,
        ...clientMeta(req),
      });
    } catch (err) {
      return httpError(err, reply);
    }
  });

  /** Master Device approves a pending step-up challenge. */
  app.post("/v1/trust-id/challenges/approve", async (req, reply) => {
    await requireSession(req, reply);
    if (!req.auth) return;
    const body = approveMasterChallengeSchema.parse(req.body ?? {});
    try {
      return await approveMasterChallenge({
        userId: req.auth.userId,
        challengeId: body.challengeId,
        deviceFingerprint: body.deviceFingerprint,
        signature: body.signature,
        ...clientMeta(req),
      });
    } catch (err) {
      return httpError(err, reply);
    }
  });
}
