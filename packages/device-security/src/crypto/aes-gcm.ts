/** AES-256-GCM helpers (Web Crypto). Used by the web vault adapter and tests. */

const IV_BYTES = 12;
const KEY_BITS = 256;

function toUint8(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return toUint8(bytes).buffer;
}

export async function generateVaultDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: KEY_BITS },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function importVaultDek(
  raw: Uint8Array,
  extractable = false,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "AES-GCM", length: KEY_BITS },
    extractable,
    ["encrypt", "decrypt"],
  );
}

export async function exportVaultDek(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(raw);
}

/** Envelope: iv (12) || ciphertext+tag */
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
    toUint8(plaintext),
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
    throw new Error("Invalid vault envelope");
  }
  const iv = toUint8(envelope.subarray(0, IV_BYTES));
  const cipher = toUint8(envelope.subarray(IV_BYTES));
  const plainBuf = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: additionalData ? toArrayBuffer(additionalData) : undefined,
    },
    key,
    cipher,
  );
  return new Uint8Array(plainBuf);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(data));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
