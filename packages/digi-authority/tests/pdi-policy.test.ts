import { describe, expect, it } from "vitest";
import {
  AuthorityService,
  DDI_PDI_APPLICATION_POLICY,
  MemoryAuthorityStore,
  ddiPdiCapabilityBinding,
  digiAuthorityPolicies,
  evaluateActorPolicy,
  generateAuthoritySigningKey,
} from "../src/index.js";

const actor = { type: "app" as const, id: "app:alpha" };
const action = "identity.currentActor";
const resource = "ddi:pdi:infra:alpha:identity.currentActor";

describe("PDI application policy", () => {
  it("asks the owner and does not allow the application by itself", () => {
    expect(ddiPdiCapabilityBinding(action, resource)).toBe(true);
    expect(ddiPdiCapabilityBinding("payment.approve", "ddi:pdi:infra:alpha:payment.approve")).toBe(false);
    expect(ddiPdiCapabilityBinding(action, "ddi:pdi:identity.currentActor")).toBe(false);
    expect(ddiPdiCapabilityBinding(action, "owner:alpha:identity.currentActor")).toBe(false);
    const match = evaluateActorPolicy(DDI_PDI_APPLICATION_POLICY, { actor, action, audience: "ddi", resource });
    expect(match.decision).toBe("ASK_OWNER");
    expect(digiAuthorityPolicies(true).map(policy => policy.actorId)).toEqual(["*"]);
    expect(digiAuthorityPolicies(false).some(policy => policy.actorId === "mrfundzman")).toBe(true);
  });

  it("keeps omitted approval one-time and honors an explicit reusable grant", async () => {
    const store = new MemoryAuthorityStore();
    const service = new AuthorityService({ store, signingKey: await generateAuthoritySigningKey(), policies: digiAuthorityPolicies(true) });
    const ownerId = "own_policy";
    const asked = await service.check({ ownerId, actor, action, resource, audience: "ddi" });
    expect(asked.decision).toBe("ASK_OWNER");
    if (asked.decision !== "ASK_OWNER") return;
    const once = await service.approveRequest(ownerId, asked.requestId);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    expect(once.grant.oneTime).toBe(true);
    const used = await service.useToken({ token: once.token, expectedAudience: "ddi", expectedActor: "app:app:alpha", expectedAction: action, expectedResource: resource });
    expect(used.ok).toBe(true);
    const replay = await service.useToken({ token: once.token, expectedAudience: "ddi", expectedActor: "app:app:alpha", expectedAction: action, expectedResource: resource });
    expect(replay.ok).toBe(false);

    const again = await service.check({ ownerId, actor, action: "data.read", resource: "ddi:pdi:infra:alpha:data.read", audience: "ddi" });
    expect(again.decision).toBe("ASK_OWNER");
    if (again.decision !== "ASK_OWNER") return;
    const reusable = await service.approveRequest(ownerId, again.requestId, { oneTime: false });
    expect(reusable.ok).toBe(true);
    if (!reusable.ok) return;
    expect(reusable.grant.oneTime).toBe(false);
    const first = await service.issueToken(ownerId, reusable.grant.id);
    const second = await service.issueToken(ownerId, reusable.grant.id);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect((await service.useToken({ token: first.token, expectedAudience: "ddi", expectedActor: "app:app:alpha", expectedAction: "data.read", expectedResource: "ddi:pdi:infra:alpha:data.read" })).ok).toBe(true);
    expect((await service.useToken({ token: second.token, expectedAudience: "ddi", expectedActor: "app:app:alpha", expectedAction: "data.read", expectedResource: "ddi:pdi:infra:alpha:data.read" })).ok).toBe(true);
    await service.revoke(ownerId, reusable.grant.id);
    const third = await service.issueToken(ownerId, reusable.grant.id);
    expect(third.ok).toBe(false);
    const audits = await store.listAudit(ownerId);
    expect(audits.some(event => event.type === "authority.approved" && event.detail.oneTime === false)).toBe(true);
    expect(JSON.stringify(audits).includes(first.token)).toBe(false);
  });

  it("rejects application self-approval and duplicate approval", async () => {
    const store = new MemoryAuthorityStore();
    const service = new AuthorityService({ store, signingKey: await generateAuthoritySigningKey(), policies: digiAuthorityPolicies(true) });
    const boundary = await service.check({ ownerId: "app:alpha", actor, action, resource, audience: "ddi" });
    expect(boundary.decision).toBe("DENY");
    const asked = await service.check({ ownerId: "own_real", actor, action, resource, audience: "ddi" });
    if (asked.decision !== "ASK_OWNER") throw new Error("expected ask");
    const self = await service.approveRequest("app:alpha", asked.requestId, { oneTime: false });
    expect(self.ok).toBe(false);
    const results = await Promise.all(Array.from({ length: 8 }, () => service.approveRequest("own_real", asked.requestId, { oneTime: false })));
    expect(results.filter(result => result.ok).length).toBe(1);
    expect((await service.listActive("own_real")).length).toBe(1);
  });
});
