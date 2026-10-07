/**
 * Durable Digi Core acceptance tests against disposable local PostgreSQL.
 * Skipped unless DIGI_CORE_TEST_DATABASE_URL points at localhost.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as jose from "jose";
import { DIGI_AUDIENCE_PRODUCTION } from "@trustid/shared";
import {
  createJwksCache,
  exchangeTrustIdAssertion,
  loadDigiCoreSchemaSql,
  openPostgresDigiCore,
  type DigiAuditSink,
  type DigiCoreHandle,
} from "../src/index.js";

const PG_URL = process.env.DIGI_CORE_TEST_DATABASE_URL;
const SCHEMA = "digi_bridge_accept";
const ISSUER = "https://trustedid.netlify.app/api";
const AUD = DIGI_AUDIENCE_PRODUCTION;
const SUBJECT = "trustid-subject-durable-core";

function assertDisposable(url: string) {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Digi Core Postgres tests only run against a local disposable database");
  }
}

async function mintKey() {
  const { privateKey, publicKey } = await jose.generateKeyPair("EdDSA", { extractable: true });
  const publicJwk = await jose.exportJWK(publicKey);
  const kid = createHash("sha256").update(JSON.stringify(publicJwk)).digest("hex").slice(0, 16);
  publicJwk.kid = kid;
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";
  return {
    privateKey,
    publicJwk,
    kid,
    async sign(claims: {
      sub?: string;
      aud?: string;
      iss?: string;
      jti?: string;
      iat?: number;
      nbf?: number;
      exp?: number;
      omitSub?: boolean;
    } = {}) {
      const now = Math.floor(Date.now() / 1000);
      const iat = claims.iat ?? now;
      const builder = new jose.SignJWT({})
        .setProtectedHeader({ alg: "EdDSA", kid, typ: "JWT" })
        .setIssuer(claims.iss ?? ISSUER)
        .setAudience(claims.aud ?? AUD)
        .setIssuedAt(iat)
        .setNotBefore(claims.nbf ?? iat)
        .setExpirationTime(claims.exp ?? now + 60)
        .setJti(claims.jti ?? crypto.randomUUID());
      if (!claims.omitSub) builder.setSubject(claims.sub ?? SUBJECT);
      return builder.sign(privateKey);
    },
  };
}

function jwksFrom(publicJwk: jose.JWK) {
  const body = JSON.stringify({ keys: [publicJwk] });
  return createJwksCache({
    jwksUrl: "https://jwks.test/jwks.json",
    fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
  });
}

async function count(core: DigiCoreHandle, table: string) {
  if (!/^[a-z_]+$/.test(table)) throw new Error("bad table");
  const result = await core.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  return Number(result.rows[0].n);
}

function queryInNewProcess(sql: string): Promise<unknown[]> {
  const source = `
    import pg from "pg";
    const pool = new pg.Pool({
      connectionString: process.env.DIGI_CORE_TEST_DATABASE_URL,
      max: 1,
      options: "-c search_path=" + process.env.DIGI_SCHEMA,
    });
    const result = await pool.query(process.env.DIGI_SQL);
    process.stdout.write(JSON.stringify(result.rows));
    await pool.end();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), "../../.."),
      env: {
        ...process.env,
        DIGI_CORE_TEST_DATABASE_URL: PG_URL,
        DIGI_SQL: sql,
        DIGI_SCHEMA: SCHEMA,
      },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const detail = err.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://redacted").slice(0, 400);
        reject(new Error(`restart probe exited ${code}: ${detail}`));
        return;
      }
      resolve(JSON.parse(out) as unknown[]);
    });
    void err;
  });
}

describe.skipIf(!PG_URL)("PostgreSQL Digi Core", () => {
  let core: DigiCoreHandle;
  let key: Awaited<ReturnType<typeof mintKey>>;
  let jwks: ReturnType<typeof jwksFrom>;

  beforeAll(async () => {
    assertDisposable(PG_URL!);
    core = await openPostgresDigiCore(PG_URL!, { schema: SCHEMA });
  });

  afterAll(async () => {
    await core?.close();
  });

  beforeEach(async () => {
    key = await mintKey();
    jwks = jwksFrom(key.publicJwk);
    await core.pool.query(
      `TRUNCATE digi_sessions, consumed_assertions, external_identities, digi_owners RESTART IDENTITY CASCADE`,
    );
  });

  async function exchange(assertion: string, audit?: DigiAuditSink) {
    return exchangeTrustIdAssertion({
      assertion,
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks,
      owners: core.owners,
      replay: core.replay,
      sessions: core.sessions,
      audit,
      runWrite: core.runWrite,
    });
  }

  it("reuses the existing migration and its canonical constraints", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const migrations = readdirSync(join(here, "../../../apps/digi-rp/migrations")).filter((name) => name.endsWith(".sql")).sort();
    expect(migrations).toEqual(["001_init.sql", "002_authority.sql"]);
    const sql = loadDigiCoreSchemaSql();
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS digi_owners");
    expect(sql).toContain("UNIQUE (issuer, subject)");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS consumed_assertions");
    expect(sql).toContain("token_hash TEXT NOT NULL UNIQUE");
    const constraints = await core.pool.query(
      `SELECT conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE connamespace = current_schema()::regnamespace`,
    );
    const defs = constraints.rows.map((row) => `${row.table_name} ${row.def}`).join("\n");
    expect(defs).toContain("UNIQUE (issuer, subject)");
    expect(defs).toContain("PRIMARY KEY (jti)");
    expect(defs).toContain("UNIQUE (token_hash)");
    const indexes = await core.pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
    );
    const names = indexes.rows.map((row) => String(row.indexname));
    expect(names).toContain("digi_sessions_owner_id_idx");
    expect(names).toContain("external_identities_owner_id_idx");
    expect(names).toContain("consumed_assertions_expires_at_idx");
  });

  it("maps one issuer+subject to one owner across a new database client", async () => {
    const first = await exchange(await key.sign({ jti: "jti-owner-a" }));
    const second = await exchange(await key.sign({ jti: "jti-owner-b" }));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.ownerCreated).toBe(true);
    expect(second.ownerCreated).toBe(false);
    expect(second.ownerId).toBe(first.ownerId);
    expect(first.ownerId).not.toBe(SUBJECT);
    await core.close();
    core = await openPostgresDigiCore(PG_URL!, { schema: SCHEMA });
    const rows = await queryInNewProcess(`SELECT id FROM digi_owners`);
    expect(rows).toEqual([{ id: first.ownerId }]);
    const third = await exchange(await key.sign({ jti: "jti-owner-c" }));
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.ownerId).toBe(first.ownerId);
    expect(await count(core, "digi_owners")).toBe(1);
    expect(await count(core, "external_identities")).toBe(1);
  });

  it("lists only the requested owner's identities across a new database client", async () => {
    const ownerA = await core.owners.resolveOrCreate({ issuer: ISSUER, subject: "trustid-subject-owner-a" });
    const ownerB = await core.owners.resolveOrCreate({ issuer: ISSUER, subject: "trustid-subject-owner-b" });
    expect(ownerA.owner.id).not.toBe(ownerB.owner.id);

    const assertIsolated = async () => {
      const identitiesA = await core.owners.listForOwner(ownerA.owner.id);
      const identitiesB = await core.owners.listForOwner(ownerB.owner.id);
      expect(identitiesA.map((identity) => [identity.ownerId, identity.issuer, identity.subject]))
        .toEqual([[ownerA.owner.id, ISSUER, "trustid-subject-owner-a"]]);
      expect(identitiesB.map((identity) => [identity.ownerId, identity.issuer, identity.subject]))
        .toEqual([[ownerB.owner.id, ISSUER, "trustid-subject-owner-b"]]);
    };

    await assertIsolated();
    await core.close();
    core = await openPostgresDigiCore(PG_URL!, { schema: SCHEMA });
    await assertIsolated();
  });

  it("creates one owner under concurrent first login", async () => {
    const requests = 16;
    const results = await Promise.all(
      Array.from({ length: requests }, (_, index) =>
        key.sign({ jti: `jti-race-${index}` }).then((assertion) => exchange(assertion)),
      ),
    );
    const successes = results.filter((result) => result.ok);
    const failures = results.filter((result) => !result.ok);
    expect(failures).toHaveLength(0);
    expect(successes).toHaveLength(requests);
    const ownerIds = new Set(successes.map((result) => (result.ok ? result.ownerId : "")));
    expect(ownerIds.size).toBe(1);
    expect(await count(core, "digi_owners")).toBe(1);
    expect(await count(core, "external_identities")).toBe(1);
    expect(await count(core, "digi_sessions")).toBe(requests);
  });

  it("consumes one assertion under concurrency and still rejects it after restart", async () => {
    const assertion = await key.sign({ jti: "jti-replay-once" });
    const attempts = 12;
    const results = await Promise.all(Array.from({ length: attempts }, () => exchange(assertion)));
    const accepted = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(attempts - 1);
    expect(rejected.every((result) => !result.ok && result.reason === "replay")).toBe(true);
    expect(await count(core, "consumed_assertions")).toBe(1);
    await core.close();
    core = await openPostgresDigiCore(PG_URL!, { schema: SCHEMA });
    const again = await exchange(assertion);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("replay");
    expect(await count(core, "consumed_assertions")).toBe(1);
  });

  it("keeps sessions across restart until revocation or expiry", async () => {
    const audit: Array<{ event: string; meta: Record<string, unknown> }> = [];
    const sink: DigiAuditSink = {
      record(event, meta) {
        audit.push({ event, meta });
      },
    };
    core.sessions.setAudit?.(sink);
    const created = await exchange(await key.sign({ jti: "jti-session-live" }), sink);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const live = await core.sessions.resolve(created.sessionToken);
    expect(live?.id).toBe(created.sessionId);
    await core.close();
    core = await openPostgresDigiCore(PG_URL!, { schema: SCHEMA });
    core.sessions.setAudit?.(sink);
    const afterRestart = await core.sessions.resolve(created.sessionToken);
    expect(afterRestart?.ownerId).toBe(created.ownerId);
    expect(afterRestart?.revokedAt).toBeNull();
    await core.sessions.revoke(created.sessionId);
    expect(await core.sessions.resolve(created.sessionToken)).toBeNull();
    await core.close();
    core = await openPostgresDigiCore(PG_URL!, { schema: SCHEMA });
    expect(await core.sessions.resolve(created.sessionToken)).toBeNull();
    expect(audit.some((event) => event.event === "digi_session_revoked")).toBe(true);

    const expired = await core.sessions.create({ ownerId: created.ownerId, ttlSeconds: -30 });
    core.sessions.setAudit?.(sink);
    expect(await core.sessions.resolve(expired.token)).toBeNull();
    expect(audit.some((event) => event.event === "digi_session_expired" && event.meta.sessionId === expired.session.id)).toBe(true);
    const leaked = JSON.stringify(audit);
    expect(leaked.includes(created.sessionToken)).toBe(false);
    expect(leaked.includes(expired.token)).toBe(false);
  });

  it("stores only the session hash and never the raw assertion", async () => {
    const assertion = await key.sign({ jti: "jti-secret-isolation" });
    const audit: Array<{ event: string; meta: Record<string, unknown> }> = [];
    const result = await exchange(assertion, {
      record(event, meta) {
        audit.push({ event, meta });
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dump = await core.pool.query(
      `SELECT coalesce(string_agg(value, ' '), '') AS blob FROM (
         SELECT id AS value FROM digi_owners
         UNION ALL SELECT issuer FROM external_identities
         UNION ALL SELECT subject FROM external_identities
         UNION ALL SELECT jti FROM consumed_assertions
         UNION ALL SELECT token_hash FROM digi_sessions
         UNION ALL SELECT id FROM digi_sessions
       ) rows`,
    );
    const blob = String(dump.rows[0].blob);
    if (blob.includes(assertion) || blob.includes(result.sessionToken)) {
      throw new Error("raw assertion or session token was persisted");
    }
    const session = await core.sessions.resolve(result.sessionToken);
    expect(session?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(session?.tokenHash).not.toBe(result.sessionToken);
    const auditBlob = JSON.stringify(audit);
    if (auditBlob.includes(assertion) || auditBlob.includes(result.sessionToken)) {
      throw new Error("raw assertion or session token was audited");
    }
    expect(audit.map((event) => event.event)).toEqual([
      "trust_assertion_accepted",
      "digi_owner_created",
      "digi_session_created",
    ]);
  });

  it("rolls back consumption when session creation fails", async () => {
    const assertion = await key.sign({ jti: "jti-rollback" });
    const brokenSessions = {
      durability: "postgres" as const,
      async create(): Promise<never> {
        throw new Error("session store down");
      },
      async resolve() {
        return null;
      },
      async revoke() {
        return undefined;
      },
    };
    await expect(
      exchangeTrustIdAssertion({
        assertion,
        expectedIssuer: ISSUER,
        expectedAudience: AUD,
        jwks,
        owners: core.owners,
        replay: core.replay,
        sessions: brokenSessions,
        runWrite: core.runWrite,
      }),
    ).rejects.toThrow(/persistence failed/);
    expect(await count(core, "digi_owners")).toBe(0);
    expect(await count(core, "consumed_assertions")).toBe(0);
    expect(await count(core, "digi_sessions")).toBe(0);
    const retried = await exchange(assertion);
    expect(retried.ok).toBe(true);
  });

  it("rejects bad TrustID assertions without writing Digi state", async () => {
    const authorityTable = await core.pool.query(`SELECT to_regclass('public.authority_grants') AS name`);
    const grantsBefore = authorityTable.rows[0].name
      ? Number((await core.pool.query(`SELECT count(*)::int AS n FROM public.authority_grants`)).rows[0].n)
      : 0;
    const now = Math.floor(Date.now() / 1000);
    const other = await mintKey();
    const badSignature = await new jose.SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ: "JWT" })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setSubject(SUBJECT)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti("bad-sig")
      .sign(other.privateKey);
    const cases: Array<{ name: string; assertion: string; reason: string }> = [
      { name: "issuer", assertion: await key.sign({ iss: "https://evil.invalid", jti: "bad-iss" }), reason: "issuer_mismatch" },
      { name: "audience", assertion: await key.sign({ aud: "lifeos", jti: "bad-aud" }), reason: "audience_mismatch" },
      { name: "signature", assertion: badSignature, reason: "bad_signature" },
      { name: "expired", assertion: await key.sign({ iat: now - 120, nbf: now - 120, exp: now - 60, jti: "bad-exp" }), reason: "expired" },
      { name: "nbf", assertion: await key.sign({ iat: now, nbf: now + 600, exp: now + 900, jti: "bad-nbf" }), reason: "not_active" },
      { name: "malformed", assertion: "this-is-not-a-valid-assertion", reason: "malformed_jwt" },
    ];
    const emptyJwks = createJwksCache({
      jwksUrl: "https://jwks.test/empty.json",
      fetchImpl: async () => new Response(JSON.stringify({ keys: [] }), { status: 200 }),
    });
    const unknownKid = await exchangeTrustIdAssertion({
      assertion: await key.sign({ jti: "bad-kid" }),
      expectedIssuer: ISSUER,
      expectedAudience: AUD,
      jwks: emptyJwks,
      owners: core.owners,
      replay: core.replay,
      sessions: core.sessions,
      runWrite: core.runWrite,
    });
    expect(unknownKid.ok).toBe(false);
    if (!unknownKid.ok) expect(unknownKid.reason).toBe("unknown_kid");
    for (const item of cases) {
      const result = await exchange(item.assertion);
      expect(result.ok, item.name).toBe(false);
      if (!result.ok) expect(result.reason, item.name).toBe(item.reason);
    }
    expect(await count(core, "digi_owners")).toBe(0);
    expect(await count(core, "consumed_assertions")).toBe(0);
    expect(await count(core, "digi_sessions")).toBe(0);
    const authorityAfter = await core.pool.query(`SELECT to_regclass('public.authority_grants') AS name`);
    const grantsAfter = authorityAfter.rows[0].name
      ? Number((await core.pool.query(`SELECT count(*)::int AS n FROM public.authority_grants`)).rows[0].n)
      : 0;
    expect(grantsAfter).toBe(grantsBefore);
  });
});
