import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { generateTrustId } from "@trustid/shared";
import { config } from "./config.js";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Deterministic keyed hash for secrets stored as unique DB indexes
 * (sessions, OAuth tokens, enrollment tokens). Uses PII pepper — not reversible.
 */
export function hashSecret(value: string): string {
  return createHmac("sha256", pepperKey("token")).update(value).digest("hex");
}

/** Verify a secret against a keyed hash or legacy unsalted SHA-256. */
export function verifySecret(value: string, stored: string): boolean {
  const next = hashSecret(value);
  if (safeEqualHash(stored, next)) return true;
  // Legacy unsalted SHA-256 (pre Zero-PII cutover)
  const legacy = createHash("sha256").update(value).digest("hex");
  return safeEqualHash(stored, legacy);
}

export function safeEqualHash(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function generateOtp(): string {
  return String(randomInt(100000, 999999));
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function newTrustId(): string {
  return generateTrustId(randomBytes(5));
}

export function normalizeContact(type: string, value: string): string {
  const v = value.trim();
  if (type === "email") return v.toLowerCase();
  if (type === "phone") return v.replace(/[^\d+]/g, "");
  return v;
}

function pepperKey(purpose: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(config.piiPepper, "utf8"),
      Buffer.from("trustid-pii-v1"),
      purpose,
      32,
    ),
  );
}

function sealKeyBytes(): Buffer {
  const raw = config.sealKey;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(raw, "utf8"),
      Buffer.from("trustid-seal-v1"),
      "aes-256-gcm",
      32,
    ),
  );
}

/** Deterministic lookup hash for contact uniqueness (no plaintext retained). */
export function contactLookupHash(type: string, value: string): string {
  const normalized = normalizeContact(type, value);
  return createHmac("sha256", pepperKey("lookup"))
    .update(`${type}:${normalized}`)
    .digest("hex");
}

/** Peppered hash of a client-generated device install UUID (one TrustID per phone). */
export function installLookupHash(installId: string): string {
  const id = installId.trim();
  if (!id) throw new Error("installId required");
  return createHmac("sha256", pepperKey("device-install"))
    .update(id)
    .digest("hex");
}

/** Blind commitment for ZK uniqueness proofs. */
export function commitContact(type: string, value: string, salt?: string): {
  lookupHash: string;
  commitment: string;
  salt: string;
} {
  const s = salt ?? randomBytes(16).toString("hex");
  const normalized = normalizeContact(type, value);
  const lookupHash = contactLookupHash(type, value);
  const commitment = createHmac("sha256", pepperKey("commitment"))
    .update(`${s}:${type}:${normalized}`)
    .digest("hex");
  return { lookupHash, commitment, salt: s };
}

export function commitName(firstName: string, lastName: string, salt?: string): {
  nameCommitment: string;
  nameSalt: string;
} {
  const s = salt ?? randomBytes(16).toString("hex");
  const nameCommitment = createHmac("sha256", pepperKey("name"))
    .update(`${s}:${firstName.trim()}:${lastName.trim()}`)
    .digest("hex");
  return { nameCommitment, nameSalt: s };
}

/** AES-256-GCM seal; output base64url(iv || tag || ciphertext). */
export function sealBytes(plaintext: Buffer): string {
  const key = sealKeyBytes();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function openBytes(sealed: string): Buffer {
  const key = sealKeyBytes();
  const buf = Buffer.from(sealed, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function encryptBytes(plaintext: Buffer): Buffer {
  const key = sealKeyBytes();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // file format: magic(4) || iv(12) || tag(16) || ciphertext
  return Buffer.concat([Buffer.from("TIDC"), iv, tag, enc]);
}

export function decryptBytes(blob: Buffer): Buffer {
  if (blob.length < 4 + 12 + 16 || blob.subarray(0, 4).toString() !== "TIDC") {
    // Legacy plaintext portrait bytes (pre-encryption)
    return blob;
  }
  const key = sealKeyBytes();
  const iv = blob.subarray(4, 16);
  const tag = blob.subarray(16, 32);
  const data = blob.subarray(32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function sealJson(value: unknown): string {
  return sealBytes(Buffer.from(JSON.stringify(value), "utf8"));
}

export function openJson<T>(sealed: string): T {
  return JSON.parse(openBytes(sealed).toString("utf8")) as T;
}

/** HKDF identity secret for ZK nullifiers — never sent to relying parties. */
export function identitySecretForUser(userId: string): string {
  return Buffer.from(
    hkdfSync(
      "sha256",
      sealKeyBytes(),
      Buffer.from(userId, "utf8"),
      "identity-secret-v1",
      32,
    ),
  ).toString("hex");
}

export function zkNullifier(identitySecret: string, audience: string): string {
  return createHmac("sha256", Buffer.from(identitySecret, "hex"))
    .update(`nullifier:${audience}`)
    .digest("hex");
}

/** Stable digest for payment step-up context (no PAN/account plaintext). */
export function hashPaymentContext(input: {
  amountMinor?: number | bigint | null;
  currency?: string | null;
  merchantRef?: string | null;
  reference?: string | null;
  intentId?: string | null;
}): string {
  const parts = [
    input.intentId ?? "",
    input.reference ?? "",
    input.merchantRef ?? "",
    input.currency ?? "",
    input.amountMinor != null ? String(input.amountMinor) : "",
  ].join("|");
  return createHmac("sha256", pepperKey("bbs-payment"))
    .update(parts)
    .digest("hex");
}

/** Audience + payment-bound nullifier for BBS step-up ZK proofs. */
export function bbsPaymentNullifier(
  identitySecret: string,
  challengeId: string,
  paymentHash: string,
): string {
  return createHmac("sha256", Buffer.from(identitySecret, "hex"))
    .update(`bbs:nullifier:${challengeId}:${paymentHash}`)
    .digest("hex");
}

/** Master/device signature over an approved payment step-up. */
export function signBbsMasterApproval(
  sealKey: string,
  input: { challengeId: string; paymentHash: string; nullifier: string },
): string {
  return createHmac("sha256", attestKeyFromSeal(sealKey))
    .update(`${input.challengeId}|${input.paymentHash}|${input.nullifier}|approved`)
    .digest("hex");
}

export function verifyBbsMasterApproval(
  sealKey: string,
  input: { challengeId: string; paymentHash: string; nullifier: string },
  signature: string,
): boolean {
  const expected = signBbsMasterApproval(sealKey, input);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function attestKeyFromSeal(sealKey: string): Buffer {
  const raw = sealKey;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(raw, "utf8"), Buffer.from("trustid-bbs-v1"), "sign", 32),
  );
}
