/**
 * X3DH-inspired session establishment (Signal protocol family).
 *
 * Curve: X25519. Signature: Ed25519 over signed-prekey SPKI bytes.
 * KDF: HKDF-SHA-256 ? 32-byte AES-256-GCM session key.
 *
 * TrustID server only relays public prekey bundles and opaque ciphertext.
 * Private keys never leave the device / browser.
 */

import {
  base64UrlToBytes,
  bytesToBase64Url,
  concatBytes,
  randomBytes,
  sha256,
} from "./encoding.js";

export type CryptoKeyPairExport = {
  publicKey: Uint8Array;
  privateKey: CryptoKey;
  publicCryptoKey: CryptoKey;
};

export type PreKeyBundle = {
  identityKey: string;
  identitySigningKey: string;
  signedPreKeyId: number;
  signedPreKey: string;
  signedPreKeySig: string;
  oneTimePreKeyId?: number;
  oneTimePreKey?: string;
};

export type X3DHInitResult = {
  sessionKey: Uint8Array;
  header: {
    identityKey: string;
    ephemeralKey: string;
    signedPreKeyId: number;
    oneTimePreKeyId?: number;
  };
};

function toBuf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function genX25519(): Promise<CryptoKeyPairExport> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey,
    privateKey: pair.privateKey,
    publicCryptoKey: pair.publicKey,
  };
}

async function genEd25519(): Promise<{
  publicKey: Uint8Array;
  privateKey: CryptoKey;
  publicCryptoKey: CryptoKey;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  return {
    publicKey,
    privateKey: pair.privateKey,
    publicCryptoKey: pair.publicKey,
  };
}

async function importX25519Public(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toBuf(raw), { name: "X25519" }, true, []);
}

async function importEd25519Public(spki: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "spki",
    toBuf(spki),
    { name: "Ed25519" },
    true,
    ["verify"],
  );
}

async function dh(priv: CryptoKey, pubRaw: Uint8Array): Promise<Uint8Array> {
  const pub = await importX25519Public(pubRaw);
  const bits = await crypto.subtle.deriveBits(
    { name: "X25519", public: pub },
    priv,
    256,
  );
  return new Uint8Array(bits);
}

async function hkdfSha256(ikm: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", toBuf(ikm), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: new TextEncoder().encode(info),
    },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function generateIdentityMaterial() {
  const identity = await genX25519();
  const signing = await genEd25519();
  return { identity, signing };
}

export async function generateSignedPreKey(
  signingPrivateKey: CryptoKey,
  id: number,
): Promise<{ id: number; keyPair: CryptoKeyPairExport; signature: Uint8Array }> {
  const keyPair = await genX25519();
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, signingPrivateKey, toBuf(keyPair.publicKey)),
  );
  return { id, keyPair, signature };
}

export async function generateOneTimePreKeys(
  count: number,
): Promise<Array<{ id: number; keyPair: CryptoKeyPairExport }>> {
  const out: Array<{ id: number; keyPair: CryptoKeyPairExport }> = [];
  for (let i = 1; i <= count; i++) {
    out.push({ id: i, keyPair: await genX25519() });
  }
  return out;
}

export async function verifySignedPreKey(
  identitySigningKey: Uint8Array,
  signedPreKeyPub: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const pub = await importEd25519Public(identitySigningKey);
  return crypto.subtle.verify(
    { name: "Ed25519" },
    pub,
    toBuf(signature),
    toBuf(signedPreKeyPub),
  );
}

export function encodePreKeyBundle(input: {
  identity: CryptoKeyPairExport;
  signing: { publicKey: Uint8Array };
  signedPreKey: { id: number; keyPair: CryptoKeyPairExport; signature: Uint8Array };
  oneTime?: { id: number; keyPair: CryptoKeyPairExport };
}): PreKeyBundle {
  return {
    identityKey: bytesToBase64Url(input.identity.publicKey),
    identitySigningKey: bytesToBase64Url(input.signing.publicKey),
    signedPreKeyId: input.signedPreKey.id,
    signedPreKey: bytesToBase64Url(input.signedPreKey.keyPair.publicKey),
    signedPreKeySig: bytesToBase64Url(input.signedPreKey.signature),
    oneTimePreKeyId: input.oneTime?.id,
    oneTimePreKey: input.oneTime
      ? bytesToBase64Url(input.oneTime.keyPair.publicKey)
      : undefined,
  };
}

export async function x3dhInitiate(
  aliceIdentity: CryptoKeyPairExport,
  bobBundle: PreKeyBundle,
): Promise<X3DHInitResult> {
  const bobIk = base64UrlToBytes(bobBundle.identityKey);
  const bobSpk = base64UrlToBytes(bobBundle.signedPreKey);
  const bobSig = base64UrlToBytes(bobBundle.signedPreKeySig);
  const bobSign = base64UrlToBytes(bobBundle.identitySigningKey);

  if (!(await verifySignedPreKey(bobSign, bobSpk, bobSig))) {
    throw new Error("Signed prekey signature invalid");
  }

  const ephemeral = await genX25519();
  const dh1 = await dh(aliceIdentity.privateKey, bobSpk);
  const dh2 = await dh(ephemeral.privateKey, bobIk);
  const dh3 = await dh(ephemeral.privateKey, bobSpk);

  let ikm = concatBytes(dh1, dh2, dh3);
  let opkId: number | undefined;
  if (bobBundle.oneTimePreKey && bobBundle.oneTimePreKeyId != null) {
    const bobOpk = base64UrlToBytes(bobBundle.oneTimePreKey);
    const dh4 = await dh(ephemeral.privateKey, bobOpk);
    ikm = concatBytes(ikm, dh4);
    opkId = bobBundle.oneTimePreKeyId;
  }

  const sessionKey = await hkdfSha256(ikm, "TrustID-X3DH-v1");
  dh1.fill(0);
  dh2.fill(0);
  dh3.fill(0);
  ikm.fill(0);

  return {
    sessionKey,
    header: {
      identityKey: bytesToBase64Url(aliceIdentity.publicKey),
      ephemeralKey: bytesToBase64Url(ephemeral.publicKey),
      signedPreKeyId: bobBundle.signedPreKeyId,
      oneTimePreKeyId: opkId,
    },
  };
}

export async function x3dhRespond(input: {
  bobIdentity: CryptoKeyPairExport;
  bobSignedPreKey: CryptoKeyPairExport;
  bobOneTimePreKey?: CryptoKeyPairExport;
  header: X3DHInitResult["header"];
}): Promise<Uint8Array> {
  const aliceIk = base64UrlToBytes(input.header.identityKey);
  const aliceEk = base64UrlToBytes(input.header.ephemeralKey);

  const dh1 = await dh(input.bobSignedPreKey.privateKey, aliceIk);
  const dh2 = await dh(input.bobIdentity.privateKey, aliceEk);
  const dh3 = await dh(input.bobSignedPreKey.privateKey, aliceEk);

  let ikm = concatBytes(dh1, dh2, dh3);
  if (input.bobOneTimePreKey && input.header.oneTimePreKeyId != null) {
    const dh4 = await dh(input.bobOneTimePreKey.privateKey, aliceEk);
    ikm = concatBytes(ikm, dh4);
  }

  const sessionKey = await hkdfSha256(ikm, "TrustID-X3DH-v1");
  dh1.fill(0);
  dh2.fill(0);
  dh3.fill(0);
  ikm.fill(0);
  return sessionKey;
}

export async function sealWithSessionKey(
  sessionKey: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<{ nonce: string; ciphertext: string }> {
  const key = await crypto.subtle.importKey(
    "raw",
    toBuf(sessionKey),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const nonce = randomBytes(12);
  const cipherBuf = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toBuf(nonce),
      additionalData: aad ? toBuf(aad) : undefined,
    },
    key,
    toBuf(plaintext),
  );
  return {
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(new Uint8Array(cipherBuf)),
  };
}

export async function openWithSessionKey(
  sessionKey: Uint8Array,
  nonceB64: string,
  ciphertextB64: string,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    toBuf(sessionKey),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plainBuf = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toBuf(base64UrlToBytes(nonceB64)),
      additionalData: aad ? toBuf(aad) : undefined,
    },
    key,
    toBuf(base64UrlToBytes(ciphertextB64)),
  );
  return new Uint8Array(plainBuf);
}

export async function commitSecret(secret: Uint8Array): Promise<string> {
  return bytesToBase64Url(await sha256(secret));
}

export type { CryptoKeyPairExport as X25519KeyPair };
