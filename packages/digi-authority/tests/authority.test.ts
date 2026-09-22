import { describe, expect, it } from "vitest";
import {
  AuthorityService,
  DIGITAL_TWIN_MRFUNDZMAN_POLICY,
  MemoryAuthorityStore,
  actorKey,
  assertDelegationSubset,
  evaluateActorPolicy,
  generateAuthoritySigningKey,
  mintAuthorityToken,
  verifyAuthorityToken,
} from "../src/index.js";
import { SqliteAuthorityStore } from "../src/sqlite-store.js";

const OWNER = "digi_owner_fundz";
const TWIN = { type: "digital_twin" as const, id: "mrfundzman" };

async function makeService(store = new MemoryAuthorityStore(), persistence: "memory" | "sqlite" | "postgres" = "memory") {
  const key = await generateAuthoritySigningKey("t3-test");
  const svc = new AuthorityService({
    store,
    signingKey: key,
    policies: [DIGITAL_TWIN_MRFUNDZMAN_POLICY],
    persistence,
  });
  return { svc, key, store };
}

describe("T3 unit  policy fixture", () => {
  it("digital twin may create TV/radio programs", () => {
    const m = evaluateActorPolicy(DIGITAL_TWIN_MRFUNDZMAN_POLICY, {
      actor: TWIN,
      action: "tv.program.create",
      audience: "tv",
      resource: "tv:station:mrfundzman",
    });
    expect(m.decision).toBe("ALLOW");
  });

  it("publish is ALLOW_WITH_LIMITS maxPosts=1", () => {
    const m = evaluateActorPolicy(DIGITAL_TWIN_MRFUNDZMAN_POLICY, {
      actor: TWIN,
      action: "tv.program.publish",
      audience: "tv",
      resource: "tv:station:mrfundzman",
    });
    expect(m.decision).toBe("ALLOW_WITH_LIMITS");
    expect(m.limits.maxPosts).toBe(1);
  });

  it("live start asks owner", () => {
    const m = evaluateActorPolicy(DIGITAL_TWIN_MRFUNDZMAN_POLICY, {
      actor: TWIN,
      action: "tv.live.start",
      audience: "tv",
      resource: "tv:station:mrfundzman",
    });
    expect(m.decision).toBe("ASK_OWNER");
  });

  it("payment.approve asks owner and requires step-up", () => {
    const m = evaluateActorPolicy(DIGITAL_TWIN_MRFUNDZMAN_POLICY, {
      actor: TWIN,
      action: "payment.approve",
      audience: "fundzman",
      resource: "fundzman:wallet:123",
    });
    expect(m.decision).toBe("ASK_OWNER");
    expect(m.requireStepUp).toBe(true);
    expect(m.oneTime).toBe(true);
  });

  it("authority.delegate is denied", () => {
    const m = evaluateActorPolicy(DIGITAL_TWIN_MRFUNDZMAN_POLICY, {
      actor: TWIN,
      action: "authority.delegate",
      audience: "digi",
      resource: "digi:owner:fundz",
    });
    expect(m.decision).toBe("DENY");
  });
});

describe("T3 unit  tokens", () => {
  it("mints and verifies EdDSA authority token", async () => {
    const key = await generateAuthoritySigningKey("k1");
    const { token, claims } = await mintAuthorityToken(key, {
      ownerId: OWNER,
      audience: "tv",
      actor: actorKey(TWIN),
      actions: ["tv.program.publish"],
      resources: ["tv:station:mrfundzman"],
      limits: { maxPosts: 1 },
      approval: "ALLOW_WITH_LIMITS",
      grantId: "auth_1",
      grantVersion: 1,
      oneTime: false,
      jti: "jti_1",
      ttlSeconds: 300,
    });
    expect(claims.iss).toBe("digiconomy-authority");
    const v = await verifyAuthorityToken({
      token,
      expectedAudience: "tv",
      expectedActor: actorKey(TWIN),
      expectedAction: "tv.program.publish",
      expectedResource: "tv:station:mrfundzman",
      publicJwks: [key.publicJwk],
    });
    expect(v.ok).toBe(true);
  });

  it("wrong audience fails", async () => {
    const key = await generateAuthoritySigningKey("k2");
    const { token } = await mintAuthorityToken(key, {
      ownerId: OWNER,
      audience: "tv",
      actor: actorKey(TWIN),
      actions: ["tv.program.publish"],
      resources: ["tv:station:mrfundzman"],
      limits: {},
      approval: "ALLOW",
      grantId: "auth_2",
      grantVersion: 1,
      oneTime: false,
      jti: "jti_2",
    });
    const v = await verifyAuthorityToken({
      token,
      expectedAudience: "radio",
      publicJwks: [key.publicJwk],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("wrong_audience");
  });

  it("expired token fails", async () => {
    const key = await generateAuthoritySigningKey("k3");
    const past = new Date(Date.now() - 60_000);
    const { token } = await mintAuthorityToken(key, {
      ownerId: OWNER,
      audience: "tv",
      actor: actorKey(TWIN),
      actions: ["tv.program.publish"],
      resources: ["tv:station:mrfundzman"],
      limits: {},
      approval: "ALLOW",
      grantId: "auth_3",
      grantVersion: 1,
      oneTime: false,
      jti: "jti_3",
      ttlSeconds: 1,
      now: past,
    });
    const v = await verifyAuthorityToken({
      token,
      expectedAudience: "tv",
      publicJwks: [key.publicJwk],
      now: new Date(),
      clockToleranceSeconds: 0,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });
});

describe("T3 unit  request / approve / limits / revoke", () => {
  it("TV publish ALLOW_WITH_LIMITS then limit deny", async () => {
    const { svc } = await makeService();
    const c1 = await svc.check({
      ownerId: OWNER,
      actor: TWIN,
      action: "tv.program.publish",
      resource: "tv:station:mrfundzman",
      audience: "tv",
    });
    expect(c1.decision).toBe("ALLOW_WITH_LIMITS");
    if (c1.decision !== "ALLOW_WITH_LIMITS") return;
    const issued = await svc.issueToken(OWNER, c1.grantId, {
      actions: ["tv.program.publish"],
      resources: ["tv:station:mrfundzman"],
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const use1 = await svc.useToken({
      token: issued.token,
      expectedAudience: "tv",
      expectedActor: actorKey(TWIN),
      expectedAction: "tv.program.publish",
      expectedResource: "tv:station:mrfundzman",
    });
    expect(use1.ok).toBe(true);

    const c2 = await svc.check({
      ownerId: OWNER,
      actor: TWIN,
      action: "tv.program.publish",
      resource: "tv:station:mrfundzman",
      audience: "tv",
    });
    expect(c2.decision).toBe("DENY");
    if (c2.decision === "DENY") expect(c2.reason).toBe("maxPosts_exceeded");
  });

  it("radio same structure", async () => {
    const { svc } = await makeService();
    const c = await svc.check({
      ownerId: OWNER,
      actor: TWIN,
      action: "radio.program.publish",
      resource: "radio:station:mrfundzman",
      audience: "radio",
    });
    expect(c.decision).toBe("ALLOW_WITH_LIMITS");
  });

  it("owner approval flow for live start", async () => {
    const { svc } = await makeService();
    const c = await svc.check({
      ownerId: OWNER,
      actor: TWIN,
      action: "tv.live.start",
      resource: "tv:station:mrfundzman",
      audience: "tv",
    });
    expect(c.decision).toBe("ASK_OWNER");
    if (c.decision !== "ASK_OWNER") return;
    const pending = await svc.listPending(OWNER);
    expect(pending.some((p) => p.id === c.requestId)).toBe(true);
    const approved = await svc.approveRequest(OWNER, c.requestId, {
      oneTime: true,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    const used = await svc.useToken({
      token: approved.token,
      expectedAudience: "tv",
      expectedActor: actorKey(TWIN),
      expectedAction: "tv.live.start",
      expectedResource: "tv:station:mrfundzman",
    });
    expect(used.ok).toBe(true);
  });

  it("owner deny", async () => {
    const { svc } = await makeService();
    const c = await svc.check({
      ownerId: OWNER,
      actor: TWIN,
      action: "radio.live.start",
      resource: "radio:station:mrfundzman",
      audience: "radio",
    });
    expect(c.decision).toBe("ASK_OWNER");
    if (c.decision !== "ASK_OWNER") return;
    const d = await svc.denyRequest(OWNER, c.requestId);
    expect(d.ok).toBe(true);
    const pending = await svc.listPending(OWNER);
    expect(pending.find((p) => p.id === c.requestId)).toBeUndefined();
  });

  it("payment without step-up denied; with step-up then approve+consume", async () => {
    const { svc } = await makeService();
    const noStep = await svc.check({
      ownerId: OWNER,
      actor: TWIN,
      action: "payment.approve",
      resource: "fundzman:wallet:123",
      audience: "fundzman",
      stepUpProvided: false,
    });
    expect(noStep.decision).toBe("DENY");

    const withStep = await svc.check({
      ownerId: OWNER,
      actor: TWIN,
      action: "payment.approve",
      resource: "fundzman:wallet:123",
      audience: "fundzman",
      stepUpProvided: true,
    });
    expect(withStep.decision).toBe("ASK_OWNER");
    if (withStep.decision !== "ASK_OWNER") return;
    const approved = await svc.approveRequest(OWNER, withStep.requestId, {
      oneTime: true,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    const use1 = await svc.useToken({
      token: approved.token,
      expectedAudience: "fundzman",
      expectedActor: actorKey(TWIN),
      expectedAction: "payment.approve",
      expectedResource: "fundzman:wallet:123",
    });
    expect(use1.ok).toBe(true);
    const use2 = await svc.useToken({
      token: approved.token,
      expectedAudience: "fundzman",
      expectedActor: actorKey(TWIN),
      expectedAction: "payment.approve",
      expectedResource: "fundzman:wallet:123",
    });
    expect(use2.ok).toBe(false);
    if (!use2.ok) expect(use2.reason).toBe("replay");
  });

  it("revocation blocks new token issuance", async () => {
    const { svc } = await makeService();
    const c = await svc.check({
      ownerId: OWNER,
      actor: TWIN,
      action: "tv.program.create",
      resource: "tv:station:mrfundzman",
      audience: "tv",
    });
    expect(c.decision).toBe("ALLOW");
    if (c.decision !== "ALLOW" || !c.grantId) return;
    const before = await svc.issueToken(OWNER, c.grantId);
    expect(before.ok).toBe(true);
    await svc.revoke(OWNER, c.grantId);
    const after = await svc.issueToken(OWNER, c.grantId);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe("revoked");
  });

  it("wrong resource / wrong actor fail closed", async () => {
    const { svc, key } = await makeService();
    const c = await svc.check({
      ownerId: OWNER,
      actor: TWIN,
      action: "tv.program.create",
      resource: "tv:station:mrfundzman",
      audience: "tv",
    });
    if (c.decision !== "ALLOW" || !c.grantId) throw new Error("expected allow");
    const issued = await svc.issueToken(OWNER, c.grantId);
    if (!issued.ok) throw new Error("issue failed");

    const badResource = await verifyAuthorityToken({
      token: issued.token,
      expectedAudience: "tv",
      expectedResource: "tv:station:dpcribs",
      publicJwks: [key.publicJwk],
    });
    expect(badResource.ok).toBe(false);
    if (!badResource.ok) expect(badResource.reason).toBe("wrong_resource");

    const badActor = await verifyAuthorityToken({
      token: issued.token,
      expectedAudience: "tv",
      expectedActor: "service:unknown",
      publicJwks: [key.publicJwk],
    });
    expect(badActor.ok).toBe(false);
    if (!badActor.ok) expect(badActor.reason).toBe("wrong_actor");
  });

  it("delegation cannot escalate", () => {
    const parent = {
      actions: ["tv.program.create"],
      resources: ["tv:station:mrfundzman"],
      validUntil: new Date("2026-10-01T00:00:00Z"),
      limits: { maxPosts: 2 },
      audience: "tv",
      ownerId: OWNER,
    };
    expect(
      assertDelegationSubset(parent, {
        ...parent,
        actions: ["tv.program.create", "payment.approve"],
      }).ok
    ).toBe(false);
    expect(
      assertDelegationSubset(parent, {
        ...parent,
        resources: ["tv:station:other"],
      }).ok
    ).toBe(false);
    expect(
      assertDelegationSubset(parent, {
        ...parent,
        validUntil: new Date("2026-12-01T00:00:00Z"),
      }).ok
    ).toBe(false);
    expect(
      assertDelegationSubset(parent, {
        ...parent,
        limits: { maxPosts: 99 },
      }).ok
    ).toBe(false);
    expect(
      assertDelegationSubset(parent, {
        ...parent,
        audience: "fundzman",
      }).ok
    ).toBe(false);
  });
});

describe("T3 SQL-backed integration", () => {
  it("owner ? grant ? approval ? token ? consume ? replay reject", async () => {
    const store = new SqliteAuthorityStore(":memory:");
    try {
      const { svc } = await makeService(store, "sqlite");
      const ask = await svc.check({
        ownerId: OWNER,
        actor: TWIN,
        action: "tv.live.start",
        resource: "tv:station:mrfundzman",
        audience: "tv",
      });
      expect(ask.decision).toBe("ASK_OWNER");
      if (ask.decision !== "ASK_OWNER") return;
      const approved = await svc.approveRequest(OWNER, ask.requestId, {
        oneTime: true,
      });
      expect(approved.ok).toBe(true);
      if (!approved.ok) return;
      const use1 = await svc.useToken({
        token: approved.token,
        expectedAudience: "tv",
        expectedActor: actorKey(TWIN),
        expectedAction: "tv.live.start",
        expectedResource: "tv:station:mrfundzman",
      });
      expect(use1.ok).toBe(true);
      const use2 = await svc.useToken({
        token: approved.token,
        expectedAudience: "tv",
        expectedActor: actorKey(TWIN),
        expectedAction: "tv.live.start",
        expectedResource: "tv:station:mrfundzman",
      });
      expect(use2.ok).toBe(false);
      if (!use2.ok) expect(use2.reason).toBe("replay");
      const health = svc.getHealth();
      expect(health.status).toBe("READY");
      expect(health.tokenAlg).toBe("EdDSA");
      expect(health.persistence).toBe("sqlite");
    } finally {
      store.close();
    }
  });
});

describe("T3 concurrency  one-time jti", () => {
  it("two simultaneous uses: one wins, one replay", async () => {
    const store = new SqliteAuthorityStore(":memory:");
    try {
      const { svc } = await makeService(store, "sqlite");
      const ask = await svc.check({
        ownerId: OWNER,
        actor: TWIN,
        action: "payment.approve",
        resource: "fundzman:wallet:1",
        audience: "fundzman",
        stepUpProvided: true,
      });
      if (ask.decision !== "ASK_OWNER") throw new Error("expected ask");
      const approved = await svc.approveRequest(OWNER, ask.requestId, {
        oneTime: true,
      });
      if (!approved.ok) throw new Error("approve failed");

      const results = await Promise.all([
        svc.useToken({
          token: approved.token,
          expectedAudience: "fundzman",
          expectedActor: actorKey(TWIN),
          expectedAction: "payment.approve",
          expectedResource: "fundzman:wallet:1",
        }),
        svc.useToken({
          token: approved.token,
          expectedAudience: "fundzman",
          expectedActor: actorKey(TWIN),
          expectedAction: "payment.approve",
          expectedResource: "fundzman:wallet:1",
        }),
      ]);
      const oks = results.filter((r) => r.ok).length;
      const fails = results.filter((r) => !r.ok);
      expect(oks).toBe(1);
      expect(fails).toHaveLength(1);
      if (!fails[0]!.ok) expect(fails[0]!.reason).toBe("replay");
    } finally {
      store.close();
    }
  });
});
