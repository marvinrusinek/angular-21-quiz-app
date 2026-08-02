import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEV_DATABASE_PATH,
  E2E_DATABASE_PATH,
  E2E_DB_DIR,
  fingerprint,
  prepareE2eDatabase,
  purgeStaleDatabases
} from './e2e-database';

/**
 * Runs once before the whole suite, in the runner process, before any
 * webServer starts — so the backend picks up DATABASE_PATH from the start and
 * never opens the developer's database at all.
 */
export default function globalSetup(): void {
  prepareE2eDatabase();
  const swept = purgeStaleDatabases();
  if (swept.length > 0) {
    console.log(`[e2e-db] swept ${swept.length} stale database file(s) from a previous run`);
  }

  // Snapshot the dev database so teardown (and the isolation spec) can PROVE it
  // was never written to, rather than merely assuming it.
  writeFileSync(
    join(E2E_DB_DIR, 'dev-db-fingerprint.json'),
    JSON.stringify(fingerprint(DEV_DATABASE_PATH)),
    'utf8'
  );

  console.log(`[e2e-db] using throwaway database ${E2E_DATABASE_PATH}`);
}
