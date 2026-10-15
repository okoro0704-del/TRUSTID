/**
 * Android Master Device enrollment (T3): passkey with user verification + Android Key Attestation +
 * proof of possession, behind MASTER_DEVICE_ENROLLMENT. Real WebAuthn assertions from a software
 * authenticator; real X.509 attestation chains signed by a generated test root.
 */
import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { config } from "../src/lib/config.js";
import { createSession } from "../src/modules/sessions/service.js";
import { setAttestationRootsForTests } from "../src/modules/step-up/master-device-enrollment.js";
import { normalizeSerial, revokedSerialsFromStatusList } from "../src/modules/step-up/android-key-attestation.js";
import { consumeWebAuthnChallenge } from "../src/modules/authentication/challenges.js";
import { verifyReauthentication } from "../src/modules/authentication/webauthn.js";
import { resetTables } from "./helpers/db.js";
import { attestationChain, assertion, seedPasskey, testAttestationRoot, type KeyDescriptionInput, type SoftwarePasskey } from "./helpers/android-attestation.js";
import { createZeroPiiUser } from "./helpers/zero-pii-user.js";
import { ADMIN, PORTAL, digest, portalTokens } from "./helpers/portal-oauth.js";

const APP_CERT = "8e5eb29468beea2d36135b8500c376e493277a97140a69d1688bd3ea4cf336aa";
const ANDROID_ORIGIN = `android:apk-key-hash:${Buffer.from(APP_CERT, "hex").toString("base64url")}`;
const RP_ID = "localhost";
const root = testAttestationRoot();

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(() => {
  process.env.MASTER_DEVICE_ENROLLMENT = "enabled";
  process.env.ANDROID_APP_SIGNING_SHA256 = APP_CERT;
  process.env.ANDROID_ATTESTATION_REVOCATION_CHECK = "off";
  process.env.WEBAUTHN_ANDROID_ORIGINS = ANDROID_ORIGIN;
  setAttestationRootsForTests([root.pem]);
});

beforeEach(async () => {
  await resetTables(prisma);
  app = await buildApp();
});

afterAll(async () => {
  setAttestationRootsForTests(null);
  delete process.env.MASTER_DEVICE_ENROLLMENT;
  delete process.env.ANDROID_APP_SIGNING_SHA256;
  delete process.env.ANDROID_ATTESTATION_REVOCATION_CHECK;
  delete process.env.WEBAUTHN_ANDROID_ORIGINS;
  delete process.env.MASTER_DEVICE_RECOVERY_COOLDOWN_HOURS;
  await app?.close();
  await prisma.$disconnect();
});

type Owner = { userId: string; trustId: string; session: Record<string, string>; sessionToken: string; passkey: SoftwarePasskey };

/** A TrustID owner signed in on their phone, with a passkey on that phone. */
async function owner(): Promise<Owner> {
  const user = await createZeroPiiUser(`${Math.random().toString(36).slice(2)}@example.test`);
  const { passkey, deviceId } = await seedPasskey(user.id);
  const { token } = await createSession({ userId: user.id, deviceId });
  return { userId: user.id, trustId: user.trustId, session: { [config.sessionCookieName]: token }, sessionToken: token, passkey };
}

const post = (url: string, session: Record<string, string> | undefined, payload: unknown) =>
  app.inject({ method: "POST", url, ...(session ? { cookies: session } : {}), payload: payload as Record<string, unknown> });

/** Native Credential Manager passkey assertion (Android origin) answering `options`; user verification by default. */
function answer(o: Owner, options: { challenge: string }, opts: { uv?: boolean; origin?: string } = {}) {
  return assertion(o.passkey, { challenge: options.challenge, rpId: RP_ID, origin: opts.origin ?? ANDROID_ORIGIN, uv: opts.uv });
}

/** Passkey assertion for THIS enrollment (options bound to its nonce and key). */
async function enrollPasskey(o: Owner, enrollment: string, opts: { uv?: boolean; origin?: string } = {}) {
  const options = await post("/v1/step-up/master-device/enrollment/reauth", o.session, { enrollment });
  expect(options.statusCode, options.body).toBe(200);
  expect(options.json().userVerification).toBe("required");
  return answer(o, options.json(), opts);
}

/** Remove the Master Device: begin → device signature (optional) → passkey for THIS removal → revoke. */
async function revoke(o: Owner, opts: { deviceKey?: KeyObject; uv?: boolean } = {}) {
  const begun = await post("/v1/step-up/master-device/revoke/begin", o.session, {});
  if (begun.statusCode !== 200) return begun;
  const b = begun.json() as { revocation: string; signing_payload: string; passkey_options: { challenge: string } };
  return post("/v1/step-up/master-device/revoke", o.session, {
    revocation: b.revocation,
    reauth: answer(o, b.passkey_options, { uv: opts.uv }),
    ...(opts.deviceKey ? { device_signature: cryptoSign("sha256", Buffer.from(b.signing_payload), opts.deviceKey).toString("base64url") } : {}),
  });
}

type Phone = { privateKey: KeyObject; spki: string; fingerprint: string };

/** The Android app's side of the ceremony, step by step, with knobs for each negative test. */
async function enroll(o: Owner, opts: { kd?: Partial<KeyDescriptionInput>; uv?: boolean; signWith?: KeyObject; chain?: (c: string[]) => string[]; skipAttestation?: boolean; otherKeyInAttestation?: boolean; leafNotBefore?: Date } = {}) {
  const begun = await post("/v1/step-up/master-device/enrollment", o.session, {});
  if (begun.statusCode !== 200) return { begun };
  const { enrollment, attestation_challenge } = begun.json() as { enrollment: string; attestation_challenge: string };
  // Keystore: key generated WITH the server's attestation challenge.
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const phone: Phone = { privateKey: key.privateKey, spki: key.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), fingerprint: `trustid-device-${Math.random().toString(36).slice(2, 12)}` };
  const bound = await post("/v1/step-up/master-device/enrollment/key", o.session, { enrollment, public_key: phone.spki });
  if (bound.statusCode !== 200) return { begun, bound };
  const attestedKey = opts.otherKeyInAttestation ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey : key.publicKey;
  let chain = attestationChain(root, attestedKey, { challenge: Buffer.from(attestation_challenge, "base64url"), signingCertSha256: APP_CERT, ...opts.kd }, { leafNotBefore: opts.leafNotBefore });
  if (opts.chain) chain = opts.chain(chain);
  const body = {
    enrollment: bound.json().enrollment,
    public_key: phone.spki,
    device_fingerprint: phone.fingerprint,
    signature: cryptoSign("sha256", Buffer.from(bound.json().signing_payload, "utf8"), opts.signWith ?? key.privateKey).toString("base64url"),
    reauth: await enrollPasskey(o, bound.json().enrollment, { uv: opts.uv }),
    ...(opts.skipAttestation ? {} : { attestation: chain }),
  };
  const done = await post("/v1/step-up/master-device/enrollment/complete", o.session, body);
  return { begun, bound, done, body, phone };
}

const status = (o: Owner) => app.inject({ method: "GET", url: "/v1/step-up/master-device", cookies: o.session });

describe("enrollment ceremony", () => {
  it("1. valid passkey (UV) + attested hardware key + proof of possession enrolls; owner notified; audited with session ref", async () => {
    const o = await owner();
    const { done } = await enroll(o);
    expect(done!.statusCode, done!.body).toBe(200);
    expect(done!.json()).toMatchObject({ registered: true, device: { security_level: "tee" } });
    const st = (await status(o)).json();
    expect(st).toMatchObject({ registered: true, enrollment_enabled: true, device: { platform: "android", security_level: "tee" } });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { userId: o.userId, type: "master_device.registered" } });
    const meta = JSON.parse(audit.metadata);
    expect(meta).toMatchObject({ platform: "android", securityLevel: "tee", verifiedBoot: true });
    expect(meta.sessionRef).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(audit.metadata).not.toContain(o.sessionToken);
    expect(await prisma.securityNotification.count({ where: { userId: o.userId, type: "master_device_enrolled" } })).toBe(1);
  });

  it("2. without login every step is refused", async () => {
    for (const url of ["/v1/step-up/master-device/enrollment", "/v1/step-up/master-device/enrollment/key", "/v1/step-up/master-device/enrollment/complete"]) {
      expect((await post(url, undefined, {})).statusCode).toBe(401);
    }
  });

  it("3. a passkey assertion without user verification (presence only) is refused", async () => {
    const o = await owner();
    const { done } = await enroll(o, { uv: false });
    expect(done!.statusCode).toBe(401);
    expect(done!.json()).toMatchObject({ error: "reauthentication_failed" });
    expect((await status(o)).json().registered).toBe(false);
    const failed = await prisma.auditEvent.findFirst({ where: { userId: o.userId, type: "step_up.master_device_enrollment_failed" } });
    expect(JSON.parse(failed!.metadata)).toMatchObject({ reason: "reauthentication_failed" });
  });

  it("3b. a passkey assertion for a web origin not configured, or a foreign app origin, is refused", async () => {
    const o = await owner();
    const begun = await post("/v1/step-up/master-device/enrollment", o.session, {});
    expect(begun.statusCode).toBe(200);
    const foreign = `android:apk-key-hash:${Buffer.alloc(32, 7).toString("base64url")}`;
    const { done } = await (async () => {
      const r = await enroll(o, {});
      return r;
    })();
    expect(done!.statusCode).toBe(200);
    // separate owner for the foreign-origin case
    const o2 = await owner();
    const b2 = await post("/v1/step-up/master-device/enrollment", o2.session, {});
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = key.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const bound = await post("/v1/step-up/master-device/enrollment/key", o2.session, { enrollment: b2.json().enrollment, public_key: spki });
    const res = await post("/v1/step-up/master-device/enrollment/complete", o2.session, {
      enrollment: bound.json().enrollment,
      public_key: spki,
      device_fingerprint: "trustid-device-foreign-origin",
      signature: cryptoSign("sha256", Buffer.from(bound.json().signing_payload), key.privateKey).toString("base64url"),
      reauth: await enrollPasskey(o2, bound.json().enrollment, { origin: foreign }),
      attestation: attestationChain(root, key.publicKey, { challenge: Buffer.from(b2.json().attestation_challenge, "base64url"), signingCertSha256: APP_CERT }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("4. a wrong attestation challenge or a tampered enrollment token is refused", async () => {
    const o = await owner();
    const wrong = await enroll(o, { kd: { challenge: createHash("sha256").update("another enrollment").digest() } });
    expect(wrong.done!.statusCode).toBe(403);
    expect(wrong.done!.json().message).toMatch(/challenge_mismatch/);
    const begun = await post("/v1/step-up/master-device/enrollment", o.session, {});
    const [body, mac] = (begun.json().enrollment as string).split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), exp: 9_999_999_999 })).toString("base64url");
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    expect((await post("/v1/step-up/master-device/enrollment/key", o.session, { enrollment: `${forged}.${mac}`, public_key: key })).statusCode).toBe(400);
  });

  it("5. a completed enrollment cannot be replayed", async () => {
    const o = await owner();
    const { done, body } = await enroll(o);
    expect(done!.statusCode).toBe(200);
    const replay = await post("/v1/step-up/master-device/enrollment/complete", o.session, body);
    expect(replay.statusCode).toBe(409);
    // and no fresh passkey request can be obtained for it either
    expect((await post("/v1/step-up/master-device/enrollment/reauth", o.session, { enrollment: body!.enrollment })).statusCode).toBe(409);
  });

  it("6. proof of possession is required (signature by another key fails)", async () => {
    const o = await owner();
    const { done } = await enroll(o, { signWith: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey });
    expect(done!.statusCode).toBe(401);
    expect(done!.json()).toMatchObject({ error: "invalid_signature" });
  });

  it("7. wrong-owner binding fails: another owner's session cannot continue an enrollment; an attestation for another key is refused", async () => {
    const a = await owner();
    const b = await owner();
    const begun = await post("/v1/step-up/master-device/enrollment", a.session, {});
    const spki = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const crossed = await post("/v1/step-up/master-device/enrollment/key", b.session, { enrollment: begun.json().enrollment, public_key: spki });
    expect(crossed.statusCode).toBe(403);
    const other = await enroll(a, { otherKeyInAttestation: true });
    expect(other.done!.statusCode).toBe(403);
    expect(other.done!.json().message).toMatch(/key_mismatch/);
  });

  it("disabled by default: with MASTER_DEVICE_ENROLLMENT unset enrollment is refused", async () => {
    const o = await owner();
    process.env.MASTER_DEVICE_ENROLLMENT = "disabled";
    try {
      const res = await post("/v1/step-up/master-device/enrollment", o.session, {});
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "master_device_enrollment_disabled" });
    } finally {
      process.env.MASTER_DEVICE_ENROLLMENT = "enabled";
    }
  });

  it("refuses enrollment when the attestation is missing or the app signing policy is not configured", async () => {
    const o = await owner();
    const missing = await enroll(o, { skipAttestation: true });
    expect(missing.done!.statusCode).toBe(400);
    expect(missing.done!.json()).toMatchObject({ error: "attestation_required" });
    const saved = process.env.ANDROID_APP_SIGNING_SHA256;
    delete process.env.ANDROID_APP_SIGNING_SHA256;
    try {
      const unconfigured = await enroll(await owner());
      expect(unconfigured.done!.statusCode).toBe(503);
    } finally {
      process.env.ANDROID_APP_SIGNING_SHA256 = saved;
    }
  });
});

describe("13. hardware and per-use biometric policy (Android Key Attestation)", () => {
  const cases: Array<[string, Partial<KeyDescriptionInput> | null, ((c: string[]) => string[]) | null, RegExp]> = [
    ["software-backed key", { securityLevel: 0 }, null, /security_level_software/],
    ["no user authentication required", { noAuthRequired: true }, null, /no_user_auth/],
    ["user auth not biometric", { userAuthType: 1 }, null, /not_biometric_bound/],
    ["device credential (PIN) allowed as well", { userAuthType: 3 }, null, /auth_allows_device_credential/],
    ["authentication valid for a time window, not per use", { authTimeout: 30 }, null, /auth_not_per_use/],
    ["not a signing key", { purposes: [0] }, null, /not_a_signing_key/],
    ["not P-256", { ecCurve: 2 }, null, /not_p256/],
    ["key imported into the hardware, not generated there", { origin: 2 }, null, /key_not_generated_in_hardware/],
    ["key origin not attested by the hardware", { origin: null }, null, /key_not_generated_in_hardware/],
    ["attestation version older than Keymaster 4", { attestationVersion: 2 }, null, /attestation_version_too_old/],
    ["key created long before this enrollment began", { createdAt: Date.now() - 3600_000 }, null, /key_older_than_enrollment/],
    ["key creation time in the future", { createdAt: Date.now() + 3600_000 }, null, /key_created_in_future/],
    ["no key creation time", { createdAt: null }, null, /no_creation_time/],
    ["unlocked bootloader", { deviceLocked: false }, null, /unverified_boot/],
    ["unverified boot", { verifiedBootState: 2 }, null, /unverified_boot/],
    ["another app package", { packageName: "com.attacker.app" }, null, /wrong_package/],
    ["another app signing certificate", { signingCertSha256: "22".repeat(32) }, null, /wrong_app_signer/],
    ["chain to an untrusted root", null, (c) => {
      const other = testAttestationRoot();
      return [c[0]!, c[1]!, other.pem.replace(/-----[A-Z ]+-----|\s/g, "")];
    }, /chain_signature|untrusted_root/],
    ["truncated chain (leaf only)", null, (c) => [c[0]!], /chain_length/],
  ];
  for (const [label, kd, chain, reason] of cases) {
    it(`refuses: ${label}`, async () => {
      const o = await owner();
      const { done } = await enroll(o, { kd: kd ?? {}, chain: chain ?? undefined });
      expect(done!.statusCode, done!.body).toBe(403);
      expect(done!.json().message).toMatch(reason);
      expect((await status(o)).json().registered).toBe(false);
    });
  }

  it("refuses a leaf whose issuer signature is broken, and an intermediate that is not a CA", async () => {
    const o = await owner();
    const begun = await post("/v1/step-up/master-device/enrollment", o.session, {});
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = key.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const bound = await post("/v1/step-up/master-device/enrollment/key", o.session, { enrollment: begun.json().enrollment, public_key: spki });
    const challenge = Buffer.from(begun.json().attestation_challenge, "base64url");
    const base = {
      enrollment: bound.json().enrollment,
      public_key: spki,
      device_fingerprint: "trustid-device-broken-chain",
      signature: cryptoSign("sha256", Buffer.from(bound.json().signing_payload), key.privateKey).toString("base64url"),
    };
    for (const opts of [{ brokenSignature: true }, { intermediateNotCa: true }]) {
      const res = await post("/v1/step-up/master-device/enrollment/complete", o.session, {
        ...base,
        reauth: await enrollPasskey(o, bound.json().enrollment),
        attestation: attestationChain(root, key.publicKey, { challenge, signingCertSha256: APP_CERT }, opts),
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("StrongBox can be required by policy", async () => {
    process.env.ANDROID_ATTESTATION_MIN_LEVEL = "strongbox";
    try {
      expect((await enroll(await owner())).done!.statusCode).toBe(403);
      expect((await enroll(await owner(), { kd: { securityLevel: 2 } })).done!.statusCode).toBe(200);
    } finally {
      delete process.env.ANDROID_ATTESTATION_MIN_LEVEL;
    }
  });
});

describe("approvals with an enrolled Android Master Device", () => {
  async function enrolled() {
    const o = await owner();
    const r = await enroll(o);
    expect(r.done!.statusCode).toBe(200);
    return { o, phone: r.phone! };
  }
  const create = (accessToken: string, action = "mybrandos.likeness.approve") =>
    app.inject({
      method: "POST",
      url: "/v1/step-up/challenges",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { method: "master_device", action, operation_digest: digest(`op-${action}`), session_binding: digest("rp-session") },
    });
  async function pendingPayload(o: Owner, id: string) {
    const list = (await app.inject({ method: "GET", url: "/v1/step-up/pending", cookies: o.session })).json() as { challenges: Array<{ challenge_id: string; signing_payload: string }> };
    return list.challenges.find((c) => c.challenge_id === id)!.signing_payload;
  }

  it("approve, 9. invalid signature, 10. cross-application, 12. concurrent approvals, denial and expiry are audited", async () => {
    const { o, phone } = await enrolled();
    const tokens = await portalTokens(app, o.userId);
    const id = (await create(tokens.access_token)).json().challenge_id as string;
    const payload = await pendingPayload(o, id);
    expect(payload).toContain("action=mybrandos.likeness.approve");
    const bad = await post(`/v1/step-up/challenges/${id}/master-device/approve`, o.session, { device_fingerprint: phone.fingerprint, signature: cryptoSign("sha256", Buffer.from(payload.replace("likeness", "digitwin")), phone.privateKey).toString("base64url") });
    expect(bad.statusCode).toBe(401);
    const good = { device_fingerprint: phone.fingerprint, signature: cryptoSign("sha256", Buffer.from(payload), phone.privateKey).toString("base64url") };
    const results = await Promise.all([1, 2, 3].map(() => post(`/v1/step-up/challenges/${id}/master-device/approve`, o.session, good)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const adminTokens = await portalTokens(app, o.userId, { client: ADMIN });
    const foreign = await app.inject({ method: "POST", url: `/v1/step-up/challenges/${id}/consume`, headers: { authorization: `Bearer ${adminTokens.access_token}` }, payload: { session_binding: digest("rp-session"), operation_digest: digest("op-mybrandos.likeness.approve") } });
    expect(foreign.statusCode).toBe(404);

    const denyId = (await create(tokens.access_token, "mybrandos.digitwin.ask")).json().challenge_id as string;
    expect((await post(`/v1/step-up/challenges/${denyId}/deny`, o.session, {})).statusCode).toBe(200);
    const expireId = (await create(tokens.access_token, "mybrandos.digitwin.brief")).json().challenge_id as string;
    await prisma.stepUpChallenge.update({ where: { challengeId: expireId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await post(`/v1/step-up/challenges/${expireId}/master-device/approve`, o.session, good);
    expect(expired.statusCode).toBe(410);

    const types = (await prisma.auditEvent.findMany({ where: { userId: o.userId }, select: { type: true } })).map((e) => e.type);
    for (const t of ["step_up.approval_failed", "step_up.challenge_approved", "step_up.challenge_denied", "step_up.challenge_expired"]) expect(types).toContain(t);
    const activity = (await app.inject({ method: "GET", url: "/v1/step-up/master-device/activity", cookies: o.session })).json() as { events: Array<Record<string, unknown>> };
    expect(activity.events.some((e) => e.type === "step_up.challenge_denied" && e.action === "mybrandos.digitwin.ask")).toBe(true);
    // Only these fields leave the server: no addresses, user agents, keys, signatures or tokens.
    for (const e of activity.events) expect(Object.keys(e).sort()).toEqual(["action", "at", "client", "reason", "type"]);
    expect(JSON.stringify(activity)).not.toMatch(/d{1,3}(.d{1,3}){3}/);
    expect(PORTAL.clientId).toBeTruthy();
  });

  it("8. a revoked device cannot approve; revoke needs a passkey with UV", async () => {
    const { o, phone } = await enrolled();
    const tokens = await portalTokens(app, o.userId);
    const id = (await create(tokens.access_token)).json().challenge_id as string;
    const payload = await pendingPayload(o, id);
    expect((await revoke(o, { uv: false })).statusCode).toBe(401);
    expect((await revoke(o, { deviceKey: phone.privateKey })).statusCode).toBe(200);
    const res = await post(`/v1/step-up/challenges/${id}/master-device/approve`, o.session, { device_fingerprint: phone.fingerprint, signature: cryptoSign("sha256", Buffer.from(payload), phone.privateKey).toString("base64url") });
    expect([403, 409]).toContain(res.statusCode);
    expect((await prisma.stepUpChallenge.findUniqueOrThrow({ where: { challengeId: id } })).status).toBe("cancelled");
    // device in hand → a new device can be enrolled at once
    expect((await enroll(o)).done!.statusCode).toBe(200);
  });

  it("replacing a lost device needs recovery: a passkey-only revoke blocks re-enrollment", async () => {
    const { o } = await enrolled();
    const res = await revoke(o);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ revoked: true, recovery_required: true });
    const again = await post("/v1/step-up/master-device/enrollment", o.session, {});
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "master_device_recovery_required" });
    expect((await status(o)).json()).toMatchObject({ registered: false, recovery_required: true });
  });
});

describe("release-candidate hardening", () => {
  it("an approval no app has consumed yet dies with the revoked device", async () => {
    const o = await owner();
    const r = await enroll(o);
    expect(r.done!.statusCode).toBe(200);
    const phone = r.phone!;
    const tokens = await portalTokens(app, o.userId);
    const action = "mybrandos.likeness.approve";
    const created = await app.inject({
      method: "POST",
      url: "/v1/step-up/challenges",
      headers: { authorization: `Bearer ${tokens.access_token}` },
      payload: { method: "master_device", action, operation_digest: digest(`op-${action}`), session_binding: digest("rp-session") },
    });
    const id = created.json().challenge_id as string;
    const list = (await app.inject({ method: "GET", url: "/v1/step-up/pending", cookies: o.session })).json() as { challenges: Array<{ challenge_id: string; signing_payload: string }> };
    const payload = list.challenges.find((c) => c.challenge_id === id)!.signing_payload;
    const approved = await post(`/v1/step-up/challenges/${id}/master-device/approve`, o.session, {
      device_fingerprint: phone.fingerprint,
      signature: cryptoSign("sha256", Buffer.from(payload), phone.privateKey).toString("base64url"),
    });
    expect(approved.statusCode).toBe(200);
    // The owner revokes before the app consumed the approval (e.g. the phone was taken).
    expect((await revoke(o)).statusCode).toBe(200);
    const consume = await app.inject({
      method: "POST",
      url: `/v1/step-up/challenges/${id}/consume`,
      headers: { authorization: `Bearer ${tokens.access_token}` },
      payload: { session_binding: digest("rp-session"), operation_digest: digest(`op-${action}`) },
    });
    expect(consume.statusCode).toBe(409);
    expect((await prisma.stepUpChallenge.findUniqueOrThrow({ where: { challengeId: id } })).status).toBe("cancelled");
  });

  it("concurrent completions enroll at most one Master Device (same token, or two ceremonies from the same state)", async () => {
    const o = await owner();
    async function prepared() {
      const begun = await post("/v1/step-up/master-device/enrollment", o.session, {});
      const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const spki = key.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
      const bound = await post("/v1/step-up/master-device/enrollment/key", o.session, { enrollment: begun.json().enrollment, public_key: spki });
      expect(bound.statusCode).toBe(200);
      const chain = attestationChain(root, key.publicKey, { challenge: Buffer.from(begun.json().attestation_challenge, "base64url"), signingCertSha256: APP_CERT });
      const make = (fingerprint: string, reauth: unknown) => ({
        enrollment: bound.json().enrollment,
        public_key: spki,
        device_fingerprint: fingerprint,
        signature: cryptoSign("sha256", Buffer.from(bound.json().signing_payload, "utf8"), key.privateKey).toString("base64url"),
        reauth,
        attestation: chain,
      });
      return Object.assign(make, { enrollment: bound.json().enrollment as string });
    }
    const a = await prepared();
    const b = await prepared();
    const bodies = [
      a("trustid-device-race-a1", await enrollPasskey(o, a.enrollment)),
      a("trustid-device-race-a2", await enrollPasskey(o, a.enrollment)),
      b("trustid-device-race-b1", await enrollPasskey(o, b.enrollment)),
    ];
    const results = await Promise.all(bodies.map((body) => post("/v1/step-up/master-device/enrollment/complete", o.session, body)));
    expect(results.map((r) => r.statusCode).filter((c) => c === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.statusCode !== 200)) expect(r.statusCode).toBe(409);
    expect(await prisma.masterDevice.count({ where: { userId: o.userId, status: "active", isMasterDevice: true } })).toBe(1);
    // After revoking it, nothing is left that could still approve.
    expect((await revoke(o)).statusCode).toBe(200);
    expect((await status(o)).json().registered).toBe(false);
  });

  it("every payload the server asks the phone to sign fits the native signer's strict grammar (MasterDevicePrompt.kt)", async () => {
    // Mirror of apps/device/native/android/MasterDevicePlugin.kt MasterDevicePrompt: the plugin refuses anything else.
    const FORMATS: Record<string, string[]> = {
      "trustid-step-up/v1": ["challenge", "sub", "client", "action", "operation", "session", "device", "exp"],
      "trustid-master-device-enroll/v1": ["enrollment", "sub", "key", "exp"],
      "trustid-master-device-revoke/v2": ["sub", "device", "nonce", "exp"],
    };
    const signable = (payload: string) => {
      const lines = payload.split("\n");
      const keys = FORMATS[lines[0]!];
      return Boolean(keys) && payload.length <= 2048 && lines.length === keys!.length + 1 &&
        keys!.every((k, i) => lines[i + 1]!.startsWith(`${k}=`) && /^[A-Za-z0-9_.:@+/=-]{1,200}$/.test(lines[i + 1]!.slice(k.length + 1)));
    };
    const o = await owner();
    const begun = await post("/v1/step-up/master-device/enrollment", o.session, {});
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const bound = await post("/v1/step-up/master-device/enrollment/key", o.session, { enrollment: begun.json().enrollment, public_key: key.publicKey.export({ format: "der", type: "spki" }).toString("base64url") });
    expect(signable(bound.json().signing_payload)).toBe(true);
    const o2 = await owner();
    expect((await enroll(o2)).done!.statusCode).toBe(200);
    const tokens = await portalTokens(app, o2.userId);
    const created = await app.inject({
      method: "POST",
      url: "/v1/step-up/challenges",
      headers: { authorization: `Bearer ${tokens.access_token}` },
      payload: { method: "master_device", action: "users.role:write", operation_digest: digest("op"), session_binding: digest("rp-session") },
    });
    const list = (await app.inject({ method: "GET", url: "/v1/step-up/pending", cookies: o2.session })).json() as { challenges: Array<{ challenge_id: string; signing_payload: string }> };
    const stepUp = list.challenges.find((c) => c.challenge_id === created.json().challenge_id)!.signing_payload;
    expect(signable(stepUp)).toBe(true);
    const removal = await post("/v1/step-up/master-device/revoke/begin", o2.session, {});
    expect(signable(removal.json().signing_payload)).toBe(true);
    expect(signable("anything else")).toBe(false);
  });

  it("a WebAuthn challenge is consumed once even by concurrent requests", async () => {
    const o = await owner();
    const options = await post("/auth/webauthn/reauth/options", o.session, { userVerification: "required" });
    const challenge = options.json().challenge as string;
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => consumeWebAuthnChallenge({ challenge, purpose: "reauthentication", userId: o.userId })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("the attestation status list: every listed serial is untrusted (REVOKED and SUSPENDED); a malformed list fails closed", () => {
    const serials = revokedSerialsFromStatusList({
      entries: { "0A1b": { status: "REVOKED", reason: "KEY_COMPROMISE" }, c0ffee: { status: "SUSPENDED", reason: "SOFTWARE_FLAW" } },
    });
    expect(serials.has(normalizeSerial("0a1b"))).toBe(true);
    expect(serials.has("c0ffee")).toBe(true);
    expect(() => revokedSerialsFromStatusList({})).toThrow(/revocation_list_unavailable/);
    expect(() => revokedSerialsFromStatusList(null)).toThrow(/revocation_list_unavailable/);
  });
});

describe("operation-bound passkeys, single-use removal and attestation clocks", () => {
  async function prepared(o: Owner) {
    const begun = await post("/v1/step-up/master-device/enrollment", o.session, {});
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = key.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const bound = await post("/v1/step-up/master-device/enrollment/key", o.session, { enrollment: begun.json().enrollment, public_key: spki });
    return {
      key,
      enrollment: bound.json().enrollment as string,
      body: (reauth: unknown) => ({
        enrollment: bound.json().enrollment,
        public_key: spki,
        device_fingerprint: `trustid-device-${Math.random().toString(36).slice(2, 12)}`,
        signature: cryptoSign("sha256", Buffer.from(bound.json().signing_payload, "utf8"), key.privateKey).toString("base64url"),
        reauth,
        attestation: attestationChain(root, key.publicKey, { challenge: Buffer.from(begun.json().attestation_challenge, "base64url"), signingCertSha256: APP_CERT }),
      }),
    };
  }
  const complete = (o: Owner, body: unknown) => post("/v1/step-up/master-device/enrollment/complete", o.session, body);

  it("a generic Trust Center re-authentication cannot enroll or remove a Master Device", async () => {
    const o = await owner();
    const generic = async () => answer(o, (await post("/auth/webauthn/reauth/options", o.session, { userVerification: "required" })).json());
    const p = await prepared(o);
    const res = await complete(o, p.body(await generic()));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "reauthentication_failed" });
    expect((await complete(o, p.body(await enrollPasskey(o, p.enrollment)))).statusCode).toBe(200);
    const begun = (await post("/v1/step-up/master-device/revoke/begin", o.session, {})).json();
    const removal = await post("/v1/step-up/master-device/revoke", o.session, { revocation: begun.revocation, reauth: await generic() });
    expect(removal.statusCode).toBe(401);
    expect((await status(o)).json().registered).toBe(true);
  });

  it("a passkey made for one enrollment or removal is refused for another, and is not a generic re-authentication", async () => {
    const o = await owner();
    const a = await prepared(o);
    const b = await prepared(o);
    const forA = await enrollPasskey(o, a.enrollment);
    expect((await complete(o, b.body(forA))).statusCode).toBe(401);
    expect((await complete(o, a.body(forA))).statusCode).toBe(200);

    const r1 = (await post("/v1/step-up/master-device/revoke/begin", o.session, {})).json();
    const r2 = (await post("/v1/step-up/master-device/revoke/begin", o.session, {})).json();
    const forR1 = answer(o, r1.passkey_options);
    expect((await post("/v1/step-up/master-device/revoke", o.session, { revocation: r2.revocation, reauth: forR1 })).statusCode).toBe(401);
    // Bound challenges are never accepted by the generic re-authentication used elsewhere.
    await expect(verifyReauthentication({ userId: o.userId, response: forR1 as never })).rejects.toMatchObject({ statusCode: 400 });
    expect((await post("/v1/step-up/master-device/revoke", o.session, { revocation: r1.revocation, reauth: forR1 })).statusCode).toBe(200);
  });

  it("device removal signatures are single-use and expire; the old static payload is refused", async () => {
    const o = await owner();
    const r = await enroll(o);
    expect(r.done!.statusCode).toBe(200);
    const phone = r.phone!;
    const st = (await status(o)).json();

    const legacy = (await post("/v1/step-up/master-device/revoke/begin", o.session, {})).json();
    const staticSig = cryptoSign("sha256", Buffer.from(["trustid-master-device-revoke/v1", `sub=${o.trustId}`, `device=${st.device.id}`].join("\n")), phone.privateKey).toString("base64url");
    const refused = await post("/v1/step-up/master-device/revoke", o.session, { revocation: legacy.revocation, reauth: answer(o, legacy.passkey_options), device_signature: staticSig });
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ error: "invalid_signature" });

    const expiring = (await post("/v1/step-up/master-device/revoke/begin", o.session, {})).json();
    expect(expiring.signing_payload).toMatch(/^trustid-master-device-revoke\/v2\nsub=.+\ndevice=.+\nnonce=[A-Za-z0-9_-]{43}\nexp=\d{4}-/);
    const realNow = Date.now;
    Date.now = () => realNow() + 301_000;
    try {
      const late = await post("/v1/step-up/master-device/revoke", o.session, {
        revocation: expiring.revocation,
        reauth: answer(o, expiring.passkey_options),
        device_signature: cryptoSign("sha256", Buffer.from(expiring.signing_payload), phone.privateKey).toString("base64url"),
      });
      expect(late.statusCode).toBe(410);
      expect(late.json()).toMatchObject({ error: "revocation_expired" });
    } finally {
      Date.now = realNow;
    }

    const fresh = (await post("/v1/step-up/master-device/revoke/begin", o.session, {})).json();
    const body = {
      revocation: fresh.revocation,
      reauth: answer(o, fresh.passkey_options),
      device_signature: cryptoSign("sha256", Buffer.from(fresh.signing_payload), phone.privateKey).toString("base64url"),
    };
    expect((await post("/v1/step-up/master-device/revoke", o.session, body)).statusCode).toBe(200);
    expect((await post("/v1/step-up/master-device/revoke", o.session, body)).statusCode).not.toBe(200);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { userId: o.userId, type: "step_up.master_device_revoked" } });
    expect(JSON.parse(audit.metadata)).toMatchObject({ proof: "device_signature" });
  });

  it("certificate validity allows a bounded clock skew only", async () => {
    expect((await enroll(await owner(), { leafNotBefore: new Date(Date.now() + 120_000) })).done!.statusCode).toBe(200);
    const late = await enroll(await owner(), { leafNotBefore: new Date(Date.now() + 3600_000) });
    expect(late.done!.statusCode).toBe(403);
    expect(late.done!.json().message).toMatch(/certificate_validity_0/);
  });
});

describe("baseline", () => {
  it("17/16. legacy register still refuses signing keys; OIDC discovery and JWKS unaffected", async () => {
    const o = await owner();
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const legacy = await post("/v1/trust-id/master-device/register", o.session, { deviceFingerprint: "legacy-register-0001", publicKey: key });
    expect(legacy.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/.well-known/openid-configuration" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/.well-known/jwks.json" })).statusCode).toBe(200);
  });
});

describe("web orchestration (apps/web/src/lib/masterDeviceNative.ts) against the real API", () => {
  async function harness(o: Owner, opts: { tamperPayload?: boolean; failComplete?: boolean } = {}) {
    const { enrollAndroidMasterDevice } = await import("../../web/src/lib/masterDeviceNative.js");
    const keys = new Map<string, KeyObject>();
    const deleted: string[] = [];
    let active: string | null = null;
    const native = {
      getSupport: async () => ({ supported: true, sdk: 34, strongBiometric: true, activeAlias: active }),
      generateKey: async ({ attestationChallenge }: { attestationChallenge: string }) => {
        const k = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        const alias = `trustid_md_${keys.size + 1}`;
        keys.set(alias, k.privateKey);
        return {
          alias,
          publicKey: k.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
          attestation: attestationChain(root, k.publicKey, { challenge: Buffer.from(attestationChallenge, "base64url"), signingCertSha256: APP_CERT }),
          securityLevel: "tee",
        };
      },
      activateKey: async ({ alias }: { alias: string }) => void (active = alias),
      deleteKey: async ({ alias }: { alias?: string }) => void deleted.push(alias ?? "active"),
      sign: async ({ payload, alias }: { payload: string; alias?: string }) => ({
        signature: cryptoSign("sha256", Buffer.from(payload), keys.get(alias ?? active!)!).toString("base64url"),
      }),
    };
    const apiFn = async <T,>(path: string, init?: { method?: string; body?: string }) => {
      let body = init?.body ? JSON.parse(init.body) : undefined;
      if (opts.failComplete && path.endsWith("/complete")) body = { ...body, attestation: undefined };
      const res = await app.inject({ method: (init?.method ?? "GET") as "GET", url: path, cookies: o.session, payload: body });
      if (res.statusCode >= 400) throw Object.assign(new Error(res.json().message ?? res.body), { status: res.statusCode });
      const json = res.json() as T & { signing_payload?: string };
      if (opts.tamperPayload && json.signing_payload) json.signing_payload = json.signing_payload.replace(/sub=.*/, "sub=TD-SOMEONE-ELSE");
      return json as T;
    };
    const result = enrollAndroidMasterDevice({
      api: apiFn,
      native,
      passkey: async (options: unknown) => answer(o, options as { challenge: string }),
      trustId: o.trustId,
      deviceFingerprint: `trustid-device-${Math.random().toString(36).slice(2, 12)}`,
    });
    return { result, deleted, getActive: () => active };
  }

  it("enrolls end to end and keeps the key only after the server accepted it", async () => {
    const o = await owner();
    const h = await harness(o);
    const done = await h.result;
    expect(done).toMatchObject({ registered: true, securityLevel: "tee" });
    expect(h.getActive()).toBe("trustid_md_1");
    expect(h.deleted).toEqual([]);
    expect((await status(o)).json().registered).toBe(true);
  });

  it("refuses to sign enrollment bytes naming another subject, and deletes the pending key", async () => {
    const o = await owner();
    const h = await harness(o, { tamperPayload: true });
    await expect(h.result).rejects.toMatchObject({ code: "payload_mismatch" });
    expect(h.deleted).toEqual(["trustid_md_1"]);
    expect(h.getActive()).toBeNull();
  });

  it("deletes the pending key when the server refuses enrollment", async () => {
    const o = await owner();
    const h = await harness(o, { failComplete: true });
    await expect(h.result).rejects.toMatchObject({ status: 400 });
    expect(h.deleted).toEqual(["trustid_md_1"]);
    expect((await status(o)).json().registered).toBe(false);
  });
});
