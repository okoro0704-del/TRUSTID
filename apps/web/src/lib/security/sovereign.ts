/**
 * Client helpers for Tier-2 sovereign sync + guardian recovery.
 * Cryptography runs locally via @trustid/sovereign-crypto; the API is a blind relay.
 */

import {
  bytesToBase64Url,
  commitSecret,
  encodePreKeyBundle,
  generateIdentityMaterial,
  generateOneTimePreKeys,
  generateSignedPreKey,
  splitRecoveryMasterKey,
  type ShamirShare,
} from "@trustid/sovereign-crypto";
import { api } from "../api";

const IDB = "trustid-sovereign-v1";

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("keys")) db.createObjectStore("keys");
      if (!db.objectStoreNames.contains("shares")) db.createObjectStore("shares");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(store: string, key: string, value: unknown) {
  const db = await openIdb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Generate + publish X3DH public prekeys for a device. Private keys stay in IndexedDB. */
export async function publishDevicePrekeys(deviceId: string) {
  const identity = await generateIdentityMaterial();
  const spk = await generateSignedPreKey(identity.signing.privateKey, 1);
  const otks = await generateOneTimePreKeys(10);
  const bundle = encodePreKeyBundle({
    identity: identity.identity,
    signing: identity.signing,
    signedPreKey: spk,
  });

  await idbPut("keys", `identity:${deviceId}`, {
    identityPrivate: identity.identity.privateKey,
    identityPublic: identity.identity.publicKey,
    signingPrivate: identity.signing.privateKey,
    signingPublic: identity.signing.publicKey,
    signedPreKeyPrivate: spk.keyPair.privateKey,
    signedPreKeyPublic: spk.keyPair.publicKey,
    signedPreKeyId: spk.id,
    oneTime: otks.map((o) => ({
      id: o.id,
      privateKey: o.keyPair.privateKey,
      publicKey: o.keyPair.publicKey,
    })),
  });

  return api("/sync/prekeys", {
    method: "PUT",
    body: JSON.stringify({
      deviceId,
      bundle: {
        identityKey: bundle.identityKey,
        identitySigningKey: bundle.identitySigningKey,
        signedPreKeyId: bundle.signedPreKeyId,
        signedPreKey: bundle.signedPreKey,
        signedPreKeySig: bundle.signedPreKeySig,
        oneTimePreKeys: otks.map((o) => ({
          id: o.id,
          publicKey: bytesToBase64Url(o.keyPair.publicKey),
        })),
      },
    }),
  });
}

/** Create Shamir guardian circle: split secret locally, upload opaque shares. */
export async function setupGuardianCircle(input: {
  threshold: number;
  guardians: Array<{ label: string; trustId?: string }>;
}) {
  const n = input.guardians.length;
  if (n < input.threshold) {
    throw new Error("Need at least as many guardians as the threshold");
  }
  const { secret, shares } = splitRecoveryMasterKey(input.threshold, n);
  const secretCommitment = await commitSecret(secret);

  const payloadShares = shares.map((s: ShamirShare, i) => ({
    shareIndex: s.index,
    shareCiphertext: s.value,
    guardianLabel: input.guardians[i]!.label,
    guardianTrustId: input.guardians[i]!.trustId,
  }));

  await idbPut("shares", "master-commitment", secretCommitment);
  secret.fill(0);

  return api<{
    circleId: string;
    threshold: number;
    shareCount: number;
    inviteCodes: Array<{ shareIndex: number; inviteCode: string }>;
  }>("/recovery/guardians/circle", {
    method: "POST",
    body: JSON.stringify({
      threshold: input.threshold,
      shareCount: n,
      secretCommitment,
      shares: payloadShares,
    }),
  });
}

export async function fetchSyncDevices() {
  return api<
    Array<{
      id: string;
      name: string;
      trustLevel: string;
      hasPrekeyBundle: boolean;
      status: string;
    }>
  >("/sync/devices");
}

export async function fetchGuardianStatus() {
  return api<{
    status: string;
    circleId?: string;
    threshold?: number;
    shareCount?: number;
    shares?: Array<{
      shareIndex: number;
      guardianLabel: string;
      status: string;
    }>;
    architecture?: { protocols?: Record<string, string> };
  }>("/recovery/status");
}
