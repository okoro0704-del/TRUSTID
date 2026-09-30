import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresAuthorityStore } from "@trustid/digi-authority";
import { openPostgresDigiCore } from "@trustid/digi-bridge";
import { buildDigiRp } from "../src/app.js";

const databaseUrl = process.env.DDI_TEST_DATABASE_URL ?? "";
const ISSUER = "https://trustedid.netlify.app/api";
const AUDIENCE = "digiconomy:digi";
const ddiRoot = "C:/Users/Hp/Desktop/DDI";

describe("real HTTP DDI authority acceptance", () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => {
    await Promise.all(closers.splice(0).map(close => close()));
  });

  it("activates a PDI connection from a reusable HTTP grant and honors both revocations", async () => {
    expect(databaseUrl).toMatch(/^postgres(ql)?:\/\//);
    const host = new URL(databaseUrl).hostname;
    expect(["127.0.0.1", "localhost", "::1"]).toContain(host);
    const digiSchema = "digi_pdi_contract";
    const authoritySchema = "authority_pdi_contract";
    const ddiSchema = "ddi_pdi_contract";
    const admin = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
    await admin.query(`DROP SCHEMA IF EXISTS ${digiSchema} CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS ${authoritySchema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${authoritySchema}`);
    await admin.query(`DROP SCHEMA IF EXISTS ${ddiSchema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${ddiSchema}`);
    await admin.end();
    const core = await openPostgresDigiCore(databaseUrl, { schema: digiSchema });
    closers.push(() => core.close());
    const authorityUrl = new URL(databaseUrl);
    authorityUrl.searchParams.set("options", `-c search_path=${authoritySchema}`);
    const authorityStore = new PostgresAuthorityStore(authorityUrl.toString());
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    privateJwk.kid = "pdi-contract";
    privateJwk.alg = "EdDSA";
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "trustid-proof";
    publicJwk.alg = "EdDSA";
    const previousNodeEnv = process.env.NODE_ENV;
    const previousKey = process.env.DIGI_AUTHORITY_PRIVATE_JWK;
    process.env.NODE_ENV = "production";
    process.env.DIGI_AUTHORITY_PRIVATE_JWK = JSON.stringify(privateJwk);
    let base = "";
    let digi: Awaited<ReturnType<typeof buildDigiRp>>;
    try {
      digi = await buildDigiRp({
        trustIdIssuer: ISSUER,
        jwksUrl: `${ISSUER}/jwks`,
        digiAudience: AUDIENCE,
        cookieSecret: "pdi-authority-contract-cookie-secret-32",
        corsOrigins: [],
        owners: core.owners,
        replay: core.replay,
        sessions: core.sessions,
        runWrite: core.runWrite,
        authorityStore,
        authorityPersistence: "postgres",
        fetchImpl: (async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousKey === undefined) delete process.env.DIGI_AUTHORITY_PRIVATE_JWK;
      else process.env.DIGI_AUTHORITY_PRIVATE_JWK = previousKey;
    }
    base = await digi.app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => digi.app.close());
    const assertion = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: "trustid-proof" }).setIssuer(ISSUER).setAudience(AUDIENCE).setSubject("subject-pdi-contract").setIssuedAt().setExpirationTime("2m").setJti(randomUUID()).sign(privateKey);
    const exchanged = await fetch(new URL("/auth/trustid/exchange", base), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assertion }) });
    expect(exchanged.status).toBe(200);
    const session = await exchanged.json() as { ownerId: string; sessionToken: string };
    const ddi = await import(pathToFileURL(join(ddiRoot, "packages/service/src/runtime.ts")).href) as typeof import("../../../../DDI/packages/service/src/runtime.ts");
    const repositoryModule = await import(pathToFileURL(join(ddiRoot, "packages/service/src/postgres-repository.ts")).href) as typeof import("../../../../DDI/packages/service/src/postgres-repository.ts");
    const postgresModule = await import(pathToFileURL(join(ddiRoot, "packages/service/src/postgres.ts")).href) as typeof import("../../../../DDI/packages/service/src/postgres.ts");
    const digiModule = await import(pathToFileURL(join(ddiRoot, "packages/service/src/digi.ts")).href) as typeof import("../../../../DDI/packages/service/src/digi.ts");
    const bindingModule = await import(pathToFileURL(join(ddiRoot, "packages/core/src/connection.ts")).href) as typeof import("../../../../DDI/packages/core/src/connection.ts");
    const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000, options: `-c search_path=${ddiSchema}` });
    closers.push(() => pool.end());
    await postgresModule.migrate(pool, join(ddiRoot, "migrations/001_ddi_foundation.sql"));
    await postgresModule.migrate(pool, join(ddiRoot, "migrations/002_ddi_runtime.sql"));
    await postgresModule.migrate(pool, join(ddiRoot, "migrations/003_pdi_connections.sql"));
    const repository = new repositoryModule.PostgresDdiRepository(pool);
    const grants = new digiModule.HttpDigiAuthorityGrantClient(base);
    const consume = new digiModule.HttpDigiAuthorityClient({ consumeUrl: `${base}/v1/authority/consume`, jwksUrl: `${base}/.well-known/authority-jwks.json`, verifierModuleUrl: pathToFileURL(join("C:/Users/Hp/Desktop/TRUST ID", "packages/authority-verifier/dist/index.js")).href });
    const service = new ddi.DurableDdiService(repository, ddi.authorityVerifier(consume), ddi.defaultAdapters(async () => ({ subject: "subject-pdi-contract" })), new digiModule.HttpDigiSessionClient(base), grants);
    const actor = await service.authenticate(session.sessionToken);
    expect(actor?.ownerId).toBe(session.ownerId);
    if (!actor) return;
    expect(await service.findPersonal(actor)).toBeNull();
    const infra = await service.provision(actor, { type: "PERSONAL", idempotencyKey: "pdi-contract" });
    const registered = await service.registerApp(actor, infra.id, { type: "REFERENCE", displayName: "Contract", capabilities: ["identity.currentActor", "data.read"], idempotencyKey: "pdi-contract-app" }) as { id: string; applicationCredential?: string };
    await service.bind(actor, infra.id, "identity", "TrustID");
    const requested = await service.requestConnection(registered.id, ["identity.currentActor", "data.read"], "contract-request", "contract-connection");
    expect(requested.status).toBe("REQUESTED");
    const headers = { authorization: `Bearer ${session.sessionToken}`, "content-type": "application/json" };
    const binding = bindingModule.authorityBinding(registered.id, infra.id, "identity.currentActor");
    const checked = await fetch(new URL("/authority/check", base), { method: "POST", headers, body: JSON.stringify({ actor: binding.actor, action: binding.action, resource: binding.resource, audience: binding.audience, ownerId: session.ownerId }) });
    const decision = await checked.json() as { decision: string; requestId?: string };
    expect(decision.decision).toBe("ASK_OWNER");
    const dataBinding = bindingModule.authorityBinding(registered.id, infra.id, "data.read");
    const dataCheck = await fetch(new URL("/authority/check", base), { method: "POST", headers, body: JSON.stringify({ actor: dataBinding.actor, action: dataBinding.action, resource: dataBinding.resource, audience: dataBinding.audience }) });
    expect((await dataCheck.json() as { decision: string }).decision).toBe("ASK_OWNER");
    const approved = await fetch(new URL(`/authority/requests/${decision.requestId}/approve`, base), { method: "POST", headers, body: JSON.stringify({ oneTime: false }) });
    const created = await approved.json() as { grantId: string; oneTime: boolean };
    expect(created.oneTime).toBe(false);
    const active = await service.approveConnection(actor, requested.id, ["identity.currentActor"], "contract-approve", session.sessionToken);
    expect(active.status).toBe("ACTIVE");
    expect(active.approvedCapabilities).toEqual(["identity.currentActor"]);
    expect(active.authorityGrantRefs.map(item => item.grantId)).toEqual([created.grantId]);
    const issue = async () => {
      const response = await fetch(new URL("/authority/token", base), { method: "POST", headers, body: JSON.stringify({ grantId: created.grantId }) });
      expect(response.status).toBe(200);
      return (await response.json() as { token: string }).token;
    };
    const execute = (token: string, correlationId: string, capability: "identity.currentActor" | "data.read" = "identity.currentActor") => {
      const selected = capability === "identity.currentActor" ? binding : dataBinding;
      return service.execute({ infrastructureId: infra.id, applicationId: registered.id as never, capability, action: selected.action, resource: selected.resource, audience: selected.audience, actor: { ownerId: actor.ownerId, kind: "SERVICE", verified: true, authorityActor: selected.actor }, authority: { token }, correlationId, executionMode: "APP" });
    };
    const firstToken = await issue();
    const secondToken = await issue();
    expect((await execute(firstToken, "contract-1")).status).toBe("COMPLETED");
    expect((await execute(secondToken, "contract-2")).status).toBe("COMPLETED");
    const thirdToken = await issue();
    expect((await execute("not-a-grant", "contract-data", "data.read")).reason).toBe("CAPABILITY_NOT_APPROVED");
    const revokedConnection = await service.requestConnection(registered.id, ["identity.currentActor"], "contract-second", "contract-second-key").catch(() => null);
    expect(revokedConnection).toBeNull();
    const secondApp = await service.registerApp(actor, infra.id, { type: "REFERENCE", displayName: "Second", capabilities: ["identity.currentActor"], idempotencyKey: "pdi-contract-app-2" }) as { id: string };
    const secondRequest = await service.requestConnection(secondApp.id, ["identity.currentActor"], "second-request", "second-connection");
    const secondBinding = bindingModule.authorityBinding(secondApp.id, infra.id, "identity.currentActor");
    const secondCheck = await fetch(new URL("/authority/check", base), { method: "POST", headers, body: JSON.stringify({ actor: secondBinding.actor, action: secondBinding.action, resource: secondBinding.resource, audience: secondBinding.audience }) });
    const secondDecision = await secondCheck.json() as { decision: string; requestId: string };
    expect(secondDecision.decision).toBe("ASK_OWNER");
    const secondApproved = await fetch(new URL(`/authority/requests/${secondDecision.requestId}/approve`, base), { method: "POST", headers, body: JSON.stringify({ oneTime: false }) });
    const secondGrant = await secondApproved.json() as { grantId: string };
    const secondActive = await service.approveConnection(actor, secondRequest.id, ["identity.currentActor"], "second-approve", session.sessionToken);
    expect(secondActive.authorityGrantRefs[0]?.grantId).toBe(secondGrant.grantId);
    const liveToken = await (await fetch(new URL("/authority/token", base), { method: "POST", headers, body: JSON.stringify({ grantId: secondGrant.grantId }) })).json() as { token: string };
    await service.revokeConnection(actor, secondRequest.id, "connection-revoke", session.sessionToken);
    const blocked = await service.execute({ infrastructureId: infra.id, applicationId: secondApp.id as never, capability: "identity.currentActor", action: secondBinding.action, resource: secondBinding.resource, audience: secondBinding.audience, actor: { ownerId: actor.ownerId, kind: "SERVICE", verified: true, authorityActor: secondBinding.actor }, authority: { token: liveToken.token }, correlationId: "after-connection-revoke" });
    expect(blocked.reason).toBe("CONNECTION_NOT_ACTIVE");
    const stillActive = await fetch(new URL(`/authority/grants/${secondGrant.grantId}`, base), { headers });
    expect((await stillActive.json() as { grant: { status: string } }).grant.status).toBe("REVOKED");
    await fetch(new URL(`/authority/grants/${created.grantId}/revoke`, base), { method: "POST", headers });
    const retired = await fetch(new URL("/authority/token", base), { method: "POST", headers, body: JSON.stringify({ grantId: created.grantId }) });
    expect(retired.status).toBe(400);
    const denied = await execute(thirdToken, "contract-3");
    expect(denied.status).toBe("DENIED");
    const text = JSON.stringify(await repository.snapshot());
    expect(text.includes(session.sessionToken)).toBe(false);
    expect(text.includes(firstToken)).toBe(false);
    expect(text.includes(assertion)).toBe(false);
    expect(text.includes(registered.applicationCredential ?? "missing-secret")).toBe(false);
  });
});
