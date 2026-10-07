#!/usr/bin/env node
/**
 * Before `prisma db push` on PostgreSQL: create the extensions the schema's
 * column types need (pgvector for biometric_embeddings.vector), so a fresh
 * database can be pushed. No-op for SQLite.
 *
 * Usage (from apps/api): node ../../scripts/ensure-pg-extensions.mjs
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const url = process.env.DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\//i.test(url)) {
  console.log("[ensure-pg-extensions] not PostgreSQL; skipped");
  process.exit(0);
}
const require = createRequire(import.meta.url);
const prismaCli = require.resolve("prisma/build/index.js");
execFileSync(process.execPath, [prismaCli, "db", "execute", "--url", url, "--stdin"], {
  input: "CREATE EXTENSION IF NOT EXISTS vector;",
  stdio: ["pipe", "inherit", "inherit"],
});
console.log("[ensure-pg-extensions] vector extension present");
