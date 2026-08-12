import { z } from "zod";
import { AUDIT_EVENTS, isDeviceCredentialActive } from "@trustid/shared";
import { prisma } from "../../db/client.js";
import { recordAudit } from "../audit/service.js";

const prekeySchema = z.object({
  identityKey: z.string().min(16),
  identitySigningKey: z.string().min(16),
  signedPreKeyId: z.number().int().positive(),
  signedPreKey: z.string().min(16),
  signedPreKeySig: z.string().min(16),
  oneTimePreKeys: z
    .array(
      z.object({
        id: z.number().int().positive(),
        publicKey: z.string().min(16),
      }),
    )
    .max(100)
    .default([]),
});

const envelopeSchema = z.object({
  recipientDeviceId: z.string().min(1),
  envelopeType: z.enum(["vault_meta", "device_auth", "generic"]),
  header: z.record(z.unknown()),
  nonce: z.string().min(8),
  ciphertext: z.string().min(8),
  ttlHours: z.number().int().min(1).max(168).optional(),
});

async function assertOwnedDevice(userId: string, deviceId: string) {
  const device = await prisma.device.findFirst({
    where: {
      id: deviceId,
      userId,
      status: { in: ["active", "trusted"] },
    },
  });
  if (!device) {
    throw Object.assign(new Error("Device not found"), { statusCode: 404 });
  }
  return device;
}

/** Publish / rotate public X3DH prekey bundle for a device (private keys never sent). */
export async function publishPrekeyBundle(input: {
  userId: string;
  deviceId: string;
  bundle: unknown;
}) {
  await assertOwnedDevice(input.userId, input.deviceId);
  const bundle = prekeySchema.parse(input.bundle);

  const row = await prisma.deviceSyncPrekeyBundle.upsert({
    where: { deviceId: input.deviceId },
    create: {
      userId: input.userId,
      deviceId: input.deviceId,
      identityKey: bundle.identityKey,
      identitySigningKey: bundle.identitySigningKey,
      signedPreKeyId: bundle.signedPreKeyId,
      signedPreKey: bundle.signedPreKey,
      signedPreKeySig: bundle.signedPreKeySig,
      oneTimePreKeysJson: JSON.stringify(bundle.oneTimePreKeys),
    },
    update: {
      identityKey: bundle.identityKey,
      identitySigningKey: bundle.identitySigningKey,
      signedPreKeyId: bundle.signedPreKeyId,
      signedPreKey: bundle.signedPreKey,
      signedPreKeySig: bundle.signedPreKeySig,
      oneTimePreKeysJson: JSON.stringify(bundle.oneTimePreKeys),
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_SYNC_PREKEYS_PUBLISHED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      deviceId: input.deviceId,
      signedPreKeyId: bundle.signedPreKeyId,
      oneTimeCount: bundle.oneTimePreKeys.length,
    },
  });

  return { id: row.id, deviceId: row.deviceId, updatedAt: row.updatedAt };
}

/** Fetch another device's public bundle; consumes one OPK if present (blind relay). */
export async function fetchPrekeyBundle(input: {
  userId: string;
  targetDeviceId: string;
}) {
  await assertOwnedDevice(input.userId, input.targetDeviceId);
  const row = await prisma.deviceSyncPrekeyBundle.findUnique({
    where: { deviceId: input.targetDeviceId },
  });
  if (!row) {
    throw Object.assign(new Error("No prekey bundle for device"), {
      statusCode: 404,
    });
  }

  let oneTimePreKeys: Array<{ id: number; publicKey: string }> = [];
  try {
    oneTimePreKeys = JSON.parse(row.oneTimePreKeysJson) as Array<{
      id: number;
      publicKey: string;
    }>;
  } catch {
    oneTimePreKeys = [];
  }

  const opk = oneTimePreKeys.shift();
  if (opk) {
    await prisma.deviceSyncPrekeyBundle.update({
      where: { deviceId: input.targetDeviceId },
      data: { oneTimePreKeysJson: JSON.stringify(oneTimePreKeys) },
    });
  }

  return {
    deviceId: row.deviceId,
    identityKey: row.identityKey,
    identitySigningKey: row.identitySigningKey,
    signedPreKeyId: row.signedPreKeyId,
    signedPreKey: row.signedPreKey,
    signedPreKeySig: row.signedPreKeySig,
    oneTimePreKeyId: opk?.id,
    oneTimePreKey: opk?.publicKey,
  };
}

export async function queueEnvelope(input: {
  userId: string;
  senderDeviceId: string;
  body: unknown;
}) {
  await assertOwnedDevice(input.userId, input.senderDeviceId);
  const body = envelopeSchema.parse(input.body);
  await assertOwnedDevice(input.userId, body.recipientDeviceId);

  const ttlHours = body.ttlHours ?? 48;
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);

  const env = await prisma.deviceSyncEnvelope.create({
    data: {
      userId: input.userId,
      senderDeviceId: input.senderDeviceId,
      recipientDeviceId: body.recipientDeviceId,
      envelopeType: body.envelopeType,
      headerJson: JSON.stringify(body.header),
      nonce: body.nonce,
      ciphertext: body.ciphertext,
      expiresAt,
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_SYNC_ENVELOPE_QUEUED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: {
      envelopeId: env.id,
      type: body.envelopeType,
      recipientDeviceId: body.recipientDeviceId,
    },
  });

  return { id: env.id, expiresAt: env.expiresAt };
}

export async function listInbox(input: {
  userId: string;
  recipientDeviceId: string;
}) {
  await assertOwnedDevice(input.userId, input.recipientDeviceId);
  const now = new Date();
  const rows = await prisma.deviceSyncEnvelope.findMany({
    where: {
      userId: input.userId,
      recipientDeviceId: input.recipientDeviceId,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  return rows.map((r) => ({
    id: r.id,
    senderDeviceId: r.senderDeviceId,
    envelopeType: r.envelopeType,
    header: JSON.parse(r.headerJson) as unknown,
    nonce: r.nonce,
    ciphertext: r.ciphertext,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  }));
}

export async function consumeEnvelope(input: {
  userId: string;
  recipientDeviceId: string;
  envelopeId: string;
}) {
  await assertOwnedDevice(input.userId, input.recipientDeviceId);
  const row = await prisma.deviceSyncEnvelope.findFirst({
    where: {
      id: input.envelopeId,
      userId: input.userId,
      recipientDeviceId: input.recipientDeviceId,
      consumedAt: null,
    },
  });
  if (!row) {
    throw Object.assign(new Error("Envelope not found"), { statusCode: 404 });
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw Object.assign(new Error("Envelope expired"), { statusCode: 410 });
  }

  await prisma.deviceSyncEnvelope.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  });

  await recordAudit({
    type: AUDIT_EVENTS.DEVICE_SYNC_ENVELOPE_CONSUMED,
    userId: input.userId,
    actorType: "user",
    actorId: input.userId,
    metadata: { envelopeId: row.id },
  });

  return {
    id: row.id,
    senderDeviceId: row.senderDeviceId,
    envelopeType: row.envelopeType,
    header: JSON.parse(row.headerJson) as unknown,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
  };
}

export async function listSyncDevices(userId: string) {
  const devices = await prisma.device.findMany({
    where: {
      userId,
      OR: [
        { status: "active" },
        { status: "trusted" },
      ],
    },
    include: { syncPrekeyBundles: true },
    orderBy: { createdAt: "asc" },
  });

  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    trustLevel: d.trustLevel,
    hasPrekeyBundle: d.syncPrekeyBundles.length > 0,
    status: isDeviceCredentialActive(d.status) ? "active" : d.status,
  }));
}
