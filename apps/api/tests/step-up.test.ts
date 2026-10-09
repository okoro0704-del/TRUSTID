/**
 * Gates 4-6: authenticated step-up (contract, Master Device, biometric).
 *
 * Real: Fastify app, Prisma (SQLite), OAuth code+PKCE token issuance, EdDSA
 * approval signing, ECDSA P-256 Master Device keys and signatures, 1:1 vector
 * matcher with the production threshold.
 * Mocked: only the PAD gate, and only in the "biometric matching logic" block,
 * to exercise matching behaviour that production keeps closed until PAD is
 * COMPLETE. No biometric hardware is involved.
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as jose from "jose";
import { SCOPES } from "@trustid/shared";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { config } from "../src/lib/config.js";
import { deviceFingerprintHash } from "../src/lib/crypto.js";
import { getJwks } from "../src/modules/verified-identity/assertions.js";
import { pgVectorMatcher } from "../src/modules/trust-id/vector-matcher.js";
import * as padPolicy from "../src/modules/step-up/pad-policy.js";
import { STEP_UP_APPROVAL_TYP } from "../src/modules/step-up/service.js";
import { resetTables } from "./helpers/db.js";
import { facePayload } from "./helpers/face.js";
import { ADMIN, PORTAL, digest, portalTokens, portalUser } from "./helpers/portal-oauth.js";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetTables(prisma);
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

const FINGERPRINT = "master-device-hardware-id-0001";
const SESSION_BINDING = digest("portal-session-abc");
const OPERATION = digest(JSON.stringify({ op: "domain.purchase", domain: "example.com", price: 12 }));

async function withMasterDevice(userId: string, fingerprint = FINGERPRINT) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ format: "der", type: "spki" });
  const row = await prisma.masterDevice.create({
    data: {
      userId,
      deviceFingerprint: deviceFingerprintHash(fingerprint),
      publicKey: spki,
      isMasterDevice: true,
      status: "active",
    },
  });
  const signer = (payload: string, encoding: "der" | "ieee-p1363" = "der") =>
    cryptoSign("sha256", Buffer.from(payload, "utf8"), { key: privateKey, dsaEncoding: encoding }).toString("base64url");
  return { row, signer };
}

/** A signed-in subject with a Portal access token and a TrustID session on the approving device. */
async function subject(opts: { scopes?: string[]; client?: typeof PORTAL } = {}) {
  const { user, sessionToken } = await portalUser();
  const tokens = await portalTokens(app, user.id, { scopes: opts.scopes, client: opts.client });
  return {
    user,
    accessToken: tokens.access_token,
    idToken: tokens.id_token!,
    session: { [config.sessionCookieName]: sessionToken },
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function create(accessToken: string, body: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: "/v1/step-up/challenges",
    headers: bearer(accessToken),
    payload: { method: "master_device", action: "domain.purchase", operation_digest: OPERATION, session_binding: SESSION_BINDING, ...body },
  });
}

async function pendingFor(session: Record<string, string>) {
  const res = await app.inject({ method: "GET", url: "/v1/step-up/pending", cookies: session });
  return (res.json() as { challenges: Array<{ challenge_id: string; signing_payload?: string }> }).challenges;
}

const approveMaster = (challengeId: string, session: Record<string, string>, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/v1/step-up/challenges/${challengeId}/master-device/approve`, cookies: session, payload: body });

const consume = (accessToken: string, challengeId: string, body: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: `/v1/step-up/challenges/${challengeId}/consume`,
    headers: bearer(accessToken),
    payload: { session_binding: SESSION_BINDING, operation_digest: OPERATION, ...body },
  });

describe("Gate 6: Master Device step-up end to end", () => {
  it("challenge -> signed approval -> one-time scoped approval token for that client and operation", async () => {
    const s = await subject();
    const { row: master, signer } = await withMasterDevice(s.user.id);

    const created = await create(s.accessToken);
    expect(created.statusCode).toBe(201);
    const challenge = created.json() as { challenge_id: string; status: string; expires_at: string };
    expect(challenge.status).toBe("pending");
    expect(challenge.challenge_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Date(challenge.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(120_000);

    const [pending] = await pendingFor(s.session);
    expect(pending!.challenge_id).toBe(challenge.challenge_id);
    const payload = pending!.signing_payload!;
    for (const part of [`challenge=${challenge.challenge_id}`, `sub=${s.user.trustId}`, `client=${PORTAL.clientId}`, "action=domain.purchase", `operation=${OPERATION}`, `device=${master.id}`]) {
      expect(payload).toContain(part);
    }

    const approved = await approveMaster(challenge.challenge_id, s.session, { device_fingerprint: FINGERPRINT, signature: signer(payload) });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "approved" });
    // Approval does not create a TrustID login session.
    expect(approved.headers["set-cookie"]).toBeUndefined();

    const consumed = await consume(s.accessToken, challenge.challenge_id);
    expect(consumed.statusCode).toBe(200);
    const { approval } = consumed.json() as { approval: string };
    const { payload: claims, protectedHeader } = await jose.jwtVerify(approval, jose.createLocalJWKSet(await getJwks()), {
      issuer: config.oidcIssuer,
      audience: PORTAL.clientId,
      typ: STEP_UP_APPROVAL_TYP,
    });
    expect(protectedHeader.typ).toBe(STEP_UP_APPROVAL_TYP);
    expect(claims).toMatchObject({
      sub: s.user.trustId,
      azp: PORTAL.clientId,
      jti: challenge.challenge_id,
      action: "domain.purchase",
      operation_digest: OPERATION,
      session_binding: SESSION_BINDING,
      method: "master_device",
      amr: ["hwk"],
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(60);

    // Replay: consumed once only.
    const replay = await consume(s.accessToken, challenge.challenge_id);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ error: "challenge_already_consumed" });
    // The approval is neither a session nor an access token.
    expect((await app.inject({ method: "GET", url: "/oauth/userinfo", headers: bearer(approval) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/step-up/pending", headers: bearer(approval) })).statusCode).toBe(401);
  });

  it("accepts raw r||s (P1363) signatures as well as DER", async () => {
    const s = await subject();
    const { signer } = await withMasterDevice(s.user.id);
    const { challenge_id } = (await create(s.accessToken)).json() as { challenge_id: string };
    const [pending] = await pendingFor(s.session);
    const res = await approveMaster(challenge_id, s.session, { device_fingerprint: FINGERPRINT, signature: signer(pending!.signing_payload!, "ieee-p1363") });
    expect(res.statusCode).toBe(200);
  });

  it("denies unsigned, invalid, wrong-payload, wrong-key and wrong-device signatures; denies after 3 failures", async () => {
    const s = await subject();
    const { signer } = await withMasterDevice(s.user.id);
    const { challenge_id } = (await create(s.accessToken)).json() as { challenge_id: string };
    const [pending] = await pendingFor(s.session);
    const payload = pending!.signing_payload!;

    const missing = await approveMaster(challenge_id, s.session, { device_fingerprint: FINGERPRINT });
    expect(missing.statusCode).toBe(400);

    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    const wrongKey = cryptoSign("sha256", Buffer.from(payload), other).toString("base64url");
    expect((await approveMaster(challenge_id, s.session, { device_fingerprint: FINGERPRINT, signature: wrongKey })).json()).toMatchObject({ error: "invalid_signature" });

    const wrongPayload = signer(payload.replace("action=domain.purchase", "action=domain.transfer"));
    expect((await approveMaster(challenge_id, s.session, { device_fingerprint: FINGERPRINT, signature: wrongPayload })).json()).toMatchObject({ error: "invalid_signature" });

    expect((await approveMaster(challenge_id, s.session, { device_fingerprint: "a-different-device-0002", signature: signer(payload) })).json()).toMatchObject({ error: "wrong_master_device" });

    // Three failures: the challenge is denied and a correct signature no longer approves it.
    const late = await approveMaster(challenge_id, s.session, { device_fingerprint: FINGERPRINT, signature: signer(payload) });
    expect(late.statusCode).toBe(409);
    const status = await app.inject({ method: "GET", url: `/v1/step-up/challenges/${challenge_id}`, headers: bearer(s.accessToken) });
    expect(status.json()).toMatchObject({ status: "denied" });
  });

  it("a signature for one challenge cannot approve another (replay across challenges)", async () => {
    const s = await subject();
    const { signer } = await withMasterDevice(s.user.id);
    const first = (await create(s.accessToken)).json() as { challenge_id: string };
    const second = (await create(s.accessToken)).json() as { challenge_id: string };
    const pending = await pendingFor(s.session);
    const firstPayload = pending.find((p) => p.challenge_id === first.challenge_id)!.signing_payload!;
    const res = await approveMaster(second.challenge_id, s.session, { device_fingerprint: FINGERPRINT, signature: signer(firstPayload) });
    expect(res.json()).toMatchObject({ error: "invalid_signature" });
  });

  it("no registered Master Device: the challenge cannot be created", async () => {
    const s = await subject();
    const res = await create(s.accessToken);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "master_device_not_registered" });
  });
});

describe("Gate 4: challenge binding and lifecycle", () => {
  async function approvedChallenge() {
    const s = await subject();
    const { signer } = await withMasterDevice(s.user.id);
    const { challenge_id } = (await create(s.accessToken)).json() as { challenge_id: string };
    const [pending] = await pendingFor(s.session);
    await approveMaster(challenge_id, s.session, { device_fingerprint: FINGERPRINT, signature: signer(pending!.signing_payload!) });
    return { s, challenge_id };
  }

  it("cross-user: another subject can neither see, approve, deny nor consume it", async () => {
    const { s, challenge_id } = await approvedChallenge();
    const mallory = await subject();
    const { signer } = await withMasterDevice(mallory.user.id, "mallory-device-0003");
    expect((await app.inject({ method: "GET", url: `/v1/step-up/challenges/${challenge_id}`, headers: bearer(mallory.accessToken) })).statusCode).toBe(404);
    expect((await consume(mallory.accessToken, challenge_id)).statusCode).toBe(404);
    expect((await approveMaster(challenge_id, mallory.session, { device_fingerprint: "mallory-device-0003", signature: signer("x") })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/v1/step-up/challenges/${challenge_id}/deny`, cookies: mallory.session })).statusCode).toBe(404);
    expect(await pendingFor(mallory.session)).toEqual([]);
    expect((await consume(s.accessToken, challenge_id)).statusCode).toBe(200);
  });

  it("cross-client: another Portal client of the same subject cannot see or consume it", async () => {
    const { s, challenge_id } = await approvedChallenge();
    const adminTokens = await portalTokens(app, s.user.id, { client: ADMIN });
    expect((await consume(adminTokens.access_token, challenge_id)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/step-up/challenges/${challenge_id}`, headers: bearer(adminTokens.access_token) })).statusCode).toBe(404);
  });

  it("cross-session: a different access token, client session binding or operation cannot consume it", async () => {
    const { s, challenge_id } = await approvedChallenge();
    const otherToken = await portalTokens(app, s.user.id);
    expect((await consume(otherToken.access_token, challenge_id)).json()).toMatchObject({ error: "session_binding_mismatch" });
    expect((await consume(s.accessToken, challenge_id, { session_binding: digest("another-portal-session") })).json()).toMatchObject({ error: "session_binding_mismatch" });
    expect((await consume(s.accessToken, challenge_id, { operation_digest: digest("a different operation") })).json()).toMatchObject({ error: "operation_mismatch" });
    // The failed attempts did not use it up.
    expect((await consume(s.accessToken, challenge_id)).statusCode).toBe(200);
  });

  it("pending challenges cannot be consumed; expired ones cannot be approved or consumed", async () => {
    const s = await subject();
    const { signer } = await withMasterDevice(s.user.id);
    const { challenge_id } = (await create(s.accessToken)).json() as { challenge_id: string };
    expect((await consume(s.accessToken, challenge_id)).json()).toMatchObject({ error: "challenge_not_approved" });
    const [pending] = await pendingFor(s.session);
    await prisma.stepUpChallenge.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const late = await approveMaster(challenge_id, s.session, { device_fingerprint: FINGERPRINT, signature: signer(pending!.signing_payload!) });
    expect(late.statusCode).toBe(410);
    expect(late.json()).toMatchObject({ error: "challenge_expired" });
    expect(await pendingFor(s.session)).toEqual([]);
  });

  it("an approval expires too: consume after expiry fails", async () => {
    const { s, challenge_id } = await approvedChallenge();
    await prisma.stepUpChallenge.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await consume(s.accessToken, challenge_id)).json()).toMatchObject({ error: "challenge_not_approved" });
  });

  it("cancel (client) and deny (subject) are final", async () => {
    const s = await subject();
    const { signer } = await withMasterDevice(s.user.id);
    const a = (await create(s.accessToken)).json() as { challenge_id: string };
    const b = (await create(s.accessToken)).json() as { challenge_id: string };
    const pending = await pendingFor(s.session);
    const cancelled = await app.inject({ method: "POST", url: `/v1/step-up/challenges/${a.challenge_id}/cancel`, headers: bearer(s.accessToken) });
    expect(cancelled.json()).toMatchObject({ status: "cancelled" });
    const payloadA = pending.find((p) => p.challenge_id === a.challenge_id)!.signing_payload!;
    expect((await approveMaster(a.challenge_id, s.session, { device_fingerprint: FINGERPRINT, signature: signer(payloadA) })).statusCode).toBe(409);
    const denied = await app.inject({ method: "POST", url: `/v1/step-up/challenges/${b.challenge_id}/deny`, cookies: s.session });
    expect(denied.json()).toMatchObject({ status: "denied" });
    expect((await consume(s.accessToken, b.challenge_id)).json()).toMatchObject({ error: "challenge_not_approved" });
  });

  it("requires the identity.step_up scope and a real OAuth access token; approval requires a TrustID session", async () => {
    const noScope = await subject({ scopes: [SCOPES.OPENID, SCOPES.IDENTITY_BASIC] });
    await withMasterDevice(noScope.user.id);
    // Portal clients may hold the scope, but this token was not granted it.
    const tokenScopes = (await prisma.oAuthAccessToken.findFirst({ where: { userId: noScope.user.id } }))!.scopes;
    expect(JSON.parse(tokenScopes)).not.toContain(SCOPES.IDENTITY_STEP_UP);
    expect((await create(noScope.accessToken)).json()).toMatchObject({ error: "insufficient_scope" });

    const s = await subject();
    await withMasterDevice(s.user.id, "fp-0004");
    expect((await create(s.idToken)).statusCode).toBe(401);
    const sessionTokenAsBearer = s.session[config.sessionCookieName]!;
    expect((await create(sessionTokenAsBearer)).statusCode).toBe(401);
    const { challenge_id } = (await create(s.accessToken)).json() as { challenge_id: string };
    const viaOAuth = await app.inject({
      method: "POST",
      url: `/v1/step-up/challenges/${challenge_id}/master-device/approve`,
      headers: bearer(s.accessToken),
      payload: { device_fingerprint: "fp-0004", signature: "AAAAAAAAAAAA" },
    });
    expect(viaOAuth.statusCode).toBe(401);
  });

  it("validates action, digests, ttl and unknown fields", async () => {
    const s = await subject();
    await withMasterDevice(s.user.id);
    for (const bad of [{ action: "Domain Purchase" }, { operation_digest: "short" }, { session_binding: "raw-session-id" }, { ttl_seconds: 5 }, { ttl_seconds: 3600 }, { method: "password" }, { extra: 1 }]) {
      expect((await create(s.accessToken, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await app.inject({ method: "GET", url: "/v1/step-up/challenges/not-a-challenge", headers: bearer(s.accessToken) })).statusCode).toBe(404);
  });

  it("challenge ids are unpredictable and unique", async () => {
    const s = await subject();
    await withMasterDevice(s.user.id);
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) ids.add(((await create(s.accessToken)).json() as { challenge_id: string }).challenge_id);
    expect(ids.size).toBe(20);
  });
});

describe("Gate 5: biometric step-up", () => {
  async function biometricSubject() {
    const s = await subject();
    await pgVectorMatcher.enrollEmbedding({ userId: s.user.id, trustId: s.user.trustId, biometric: facePayload(11) });
    const created = await create(s.accessToken, { method: "biometric" });
    expect(created.statusCode).toBe(201);
    return { s, challengeId: (created.json() as { challenge_id: string }).challenge_id };
  }
  const verifyFace = (challengeId: string, session: Record<string, string>, biometric: unknown) =>
    app.inject({ method: "POST", url: `/v1/step-up/challenges/${challengeId}/biometric/verify`, cookies: session, payload: { biometric } });

  it("production: fails closed while PAD is INCOMPLETE, even for the right face", async () => {
    expect(padPolicy.biometricStepUpPadReady()).toBe(false);
    const { s, challengeId } = await biometricSubject();
    const res = await verifyFace(challengeId, s.session, facePayload(11));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "step_up_pad_unavailable" });
    expect((await consume(s.accessToken, challengeId)).json()).toMatchObject({ error: "challenge_not_approved" });
  });

  it("no enrolled face: the challenge cannot be created", async () => {
    const s = await subject();
    expect((await create(s.accessToken, { method: "biometric" })).json()).toMatchObject({ error: "biometric_not_enrolled" });
  });

  describe("matching logic (PAD gate mocked open; production keeps it closed)", () => {
    beforeEach(() => {
      vi.spyOn(padPolicy, "biometricStepUpPadReady").mockReturnValue(true);
    });

    it("the same subject's face approves; the approval records PAD and threshold assurance", async () => {
      const { s, challengeId } = await biometricSubject();
      const res = await verifyFace(challengeId, s.session, facePayload(11));
      expect(res.statusCode).toBe(200);
      const { approval } = (await consume(s.accessToken, challengeId)).json() as { approval: string };
      const claims = jose.decodeJwt(approval);
      expect(claims).toMatchObject({ method: "biometric", amr: ["face"], assurance: { pad: "INCOMPLETE", threshold: "UNCALIBRATED" } });
    });

    it("another person's face never approves, even if that person is enrolled (no 1:N)", async () => {
      const { s, challengeId } = await biometricSubject();
      const other = await portalUser();
      await pgVectorMatcher.enrollEmbedding({ userId: other.user.id, trustId: other.user.trustId, biometric: facePayload(14) });
      const res = await verifyFace(challengeId, s.session, facePayload(14));
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: "biometric_no_match" });
      // And the other person's own session cannot touch this subject's challenge.
      expect((await verifyFace(challengeId, { [config.sessionCookieName]: other.sessionToken }, facePayload(14))).statusCode).toBe(404);
    });

    it("three no-matches deny the challenge", async () => {
      const { s, challengeId } = await biometricSubject();
      for (let i = 0; i < 3; i++) expect((await verifyFace(challengeId, s.session, facePayload(50 + i))).statusCode).toBe(401);
      expect((await verifyFace(challengeId, s.session, facePayload(11))).statusCode).toBe(409);
    });

    it("malformed proof, wrong model and an unavailable matcher never approve (and are not no-matches)", async () => {
      const { s, challengeId } = await biometricSubject();
      expect((await verifyFace(challengeId, s.session, { modality: "face", vector: [0.1, 0.2] })).statusCode).toBe(400);
      expect((await verifyFace(challengeId, s.session, facePayload(11, { modelVersion: 999 }))).statusCode).toBe(422);
      vi.spyOn(pgVectorMatcher, "verifyOneToOne").mockRejectedValueOnce(new Error("pgvector down"));
      const down = await verifyFace(challengeId, s.session, facePayload(11));
      expect(down.statusCode).toBe(503);
      expect(down.json()).toMatchObject({ error: "biometric_service_unavailable" });
      // None of those counted against the subject: the right face still approves.
      expect((await verifyFace(challengeId, s.session, facePayload(11))).statusCode).toBe(200);
    });

    it("an expired challenge cannot be approved; a consumed one cannot be replayed", async () => {
      const { s, challengeId } = await biometricSubject();
      expect((await verifyFace(challengeId, s.session, facePayload(11))).statusCode).toBe(200);
      expect((await consume(s.accessToken, challengeId)).statusCode).toBe(200);
      expect((await verifyFace(challengeId, s.session, facePayload(11))).statusCode).toBe(409);
      const second = await create(s.accessToken, { method: "biometric" });
      const id2 = (second.json() as { challenge_id: string }).challenge_id;
      await prisma.stepUpChallenge.updateMany({ where: { challengeId: id2 }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await verifyFace(id2, s.session, facePayload(11))).statusCode).toBe(410);
    });
  });
});
