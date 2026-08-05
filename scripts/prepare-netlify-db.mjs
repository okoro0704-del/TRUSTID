/**
 * Creates apps/api/prisma/template.db for Netlify Functions (/tmp copy on cold start).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = path.join(root, "apps/api");
const templatePath = path.join(apiDir, "prisma", "template.db");

for (const p of [
  templatePath,
  `${templatePath}-journal`,
  `${templatePath}-wal`,
  `${templatePath}-shm`,
]) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

execSync("node scripts/sync-prisma-provider.mjs", {
  cwd: root,
  env: {
    ...process.env,
    DATABASE_URL: `file:${templatePath}`,
    PRISMA_PROVIDER: "sqlite",
  },
  stdio: "inherit",
});

execSync("npx prisma db push --skip-generate", {
  cwd: apiDir,
  env: {
    ...process.env,
    DATABASE_URL: `file:${templatePath}`,
  },
  stdio: "inherit",
});

execSync("npx tsx prisma/seed.ts", {
  cwd: apiDir,
  env: {
    ...process.env,
    DATABASE_URL: `file:${templatePath}`,
  },
  stdio: "inherit",
});

console.log("Created", templatePath);
