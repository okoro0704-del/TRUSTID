import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../lib/config.js";
import { decryptBytes, encryptBytes } from "../../lib/crypto.js";
import { getDataZoneClient } from "../baas/registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "../../../data/private-media");

function mediaRoot() {
  return process.env.TRUSTID_MEDIA_ROOT || DEFAULT_ROOT;
}

function signingSecret() {
  return (
    process.env.MEDIA_SIGNING_SECRET ||
    config.cookieSecret ||
    "dev-media-signing-secret"
  );
}

export type StoredMedia = {
  storageKey: string;
  absolutePath: string;
  contentHash: string;
  byteSize: number;
  via?: "datazone" | "local_fallback";
};

/**
 * Private media — prefer DataZone object storage; local disk only when unbound/fallback.
 * TrustID retains metadata pointers (IdentityMediaObject.storageKey), not blob ownership.
 */
export async function storePrivateBytes(input: {
  userId: string;
  trustId?: string;
  purpose: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<StoredMedia> {
  const contentHash = createHash("sha256").update(input.bytes).digest("hex");
  const dz = getDataZoneClient();
  if (dz.bound && input.trustId) {
    const remote = await dz.putObject({
      userId: input.userId,
      trustId: input.trustId,
      purpose: input.purpose,
      mimeType: input.mimeType,
      bytes: input.bytes,
    });
    if (remote.ok && remote.data) {
      return {
        storageKey: remote.data.storageKey,
        absolutePath: `datazone://${remote.data.storageKey}`,
        contentHash: remote.data.contentHash || contentHash,
        byteSize: remote.data.byteSize || input.bytes.byteLength,
        via: "datazone",
      };
    }
  }

  const id = randomBytes(16).toString("hex");
  const storageKey = `${input.purpose}/${input.userId}/${id}`;
  const absolutePath = path.join(mediaRoot(), storageKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, encryptBytes(input.bytes));
  return {
    storageKey,
    absolutePath,
    contentHash,
    byteSize: input.bytes.byteLength,
    via: "local_fallback",
  };
}

export async function readPrivateBytes(
  storageKey: string,
  auth?: { userId: string; trustId: string },
): Promise<Buffer> {
  if (storageKey.startsWith("datazone://") || (auth && getDataZoneClient().bound)) {
    const key = storageKey.replace(/^datazone:\/\//, "");
    const dz = getDataZoneClient();
    if (dz.bound && auth) {
      const remote = await dz.getObjectBytes(key, auth);
      if (remote.ok && remote.data) {
        return Buffer.from(remote.data);
      }
    }
  }

  if (
    storageKey.includes("..") ||
    path.isAbsolute(storageKey) ||
    storageKey.startsWith("/") ||
    storageKey.startsWith("\\")
  ) {
    throw Object.assign(new Error("not_found"), { statusCode: 404, code: "not_found" });
  }
  const absolutePath = path.join(mediaRoot(), storageKey);
  const resolved = path.resolve(absolutePath);
  if (!resolved.startsWith(path.resolve(mediaRoot()))) {
    throw Object.assign(new Error("not_found"), { statusCode: 404, code: "not_found" });
  }
  try {
    const raw = await readFile(resolved);
    return decryptBytes(raw);
  } catch {
    throw Object.assign(new Error("not_found"), { statusCode: 404, code: "not_found" });
  }
}

export async function deletePrivateBytes(storageKey: string): Promise<void> {
  try {
    await unlink(path.join(mediaRoot(), storageKey.replace(/^datazone:\/\//, "")));
  } catch {
    /* ignore missing */
  }
}

/** Create a short-lived HMAC token for media retrieval (not a JWT assertion). */
export function createMediaAccessToken(input: {
  mediaId: string;
  userId: string;
  /** viewer userId or application clientId */
  audience: string;
  ttlSeconds?: number;
}): { token: string; expiresAt: Date } {
  const ttl = input.ttlSeconds ?? 120;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const payload = `${input.mediaId}.${input.userId}.${input.audience}.${exp}`;
  const sig = createHmac("sha256", signingSecret()).update(payload).digest("base64url");
  return { token: `${payload}.${sig}`, expiresAt };
}

export function verifyMediaAccessToken(token: string): {
  mediaId: string;
  userId: string;
  audience: string;
  exp: number;
} {
  const parts = token.split(".");
  if (parts.length !== 5) {
    throw Object.assign(new Error("forbidden"), { statusCode: 403, code: "forbidden" });
  }
  const [mediaId, userId, audience, expStr, sig] = parts;
  const payload = `${mediaId}.${userId}.${audience}.${expStr}`;
  const expected = createHmac("sha256", signingSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig!);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Object.assign(new Error("forbidden"), { statusCode: 403, code: "forbidden" });
  }
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) {
    throw Object.assign(new Error("forbidden"), { statusCode: 403, code: "forbidden" });
  }
  return { mediaId: mediaId!, userId: userId!, audience: audience!, exp };
}

export function allowedPortraitMime(mime: string): boolean {
  return ["image/jpeg", "image/png", "image/webp"].includes(mime);
}
