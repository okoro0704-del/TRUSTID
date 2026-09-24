import { describe, expect, it } from "vitest";
import { decodeJwt, SignJWT } from "jose";
import { AuthorityService, MemoryAuthorityStore, generateAuthoritySigningKey, verifyAuthorityToken, assertDelegationSubset } from "../src/index.js";
import { SqliteAuthorityStore } from "../src/sqlite-store.js";

const now = new Date("2026-09-24T00:00:00Z");
const actor = "service:digi:test-agent";
const operation = { expectedAudience: "test", expectedActor: actor, expectedAction: "test-resource.read", expectedResource: "test-resource:alpha" };
async function fixture(store = new MemoryAuthorityStore(), oneTime = false, limits = {}) {
  const key = await generateAuthoritySigningKey();
  const svc = new AuthorityService({ store, signingKey: key, now: () => now });
  await store.createGrant({ id: "grant", ownerId: "owner", actorType: "service", actorId: "digi:test-agent", audience: "test",
    actions: ["test-resource.read"], resources: ["test-resource:alpha"], approvalMode: "ALLOW", limits, oneTime,
    validFrom: new Date(now.getTime()-1000), validUntil: new Date(now.getTime()+10_000) });
  const issued = await svc.issueToken("owner", "grant");
  if (!issued.ok) throw new Error(issued.reason);
  return { svc, store, key, token: issued.token };
}
describe.each(["memory", "sqlite"])("Foundation atomic usage (%s)", backend => {
  async function make(oneTime: boolean, limits = {}) {
    const store = backend === "sqlite" ? new SqliteAuthorityStore(":memory:") : new MemoryAuthorityStore();
    return { ...await fixture(store as MemoryAuthorityStore, oneTime, limits), close: () => { if (store instanceof SqliteAuthorityStore) store.close(); } };
  }
  it("multiple different tokens of one one-time grant authorize exactly once", async () => {
    const f = await make(true);
    try {
      const second = await f.svc.issueToken("owner", "grant"); if (!second.ok) throw new Error(second.reason);
      const result = await Promise.all([f.token, second.token, f.token].map(token => f.svc.useToken({ token, ...operation })));
      expect(result.filter(r => r.ok)).toHaveLength(1);
      expect((await f.store.getGrant("grant"))?.usageCount).toBe(1);
    } finally { f.close(); }
  });
  it("concurrent reusable tokens cannot exceed the grant usage budget", async () => {
    const f = await make(false, { maxMessages: 1 });
    try { const result = await Promise.all(Array.from({length: 8}, () => f.svc.useToken({token:f.token, ...operation})));
      expect(result.filter(r => r.ok)).toHaveLength(1);
    } finally { f.close(); }
  });
});
describe("Foundation grant and cryptographic boundaries", () => {
  it("caps token expiration to the grant and refuses a caller TTL extension", async () => {
    const f = await fixture(); expect(decodeJwt(f.token).exp).toBe(now.getTime()/1000+10);
    expect(await f.svc.issueToken("owner", "grant", {ttlSeconds:3600})).toMatchObject({ok:false});
  });
  it("rejects suspended and expired grants even with a signed token", async () => {
    const f = await fixture(); await f.store.updateGrantStatus("grant", "EXPIRED");
    expect(await f.svc.useToken({token:f.token,...operation})).toMatchObject({ok:false});
  });
  it("rejects signed token bound to a different owner/grant relationship", async () => {
    const f = await fixture();
    const token = await new SignJWT({...decodeJwt(f.token),sub:"other-owner"}).setProtectedHeader({alg:"EdDSA",kid:f.key.kid}).sign(f.key.privateKey);
    expect(await f.svc.useToken({token,...operation})).toMatchObject({ok:false,reason:"grant_binding_mismatch"});
  });
  it("does not support unsafe child delegation and detects omitted limits", async () => {
    const f = await fixture();
    expect(await f.svc.delegate({ownerId:"owner",parentGrantId:"grant",actor:{type:"service",id:"child"},actions:["test-resource.read"],resources:["test-resource:alpha"],validUntil:now})).toMatchObject({ok:false,reason:"delegation_chain_unsupported"});
    const base={ownerId:"owner",audience:"test",actions:["read"],resources:["alpha"],validUntil:now};
    expect(assertDelegationSubset({...base,limits:{maxMessages:1}},{...base,limits:{}})).toMatchObject({ok:false});
  });
  it.each(["exp","nbf","iat","sub","jti","grantId","oneTime","limits","approval"])("rejects a validly signed malformed authority missing %s", async field => {
    const f = await fixture(); const payload = {...decodeJwt(f.token)}; delete payload[field];
    const token=await new SignJWT(payload).setProtectedHeader({alg:"EdDSA",kid:f.key.kid}).sign(f.key.privateKey);
    expect(await verifyAuthorityToken({token,...operation,publicJwks:[f.key.publicJwk],now})).toMatchObject({ok:false});
  });
  it("rejects an otherwise signed authority carrying biometric data", async () => {
    const f=await fixture();const token=await new SignJWT({...decodeJwt(f.token),faceEmbedding:[0.1]}).setProtectedHeader({alg:"EdDSA",kid:f.key.kid}).sign(f.key.privateKey);
    expect(await verifyAuthorityToken({token,...operation,publicJwks:[f.key.publicJwk],now})).toMatchObject({ok:false});
  });
});
