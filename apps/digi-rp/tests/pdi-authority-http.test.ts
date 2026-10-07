import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { createMemorySessionStore } from "@trustid/digi-bridge";
import { MemoryAuthorityStore, digiAuthorityPolicies } from "@trustid/digi-authority";
import { buildDigiRp } from "../src/app.js";

const ISSUER = "https://test-trustid.invalid";
const DIGI_AUDIENCE = "digiconomy:digi:dev";

async function start() {
  const identity = await generateKeyPair("EdDSA", { extractable: true });
  const publicJwk = await exportJWK(identity.publicKey);
  publicJwk.kid = "test-human-root";
  publicJwk.alg = "EdDSA";
  const store = new MemoryAuthorityStore();
  const sessions = createMemorySessionStore();
  const digi = await buildDigiRp({
    trustIdIssuer: ISSUER,
    jwksUrl: `${ISSUER}/jwks`,
    digiAudience: DIGI_AUDIENCE,
    authorityStore: store,
    sessions,
    fetchImpl: (async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  const base = await digi.app.listen({ port: 0, host: "127.0.0.1" });
  const sign = (subject: string) => new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "test-human-root" }).setIssuer(ISSUER).setAudience(DIGI_AUDIENCE).setSubject(subject).setIssuedAt().setExpirationTime("2m").setJti(randomUUID()).sign(identity.privateKey);
  return { digi, base, store, sessions, sign };
}

async function exchange(base: string, assertion: string) {
  const response = await fetch(new URL("/auth/trustid/exchange", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assertion }) });
  const body = await response.json() as { ownerId: string; sessionToken: string };
  return { status: response.status, ...body };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe.sequential("public PDI authority HTTP contract", () => {
  const servers: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.close()));
  });

  it("approves a reusable DDI grant through HTTP and keeps the one-time default", async () => {
    const started = await start();
    servers.push(started.digi.app);
    const owner = await exchange(started.base, await started.sign("subject-a"));
    expect(owner.status).toBe(200);
    const other = await exchange(started.base, await started.sign("subject-b"));
    const ownerProjection = await fetch(new URL("/me", started.base), { headers: auth(owner.sessionToken) });
    expect(ownerProjection.status).toBe(200);
    expect(await ownerProjection.json()).toMatchObject({ ownerId: owner.ownerId, subject: "subject-a" });
    const otherProjection = await fetch(new URL("/me", started.base), { headers: auth(other.sessionToken) });
    expect(await otherProjection.json()).toMatchObject({ ownerId: other.ownerId, subject: "subject-b" });
    const noIdentity = await started.sessions.create({ ownerId: "own-no-trustid-identity" });
    const missingProjection = await fetch(new URL("/me", started.base), { headers: auth(noIdentity.token) });
    const missingBody = await missingProjection.json() as { ownerId: string; subject?: string };
    expect(missingBody).toMatchObject({ ownerId: "own-no-trustid-identity" });
    expect(missingBody.subject).toBeUndefined();
    const resource = `ddi:pdi:infra:a:${"identity.currentActor"}`;
    const checked = await fetch(new URL("/authority/check", started.base), { method: "POST", headers: auth(owner.sessionToken), body: JSON.stringify({ actor: "app:app:a", action: "identity.currentActor", resource, audience: "ddi", ownerId: owner.ownerId }) });
    const decision = await checked.json() as { decision: string; requestId?: string };
    expect(decision.decision).toBe("ASK_OWNER");
    const otherApp = await fetch(new URL("/authority/check", started.base), { method: "POST", headers: auth(owner.sessionToken), body: JSON.stringify({ actor: "app:app:b", action: "identity.currentActor", resource: "ddi:pdi:infra:b:identity.currentActor", audience: "ddi" }) });
    expect((await otherApp.json() as { decision: string }).decision).toBe("ASK_OWNER");
    const anonymous = await fetch(new URL(`/authority/requests/${decision.requestId}/approve`, started.base), { method: "POST" });
    expect(anonymous.status).toBe(401);
    const wrongOwner = await fetch(new URL(`/authority/requests/${decision.requestId}/approve`, started.base), { method: "POST", headers: auth(other.sessionToken), body: JSON.stringify({ oneTime: false }) });
    expect(wrongOwner.status).toBe(400);
    const malformed = await fetch(new URL(`/authority/requests/${decision.requestId}/approve`, started.base), { method: "POST", headers: auth(owner.sessionToken), body: JSON.stringify({ oneTime: "false" }) });
    expect(malformed.status).toBe(400);
    const omitted = await fetch(new URL("/authority/check", started.base), { method: "POST", headers: auth(owner.sessionToken), body: JSON.stringify({ actor: "app:app:a", action: "data.read", resource: "ddi:pdi:infra:a:data.read", audience: "ddi" }) });
    const omittedDecision = await omitted.json() as { requestId: string };
    const defaulted = await fetch(new URL(`/authority/requests/${omittedDecision.requestId}/approve`, started.base), { method: "POST", headers: auth(owner.sessionToken) });
    const defaultBody = await defaulted.json() as { oneTime: boolean; grantId: string };
    expect(defaulted.status).toBe(200);
    expect(defaultBody.oneTime).toBe(true);
    const approved = await fetch(new URL(`/authority/requests/${decision.requestId}/approve`, started.base), { method: "POST", headers: auth(owner.sessionToken), body: JSON.stringify({ oneTime: false }) });
    const grant = await approved.json() as { ok: boolean; grantId: string; oneTime: boolean; token: string };
    expect(grant.oneTime).toBe(false);
    const duplicate = await fetch(new URL(`/authority/requests/${decision.requestId}/approve`, started.base), { method: "POST", headers: auth(owner.sessionToken), body: JSON.stringify({ oneTime: false }) });
    expect(duplicate.status).toBe(400);
    const listed = await fetch(new URL("/authority/grants/active", started.base), { headers: auth(owner.sessionToken) });
    const grants = await listed.json() as { grants: { id: string; oneTime: boolean; actorId: string }[] };
    expect(grants.grants.filter(item => item.id === grant.grantId && item.oneTime === false && item.actorId === "app:a").length).toBe(1);
    expect(grants.grants.some(item => item.actorId === "app:b")).toBe(false);
    const looked = await fetch(new URL(`/authority/grants/${grant.grantId}`, started.base), { headers: auth(owner.sessionToken) });
    expect((await looked.json() as { grant: { status: string } }).grant.status).toBe("ACTIVE");
    const issue = async () => {
      const response = await fetch(new URL("/authority/token", started.base), { method: "POST", headers: auth(owner.sessionToken), body: JSON.stringify({ grantId: grant.grantId }) });
      return response.json() as Promise<{ token: string }>;
    };
    const first = await issue();
    const second = await issue();
    const use = (token: string, changes: Record<string, string> = {}) => fetch(new URL("/v1/authority/consume", started.base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, audience: "ddi", actor: "app:app:a", action: "identity.currentActor", resource, ...changes }) });
    const onceToken = (await (await fetch(new URL("/authority/token", started.base), { method: "POST", headers: auth(owner.sessionToken), body: JSON.stringify({ grantId: defaultBody.grantId }) })).json()) as { token: string };
    const onceUse = (token: string) => fetch(new URL("/v1/authority/consume", started.base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, audience: "ddi", actor: "app:app:a", action: "data.read", resource: "ddi:pdi:infra:a:data.read" }) });
    expect((await onceUse(onceToken.token)).status).toBe(200);
    expect((await onceUse(onceToken.token)).status).toBe(403);
    expect((await use(first.token)).status).toBe(200);
    expect((await use(second.token)).status).toBe(200);
    expect((await use(second.token, { actor: "app:app:b" })).status).toBe(403);
    expect((await use(second.token, { action: "data.read" })).status).toBe(403);
    expect((await use(second.token, { resource: "ddi:pdi:infra:b:identity.currentActor" })).status).toBe(403);
    expect((await use(second.token, { audience: "other" })).status).toBe(403);
    const deniedScope = await fetch(new URL("/authority/check", started.base), { method: "POST", headers: auth(owner.sessionToken), body: JSON.stringify({ actor: "app:app:a", action: "payment.approve", resource: "ddi:pdi:infra:a:payment.approve", audience: "ddi" }) });
    expect((await deniedScope.json() as { decision: string }).decision).toBe("DENY");
    const wrongAudience = await fetch(new URL("/authority/check", started.base), { method: "POST", headers: auth(owner.sessionToken), body: JSON.stringify({ actor: "app:app:a", action: "identity.currentActor", resource, audience: "banking" }) });
    expect((await wrongAudience.json() as { decision: string }).decision).toBe("DENY");
    const malformedResource = await fetch(new URL("/authority/check", started.base), { method: "POST", headers: auth(owner.sessionToken), body: JSON.stringify({ actor: "app:app:a", action: "identity.currentActor", resource: "ddi:pdi:identity.currentActor", audience: "ddi" }) });
    expect((await malformedResource.json() as { decision: string }).decision).toBe("DENY");
    await fetch(new URL(`/authority/grants/${grant.grantId}/revoke`, started.base), { method: "POST", headers: auth(owner.sessionToken) });
    const after = await fetch(new URL(`/authority/grants/${grant.grantId}`, started.base), { headers: auth(owner.sessionToken) });
    expect((await after.json() as { grant: { status: string } }).grant.status).toBe("REVOKED");
    const retired = await issue();
    expect(retired).toEqual({ error: "revoked" });
    expect(digiAuthorityPolicies(true).every(policy => policy.actorType === "app" && policy.audience === "ddi")).toBe(true);
  });

  it("denies an application actor approving its own request", async () => {
    const identity = await generateKeyPair("EdDSA", { extractable: true });
    const publicJwk = await exportJWK(identity.publicKey);
    publicJwk.kid = "test-human-root";
    publicJwk.alg = "EdDSA";
    const store = new MemoryAuthorityStore();
    const sessions = createMemorySessionStore();
    await store.createRequest({ id: "req_self", ownerId: "app:self", actorType: "app", actorId: "app:self", audience: "ddi", action: "identity.currentActor", resource: "ddi:pdi:infra:self:identity.currentActor", consequence: "LOW", decision: "ASK_OWNER", status: "PENDING", stepUpProvided: false });
    const appSession = await sessions.create({ ownerId: "app:self" });
    const digi = await buildDigiRp({
      trustIdIssuer: ISSUER,
      jwksUrl: `${ISSUER}/jwks`,
      digiAudience: DIGI_AUDIENCE,
      authorityStore: store,
      sessions,
      fetchImpl: (async () => new Response(JSON.stringify({ keys: [publicJwk] }))) as typeof fetch,
    });
    servers.push(digi.app);
    const base = await digi.app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(new URL("/authority/requests/req_self/approve", base), { method: "POST", headers: auth(appSession.token), body: JSON.stringify({ oneTime: false }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "actor_cannot_approve" });
  });
});
