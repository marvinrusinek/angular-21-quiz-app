import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEV_DATABASE_PATH,
  E2E_DATABASE_PATH,
  E2E_DB_DIR,
  fingerprint,
  removeE2eDatabase,
  sameFingerprint,
  type DatabaseFingerprint
} from './e2e-database';

/**
 * Runs after the suite whether it passed or failed, so a red run cleans up as
 * thoroughly as a green one. Throwing here fails the run — deliberate: a leaked
 * database or a touched development database is a real defect in the harness,
 * not a cosmetic one.
 */
export default function globalTeardown(): void {
  const leftovers = removeE2eDatabase();

  let before: DatabaseFingerprint | null = null;
  const snapshotPath = join(E2E_DB_DIR, 'dev-db-fingerprint.json');
  try {
    before = JSON.parse(readFileSync(snapshotPath, 'utf8')) as DatabaseFingerprint;
  } catch {
    before = null;   // setup did not run (e.g. --list); nothing to compare
  }
  rmSync(snapshotPath, { force: true });

  // A database the OS still has locked is NOT a failure: Playwright stops the
  // webServer after this hook, so the lock disappears moments later. Retry once
  // the runner itself exits, by which point the backend is gone.
  if (leftovers.length > 0) {
    process.on('exit', () => {
      const stillThere = removeE2eDatabase(4, 100);
      if (stillThere.length > 0) {
        // The next run's startup sweep will collect it — never a hard failure
        // on a green suite because of a filesystem lock.
        console.warn(`[e2e-db] left behind (will be swept next run): ${stillThere.join(', ')}`);
      }
    });
  }

  // A CHANGED development database is a genuine harness defect, so this does
  // fail the run.
  if (before && !sameFingerprint(before, fingerprint(DEV_DATABASE_PATH))) {
    throw new Error(
      `[e2e-db] the development database at ${DEV_DATABASE_PATH} changed during the run — ` +
      'E2E must never open it.'
    );
  }

  console.log(
    leftovers.length === 0
      ? `[e2e-db] removed ${E2E_DATABASE_PATH} (+ -wal, -shm); development database untouched`
      : `[e2e-db] retrying removal of ${E2E_DATABASE_PATH} at exit; development database untouched`
  );
}
