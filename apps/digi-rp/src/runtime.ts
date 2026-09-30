import {
  MemoryAuthorityStore,
  PostgresAuthorityStore,
  loadSqliteAuthorityStore,
  type AuthorityStore,
} from "@trustid/digi-authority";
import { openPostgresDigiCore, type DigiCoreHandle } from "@trustid/digi-bridge";
import { buildDigiRp } from "./app.js";

export type DigiPersistence = "postgres" | "sqlite" | "memory";

export type ComposeDigiRuntimeInput = {
  env?: NodeJS.ProcessEnv;
  databaseUrl?: string;
  /** Test isolation schema. Production uses public on Digi's own database. */
  schema?: string;
  fetchImpl?: typeof fetch;
};

function configuredDatabaseUrl(env: NodeJS.ProcessEnv, override?: string): string {
  return (override ?? env.DIGI_DATABASE_URL ?? env.DATABASE_URL ?? "").trim();
}

/**
 * Production composition for Digi RP.
 * PostgreSQL owner, replay, session, and authority stores are required.
 * Memory stores are only selected when NODE_ENV is not production and no
 * Postgres URL is configured. A configured Postgres URL that cannot be
 * opened fails closed in every environment.
 */
export async function composeDigiRuntime(input: ComposeDigiRuntimeInput = {}) {
  const env = input.env ?? process.env;
  const nodeEnv = env.NODE_ENV ?? "development";
  const production = nodeEnv === "production";
  const databaseUrl = configuredDatabaseUrl(env, input.databaseUrl);

  let core: DigiCoreHandle | undefined;
  let authorityStore: AuthorityStore;
  let persistence: DigiPersistence;

  if (databaseUrl.startsWith("postgres")) {
    core = await openPostgresDigiCore(databaseUrl, { schema: input.schema });
    const authority = new PostgresAuthorityStore(databaseUrl);
    try {
      await authority.getGrant("digi-core-startup-probe");
    } catch {
      await authority.close().catch(() => undefined);
      await core.close().catch(() => undefined);
      throw new Error(
        "Digi authority PostgreSQL unavailable — refusing memory fallback",
      );
    }
    authorityStore = authority;
    persistence = "postgres";
    try {
      const built = await buildDigiRp({
        trustIdIssuer:
          env.TRUSTID_ISSUER?.trim() || "https://trustedid.netlify.app/api",
        jwksUrl:
          env.TRUSTID_JWKS_URL?.trim() ||
          "https://lucid-integrity-production.up.railway.app/.well-known/jwks.json",
        digiAudience: env.DIGI_AUDIENCE?.trim(),
        cookieSecret: env.DIGI_COOKIE_SECRET,
        owners: core.owners,
        replay: core.replay,
        sessions: core.sessions,
        runWrite: core.runWrite,
        authorityStore,
        authorityPersistence: persistence,
        fetchImpl: input.fetchImpl,
      });
      return {
        ...built,
        persistence,
        corePersistence: "postgres" as const,
        close: async () => {
          await core?.close();
          await authority.close();
        },
      };
    } catch (err) {
      await authority.close().catch(() => undefined);
      await core.close().catch(() => undefined);
      throw err;
    }
  }

  if (production) {
    throw new Error(
      "DIGI_DATABASE_URL (postgres) required in production — refusing memory owner, replay, session, and authority stores",
    );
  }

  if (env.DIGI_AUTHORITY_SQLITE === "1") {
    const { SqliteAuthorityStore } = await loadSqliteAuthorityStore();
    authorityStore = new SqliteAuthorityStore(
      env.DIGI_AUTHORITY_SQLITE_PATH?.trim() || ":memory:",
    );
    persistence = "sqlite";
  } else {
    authorityStore = new MemoryAuthorityStore();
    persistence = "memory";
  }

  const built = await buildDigiRp({
    trustIdIssuer:
      env.TRUSTID_ISSUER?.trim() || "https://trustedid.netlify.app/api",
    jwksUrl:
      env.TRUSTID_JWKS_URL?.trim() ||
      "https://lucid-integrity-production.up.railway.app/.well-known/jwks.json",
    digiAudience: env.DIGI_AUDIENCE?.trim(),
    cookieSecret: env.DIGI_COOKIE_SECRET,
    authorityStore,
    authorityPersistence: persistence,
  });
  return {
    ...built,
    persistence,
    corePersistence: "memory" as const,
    close: async () => {
      const closable = authorityStore as AuthorityStore & {
        close?: () => Promise<void>;
      };
      if (typeof closable.close === "function") await closable.close();
    },
  };
}
