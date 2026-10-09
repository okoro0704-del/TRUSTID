import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const apiRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(apiRoot, "..", "..");
const vitest = resolve(repoRoot, "node_modules", "vitest", "vitest.mjs");

const env = { ...process.env };

// PostgreSQL contract runs provision their own explicitly supplied disposable
// database in tests/helpers/db.ts. Local SQLite runs need the URL before Vitest
// starts: setupFiles runs in a VM context and cannot safely configure the
// Prisma client imported by test modules.
if (!env.TRUSTID_TEST_POSTGRES_URL?.trim()) {
  const root = mkdtempSync(join(tmpdir(), "trustid-api-test-"));
  const database = join(root, "test.db").replaceAll("\\", "/");
  writeFileSync(database, "", { flag: "wx" });
  const schema = join(root, "schema.prisma");
  writeFileSync(schema, readFileSync(join(apiRoot, "prisma", "schema.prisma"), "utf8"));
  env.DATABASE_URL = `file:${database}`;
  const pushed = spawnSync(process.execPath, [resolve(repoRoot, "node_modules", "prisma", "build", "index.js"), "db", "push", "--skip-generate", "--schema", schema], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (pushed.status !== 0) process.exit(pushed.status ?? 1);
}

const result = spawnSync(process.execPath, [vitest, "run", ...process.argv.slice(2)], {
  cwd: apiRoot,
  env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
