/** AES-256-GCM envelope: iv(12) || ciphertext+tag */

const IV_BYTES = 12;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: additionalData ? toArrayBuffer(additionalData) : undefined,
    },
    key,
    toArrayBuffer(plaintext),
  );
  const cipher = new Uint8Array(cipherBuf);
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return out;
}

export async function aesGcmDecrypt(
  key: CryptoKey,
  envelope: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  if (envelope.length < IV_BYTES + 16) {
    throw new Error("Invalid AES-GCM envelope");
  }
  const iv = envelope.subarray(0, IV_BYTES);
  const cipher = envelope.subarray(IV_BYTES);
  const plainBuf = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: additionalData ? toArrayBuffer(additionalData) : undefined,
    },
    key,
    toArrayBuffer(cipher),
  );
  return new Uint8Array(plainBuf);
}

export async function importAes256Key(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function generateAes256Key(extractable = false): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"],
  );
}

export async function exportAes256Key(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(raw);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(data));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hkdfSha256(
  ikm: Uint8Array,
  info: string,
  salt: Uint8Array,
  length = 32,
): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(ikm),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(new TextEncoder().encode(info)),
    },
    baseKey,
    length * 8,
  );
  return new Uint8Array(bits);
}
