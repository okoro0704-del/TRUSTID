import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { allowDisposableReset } from '../guard-local-reset.mjs';
const root = path.resolve('.');
const env = { NODE_ENV: 'development', PRISMA_PROVIDER: 'sqlite', DATABASE_URL: `file:${path.join(root, 'apps/api/prisma/trustid-disposable.db').replaceAll('\\', '/')}`, TRUSTID_CONFIRM_DISPOSABLE_RESET: 'DELETE_DISPOSABLE_TEST_DATA' };
test('reset guard permits only explicitly acknowledged disposable local database', () => assert.equal(allowDisposableReset(env, root), true));
for (const override of [{ NODE_ENV: 'production' }, { NODE_ENV: undefined }, { DATABASE_URL: 'postgres://example.invalid/private' }, { DATABASE_URL: 'file:valuable.db' }, { TRUSTID_CONFIRM_DISPOSABLE_RESET: '' }, { PRISMA_PROVIDER: 'postgresql' }]) {
  test(`reset guard denies ${Object.keys(override)[0]} variant ${Object.values(override)[0]}`, () => assert.equal(allowDisposableReset({ ...env, ...override }, root), false));
}
