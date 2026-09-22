import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as jose from "jose";
import {
  DIGI_AUDIENCE_DEV,
  DIGI_ASSERTION_TTL_SECONDS,
} from "@trustid/shared";
import { prisma } from "../src/db/client.js";
import { buildApp } from "../src/app.js";
import { resetTables } from "./helpers/db.js";
import { createSession } from "../src/modules/sessions/service.js";
import { setSessionCookie } from "../src/lib/auth-context.js";
import { commitName, newTrustId } from "../src/lib/crypto.js";
import { config } from "../src/lib/config.js";
import {
  createJwksCache,
  createMemoryOwnerStore,
  createMemoryReplayStore,
  createMemorySessionStore,
  exchangeTrustIdAssertion,
} from "@trustid/digi-bridge";
import { buildDigiRp } from "../../../apps/digi-rp/src/app.js";

async function seedUser() {
  const trustId = newTrustId();
  const name = commitName("Digi", "Bridge");
  const user = await prisma.user.create({
    data: {
      trustId,
      status: "active",
      profile: {
        create: {
          nameCommitment: name.nameCommitment,
          nameSalt: name.nameSalt,
        },
      },
    },
  });
  return user;
}

describe("Phase T2 Digi trust bridge", () => {
  beforeEach(async () => {
    await resetTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("23-25 assertion endpoint requires session; ignores client sub/aud", async () => {
    const app = await buildApp();
    await app.ready();

    const unauth = await app.inject({
      method: "POST",
      url: "/trust/assertions/digi",
      payload: { sub: "TD-EVIL", audience: "evil" },
    });
    expect(unauth.statusCode).toBe(401);

    const user = await seedUser();
    const { token } = await createSession({ userId: user.id });
    const issued = await app.inject({
      method: "POST",
      url: "/trust/assertions/digi",
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        origin: config.webauthn.origin,
      },
      payload: {
        sub: "TD-OTHER-PERSON",
        audience: "lifeos",
        trustId: "TD-SPOOF",
      },
    });
    expect(issued.statusCode).toBe(200);
    const body = issued.json();
    expect(body.audience).toBe(DIGI_AUDIENCE_DEV);
    expect(body.issuer).toBe(config.oidcIssuer);
    expect(body.expires_in).toBe(DIGI_ASSERTION_TTL_SECONDS);

    const payload = jose.decodeJwt(body.assertion as string);
    expect(payload.sub).toBe(user.trustId);
    expect(payload.sub).not.toBe("TD-OTHER-PERSON");
    expect(payload.aud).toBe(DIGI_AUDIENCE_DEV);
    expect(payload.aud).not.toBe("lifeos");
    expect(typeof payload.jti).toBe("string");

    await app.close();
  });

  it("E2E TrustID session ? Digi assertion ? Digi exchange ? Digi /me; replay fails", async () => {
    const trustApp = await buildApp();
    await trustApp.ready();
    const user = await seedUser();
    const { token } = await createSession({ userId: user.id });

    const issued = await trustApp.inject({
      method: "POST",
      url: "/trust/assertions/digi",
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        origin: config.webauthn.origin,
      },
    });
    expect(issued.statusCode).toBe(200);
    const assertion = issued.json().assertion as string;

    const jwksBody = await trustApp.inject({
      method: "GET",
      url: "/.well-known/jwks.json",
    });
    expect(jwksBody.statusCode).toBe(200);

    const digi = await buildDigiRp({
      trustIdIssuer: config.oidcIssuer,
      jwksUrl: "http://trustid.test/.well-known/jwks.json",
      digiAudience: DIGI_AUDIENCE_DEV,
      fetchImpl: async () =>
        new Response(jwksBody.body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await digi.app.ready();

    const exchanged = await digi.app.inject({
      method: "POST",
      url: "/auth/trustid/exchange",
      payload: { assertion },
    });
    expect(exchanged.statusCode).toBe(200);
    const digiBody = exchanged.json();
    expect(digiBody.ok).toBe(true);
    expect(digiBody.ownerCreated).toBe(true);

    const me = await digi.app.inject({
      method: "GET",
      url: "/me",
      headers: {
        authorization: `Bearer ${digiBody.sessionToken}`,
      },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().ownerId).toBe(digiBody.ownerId);

    const replay = await digi.app.inject({
      method: "POST",
      url: "/auth/trustid/exchange",
      payload: { assertion },
    });
    expect(replay.statusCode).toBe(401);

    await digi.app.close();
    await trustApp.close();
  });
});

void setSessionCookie;
void createJwksCache;
void createMemoryOwnerStore;
void createMemoryReplayStore;
void createMemorySessionStore;
void exchangeTrustIdAssertion;
