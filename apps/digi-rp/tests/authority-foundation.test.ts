/** TEST ONLY: no production route, real data, external service, or AI integration. */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { SignJWT, decodeJwt, generateKeyPair, exportJWK } from "jose";
import { AuthorityService, MemoryAuthorityStore, generateAuthoritySigningKey } from "@trustid/digi-authority";
import { authorizeAuthority } from "@trustid/authority-verifier";
import { buildDigiRp } from "../src/app.js";

const actor = "service:digi:test-agent";
const audience = "foundation-test";
const resource = "test-resource:alpha";
const evidence: unknown[] = [];
describe("Authority Foundation V1 end-to-end", () => {
  let digi: Awaited<ReturnType<typeof buildDigiRp>>;
  let target: ReturnType<typeof Fastify>;
  let base: string;
  let targetBase: string;
  let ownerSession: string;
  let ownerId: string;
  let grantId: string;
  let token: string;
  let store: MemoryAuthorityStore;
  let authority: AuthorityService;
  let now: Date;
  let executions: string[];
  let decisions: Record<string, unknown>[];

  beforeEach(async () => {
    now = new Date(Math.floor(Date.now() / 1000) * 1000);
    executions = []; decisions = [];
    const identityKey = await generateKeyPair("EdDSA");
    const identityPublic = { ...await exportJWK(identityKey.publicKey), kid: "test-human-root", alg: "EdDSA" };
    const key = await generateAuthoritySigningKey("test-authority-root");
    store = new MemoryAuthorityStore();
    authority = new AuthorityService({ store, signingKey: key, now: () => now, policies: [{
      actorType: "service", actorId: "digi:test-agent", audience,
      rules: [{ actions: ["test-resource.read"], resources: [resource], decision: "ALLOW" }],
    }] });
    digi = await buildDigiRp({ trustIdIssuer: "https://test-trustid.invalid", jwksUrl: "https://test-trustid.invalid/jwks",
      digiAudience: "digiconomy:digi:dev", authorityStore: store, authorityService: authority,
      authorityPublicJwks: [key.publicJwk], fetchImpl: (async () => new Response(JSON.stringify({ keys: [identityPublic] }))) as typeof fetch,
    });
    base = await digi.app.listen({ port: 0, host: "127.0.0.1" });
    const assertion = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "test-human-root" })
      .setIssuer("https://test-trustid.invalid").setSubject("TD-TEST-HUMAN").setAudience("digiconomy:digi:dev")
      .setJti(randomUUID()).setIssuedAt().setNotBefore(Math.floor(Date.now()/1000)).setExpirationTime("60s").sign(identityKey.privateKey);
    const exchanged = await post("/auth/trustid/exchange", { assertion });
    expect(exchanged.status).toBe(200);
    const identity = await exchanged.json();
    ownerSession = identity.sessionToken; ownerId = identity.ownerId;
    const checked = await post("/authority/check", { actor, action: "test-resource.read", resource, audience }, ownerSession);
    expect(checked.status).toBe(200);
    const grant = await checked.json();
    expect(grant.decision).toBe("ALLOW"); grantId = grant.grantId;
    token = (await (await post("/authority/token", { grantId, ttlSeconds: 10 }, ownerSession)).json()).token;

    target = Fastify();
    target.post("/test-resource/:name/:operation", async (req, reply) => {
      const params = req.params as { name: string; operation: string };
      // Test-only authenticated machine credential. Actor is NEVER taken from body/X-Actor.
      const identity = req.headers["x-test-machine-key"] === "fixture-agent" ? actor :
        req.headers["x-test-machine-key"] === "fixture-other" ? "service:digi:other-agent" : "unknown:actor";
      const actualResource = `test-resource:${params.name}`;
      const action = `test-resource.${params.operation}`;
      const supplied = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const result = await authorizeAuthority({ token: supplied, actor: identity, action, resource: actualResource, audience,
        jwksUrl: `${base}/.well-known/authority-jwks.json`, now,
        consume: async input => (await post("/v1/authority/consume", input)).json(),
      });
      decisions.push({ decisionId: randomUUID(), actor: identity, action, resource: actualResource,
        decision: result.ok ? "ALLOW" : "DENY", reason: result.ok ? "ALLOW" : result.reason,
        subject: result.ok ? result.claims.sub : null, grantId: result.ok ? result.claims.grantId : null, timestamp: now.toISOString() });
      if (!result.ok) return reply.code(403).send({ decision: "DENY" });
      executions.push(action);
      return { decision: "ALLOW", value: "synthetic alpha", actor: result.claims.actor, subject: result.claims.sub };
    });
    targetBase = await target.listen({ port: 0, host: "127.0.0.1" });
  });
  afterEach(async () => {
    evidence.push({ test: expect.getState().currentTestName, executions, decisions,
      authorityAudit: store && ownerId ? await store.listAudit(ownerId) : [] });
    await target?.close(); await digi?.app.close();
  });
  afterAll(() => {
    const dir = fileURLToPath(new URL("../../../artifacts/authority-foundation/", import.meta.url));
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/decisions.json`, JSON.stringify({ scope: "local synthetic tests only", evidence }, null, 2));
  });
  function post(path: string, body: unknown, session?: string) {
    return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}) }, body: JSON.stringify(body) });
  }
  function execute(operation = "read", name = "alpha", credential = token, machine = "fixture-agent") {
    return fetch(`${targetBase}/test-resource/${name}/${operation}`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "x-test-machine-key": machine } });
  }
  it("owner assertion -> session -> grant -> signed token -> verifier -> consumption -> exactly one read -> audit", async () => {
    expect((await execute()).status).toBe(200);
    expect(executions).toEqual(["test-resource.read"]);
    expect(decisions).toMatchObject([{ decision: "ALLOW", actor, subject: ownerId, grantId }]);
    expect((await store.listAudit(ownerId)).some(e => e.type === "authority.used" && e.grantId === grantId)).toBe(true);
    expect(digi.auditLog.some(e => e.event === "trust_assertion_accepted")).toBe(true);
    const claims = decodeJwt(token);
    expect(Object.keys(claims).sort()).toEqual(["iss","sub","aud","actor","actions","resources","limits","approval","grantId","grantVersion","oneTime","jti","iat","nbf","exp"].sort());
  });
  it.each([["delete","alpha","fixture-agent"], ["write","alpha","fixture-agent"], ["read","beta","fixture-agent"], ["read","alpha","fixture-other"], ["read","alpha","unknown"]])("DENY %s on %s as %s without execution", async (action, name, machine) => {
    expect((await execute(action,name,token,machine)).status).toBe(403);
    expect(executions).toHaveLength(0); expect(decisions[0].decision).toBe("DENY");
  });
  it("enforces exact expiration with deterministic time", async () => {
    expect((await execute()).status).toBe(200);
    now = new Date(now.getTime()+10_000);
    expect((await execute()).status).toBe(403); expect(executions).toHaveLength(1);
  });
  it("reusable token remains reusable; revocation immediately prevents its next use", async () => {
    expect((await execute()).status).toBe(200); expect((await execute()).status).toBe(200);
    expect((await post(`/authority/grants/${grantId}/revoke`, {}, ownerSession)).status).toBe(200);
    expect((await execute()).status).toBe(403); expect(executions).toHaveLength(2);
  });
  it.each(["actor","actions","resources","exp","grantId","jti","signature"])("rejects tampering: %s", async field => {
    const parts = token.split('.');
    if (field === "signature") parts[2] = (parts[2][0] === "A" ? "B" : "A") + parts[2].slice(1);
    else { const p = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      p[field] = field === "exp" ? p.exp+3600 : field === "actions" ? ["test-resource.delete"] : field === "resources" ? ["test-resource:beta"] : "attacker";
      parts[1] = Buffer.from(JSON.stringify(p)).toString("base64url"); }
    expect((await execute("read","alpha",parts.join('.'))).status).toBe(403); expect(executions).toHaveLength(0);
  });
  it.each(["", "not-a-token"])("denies missing/malformed authority %s", async bad => {
    expect((await execute("read","alpha",bad)).status).toBe(403); expect(executions).toHaveLength(0);
  });
  it("actor credentials and fabricated owner IDs cannot create or enlarge authority", async () => {
    for (const credential of [undefined, token, "local-install", "public-space-slug"]) {
      expect((await post("/authority/check", { ownerId, actor, action: "test-resource.delete", resource, audience, stepUpProvided: true }, credential)).status).toBe(401);
      expect((await post("/authority/token", { grantId, actions: ["test-resource.delete"] }, credential)).status).toBe(401);
      expect((await post(`/authority/grants/${grantId}/revoke`, {}, credential)).status).toBe(401);
    }
    expect((await post("/authority/check", { ownerId: "someone-else", actor, action: "test-resource.read", resource, audience }, ownerSession)).status).toBe(403);
    for (const narrow of [{ actions: ["test-resource.delete"] }, { resources: ["test-resource:beta"] }, { ttlSeconds: 3600 }]) {
      expect((await post("/authority/token", { grantId, ...narrow }, ownerSession)).status).toBe(400);
    }
    expect(executions).toHaveLength(0);
  });
});
