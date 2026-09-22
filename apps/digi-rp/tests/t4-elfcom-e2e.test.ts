/**
 * T4 cross-service E2E: Digi RP (HTTP) ? ElfCom-shaped consumer (HTTP).
 * Two listen() servers  real network boundaries, not in-process calls.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  AuthorityService,
  DIGITAL_TWIN_MRFUNDZMAN_POLICY,
  actorKey,
  generateAuthoritySigningKey,
  type AuthoritySigningKey,
} from "@trustid/digi-authority";
import { SqliteAuthorityStore } from "@trustid/digi-authority/sqlite";
import { buildDigiRp } from "../src/app.js";
import {
  elfComConversationResource,
  verifyAuthority,
} from "@trustid/authority-verifier";

const OWNER = "digi_owner_fundz_t4";
const TWIN = { type: "digital_twin" as const, id: "mrfundzman" };
const OWNER_TRUST_ID = "tid_fundzman_t4";

describe("T4 cross-service ElfCom enforcement", () => {
  let digiBase = "";
  let elfBase = "";
  let digiClose: (() => Promise<void>) | null = null;
  let elfClose: (() => Promise<void>) | null = null;
  let store: SqliteAuthorityStore;
  let key: AuthoritySigningKey;
  let authority: AuthorityService;
  const messages: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    store = new SqliteAuthorityStore(":memory:");
    key = await generateAuthoritySigningKey("t4-e2e");
    authority = new AuthorityService({
      store,
      signingKey: key,
      policies: [DIGITAL_TWIN_MRFUNDZMAN_POLICY],
      persistence: "sqlite",
      resolveOwnerTrustId: async () => OWNER_TRUST_ID,
    });

    const digi = await buildDigiRp({
      trustIdIssuer: "https://trustedid.netlify.app/api",
      jwksUrl: "https://example.invalid/jwks.json",
      authorityStore: store,
      authorityService: authority,
      authorityPersistence: "sqlite",
      authorityPublicJwks: [key.publicJwk],
    });
    await digi.app.listen({ port: 0, host: "127.0.0.1" });
    const digiAddr = digi.app.server.address();
    const digiPort = typeof digiAddr === "object" && digiAddr ? digiAddr.port : 0;
    digiBase = `http://127.0.0.1:${digiPort}`;
    digiClose = async () => {
      await digi.app.close();
    };

    const elf = Fastify({ logger: false });
    elf.post("/v1/authority/messages/send", async (req, reply) => {
      const authz = req.headers.authorization;
      if (!authz?.startsWith("Bearer ")) {
        return reply.code(401).send({ decision: "DENY", reason: "missing_token" });
      }
      const token = authz.slice(7);
      const body = req.body as {
        body: string;
        conversationId?: string;
        actor: string;
        correlationId?: string;
      };
      if (!body.conversationId) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      // Resource derived from operation (confused-deputy safe)
      const resource = elfComConversationResource(body.conversationId);
      const verified = await verifyAuthority({
        token,
        audience: "elfcom",
        actor: body.actor,
        action: "message.send",
        resource,
        jwksUrl: `${digiBase}/.well-known/authority-jwks.json`,
      });
      if (!verified.ok) {
        return reply.code(403).send({ decision: "DENY", reason: verified.reason });
      }
      const consumed = await fetch(`${digiBase}/v1/authority/consume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          audience: "elfcom",
          actor: body.actor,
          action: "message.send",
          resource,
          correlationId: body.correlationId,
        }),
      });
      const cjson = (await consumed.json()) as {
        decision?: string;
        reason?: string;
      };
      if (!consumed.ok || cjson.decision !== "ALLOW") {
        return reply
          .code(403)
          .send({ decision: "DENY", reason: cjson.reason ?? "consume_denied" });
      }
      const messageId = `msg_${messages.length + 1}`;
      messages.push({
        messageId,
        owner: verified.claims.sub,
        actor: verified.claims.actor,
        ownerTrustId: verified.claims.ownerTrustId,
        body: body.body,
        resource,
        grantId: verified.claims.grantId,
        jti: verified.claims.jti,
        performedBy: verified.claims.actor,
      });
      return {
        decision: "ALLOW",
        messageId,
        owner: verified.claims.sub,
        actor: verified.claims.actor,
        performedBy: verified.claims.actor,
        ownerTrustId: verified.claims.ownerTrustId,
        grantId: verified.claims.grantId,
        jti: verified.claims.jti,
      };
    });
    await elf.listen({ port: 0, host: "127.0.0.1" });
    const elfAddr = elf.server.address();
    const elfPort = typeof elfAddr === "object" && elfAddr ? elfAddr.port : 0;
    elfBase = `http://127.0.0.1:${elfPort}`;
    elfClose = async () => {
      await elf.close();
    };
  });

  afterAll(async () => {
    await elfClose?.();
    await digiClose?.();
    store.close();
  });

  it("positive: Twin capability sends message with owner/actor preserved", async () => {
    const conversationId = "conv_t4_abc";
    const resource = elfComConversationResource(conversationId);

    const check = await authority.check({
      ownerId: OWNER,
      actor: TWIN,
      action: "message.send",
      resource,
      audience: "elfcom",
    });
    expect(check.decision).toBe("ALLOW_WITH_LIMITS");
    if (check.decision !== "ALLOW_WITH_LIMITS") return;

    const issued = await authority.issueToken(OWNER, check.grantId, {
      actions: ["message.send"],
      resources: [resource],
      ttlSeconds: 120,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const health = await fetch(`${digiBase}/health`).then((r) => r.json());
    expect((health as { authority: { jwks: string } }).authority.jwks).toBe("READY");

    const res = await fetch(`${elfBase}/v1/authority/messages/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: "Hello from Digital Twin",
        conversationId,
        actor: actorKey(TWIN),
        correlationId: "corr_t4_1",
      }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(json.decision).toBe("ALLOW");
    expect(json.owner).toBe(OWNER);
    expect(json.actor).toBe(actorKey(TWIN));
    expect(json.performedBy).toBe(actorKey(TWIN));
    expect(json.ownerTrustId).toBe(OWNER_TRUST_ID);
    expect(messages).toHaveLength(1);
  });

  it("negative: wrong conversation resource ? DENY (confused deputy)", async () => {
    const resource = elfComConversationResource("conv_A");
    const check = await authority.check({
      ownerId: OWNER,
      actor: TWIN,
      action: "message.send",
      resource,
      audience: "elfcom",
    });
    if (check.decision !== "ALLOW_WITH_LIMITS" && check.decision !== "ALLOW") {
      // may be limit exceeded from prior  create fresh grant by new resource ok
    }
    // mint token for A via fresh grant
    const grant = await store.createGrant({
      id: `auth_conf_${Date.now()}`,
      ownerId: OWNER,
      actorType: TWIN.type,
      actorId: TWIN.id,
      audience: "elfcom",
      actions: ["message.send"],
      resources: [resource],
      limits: { maxMessages: 5 },
      approvalMode: "ALLOW_WITH_LIMITS",
      oneTime: false,
      validFrom: new Date(),
      validUntil: new Date(Date.now() + 3600_000),
    });
    const issued = await authority.issueToken(OWNER, grant.id, {
      actions: ["message.send"],
      resources: [resource],
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const res = await fetch(`${elfBase}/v1/authority/messages/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: "attack",
        conversationId: "conv_B",
        actor: actorKey(TWIN),
      }),
    });
    const json = (await res.json()) as { decision: string; reason: string };
    expect(res.status).toBe(403);
    expect(json.decision).toBe("DENY");
    expect(json.reason).toBe("wrong_resource");
  });

  it("negative: aud=tv token rejected by ElfCom", async () => {
    const grant = await store.createGrant({
      id: `auth_tv_${Date.now()}`,
      ownerId: OWNER,
      actorType: TWIN.type,
      actorId: TWIN.id,
      audience: "tv",
      actions: ["message.send"],
      resources: [elfComConversationResource("x")],
      limits: {},
      approvalMode: "ALLOW",
      oneTime: false,
      validFrom: new Date(),
      validUntil: new Date(Date.now() + 3600_000),
    });
    const issued = await authority.issueToken(OWNER, grant.id);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const res = await fetch(`${elfBase}/v1/authority/messages/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: "nope",
        conversationId: "x",
        actor: actorKey(TWIN),
      }),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { reason: string };
    expect(json.reason).toBe("wrong_audience");
  });

  it("negative: one-time replay via Digi consume", async () => {
    const resource = elfComConversationResource("conv_once");
    const grant = await store.createGrant({
      id: `auth_once_${Date.now()}`,
      ownerId: OWNER,
      actorType: TWIN.type,
      actorId: TWIN.id,
      audience: "elfcom",
      actions: ["message.send"],
      resources: [resource],
      limits: {},
      approvalMode: "ALLOW",
      oneTime: true,
      validFrom: new Date(),
      validUntil: new Date(Date.now() + 3600_000),
    });
    const issued = await authority.issueToken(OWNER, grant.id, {
      actions: ["message.send"],
      resources: [resource],
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const first = await fetch(`${elfBase}/v1/authority/messages/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: "once",
        conversationId: "conv_once",
        actor: actorKey(TWIN),
      }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${elfBase}/v1/authority/messages/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: "twice",
        conversationId: "conv_once",
        actor: actorKey(TWIN),
      }),
    });
    expect(second.status).toBe(403);
    const json = (await second.json()) as { reason: string };
    expect(json.reason).toBe("replay");
  });

  it("negative: missing token", async () => {
    const res = await fetch(`${elfBase}/v1/authority/messages/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: "x",
        conversationId: "c",
        actor: actorKey(TWIN),
      }),
    });
    expect(res.status).toBe(401);
  });
});
