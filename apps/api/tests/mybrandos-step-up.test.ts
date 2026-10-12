/**
 * mybrandOS as a step-up relying party: every Digi Twin request and every AI likeness consent is
 * authorized by the person with a Trust ID step-up. Real app, real token endpoint, real step-up
 * service; Master Device approval with a real P-256 key.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPES } from "@trustid/shared";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/db/client.js";
import { MYBRANDOS_SCOPES, bootstrapOAuthApplications } from "../src/lib/bootstrap-oauth-apps.js";
import { deviceFingerprintHash } from "../src/lib/crypto.js";
import { createAuthorizationCode } from "../src/modules/authorization/service.js";
import * as idToken from "../src/modules/authorization/id-token.js";
import { createSession } from "../src/modules/sessions/service.js";
import { resetTables } from "./helpers/db.js";
import { createZeroPiiUser } from "./helpers/zero-pii-user.js";

const MYBRANDOS = "mybrandos_public";
const REDIRECT = "https://mrfundzman.getlifeos.app/auth/callback";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetTables(prisma);
  process.env.MYBRANDOS_OAUTH_REDIRECT_URIS = REDIRECT;
  await bootstrapOAuthApplications();
  app = await buildApp();
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

async function mybrandosToken(userId: string, scopes: string[]) {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const { code } = await createAuthorizationCode({
    userId,
    clientId: MYBRANDOS,
    redirectUri: REDIRECT,
    scopes,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  });
  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: MYBRANDOS, code_verifier: verifier },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { access_token: string; id_token?: string; scope: string };
}

describe("mybrandOS step-up", () => {
  it("mybrandos_public may request identity.step_up (and nothing beyond the defaults + step-up)", async () => {
    const row = await prisma.application.findUniqueOrThrow({ where: { clientId: MYBRANDOS } });
    const allowed = JSON.parse(row.allowedScopes) as string[];
    expect(allowed).toContain(SCOPES.IDENTITY_STEP_UP);
    expect([...allowed].sort()).toEqual([...MYBRANDOS_SCOPES].sort());
  });

  it("a Digi Twin request is approved on the Master Device and consumed exactly once", async () => {
    const user = await createZeroPiiUser(`${randomBytes(6).toString("hex")}@example.test`);
    const { token: sessionToken } = await createSession({ userId: user.id });
    const tokens = await mybrandosToken(user.id, [SCOPES.OPENID, SCOPES.IDENTITY_BASIC, SCOPES.IDENTITY_STEP_UP]);
    expect(tokens.scope.split(" ")).toContain(SCOPES.IDENTITY_STEP_UP);

    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await prisma.masterDevice.create({
      data: {
        userId: user.id,
        deviceFingerprint: deviceFingerprintHash("oppo-master-device"),
        publicKey: publicKey.export({ format: "der", type: "spki" }),
        isMasterDevice: true,
        status: "active",
      },
    });

    const operation = digest(JSON.stringify({ action: "mybrandos.digitwin.brief", kind: "brief" }));
    const binding = digest("mybrandos-session:sess-1");
    const auth = { authorization: `Bearer ${tokens.access_token}` };
    const created = await app.inject({
      method: "POST",
      url: "/v1/step-up/challenges",
      headers: auth,
      payload: { method: "master_device", action: "mybrandos.digitwin.brief", operation_digest: operation, session_binding: binding, ttl_seconds: 180 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const challengeId = created.json().challenge_id as string;

    // Not approved yet: cannot be consumed.
    const early = await app.inject({
      method: "POST",
      url: `/v1/step-up/challenges/${challengeId}/consume`,
      headers: auth,
      payload: { session_binding: binding, operation_digest: operation },
    });
    expect(early.statusCode).toBe(409);

    // The person approves on their phone (Master Device signs the exact payload).
    const pending = await app.inject({ method: "GET", url: "/v1/step-up/pending", headers: { authorization: `Bearer ${sessionToken}` } });
    expect(pending.statusCode, pending.body).toBe(200);
    const item = (pending.json().challenges as Array<{ challenge_id: string; signing_payload: string }>).find((c) => c.challenge_id === challengeId)!;
    const signature = cryptoSign("sha256", Buffer.from(item.signing_payload, "utf8"), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
    const approved = await app.inject({
      method: "POST",
      url: `/v1/step-up/challenges/${challengeId}/master-device/approve`,
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { device_fingerprint: "oppo-master-device", signature },
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const consumed = await app.inject({
      method: "POST",
      url: `/v1/step-up/challenges/${challengeId}/consume`,
      headers: auth,
      payload: { session_binding: binding, operation_digest: operation },
    });
    expect(consumed.statusCode, consumed.body).toBe(200);
    expect(consumed.json().status).toBe("consumed");

    const again = await app.inject({
      method: "POST",
      url: `/v1/step-up/challenges/${challengeId}/consume`,
      headers: auth,
      payload: { session_binding: binding, operation_digest: operation },
    });
    expect(again.statusCode).toBe(409);
  });

  it("a token without identity.step_up cannot create challenges", async () => {
    const user = await createZeroPiiUser(`${randomBytes(6).toString("hex")}@example.test`);
    const tokens = await mybrandosToken(user.id, [SCOPES.OPENID, SCOPES.IDENTITY_BASIC]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/step-up/challenges",
      headers: { authorization: `Bearer ${tokens.access_token}` },
      payload: { method: "master_device", action: "mybrandos.digitwin.brief", operation_digest: digest("x"), session_binding: digest("y") },
    });
    expect(res.statusCode).toBe(403);
  });

  it("sign-in still succeeds if the id_token cannot be signed", async () => {
    vi.spyOn(idToken, "issueIdToken").mockRejectedValue(new Error("signing key unavailable"));
    const user = await createZeroPiiUser(`${randomBytes(6).toString("hex")}@example.test`);
    const tokens = await mybrandosToken(user.id, [SCOPES.OPENID, SCOPES.IDENTITY_BASIC]);
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.id_token).toBeUndefined();
  });
});
