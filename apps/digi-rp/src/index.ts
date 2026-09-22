import {
  PostgresAuthorityStore,
  MemoryAuthorityStore,
  loadSqliteAuthorityStore,
  type AuthorityStore,
} from "@trustid/digi-authority";
import { buildDigiRp } from "./app.js";

const port = Number(process.env.PORT ?? 8795);
const databaseUrl =
  process.env.DIGI_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
const nodeEnv = process.env.NODE_ENV ?? "development";

async function createAuthorityStore(): Promise<{
  store: AuthorityStore;
  persistence: "postgres" | "sqlite" | "memory";
}> {
  if (databaseUrl?.startsWith("postgres")) {
    return {
      store: new PostgresAuthorityStore(databaseUrl),
      persistence: "postgres",
    };
  }
  if (nodeEnv === "production") {
    throw new Error(
      "DIGI_DATABASE_URL (postgres) required in production — refusing memory store"
    );
  }
  if (process.env.DIGI_AUTHORITY_SQLITE === "1") {
    const { SqliteAuthorityStore } = await loadSqliteAuthorityStore();
    return {
      store: new SqliteAuthorityStore(
        process.env.DIGI_AUTHORITY_SQLITE_PATH?.trim() || ":memory:"
      ),
      persistence: "sqlite",
    };
  }
  return { store: new MemoryAuthorityStore(), persistence: "memory" };
}

const { store, persistence } = await createAuthorityStore();

const { app } = await buildDigiRp({
  trustIdIssuer:
    process.env.TRUSTID_ISSUER?.trim() ||
    "https://trustedid.netlify.app/api",
  jwksUrl:
    process.env.TRUSTID_JWKS_URL?.trim() ||
    "https://lucid-integrity-production.up.railway.app/.well-known/jwks.json",
  digiAudience: process.env.DIGI_AUDIENCE?.trim(),
  cookieSecret: process.env.DIGI_COOKIE_SECRET,
  authorityStore: store,
  authorityPersistence: persistence,
});

await app.listen({ port, host: "0.0.0.0" });
console.log(`[digi-rp] listening on :${port} persistence=${persistence}`);
