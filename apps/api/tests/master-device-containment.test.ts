/**
 * Emergency containment of the Master Device trust boundary (security release on top of production).
 *
 * A session proves who is signed in; only an enrolled step-up Master Device key, proving possession
 * over a server-issued challenge, proves who may approve. These tests pin that boundary for the
 * legacy routes (/v1/trust-id/*) and the step-up v1 routes, with disposable data only.
 */
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { config } from "../src/lib/config.js";
import { deviceFingerprintHash } from "../src/lib/crypto.js";
import { LEGACY_MAX_PENDING_CHALLENGES, legacyChallengeSigningPayload } from "../src/modules/trust-id/challenges.js";
import { STEP_UP_MAX_PENDING_PER_CLIENT } from "../src/modules/step-up/service.js";
import { resetTables } from "./helpers/db.js";
import { ADMIN, PORTAL, digest, portalTokens, portalUser } from "./helpers/portal-oauth.js";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  await resetTables(prisma);
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const cookie = (token: string) => ({ [config.sessionCookieName]: token });
const sign = (key: KeyObject, payload: string) => cryptoSign("sha256", Buffer.from(payload, "utf8"), key).toString("base64url");

/** A Master Device as an Android Keystore phone holds one: P-256, DER signatures. */
async function withPhone(userId: string, fingerprint = "trustid-device-phone-0001") {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const row = await prisma.masterDevice.create({
    data: {
      userId,
      deviceFingerprint: deviceFingerprintHash(fingerprint),
      publicKey: new Uint8Array(publicKey.export({ format: "der", type: "spki" })),
      isMasterDevice: true,
      status: "active",
    },
  });
  return { row, privateKey, fingerprint, spki: publicKey.export({ format: "der", type: "spki" }).toString("base64url") };
}

async function signedIn() {
  const { user, sessionToken } = await portalUser();
  return { user, session: cookie(sessionToken) };
}

const post = (url: string, session: Record<string, string> | undefined, payload: unknown) =>
  app.inject({ method: "POST", url, ...(session ? { cookies: session } : {}), payload: payload as Record<string, unknown> });

async function issueLegacy(s: { user: { id: string }; session: Record<string, string> }, amount = 1) {
  const res = await post("/v1/trust-id/challenges/issue", s.session, { userId: s.user.id, action: "wallet_transfer", payload: { amountMinor: amount } });
  return { res, body: res.json() as { challengeId: string; signingPayload: string } };
}

describe("enrollment: a session alone cannot become an approval authority", () => {
  it("1. unauthenticated registration fails", async () => {
    const { spki } = await withPhone((await signedIn()).user.id, "unused-fp-000000001");
    const res = await post("/v1/trust-id/master-device/register", undefined, { deviceFingerprint: "attacker-device-0001", publicKey: spki });
    expect(res.statusCode).toBe(401);
  });

  it("2. an authenticated session cannot register a signing key through the legacy route", async () => {
    const s = await signedIn();
    const attacker = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const res = await post("/v1/trust-id/master-device/register", s.session, {
      deviceFingerprint: "attacker-device-0001",
      publicKey: attacker.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "master_device_enrollment_required" });
    expect(await prisma.masterDevice.count({ where: { userId: s.user.id } })).toBe(0);
    // ...so step-up has no device to bind a challenge to.
    const tokens = await portalTokens(app, s.user.id);
    const created = await app.inject({
      method: "POST",
      url: "/v1/step-up/challenges",
      headers: { authorization: `Bearer ${tokens.access_token}` },
      payload: { method: "master_device", action: "mybrandos.digitwin.brief", operation_digest: digest("op"), session_binding: digest("s") },
    });
    expect(created.statusCode).toBe(409);
  });

  it("2b. a session cannot overwrite or displace an enrolled phone's key", async () => {
    const s = await signedIn();
    const phone = await withPhone(s.user.id);
    const res = await post("/v1/trust-id/master-device/register", s.session, {
      deviceFingerprint: phone.fingerprint,
      publicKey: Buffer.from("placeholder-key-bytes-xx").toString("base64url"),
    });
    expect(res.statusCode).toBe(409);
    const row = await prisma.masterDevice.findUniqueOrThrow({ where: { id: phone.row.id } });
    expect(Buffer.from(row.publicKey).toString("base64url")).toBe(phone.spki);
  });
});

describe("legacy challenge issuance", () => {
  it("3. unauthenticated issuance fails; issuing for another owner fails; open requests are capped", async () => {
    const s = await signedIn();
    const other = await signedIn();
    expect((await post("/v1/trust-id/challenges/issue", undefined, { userId: s.user.id, action: "wallet_transfer" })).statusCode).toBe(401);
    expect((await post("/v1/trust-id/challenges/issue", s.session, { userId: other.user.id, action: "wallet_transfer" })).statusCode).toBe(403);
    for (let i = 0; i < LEGACY_MAX_PENDING_CHALLENGES; i++) expect((await issueLegacy(s, i)).res.statusCode).toBe(200);
    const capped = await issueLegacy(s, 99);
    expect(capped.res.statusCode).toBe(429);
    expect(capped.res.json()).toMatchObject({ error: "too_many_pending_challenges" });
    expect(await prisma.masterAuthChallenge.count({ where: { userId: other.user.id } })).toBe(0);
  });
});

describe("legacy challenge approval needs the enrolled key's signature over the issued challenge", () => {
  it("legitimate approval works once", async () => {
    const s = await signedIn();
    const phone = await withPhone(s.user.id);
    const { body } = await issueLegacy(s);
    expect(body.signingPayload).toBe(legacyChallengeSigningPayload(await prisma.masterAuthChallenge.findUniqueOrThrow({ where: { challengeId: body.challengeId } })));
    const ok = await post("/v1/trust-id/challenges/approve", s.session, { challengeId: body.challengeId, deviceFingerprint: phone.fingerprint, signature: sign(phone.privateKey, body.signingPayload) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "approved" });
    // 9. replay
    const again = await post("/v1/trust-id/challenges/approve", s.session, { challengeId: body.challengeId, deviceFingerprint: phone.fingerprint, signature: sign(phone.privateKey, body.signingPayload) });
    expect(again.statusCode).toBe(409);
  });

  it("4-6, 12. missing, invalid, foreign-key and modified-action signatures fail", async () => {
    const s = await signedIn();
    const phone = await withPhone(s.user.id);
    const { body } = await issueLegacy(s);
    const approve = (signature: string, fingerprint = phone.fingerprint) =>
      post("/v1/trust-id/challenges/approve", s.session, { challengeId: body.challengeId, deviceFingerprint: fingerprint, signature });
    expect((await approve("")).statusCode).toBe(400);
    expect((await approve("not-a-real-signature-at-all")).statusCode).toBe(401);
    const stranger = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    expect((await approve(sign(stranger.privateKey, body.signingPayload))).statusCode).toBe(401);
    expect((await approve(sign(phone.privateKey, body.signingPayload.replace("action=wallet_transfer", "action=settings_change")))).statusCode).toBe(401);
    expect((await approve(sign(phone.privateKey, body.signingPayload), "some-other-device-fp")).statusCode).toBe(403);
    const row = await prisma.masterAuthChallenge.findUniqueOrThrow({ where: { challengeId: body.challengeId } });
    expect(row.status).toBe("pending");
  });

  it("6b. another owner's enrolled device cannot approve this owner's challenge", async () => {
    const s = await signedIn();
    const other = await signedIn();
    await withPhone(s.user.id, "owner-phone-000000001");
    const otherPhone = await withPhone(other.user.id, "other-phone-000000001");
    const { body } = await issueLegacy(s);
    const res = await post("/v1/trust-id/challenges/approve", other.session, { challengeId: body.challengeId, deviceFingerprint: otherPhone.fingerprint, signature: sign(otherPhone.privateKey, body.signingPayload) });
    expect(res.statusCode).toBe(404);
  });

  it("7. a revoked Master Device cannot approve", async () => {
    const s = await signedIn();
    const phone = await withPhone(s.user.id);
    const { body } = await issueLegacy(s);
    await prisma.masterDevice.update({ where: { id: phone.row.id }, data: { status: "revoked", isMasterDevice: false } });
    const res = await post("/v1/trust-id/challenges/approve", s.session, { challengeId: body.challengeId, deviceFingerprint: phone.fingerprint, signature: sign(phone.privateKey, body.signingPayload) });
    expect(res.statusCode).toBe(403);
  });

  it("8. an expired challenge cannot be approved", async () => {
    const s = await signedIn();
    const phone = await withPhone(s.user.id);
    const { body } = await issueLegacy(s);
    await prisma.masterAuthChallenge.update({ where: { challengeId: body.challengeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await post("/v1/trust-id/challenges/approve", s.session, { challengeId: body.challengeId, deviceFingerprint: phone.fingerprint, signature: sign(phone.privateKey, body.signingPayload) });
    expect(res.statusCode).toBe(400);
  });

  it("13. concurrent double approval succeeds exactly once", async () => {
    const s = await signedIn();
    const phone = await withPhone(s.user.id);
    const { body } = await issueLegacy(s);
    const payload = { challengeId: body.challengeId, deviceFingerprint: phone.fingerprint, signature: sign(phone.privateKey, body.signingPayload) };
    const results = await Promise.all([1, 2, 3].map(() => post("/v1/trust-id/challenges/approve", s.session, payload)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
  });
});

describe("/v1/trust-id/master-device/verify", () => {
  it("needs a signature over an issued, pending challenge and uses it up; a signature over a chosen value is worthless", async () => {
    const s = await signedIn();
    const phone = await withPhone(s.user.id);
    const verify = (challengeId: string, signature: string) =>
      post("/v1/trust-id/master-device/verify", s.session, { challengeId, deviceFingerprint: phone.fingerprint, signature });
    // A captured signature over an arbitrary string no longer "verifies".
    expect((await verify("any-value-the-client-picks", sign(phone.privateKey, "any-value-the-client-picks"))).statusCode).toBe(404);
    const { body } = await issueLegacy(s);
    expect((await verify(body.challengeId, sign(phone.privateKey, body.challengeId))).statusCode).toBe(401);
    const good = sign(phone.privateKey, body.signingPayload);
    const ok = await verify(body.challengeId, good);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ verified: true });
    expect((await verify(body.challengeId, good)).statusCode).toBe(409);
  });
});

describe("step-up v1 (mybrandOS / Portal) with an enrolled phone", () => {
  const create = (accessToken: string, action = "mybrandos.digitwin.brief") =>
    app.inject({
      method: "POST",
      url: "/v1/step-up/challenges",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { method: "master_device", action, operation_digest: digest(`op-${action}`), session_binding: digest("session-1") },
    });

  it("legitimate approve; concurrent approvals win once; cross-application consume fails; pending cap", async () => {
    const s = await signedIn();
    const phone = await withPhone(s.user.id);
    const tokens = await portalTokens(app, s.user.id);
    const challenge = (await create(tokens.access_token)).json() as { challenge_id: string };
    const pending = (await app.inject({ method: "GET", url: "/v1/step-up/pending", cookies: s.session })).json() as { challenges: Array<{ challenge_id: string; signing_payload: string }> };
    const item = pending.challenges.find((c) => c.challenge_id === challenge.challenge_id)!;
    const body = { device_fingerprint: phone.fingerprint, signature: sign(phone.privateKey, item.signing_payload) };
    const approvals = await Promise.all([1, 2, 3].map(() => post(`/v1/step-up/challenges/${item.challenge_id}/master-device/approve`, s.session, body)));
    expect(approvals.filter((r) => r.statusCode === 200)).toHaveLength(1);

    // 10. a different application cannot consume it
    const adminTokens = await portalTokens(app, s.user.id, { client: ADMIN });
    const foreign = await app.inject({
      method: "POST",
      url: `/v1/step-up/challenges/${item.challenge_id}/consume`,
      headers: { authorization: `Bearer ${adminTokens.access_token}` },
      payload: { session_binding: digest("session-1"), operation_digest: digest("op-mybrandos.digitwin.brief") },
    });
    expect(foreign.statusCode).toBe(404);
    // 11. the same application with another session binding cannot either
    const crossSession = await app.inject({
      method: "POST",
      url: `/v1/step-up/challenges/${item.challenge_id}/consume`,
      headers: { authorization: `Bearer ${tokens.access_token}` },
      payload: { session_binding: digest("session-2"), operation_digest: digest("op-mybrandos.digitwin.brief") },
    });
    expect(crossSession.statusCode).toBe(403);

    // The approved challenge is no longer pending: open exactly the cap, then one more is refused.
    for (let i = 0; i < STEP_UP_MAX_PENDING_PER_CLIENT; i++) expect((await create(tokens.access_token, `mybrandos.digitwin.ask.${i}`)).statusCode).toBe(201);
    const capped = await create(tokens.access_token, "mybrandos.digitwin.ask.over");
    expect(capped.statusCode).toBe(429);
    expect(PORTAL.clientId).toBeTruthy();
  });
});
