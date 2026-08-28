import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_APP_SCOPES, SCOPES } from "@trustid/shared";
import { TrustIdBbsHttpProvider } from "@trustid/bbs-sdk";
import { prisma } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { hashSecret, randomToken } from "../src/lib/crypto.js";
import {
  approveBbsStepUp,
  BBS_STEP_UP_STATUS,
  verifyBbsStepUpProof,
} from "../src/modules/bbs/index.js";
import { registerApplication } from "../src/modules/authorization/service.js";
import { resetTables } from "./helpers/db.js";
import { createZeroPiiUser } from "./helpers/zero-pii-user.js";

async function createOAuthAccessToken(input: {
  userId: string;
  applicationId: string;
  scopes?: string[];
}) {
  const token = randomToken(32);
  const scopes = input.scopes ?? [
    ...DEFAULT_APP_SCOPES,
    SCOPES.IDENTITY_BBS_STEP_UP,
  ];
  await prisma.oAuthAccessToken.create({
    data: {
      tokenHash: hashSecret(token),
      userId: input.userId,
      applicationId: input.applicationId,
      scopes: JSON.stringify(scopes),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return token;
}

describe("BBS payment step-up", () => {
  beforeEach(async () => {
    await resetTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("initiates a PENDING step-up challenge via /bbs/step-up/initiate", async () => {
    const app = await buildApp();
    const user = await createZeroPiiUser("bbs@example.com");
    const registered = await registerApplication({
      name: "FinProv",
      redirectUris: ["http://localhost/callback"],
      allowedScopes: [...DEFAULT_APP_SCOPES, SCOPES.IDENTITY_BBS_STEP_UP],
    });
    const token = await createOAuthAccessToken({
      userId: user.id,
      applicationId: registered.id,
    });

    const res = await app.inject({
      method: "POST",
      url: "/bbs/step-up/initiate",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: {
        amountMinor: 1000,
        currency: "NGN",
        merchantRef: "merchant-001",
        reference: "tx-abc",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      challengeId: string;
      correlationId: string;
      status: string;
      paymentHash: string;
    };
    expect(body.challengeId).toBeTruthy();
    expect(body.correlationId).toBeTruthy();
    expect(body.status).toBe(BBS_STEP_UP_STATUS.PENDING);
    expect(body.paymentHash).toMatch(/^[0-9a-f]{64}$/);
    await app.close();
  });

  it("requires OOB for high-value payments", async () => {
    const app = await buildApp();
    const user = await createZeroPiiUser("bbs-high@example.com");
    const registered = await registerApplication({
      name: "FinProv",
      redirectUris: ["http://localhost/callback"],
      allowedScopes: [...DEFAULT_APP_SCOPES, SCOPES.IDENTITY_BBS_STEP_UP],
    });
    const token = await createOAuthAccessToken({
      userId: user.id,
      applicationId: registered.id,
    });

    const res = await app.inject({
      method: "POST",
      url: "/bbs/step-up/initiate",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      payload: {
        amountMinor: 1_000_000,
        currency: "NGN",
        merchantRef: "high-value",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe(BBS_STEP_UP_STATUS.OOB_REQUIRED);
    await app.close();
  });

  it("approves and verifies payment-bound ZK proof", async () => {
    const user = await createZeroPiiUser("bbs-proof@example.com");
    const registered = await registerApplication({
      name: "FinProv",
      redirectUris: ["http://localhost/callback"],
      allowedScopes: [...DEFAULT_APP_SCOPES, SCOPES.IDENTITY_BBS_STEP_UP],
    });
    const token = await createOAuthAccessToken({
      userId: user.id,
      applicationId: registered.id,
    });

    const app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 8787;
    const trustIdApi = `http://127.0.0.1:${port}`;

    const client = new TrustIdBbsHttpProvider({ trustIdApi });
    const challenge = await client.initiateStepUp({
      accessToken: token,
      paymentHash: "a".repeat(64),
      amountMinor: 500,
      currency: "NGN",
      merchantRef: "proof-test",
    });
    expect(challenge.status).toBe(BBS_STEP_UP_STATUS.PENDING);

    const approved = await approveBbsStepUp({
      userId: user.id,
      challengeId: challenge.challengeId,
    });
    expect(approved.proof?.claimType).toBe("payment_step_up");
    expect(approved.masterSignature).toBeTruthy();

    const verified = await verifyBbsStepUpProof({
      challengeId: challenge.challengeId,
      zkProof: approved.proof!,
      masterSignature: approved.masterSignature!,
    });
    expect(verified.valid).toBe(true);
    expect(verified.status).toBe(BBS_STEP_UP_STATUS.APPROVED);

    const remote = await client.verifyStepUpProof({
      challengeId: challenge.challengeId,
      zkProof: approved.proof!,
      masterSignature: approved.masterSignature!,
    });
    expect(remote.valid).toBe(true);

    await app.close();
  });

  it("expires stale challenges on status read", async () => {
    const user = await createZeroPiiUser("bbs-expire@example.com");
    const row = await prisma.bbsStepUpChallenge.create({
      data: {
        userId: user.id,
        paymentHash: "b".repeat(64),
        audience: "finprov",
        status: BBS_STEP_UP_STATUS.PENDING,
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/bbs/step-up/${row.challengeId}/status`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe(BBS_STEP_UP_STATUS.EXPIRED);
    await app.close();
  });
});
