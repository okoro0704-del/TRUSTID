/**
 * Align Prisma datasource provider with DATABASE_URL.
 * - postgres/postgresql → postgresql (Railway)
 * - file: (or unset/other) → sqlite (local, Netlify template)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "apps/api/prisma/schema.prisma");

const url = process.env.DATABASE_URL ?? "";
const force = process.env.PRISMA_PROVIDER; // optional override: sqlite | postgresql

let provider = "sqlite";
if (force === "sqlite" || force === "postgresql") {
  provider = force;
} else if (/^postgres(ql)?:\/\//i.test(url)) {
  provider = "postgresql";
} else if (/^file:/i.test(url) || !url) {
  provider = "sqlite";
} else if (/^mysql:\/\//i.test(url)) {
  console.error(
    "MySQL is not supported. Use PostgreSQL (Railway) or SQLite (file:).",
  );
  process.exit(1);
} else {
  // Unknown URL — keep sqlite for local defaults, but warn.
  console.warn(
    `[sync-prisma-provider] Unrecognized DATABASE_URL protocol; defaulting to sqlite. URL starts with: ${url.slice(0, 24)}…`,
  );
}

const schema = fs.readFileSync(schemaPath, "utf8");
const next = schema.replace(
  /datasource db \{[\s\S]*?\n\}/,
  `datasource db {\n  provider = "${provider}"\n  url      = env("DATABASE_URL")\n}`,
);

if (next === schema) {
  // Still rewrite provider line if block format differs slightly
  const lineFixed = schema.replace(
    /provider\s*=\s*"(sqlite|postgresql|mysql)"/,
    `provider = "${provider}"`,
  );
  fs.writeFileSync(schemaPath, lineFixed);
} else {
  fs.writeFileSync(schemaPath, next);
}

console.log(`[sync-prisma-provider] provider=${provider}`);
