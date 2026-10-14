/**
 * Test-only builders for Android Master Device enrollment:
 *   - real X.509 chains (root → intermediate → leaf) whose leaf carries an Android KeyDescription
 *     extension, signed with generated P-256 keys (stand-in for Google's roots and a device TEE),
 *   - a software WebAuthn authenticator that produces genuine assertions (UP / UV flags) for the
 *     web origin or an Android app origin.
 * Nothing here is used by the API itself.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, X509Certificate, type KeyObject } from "node:crypto";
import { prisma } from "../../src/db/client.js";

/* ------------------------------------------------------------------ DER encoder */

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
export const tlv = (tag: number[] | number, body: Buffer) => {
  const t = Array.isArray(tag) ? Buffer.from(tag) : Buffer.from([tag]);
  return Buffer.concat([t, len(body.length), body]);
};
export const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
export const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
export const octets = (b: Buffer) => tlv(0x04, b);
export const nul = () => Buffer.from([0x05, 0x00]);
export const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
function intBytes(n: number | bigint): Buffer {
  let hex = BigInt(n).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let b = Buffer.from(hex, "hex");
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return b;
}
export const int = (n: number | bigint) => tlv(0x02, intBytes(n));
export const enumerated = (n: number) => tlv(0x0a, intBytes(n));
export function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = p >> 7;
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
/** Context-specific constructed tag [n] (explicit), high-tag-number form when n > 30. */
export function ctx(n: number, inner: Buffer): Buffer {
  if (n <= 30) return tlv(0xa0 | n, inner);
  const stack = [n & 0x7f];
  let v = n >> 7;
  while (v > 0) {
    stack.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return tlv([0xbf, ...stack], inner);
}
const utcTime = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn)))));

/* ------------------------------------------------------------------ X.509 */

type CertInput = {
  subject: string;
  issuer: string;
  subjectKey: KeyObject;
  issuerKey: KeyObject;
  ca: boolean;
  extensions?: Buffer[];
  notBefore?: Date;
  notAfter?: Date;
  serial?: number;
};

export function makeCert(c: CertInput): Buffer {
  const algorithm = seq(oid("1.2.840.10045.4.3.2"));
  const exts = [
    seq(oid("2.5.29.19"), bool(true), octets(seq(...(c.ca ? [bool(true)] : [])))),
    ...(c.extensions ?? []),
  ];
  const tbs = seq(
    ctx(0, int(2)),
    int(c.serial ?? Math.floor(Math.random() * 1e9) + 1),
    algorithm,
    name(c.issuer),
    seq(utcTime(c.notBefore ?? new Date(Date.now() - 86400_000)), utcTime(c.notAfter ?? new Date(Date.now() + 365 * 86400_000))),
    name(c.subject),
    c.subjectKey.export({ format: "der", type: "spki" }) as Buffer,
    ctx(3, seq(...exts)),
  );
  const signature = cryptoSign("sha256", tbs, c.issuerKey);
  return seq(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

/* ------------------------------------------------------------------ KeyDescription */

export const KEY_DESCRIPTION_OID = "1.3.6.1.4.1.11129.2.1.17";

export type KeyDescriptionInput = {
  challenge: Buffer;
  securityLevel?: number; // 0 software, 1 TEE, 2 StrongBox
  purposes?: number[];
  algorithm?: number;
  ecCurve?: number;
  digests?: number[];
  userAuthType?: number | null; // 2 = biometric; null = absent
  noAuthRequired?: boolean;
  authTimeout?: number | null;
  deviceLocked?: boolean;
  verifiedBootState?: number;
  packageName?: string;
  signingCertSha256?: string;
};

export function keyDescription(i: KeyDescriptionInput): Buffer {
  const level = i.securityLevel ?? 1;
  const appId = seq(
    set(seq(octets(Buffer.from(i.packageName ?? "com.trustid.device")), int(3))),
    set(octets(Buffer.from(i.signingCertSha256 ?? "11".repeat(32), "hex"))),
  );
  const software = seq(ctx(709, octets(appId)));
  const hardware: Buffer[] = [
    ctx(1, set(...(i.purposes ?? [2]).map(int))),
    ctx(2, int(i.algorithm ?? 3)),
    ctx(3, int(256)),
    ctx(5, set(...(i.digests ?? [4]).map(int))),
    ctx(10, int(i.ecCurve ?? 1)),
  ];
  if (i.noAuthRequired) hardware.push(ctx(503, nul()));
  if (i.userAuthType !== null) hardware.push(ctx(504, int(i.userAuthType ?? 2)));
  if (i.authTimeout !== null && i.authTimeout !== undefined) hardware.push(ctx(505, int(i.authTimeout)));
  hardware.push(ctx(704, seq(octets(randomBytes(32)), bool(i.deviceLocked ?? true), enumerated(i.verifiedBootState ?? 0), octets(randomBytes(32)))));
  return seq(int(300), enumerated(level), int(300), enumerated(level), octets(i.challenge), octets(Buffer.alloc(0)), software, seq(...hardware));
}

/** A complete attestation for `deviceKey` (public key): leaf, intermediate, root (base64 DER). */
export function attestationChain(
  root: { key: KeyObject; publicKey: KeyObject },
  deviceKey: KeyObject,
  kd: KeyDescriptionInput,
  opts: { brokenSignature?: boolean; intermediateNotCa?: boolean } = {},
): string[] {
  const intermediate = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const rootCert = makeCert({ subject: "Test Attestation Root", issuer: "Test Attestation Root", subjectKey: root.publicKey, issuerKey: root.key, ca: true });
  const intermediateCert = makeCert({
    subject: "Test Attestation Intermediate",
    issuer: "Test Attestation Root",
    subjectKey: intermediate.publicKey,
    issuerKey: root.key,
    ca: !opts.intermediateNotCa,
  });
  const leafSigner = opts.brokenSignature ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey : intermediate.privateKey;
  const leaf = makeCert({
    subject: "Android Keystore Key",
    issuer: "Test Attestation Intermediate",
    subjectKey: deviceKey,
    issuerKey: leafSigner,
    ca: false,
    extensions: [seq(oid(KEY_DESCRIPTION_OID), octets(keyDescription(kd)))],
  });
  return [leaf, intermediateCert, rootCert].map((c) => c.toString("base64"));
}

export function testAttestationRoot() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = new X509Certificate(
    makeCert({ subject: "Test Attestation Root", issuer: "Test Attestation Root", subjectKey: publicKey, issuerKey: privateKey, ca: true }),
  ).toString();
  return { key: privateKey, publicKey, pem };
}

/* ------------------------------------------------------------------ software passkey */

function cborCoseEc2(x: Buffer, y: Buffer) {
  const small = (n: number) => (n >= 0 ? Buffer.from([n]) : Buffer.from([0x20 + (-1 - n)]));
  const bytes = (b: Buffer) => Buffer.concat([Buffer.from([0x58, b.length]), b]);
  return Buffer.concat([Buffer.from([0xa5]), small(1), small(2), small(3), small(-7), small(-1), small(1), small(-2), bytes(x), small(-3), bytes(y)]);
}

export type SoftwarePasskey = { credentialId: string; key: KeyObject; counter: number };

/** A passkey on a trusted (primary) device of the user, as WebAuthn registration would store it. */
export async function seedPasskey(userId: string): Promise<{ passkey: SoftwarePasskey; deviceId: string }> {
  const device = await prisma.device.create({ data: { userId, name: "test phone", status: "active", trustLevel: "primary" } });
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const credentialId = randomBytes(32).toString("base64url");
  await prisma.credential.create({
    data: {
      userId,
      deviceId: device.id,
      credentialId,
      publicKey: new Uint8Array(cborCoseEc2(Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url"))),
      counter: BigInt(0),
      transports: JSON.stringify(["internal", "hybrid"]),
      status: "active",
    },
  });
  return { passkey: { credentialId, key: privateKey, counter: 1 }, deviceId: device.id };
}

/** A WebAuthn assertion. `uv=false` sets only User Present (the authenticator did not verify the user). */
export function assertion(passkey: SoftwarePasskey, opts: { challenge: string; rpId: string; origin: string; uv?: boolean }) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: opts.challenge, origin: opts.origin, crossOrigin: false }));
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(passkey.counter++);
  const flags = opts.uv === false ? 0x01 : 0x05;
  const authenticatorData = Buffer.concat([createHash("sha256").update(opts.rpId).digest(), Buffer.from([flags]), counter]);
  const signature = cryptoSign("sha256", Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]), passkey.key);
  return {
    id: passkey.credentialId,
    rawId: passkey.credentialId,
    type: "public-key",
    response: {
      clientDataJSON: clientDataJSON.toString("base64url"),
      authenticatorData: authenticatorData.toString("base64url"),
      signature: signature.toString("base64url"),
    },
    clientExtensionResults: {},
  };
}
