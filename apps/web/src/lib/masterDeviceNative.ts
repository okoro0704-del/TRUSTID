/**
 * Android Master Device ceremonies (TrustID app). Pure orchestration over two seams — the TrustID
 * API and the native plugins — so it can be tested without a phone.
 *
 * Enrollment: begin (server attestation challenge) → Keystore key generated WITH that challenge →
 * bind key (server returns the exact bytes to sign) → biometric signature over those bytes →
 * passkey with user verification → complete (attestation + signature + passkey). The key is only
 * kept if the server accepts it; any failure deletes it.
 */

export type MasterDeviceNative = {
  getSupport(): Promise<{ supported: boolean; sdk: number; strongBiometric: boolean; activeAlias?: string | null }>;
  generateKey(o: { attestationChallenge: string }): Promise<{ alias: string; publicKey: string; attestation: string[]; securityLevel: string }>;
  activateKey(o: { alias: string }): Promise<void>;
  deleteKey(o: { alias?: string }): Promise<void>;
  sign(o: { payload: string; alias?: string; title?: string; subtitle?: string }): Promise<{ signature: string }>;
};

export type PasskeyNative = {
  isSupported(): Promise<{ supported: boolean }>;
  getAssertion(o: { requestJson: string }): Promise<{ responseJson: string }>;
};

export type ApiFn = <T>(path: string, init?: { method?: string; body?: string }) => Promise<T>;

export class MasterDeviceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MasterDeviceError";
  }
}

const sha256b64url = async (b64url: string) => {
  const bytes = Uint8Array.from(atob(b64url.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Refuse to sign enrollment bytes that do not name this subject and this key. */
export async function assertEnrollmentPayload(payload: string, expected: { trustId: string; publicKey: string }) {
  const lines = payload.split("\n");
  const fields = Object.fromEntries(lines.slice(1).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  if (lines[0] !== "trustid-master-device-enroll/v1" || fields.sub !== expected.trustId || fields.key !== (await sha256b64url(expected.publicKey)) || !fields.enrollment) {
    throw new MasterDeviceError("payload_mismatch", "The enrollment request does not match this phone's key.");
  }
}

export async function enrollAndroidMasterDevice(deps: {
  api: ApiFn;
  native: MasterDeviceNative;
  passkey: () => Promise<unknown>;
  trustId: string;
  deviceFingerprint: string;
}) {
  const support = await deps.native.getSupport();
  if (!support.supported) {
    throw new MasterDeviceError("unsupported_device", support.strongBiometric ? "This phone cannot hold a Master Device key." : "Set up a fingerprint or strong face unlock first.");
  }
  const begun = await deps.api<{ enrollment: string; attestation_challenge: string }>("/v1/step-up/master-device/enrollment", { method: "POST", body: "{}" });
  const key = await deps.native.generateKey({ attestationChallenge: begun.attestation_challenge });
  try {
    const bound = await deps.api<{ enrollment: string; signing_payload: string }>("/v1/step-up/master-device/enrollment/key", {
      method: "POST",
      body: JSON.stringify({ enrollment: begun.enrollment, public_key: key.publicKey }),
    });
    await assertEnrollmentPayload(bound.signing_payload, { trustId: deps.trustId, publicKey: key.publicKey });
    const { signature } = await deps.native.sign({
      alias: key.alias,
      payload: bound.signing_payload,
      title: "Make this phone your Master Device",
      subtitle: "Confirms this phone approves sensitive TrustID requests",
    });
    const reauth = await deps.passkey();
    const done = await deps.api<{ registered: boolean; device: { id: string; security_level: string | null } }>("/v1/step-up/master-device/enrollment/complete", {
      method: "POST",
      body: JSON.stringify({
        enrollment: bound.enrollment,
        public_key: key.publicKey,
        device_fingerprint: deps.deviceFingerprint,
        signature,
        reauth,
        attestation: key.attestation,
      }),
    });
    await deps.native.activateKey({ alias: key.alias });
    return { ...done, securityLevel: key.securityLevel };
  } catch (err) {
    await deps.native.deleteKey({ alias: key.alias }).catch(() => undefined);
    throw err;
  }
}

/** Revoke from this phone: device signature (immediate re-enrollment) + passkey with UV. */
export async function revokeFromThisPhone(deps: { api: ApiFn; native: MasterDeviceNative; passkey: () => Promise<unknown>; trustId: string; masterDeviceId: string }) {
  const { signature } = await deps.native.sign({
    payload: ["trustid-master-device-revoke/v1", `sub=${deps.trustId}`, `device=${deps.masterDeviceId}`].join("\n"),
    title: "Remove this Master Device",
  });
  const reauth = await deps.passkey();
  const result = await deps.api<{ revoked: boolean }>("/v1/step-up/master-device/revoke", {
    method: "POST",
    body: JSON.stringify({ reauth, device_signature: signature }),
  });
  await deps.native.deleteKey({});
  return result;
}
