import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function allowDisposableReset(env, root) {
  const target = path.join(root, 'apps/api/prisma/trustid-disposable.db');
  return env.NODE_ENV === 'development' && env.TRUSTID_CONFIRM_DISPOSABLE_RESET === 'DELETE_DISPOSABLE_TEST_DATA' &&
    env.DATABASE_URL === `file:${target.replaceAll('\\', '/')}` && env.PRISMA_PROVIDER === 'sqlite';
}

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--explain') || !allowDisposableReset(process.env, root)) {
    console.error('Setup never resets data implicitly. Install dependencies and build separately. Reset is restricted to an explicitly acknowledged development-only apps/api/prisma/trustid-disposable.db; see docs/AUTHORITY_FOUNDATION_V1.md.');
    process.exitCode = 1;
  } else {
    const schema = path.join(root, 'apps/api/prisma/schema.prisma');
    const { readFileSync } = await import('node:fs');
    if (!/datasource db\s*\{\s*provider\s*=\s*"sqlite"/.test(readFileSync(schema, 'utf8'))) throw new Error('Reset requires SQLite schema');
    const child = spawnSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--force-reset', '--schema', schema], { env: process.env, stdio: 'inherit' });
    process.exitCode = child.status ?? 1;
  }
}
