import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
  AUDIT_EVENTS,
  DEVICE_STATUS,
  WEBAUTHN_PURPOSES,
} from "@trustid/shared";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { prisma } from "../../db/client.js";
import { recordAudit } from "../audit/service.js";
import { createSession } from "../sessions/service.js";
import {
  createSecureChallenge,
  consumeWebAuthnChallenge,
  storeWebAuthnChallenge,
} from "./challenges.js";
import { verifyLogin } from "./webauthn.js";

export type SilentDeviceMeta = {
  platform?: string;
  model?: string;
  osVersion?: string;
};

function decodeKeyMaterial(raw: string): Uint8Array {
  const trimmed = raw.trim();
  try {
    return new Uint8Array(Buffer.from(trimmed, "base64url"));
  } catch {
    /* fall through */
  }
  try {
    return new Uint8Array(Buffer.from(trimmed, "base64"));
  } catch {
    throw Object.assign(new Error("Invalid key encoding"), { statusCode: 400 });
  }
}

function verifyEs256Signature(input: {
  publicKeySpki: Uint8Array;
  challenge: string;
  signature: string;
}): boolean {
  const signature = Buffer.from(decodeKeyMaterial(input.signature));
  const key = createPublicKey({
    key: Buffer.from(input.publicKeySpki),
    format: "der",
    type: "spki",
  });
  const payload = Buffer.from(input.challenge, "utf8");
  try {
    // Matches Android/iOS SHA256withECDSA / SecKeyAlgorithm.ecdsaSignatureMessageX962SHA256
    return cryptoVerify("sha256", payload, key, signature);
  } catch {
    return false;
  }
}

/** Issue a silent-auth challenge with zero identity fields. */
export async function createSilentChallenge() {
  const challenge = createSecureChallenge(32);
  const stored = await storeWebAuthnChallenge({
    purpose: WEBAUTHN_PURPOSES.SILENT_AUTHENTICATION,
    challenge,
  });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_SILENT_AUTH_STARTED,
    userId: null,
    actorType: "system",
    actorId: null,
    metadata: { challengeId: stored.id, purpose: WEBAUTHN_PURPOSES.SILENT_AUTHENTICATION },
  });

  return {
    challengeId: stored.id,
    challenge: stored.challenge,
    purpose: WEBAUTHN_PURPOSES.SILENT_AUTHENTICATION,
    expiresAt: stored.expiresAt.toISOString(),
  };
}

/**
 * One-time pairing: bind a hardware public key to the signed-in Trust ID.
 * Called after the first successful passkey / account session on a device.
 */
export async function pairSilentDeviceKey(input: {
  userId: string;
  deviceId?: string | null;
  keyId: string;
  publicKeySpki: string;
  algorithm?: string;
  device?: SilentDeviceMeta;
  ip?: string;
  userAgent?: string;
}) {
  const spki = decodeKeyMaterial(input.publicKeySpki);
  if (spki.length < 32) {
    throw Object.assign(new Error("Invalid public key"), { statusCode: 400 });
  }

  // Validate SPKI parses as a public key
  try {
    createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
  } catch {
    throw Object.assign(new Error("Public key is not a valid SPKI"), {
      statusCode: 400,
    });
  }

  const existing = await prisma.silentDeviceKey.findUnique({
    where: { keyId: input.keyId },
  });
  if (existing && existing.userId !== input.userId) {
    throw Object.assign(new Error("Silent key already bound to another account"), {
      statusCode: 409,
    });
  }

  const spkiBytes = new Uint8Array(spki) as Uint8Array<ArrayBuffer>;

  const row = existing
    ? await prisma.silentDeviceKey.update({
        where: { keyId: input.keyId },
        data: {
          publicKeySpki: spkiBytes,
          algorithm: input.algorithm ?? "ES256",
          platform: input.device?.platform ?? existing.platform,
          model: input.device?.model ?? existing.model,
          osVersion: input.device?.osVersion ?? existing.osVersion,
          deviceId: input.deviceId ?? existing.deviceId,
          status: DEVICE_STATUS.ACTIVE,
          revokedAt: null,
        },
      })
    : await prisma.silentDeviceKey.create({
        data: {
          userId: input.userId,
          deviceId: input.deviceId ?? null,
          keyId: input.keyId,
          publicKeySpki: spkiBytes,
          algorithm: input.algorithm ?? "ES256",
          platform: input.device?.platform ?? null,
          model: input.device?.model ?? null,
          osVersion: input.device?.osVersion ?? null,
          status: DEVICE_STATUS.ACTIVE,
        },
      });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_SILENT_KEY_PAIRED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      keyId: row.keyId,
      platform: row.platform,
      model: row.model,
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    paired: true as const,
    keyId: row.keyId,
    trustId: (
      await prisma.user.findUniqueOrThrow({ where: { id: input.userId } })
    ).trustId,
  };
}

async function silentAssertNative(input: {
  keyId: string;
  challenge: string;
  signature: string;
  device?: SilentDeviceMeta;
  ip?: string;
  userAgent?: string;
}) {
  const key = await prisma.silentDeviceKey.findUnique({
    where: { keyId: input.keyId },
    include: { user: true, device: true },
  });

  if (!key || key.status === DEVICE_STATUS.REVOKED) {
    await recordAudit({
      type: AUDIT_EVENTS.DEVICE_SILENT_AUTH_FAILED,
      userId: key?.userId ?? null,
      actorType: "system",
      actorId: null,
      metadata: { reason: "device_unpaired", keyId: input.keyId },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw Object.assign(
      new Error("Device is not paired for silent authentication"),
      {
        statusCode: 404,
        code: "device_unpaired",
      },
    );
  }

  const consumed = await consumeWebAuthnChallenge({
    challenge: input.challenge,
    purpose: WEBAUTHN_PURPOSES.SILENT_AUTHENTICATION,
  });
  if (!consumed.ok) {
    await recordAudit({
      type: AUDIT_EVENTS.DEVICE_SILENT_AUTH_FAILED,
      userId: key.userId,
      actorType: "system",
      actorId: key.userId,
      metadata: { reason: `challenge_${consumed.reason}`, keyId: input.keyId },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw Object.assign(new Error("Silent auth challenge invalid or expired"), {
      statusCode: 400,
      code: "challenge_invalid",
    });
  }

  const ok = verifyEs256Signature({
    publicKeySpki: new Uint8Array(key.publicKeySpki),
    challenge: input.challenge,
    signature: input.signature,
  });
  if (!ok) {
    await recordAudit({
      type: AUDIT_EVENTS.DEVICE_SILENT_AUTH_FAILED,
      userId: key.userId,
      actorType: "system",
      actorId: key.userId,
      metadata: { reason: "invalid_signature", keyId: input.keyId },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw Object.assign(new Error("Silent auth signature verification failed"), {
      statusCode: 401,
      code: "invalid_signature",
    });
  }

  await prisma.silentDeviceKey.update({
    where: { id: key.id },
    data: {
      lastUsedAt: new Date(),
      platform: input.device?.platform ?? key.platform,
      model: input.device?.model ?? key.model,
      osVersion: input.device?.osVersion ?? key.osVersion,
    },
  });

  if (key.deviceId) {
    await prisma.device.update({
      where: { id: key.deviceId },
      data: {
        lastActiveAt: new Date(),
        lastIp: input.ip ?? undefined,
        userAgent: input.userAgent ?? undefined,
        platform: input.device?.platform ?? undefined,
      },
    });
  }

  const { session, token } = await createSession({
    userId: key.userId,
    deviceId: key.deviceId,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_SILENT_AUTH_COMPLETED,
    userId: key.userId,
    actorType: "user",
    actorId: key.userId,
    metadata: {
      keyId: key.keyId,
      sessionId: session.id,
      trustId: key.user.trustId,
      mode: "native",
    },
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return {
    mode: "native" as const,
    sessionToken: token,
    sessionId: session.id,
    trustId: key.user.trustId,
    device: key.device
      ? {
          id: key.device.id,
          name: key.device.name,
          status: key.device.status,
        }
      : null,
  };
}

/**
 * Unified silent assert:
 * - native: hardware signature + challenge ? Trust ID session
 * - webauthn: discoverable passkey assertion (no username) ? session
 */
export async function silentAssert(input: {
  mode: "native" | "webauthn";
  keyId?: string;
  challenge?: string;
  signature?: string;
  response?: AuthenticationResponseJSON;
  device?: SilentDeviceMeta;
  ip?: string;
  userAgent?: string;
}) {
  if (input.mode === "webauthn") {
    if (!input.response) {
      throw Object.assign(new Error("WebAuthn assertion response required"), {
        statusCode: 400,
      });
    }
    const result = await verifyLogin({
      response: input.response,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    await recordAudit({
      type: AUDIT_EVENTS.DEVICE_SILENT_AUTH_COMPLETED,
      userId: null,
      actorType: "user",
      actorId: result.trustId,
      metadata: {
        sessionId: result.sessionId,
        trustId: result.trustId,
        mode: "webauthn",
      },
      ip: input.ip,
      userAgent: input.userAgent,
    });
    return {
      mode: "webauthn" as const,
      ...result,
    };
  }

  if (!input.keyId || !input.challenge || !input.signature) {
    throw Object.assign(
      new Error("Native silent assert requires keyId, challenge, and signature"),
      { statusCode: 400 },
    );
  }

  return silentAssertNative({
    keyId: input.keyId,
    challenge: input.challenge,
    signature: input.signature,
    device: input.device,
    ip: input.ip,
    userAgent: input.userAgent,
  });
}
