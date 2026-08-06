import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  E2E_DATABASE_NAME,
  devDatabaseName,
  e2eDatabaseExists,
  fingerprintDevDatabase,
  removeE2eDatabase,
  sameFingerprint,
  type DatabaseFingerprint
} from './e2e-database';
import { E2E_STATE_DIR } from './global-setup';

/**
 * Runs after the suite whether it passed or failed, so a red run cleans up as
 * thoroughly as a green one. Throwing here fails the run — deliberate: a leaked
 * database or a touched development database is a real defect in the harness,
 * not a cosmetic one.
 */
export default async function globalTeardown(): Promise<void> {
  // DROP ... WITH (FORCE) evicts the backend's still-open pool: Playwright
  // stops the webServer AFTER this hook. Under SQLite this needed a retry loop
  // for Windows file locks; a server-side drop has no such problem.
  const dropped = await removeE2eDatabase();

  let before: DatabaseFingerprint | null = null;
  const snapshotPath = join(E2E_STATE_DIR, 'dev-db-fingerprint.json');
  try {
    before = JSON.parse(readFileSync(snapshotPath, 'utf8')) as DatabaseFingerprint;
  } catch {
    before = null;   // setup did not run (e.g. --list); nothing to compare
  }
  rmSync(snapshotPath, { force: true });

  // A CHANGED development database is a genuine harness defect, so this fails
  // the run.
  if (before && !sameFingerprint(before, await fingerprintDevDatabase())) {
    throw new Error(
      `[e2e-db] the development database ${devDatabaseName()} changed during the run — ` +
      'E2E must never open it.'
    );
  }

  if (!dropped && await e2eDatabaseExists()) {
    // Not a hard failure: the next run's startup sweep collects it.
    console.warn(`[e2e-db] could not drop ${E2E_DATABASE_NAME} (will be swept next run)`);
    return;
  }

  console.log(`[e2e-db] dropped ${E2E_DATABASE_NAME}; development database untouched`);
}
