import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * Throwaway SQLite database for a Playwright run.
 *
 * E2E drives the REAL backend, so every interview it starts writes real rows.
 * Pointed at the normal development database that is destructive in a quiet
 * way: the dev DB accumulates hundreds of synthetic sessions, its WAL grows
 * without bound, and a test could in principle observe or mutate the
 * developer's own data. Each run therefore gets its own file, deleted on
 * teardown.
 *
 * The developer's database is NEVER deleted by this module — the only paths it
 * removes are ones it generated inside its own directory.
 */

/** Dedicated, git-ignored directory. Nothing else is allowed to live here. */
export const E2E_DB_DIR = resolve(__dirname, '..', '..', '.e2e-db');

/** Every generated file starts with this, so cleanup can never over-match. */
const FILE_PREFIX = 'sessions-';

/**
 * Stale files older than this are swept at startup (interrupted runs).
 *
 * Comfortably longer than a full suite (~21 min) so a concurrent run's file is
 * never removed out from under it: SQLite touches the database throughout a
 * run, so an in-use file always has a recent mtime.
 */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** SQLite writes two sidecars next to the database in WAL mode. */
const SIDECAR_SUFFIXES = ['', '-wal', '-shm'] as const;

/**
 * Unique per run: two Playwright runs on one machine (or a rerun started
 * before a previous teardown finished) must never share a file.
 */
function generatePath(): string {
  const unique = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return join(E2E_DB_DIR, `${FILE_PREFIX}${unique}.db`);
}

/**
 * Resolved once per runner process and republished through the environment so
 * globalSetup, the webServer and globalTeardown all agree even if the module
 * is re-required through a different path.
 */
export const E2E_DATABASE_PATH: string = process.env['E2E_DATABASE_PATH'] ?? generatePath();
process.env['E2E_DATABASE_PATH'] = E2E_DATABASE_PATH;

/** The database this module must never touch. */
export const DEV_DATABASE_PATH = resolve(__dirname, '..', '..', 'backend', 'data', 'sessions.db');

/**
 * Refuse to operate on anything outside the dedicated directory. This is the
 * guard that makes the delete step safe: a bad edit to the path logic fails the
 * run instead of removing a real database.
 */
function assertInsideE2eDir(path: string): void {
  const normalized = resolve(path);
  if (!normalized.startsWith(E2E_DB_DIR + sep)) {
    throw new Error(`Refusing to touch a database outside ${E2E_DB_DIR}: ${normalized}`);
  }
}

export interface DatabaseFingerprint {
  readonly exists: boolean;
  readonly size: number;
  readonly modifiedMs: number;
}

/** Cheap identity check used to prove the dev database was not written to. */
export function fingerprint(path: string): DatabaseFingerprint {
  try {
    const stats = statSync(path);
    return { exists: true, size: stats.size, modifiedMs: stats.mtimeMs };
  } catch {
    return { exists: false, size: 0, modifiedMs: 0 };
  }
}

export function sameFingerprint(a: DatabaseFingerprint, b: DatabaseFingerprint): boolean {
  return a.exists === b.exists && a.size === b.size && a.modifiedMs === b.modifiedMs;
}

/**
 * Sweep leftovers from interrupted runs (Ctrl-C, crash, killed terminal), where
 * teardown never executed. Only prefixed files inside the dedicated directory
 * are considered, and only once they are old enough that they cannot belong to
 * a run happening right now.
 */
export function purgeStaleDatabases(now = Date.now()): readonly string[] {
  if (!existsSync(E2E_DB_DIR)) return [];

  const removed: string[] = [];
  for (const name of readdirSync(E2E_DB_DIR)) {
    if (!name.startsWith(FILE_PREFIX)) continue;

    const path = join(E2E_DB_DIR, name);
    if (path === E2E_DATABASE_PATH) continue;   // never the current run

    try {
      if (now - statSync(path).mtimeMs < STALE_AFTER_MS) continue;
      assertInsideE2eDir(path);
      rmSync(path, { force: true });
      removed.push(name);
    } catch {
      // A file that vanished or is locked by a concurrent run is not our
      // problem — leaving it costs nothing and deleting it could break them.
    }
  }
  return removed;
}

export function prepareE2eDatabase(): void {
  mkdirSync(E2E_DB_DIR, { recursive: true });
  assertInsideE2eDir(E2E_DATABASE_PATH);
  purgeStaleDatabases();
}

/** Synchronous pause — teardown hooks cannot await. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Delete this run's database and both SQLite sidecars. Returns the paths that
 * still exist afterwards, so the caller can decide whether to retry.
 *
 * Windows keeps a file locked until the owning process actually exits, and
 * Playwright stops the webServer AFTER globalTeardown — so the first attempt
 * can legitimately fail with EBUSY. Retrying briefly covers a server that is
 * mid-shutdown; anything still locked is retried once more at process exit.
 */
export function removeE2eDatabase(attempts = 8, delayMs = 250): readonly string[] {
  assertInsideE2eDir(E2E_DATABASE_PATH);

  const paths = SIDECAR_SUFFIXES.map((suffix) => `${E2E_DATABASE_PATH}${suffix}`);

  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const path of paths) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Locked — a later attempt (or the exit handler) will get it.
      }
    }
    const remaining = paths.filter((path) => existsSync(path));
    if (remaining.length === 0) return [];
    if (attempt < attempts - 1) sleepSync(delayMs);
  }

  return paths.filter((path) => existsSync(path));
}
