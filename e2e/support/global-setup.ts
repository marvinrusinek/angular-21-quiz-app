import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  E2E_DATABASE_NAME,
  devDatabaseName,
  fingerprintDevDatabase,
  prepareE2eDatabase,
  purgeStaleDatabases
} from './e2e-database';

/** Scratch directory for the run's bookkeeping. Git-ignored. */
export const E2E_STATE_DIR = resolve(__dirname, '..', '..', '.e2e-db');

/**
 * Runs once before the whole suite, in the runner process, before any webServer
 * starts — so the backend picks up DATABASE_URL from the start and never opens
 * the developer's database at all.
 */
export default async function globalSetup(): Promise<void> {
  mkdirSync(E2E_STATE_DIR, { recursive: true });

  const swept = await purgeStaleDatabases();
  if (swept.length > 0) {
    console.log(`[e2e-db] swept ${swept.length} stale database(s) from a previous run`);
  }

  await prepareE2eDatabase();

  // Snapshot the dev database so teardown (and the isolation spec) can PROVE it
  // was never written to, rather than merely assuming it.
  writeFileSync(
    join(E2E_STATE_DIR, 'dev-db-fingerprint.json'),
    JSON.stringify(await fingerprintDevDatabase()),
    'utf8'
  );

  console.log(
    `[e2e-db] using throwaway database ${E2E_DATABASE_NAME} ` +
    `(development database ${devDatabaseName()} is untouched)`
  );
}
