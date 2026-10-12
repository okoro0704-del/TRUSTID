/**
 * Step-up Master Device enrollment, revocation and the Trust Center signing client.
 *
 * Real: Fastify app, Prisma, OAuth tokens, the Trust Center's WebCrypto signing module
 * (apps/web/src/lib/masterDeviceCrypto.ts, non-extractable P-256 keys, P1363 signatures).
 * Mocked: only the passkey assertion check (verifyReauthentication), which needs a real
 * authenticator; "reauth: { ok: true }" stands for a valid assertion, anything else fails.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { config } from "../src/lib/config.js";
import { registerMasterDevice } from "../src/modules/trust-id/master-device.js";
import { bindMasterDeviceForUser } from "../src/modules/trust-id/register.js";
import { createSession } from "../src/modules/sessions/service.js";
import {
  assertStepUpPayloadMatches,
  generateDeviceKey,
  newDeviceFingerprint,
  revokePayload,
  signPayload,
} from "../../web/src/lib/masterDeviceCrypto.js";
import { resetTables } from "./helpers/db.js";
import { PORTAL, digest, portalTokens, portalUser } from "./helpers/portal-oauth.js";

vi.mock("../src/modules/authentication/webauthn.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/modules/authentication/webauthn.js")>();
  return {
    ...original,
    verifyReauthentication: vi.fn(async (input: { response?: { ok?: boolean } }) => {
      if (input.response?.ok !== true) throw Object.assign(new Error("Re-authentication failed"), { statusCode: 401 });
      return { ok: true };
    }),
  };
});

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  await resetTables(prisma);
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const PASSKEY = { ok: true };
const cookie = (token: string) => ({ [config.sessionCookieName]: token });

async function signedIn() {
  const { user, sessionToken } = await portalUser();
  return { user, session: cookie(sessionToken) };
}

const status = (session: Record<string, string>) =>
  app.inject({ method: "GET", url: "/v1/step-up/master-device", cookies: session });

const begin = (session: Record<string, string>, publicKey: string) =>
  app.inject({ method: "POST", url: "/v1/step-up/master-device/enrollment", cookies: session, payload: { public_key: publicKey } });

const complete = (session: Record<string, string>, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/v1/step-up/master-device/enrollment/complete", cookies: session, payload: body });

/** The Trust Center enrollment as the browser performs it. */
async function enroll(session: Record<string, string>, opts: { reauth?: unknown } = {}) {
  const key = await generateDeviceKey();
  const begun = await begin(session, key.publicKeySpki);
  expect(begun.statusCode).toBe(200);
  const { enrollment, signing_payload } = begun.json() as { enrollment: string; signing_payload: string };
  const deviceFingerprint = newDeviceFingerprint();
  const body = {
    enrollment,
    public_key: key.publicKeySpki,
    device_fingerprint: deviceFingerprint,
    signature: await signPayload(key.privateKey, signing_payload),
    reauth: opts.reauth ?? PASSKEY,
  };
  return { key, deviceFingerprint, body, res: await complete(session, body) };
}

const revoke = (session: Record<string, string>, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/v1/step-up/master-device/revoke", cookies: session, payload: body });

async function createChallenge(accessToken: string) {
  return app.inject({
    method: "POST",
    url: "/v1/step-up/challenges",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      method: "master_device",
      action: "portal.post.v1.admin.installs.purge.failed",
      operation_digest: digest("purge-failed"),
      session_binding: digest("portal-session"),
    },
  });
}

describe("what counts as a step-up Master Device", () => {
  it("a terminal binding with a placeholder key is not registered and cannot receive challenges", async () => {
    const s = await signedIn();
    await registerMasterDevice({
      userId: s.user.id,
      deviceFingerprint: "terminal-install-0001",
      publicKey: createHash("sha256").update("trustid-master-bind:terminal").digest("base64url"),
    });
    expect((await status(s.session)).json()).toMatchObject({ registered: false, device: null });
    const tokens = await portalTokens(app, s.user.id);
    const res = await createChallenge(tokens.access_token);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "master_device_not_registered" });
  });
});

describe("enrollment ceremony", () => {
  it("enrolls a non-extractable WebCrypto key with proof of possession and a passkey, then approves end to end", async () => {
    const s = await signedIn();
    const { key, deviceFingerprint, res } = await enroll(s.session);
    expect(key.privateKey.extractable).toBe(false);
    expect(res.statusCode, res.body).toBe(200);
    const st = (await status(s.session)).json() as { registered: boolean; device: { id: string; key_thumbprint: string } };
    expect(st.registered).toBe(true);

    const tokens = await portalTokens(app, s.user.id);
    const created = await createChallenge(tokens.access_token);
    expect(created.statusCode).toBe(201);
    const pending = (await app.inject({ method: "GET", url: "/v1/step-up/pending", cookies: s.session })).json() as {
      challenges: Array<{ challenge_id: string; action: string; expires_at: string; method: string; client_name: string; signing_payload: string }>;
    };
    const [req] = pending.challenges;
    expect(req!.client_name).toBe(PORTAL.name);
    // The page checks the bytes describe exactly the displayed request before it signs.
    assertStepUpPayloadMatches(req!.signing_payload, req!, { trustId: s.user.trustId, masterDeviceId: st.device.id });
    const approved = await app.inject({
      method: "POST",
      url: `/v1/step-up/challenges/${req!.challenge_id}/master-device/approve`,
      cookies: s.session,
      payload: { device_fingerprint: deviceFingerprint, signature: await signPayload(key.privateKey, req!.signing_payload) },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "approved" });
    // A click alone (no valid signature) never approves.
    const second = await createChallenge(tokens.access_token);
    const unsigned = await app.inject({
      method: "POST",
      url: `/v1/step-up/challenges/${second.json().challenge_id}/master-device/approve`,
      cookies: s.session,
      payload: { device_fingerprint: deviceFingerprint, signature: "clicked-approve" },
    });
    expect(unsigned.statusCode).toBe(401);
  });

  it("requires the passkey re-authentication", async () => {
    const s = await signedIn();
    const { res } = await enroll(s.session, { reauth: { ok: false } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "reauthentication_failed" });
    expect((await status(s.session)).json()).toMatchObject({ registered: false });
  });

  it("requires a signature by the enrolled key itself (proof of possession)", async () => {
    const s = await signedIn();
    const key = await generateDeviceKey();
    const other = await generateDeviceKey();
    const { enrollment, signing_payload } = (await begin(s.session, key.publicKeySpki)).json();
    const res = await complete(s.session, {
      enrollment,
      public_key: key.publicKeySpki,
      device_fingerprint: newDeviceFingerprint(),
      signature: await signPayload(other.privateKey, signing_payload),
      reauth: PASSKEY,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "invalid_signature" });
    // ...and the token cannot be reused for a different key.
    const swapped = await complete(s.session, {
      enrollment,
      public_key: other.publicKeySpki,
      device_fingerprint: newDeviceFingerprint(),
      signature: await signPayload(other.privateKey, signing_payload),
      reauth: PASSKEY,
    });
    expect(swapped.statusCode).toBe(400);
  });

  it("rejects non-P-256 keys", async () => {
    const s = await signedIn();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    expect((await begin(s.session, rsa)).statusCode).toBe(400);
  });

  it("is bound to the TrustID session that began it", async () => {
    const s = await signedIn();
    const { token: otherToken } = await createSession({ userId: s.user.id });
    const key = await generateDeviceKey();
    const { enrollment, signing_payload } = (await begin(s.session, key.publicKeySpki)).json();
    const res = await complete(cookie(otherToken), {
      enrollment,
      public_key: key.publicKeySpki,
      device_fingerprint: newDeviceFingerprint(),
      signature: await signPayload(key.privateKey, signing_payload),
      reauth: PASSKEY,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "enrollment_session_mismatch" });
  });

  it("rejects tampered and expired tokens, and cannot be replayed", async () => {
    const s = await signedIn();
    const key = await generateDeviceKey();
    const { enrollment, signing_payload } = (await begin(s.session, key.publicKeySpki)).json();
    const body = {
      enrollment,
      public_key: key.publicKeySpki,
      device_fingerprint: newDeviceFingerprint(),
      signature: await signPayload(key.privateKey, signing_payload),
      reauth: PASSKEY,
    };
    const [claims, mac] = enrollment.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(claims, "base64url").toString()), exp: 9_999_999_999 })).toString("base64url");
    expect((await complete(s.session, { ...body, enrollment: `${forged}.${mac}` })).statusCode).toBe(400);

    vi.useFakeTimers({ now: Date.now() + 301_000, toFake: ["Date"] });
    try {
      expect((await complete(s.session, body)).statusCode).toBe(410);
    } finally {
      vi.useRealTimers();
    }
    expect((await complete(s.session, body)).statusCode).toBe(200);
    const replay = await complete(s.session, body);
    expect(replay.statusCode).toBe(409);
  });

  it("refuses a second device while one is enrolled", async () => {
    const s = await signedIn();
    expect((await enroll(s.session)).res.statusCode).toBe(200);
    const key = await generateDeviceKey();
    const res = await begin(s.session, key.publicKeySpki);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "master_device_already_enrolled" });
  });
});

describe("revocation", () => {
  it("signed by the device itself: re-enrollment is immediate and pending challenges are cancelled", async () => {
    const s = await signedIn();
    const { key } = await enroll(s.session);
    const st = (await status(s.session)).json() as { device: { id: string } };
    const tokens = await portalTokens(app, s.user.id);
    const pendingChallenge = (await createChallenge(tokens.access_token)).json() as { challenge_id: string };

    const res = await revoke(s.session, {
      reauth: PASSKEY,
      device_signature: await signPayload(key.privateKey, revokePayload(s.user.trustId, st.device.id)),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ revoked: true, enrollment_available_at: null });
    const challenge = await prisma.stepUpChallenge.findUnique({ where: { challengeId: pendingChallenge.challenge_id } });
    expect(challenge!.status).toBe("cancelled");
    expect((await enroll(s.session)).res.statusCode).toBe(200);
  });

  it("without the device (lost): passkey only, and re-enrollment waits 24 hours", async () => {
    const s = await signedIn();
    await enroll(s.session);
    const noPasskey = await revoke(s.session, { reauth: { ok: false } });
    expect(noPasskey.statusCode).toBe(401);
    expect(noPasskey.json()).toMatchObject({ error: "reauthentication_failed" });
    const res = await revoke(s.session, { reauth: PASSKEY });
    expect(res.statusCode).toBe(200);
    expect(res.json().enrollment_available_at).toBeTruthy();
    const alerts = await prisma.securityNotification.findMany({ where: { userId: s.user.id }, select: { type: true } });
    expect(alerts.map((n) => n.type)).toEqual(expect.arrayContaining(["master_device_enrolled", "master_device_revoked"]));
    const key = await generateDeviceKey();
    const blocked = await begin(s.session, key.publicKeySpki);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "master_device_enrollment_cooldown" });
    expect((await status(s.session)).json().enrollment_available_at).toBeTruthy();
  });

  it("a forged device signature does not count as possession", async () => {
    const s = await signedIn();
    await enroll(s.session);
    const st = (await status(s.session)).json() as { device: { id: string } };
    const stranger = await generateDeviceKey();
    const res = await revoke(s.session, {
      reauth: PASSKEY,
      device_signature: await signPayload(stranger.privateKey, revokePayload(s.user.trustId, st.device.id)),
    });
    expect(res.statusCode).toBe(401);
    expect((await status(s.session)).json()).toMatchObject({ registered: true });
  });
});

describe("legacy binding paths cannot install or displace a step-up key", () => {
  it("POST /v1/trust-id/master-device/register refuses a P-256 key (enrollment ceremony only)", async () => {
    const s = await signedIn();
    const key = await generateDeviceKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/trust-id/master-device/register",
      cookies: s.session,
      payload: { deviceFingerprint: "legacy-register-fp-0001", publicKey: key.publicKeySpki },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "master_device_enrollment_required" });
    expect((await status(s.session)).json()).toMatchObject({ registered: false });
  });

  it("a terminal re-bind neither overwrites nor supersedes the enrolled key", async () => {
    const s = await signedIn();
    const { deviceFingerprint } = await enroll(s.session);
    await expect(
      registerMasterDevice({ userId: s.user.id, deviceFingerprint, publicKey: Buffer.from("placeholder-key-bytes").toString("base64url") }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await bindMasterDeviceForUser({ userId: s.user.id, deviceFingerprint: "another-terminal-install-0002" });
    expect((await status(s.session)).json()).toMatchObject({ registered: true });
  });
});

describe("Trust Center payload check", () => {
  it("refuses to sign a payload that differs from the displayed request", () => {
    const exp = new Date(Date.now() + 60_000).toISOString();
    const payload = ["trustid-step-up/v1", "challenge=C1", "sub=TD-1", "client=lifeos_platform_admin_public", "action=portal.post.x", "operation=op", "session=ses", "device=D1", `exp=${exp}`].join("\n");
    const shown = { challenge_id: "C1", action: "portal.post.x", expires_at: exp, method: "master_device" };
    const expected = { trustId: "TD-1", masterDeviceId: "D1" };
    expect(() => assertStepUpPayloadMatches(payload, shown, expected)).not.toThrow();
    expect(() => assertStepUpPayloadMatches(payload, { ...shown, action: "portal.post.y" }, expected)).toThrow(/action/);
    expect(() => assertStepUpPayloadMatches(payload, { ...shown, challenge_id: "C2" }, expected)).toThrow(/challenge/);
    expect(() => assertStepUpPayloadMatches(payload, shown, { ...expected, masterDeviceId: "D2" })).toThrow(/device/);
    expect(() => assertStepUpPayloadMatches(payload, shown, { ...expected, trustId: "TD-2" })).toThrow(/subject/);
    expect(() => assertStepUpPayloadMatches(payload, { ...shown, method: "biometric" }, expected)).toThrow(/method/);
    expect(() => assertStepUpPayloadMatches(payload, shown, expected, new Date(Date.now() + 120_000))).toThrow(/expired/);
    expect(() => assertStepUpPayloadMatches(`${payload}\naction=portal.post.y`, shown, expected)).toThrow(/Malformed/);
  });
});

describe("legacy challenge routes", () => {
  it("issuing a challenge needs a session, and only for yourself", async () => {
    const s = await signedIn();
    const other = await signedIn();
    const body = { userId: other.user.id, action: "wallet_transfer", payload: { amountMinor: 1 } };
    const anonymous = await app.inject({ method: "POST", url: "/v1/trust-id/challenges/issue", payload: body });
    expect(anonymous.statusCode).toBe(401);
    const forSomeoneElse = await app.inject({ method: "POST", url: "/v1/trust-id/challenges/issue", cookies: s.session, payload: body });
    expect(forSomeoneElse.statusCode).toBe(403);
    expect(await prisma.masterAuthChallenge.count()).toBe(0);
    const own = await app.inject({ method: "POST", url: "/v1/trust-id/challenges/issue", cookies: other.session, payload: body });
    expect(own.statusCode).toBe(200);
  });

  it("approving needs the enrolled device's signature over the challenge; a bare request does nothing", async () => {
    const s = await signedIn();
    const { key, deviceFingerprint } = await enroll(s.session);
    const issued = (
      await app.inject({
        method: "POST",
        url: "/v1/trust-id/challenges/issue",
        cookies: s.session,
        payload: { userId: s.user.id, action: "wallet_transfer", payload: { amountMinor: 5 } },
      })
    ).json() as { challengeId: string; signingPayload: string };
    const approve = (body: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/v1/trust-id/challenges/approve", cookies: s.session, payload: { challengeId: issued.challengeId, ...body } });
    expect((await approve({ deviceFingerprint, signature: "not-a-real-signature-at-all" })).statusCode).toBe(401);
    expect((await approve({ deviceFingerprint: "some-other-device-fp", signature: await signPayload(key.privateKey, issued.signingPayload) })).statusCode).toBe(403);
    const ok = await approve({ deviceFingerprint, signature: await signPayload(key.privateKey, issued.signingPayload) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "approved" });
  });

  it("/master-device/verify reports verified only for a valid signature by the enrolled key", async () => {
    const s = await signedIn();
    const { key, deviceFingerprint } = await enroll(s.session);
    const verify = (signature: string) =>
      app.inject({ method: "POST", url: "/v1/trust-id/master-device/verify", cookies: s.session, payload: { deviceFingerprint, challengeId: "legacy-challenge-1", signature } });
    expect((await verify("not-a-real-signature-at-all")).statusCode).toBe(401);
    const ok = await verify(await signPayload(key.privateKey, "legacy-challenge-1"));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ verified: true });
  });
});
