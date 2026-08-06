import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Client } from 'pg';

/**
 * Throwaway Postgres database for a Playwright run.
 *
 * E2E drives the REAL backend, so every interview it starts writes real rows.
 * Pointed at the normal development database that is destructive in a quiet
 * way: the dev database accumulates hundreds of synthetic sessions, and a test
 * could in principle observe or mutate the developer's own data. Each run
 * therefore gets its OWN database, dropped on teardown.
 *
 * PORTED FROM SQLITE. Isolation used to mean a throwaway FILE in a dedicated
 * directory, guarded by a path check. A file no longer exists, so the unit of
 * isolation is now a database on the same server, guarded by a NAME check: this
 * module will only ever create or drop a database whose name begins with
 * `e2e_`, and it refuses outright to touch the one named in DATABASE_URL.
 *
 * The developer's database is NEVER dropped by this module.
 */

/** Every generated database starts with this, so cleanup can never over-match. */
const NAME_PREFIX = 'e2e_';

/**
 * Stale databases older than this are swept at startup (interrupted runs).
 *
 * Comfortably longer than a full suite (~21 min) so a concurrent run's database
 * is never dropped out from under it. Postgres does not record a creation time,
 * so the age is read from the timestamp embedded in the generated name.
 */
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * Read DATABASE_URL from `backend/.env`.
 *
 * The backend loads that file itself via `node --env-file-if-exists`, but the
 * Playwright RUNNER is a different process and never sees it. Without this the
 * harness would fail at startup on a machine that is otherwise configured
 * correctly. An explicit environment variable still wins.
 */
function readBackendEnv(): string {
  try {
    const file = readFileSync(resolve(__dirname, '..', '..', 'backend', '.env'), 'utf8');
    for (const line of file.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('DATABASE_URL=')) {
        return trimmed.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // No .env — an explicitly exported DATABASE_URL may still be present.
  }
  return '';
}

/**
 * The server E2E connects to. This is the DEVELOPER'S connection string — it
 * names the database this module must never touch, and it supplies the
 * credentials used to create the throwaway one beside it.
 */
export const DEV_DATABASE_URL =
  (process.env['DATABASE_URL'] ?? '').trim() || readBackendEnv();

export class E2eDatabaseError extends Error {
  public override readonly name = 'E2eDatabaseError';
}

function requireDevUrl(): string {
  if (DEV_DATABASE_URL.length === 0) {
    throw new E2eDatabaseError(
      'DATABASE_URL is not set. E2E drives the real backend, which now requires ' +
      'Postgres. Set DATABASE_URL to a server you can create databases on ' +
      '(a Neon branch or a local Postgres) and run again.'
    );
  }
  return DEV_DATABASE_URL;
}

/** The database named in DATABASE_URL — the one that is off limits. */
export function devDatabaseName(): string {
  return new URL(requireDevUrl()).pathname.replace(/^\//, '');
}

/**
 * Unique per run: two Playwright runs on one machine (or a rerun started before
 * a previous teardown finished) must never share a database. The leading
 * timestamp is what the stale sweep reads.
 */
function generateName(): string {
  const stamp = Date.now().toString(36);
  const unique = Math.random().toString(36).slice(2, 8);
  return `${NAME_PREFIX}${stamp}_${process.pid}_${unique}`;
}

/**
 * Resolved once per runner process and republished through the environment so
 * globalSetup, the webServer and globalTeardown all agree even if the module is
 * re-required through a different path.
 */
export const E2E_DATABASE_NAME: string =
  process.env['E2E_DATABASE_NAME'] ?? generateName();
process.env['E2E_DATABASE_NAME'] = E2E_DATABASE_NAME;

/** The same server, pointed at this run's database. */
export function urlForDatabase(name: string): string {
  const url = new URL(requireDevUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

export const E2E_DATABASE_URL: string = DEV_DATABASE_URL.length > 0
  ? urlForDatabase(E2E_DATABASE_NAME)
  : '';

/**
 * Refuse to operate on anything that is not a generated database. This is the
 * guard that makes the drop step safe: a bad edit to the naming logic fails the
 * run instead of destroying a real database.
 */
function assertDisposable(name: string): void {
  if (!name.startsWith(NAME_PREFIX)) {
    throw new E2eDatabaseError(
      `Refusing to create or drop a database not named ${NAME_PREFIX}*: ${name}`
    );
  }
  if (name === devDatabaseName()) {
    throw new E2eDatabaseError(
      `Refusing to touch the development database: ${name}`
    );
  }
}

/**
 * The DIRECT endpoint, for administrative work.
 *
 * Neon's pooled endpoint runs PgBouncer in transaction mode, which cannot
 * execute CREATE DATABASE or DROP DATABASE — those need a real session on the
 * backend. The app rightly uses the pooled host; this module strips `-pooler`
 * from the hostname so create/drop go to the direct one.
 *
 * On a plain Postgres server there is no `-pooler` and this is a no-op.
 */
function adminUrl(): string {
  const url = new URL(requireDevUrl());
  url.hostname = url.hostname.replace('-pooler.', '.');
  return url.toString();
}

/**
 * Exported so the webServer command can create the database before the backend
 * starts — see `ensure-e2e-database.js` for why that cannot wait for
 * globalSetup.
 */
export const E2E_ADMIN_DATABASE_URL: string =
  DEV_DATABASE_URL.length > 0 ? adminUrl() : '';

/**
 * Connect to the server for administrative work.
 *
 * CREATE/DROP DATABASE cannot run while connected to the target, so this
 * connects to the DEVELOPER'S database and issues the statement from there. It
 * only ever reads from that connection.
 */
async function withAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: adminUrl(),
    // Managed Postgres requires TLS with certificates that do not chain to a
    // root in every environment; the connection is still encrypted.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30_000
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Cheap identity check used to prove the dev database was not written to. */
export interface DatabaseFingerprint {
  readonly reachable: boolean;
  readonly sessions: number;
  readonly answers: number;
}

export async function fingerprintDevDatabase(): Promise<DatabaseFingerprint> {
  try {
    return await withAdmin(async (client) => {
      const count = async (table: string): Promise<number> => {
        try {
          const { rows } = await client.query<{ n: string }>(
            `SELECT COUNT(*)::int AS n FROM ${table}`
          );
          return Number(rows[0]?.n ?? 0);
        } catch {
          return 0;   // table absent — a dev database that was never migrated
        }
      };
      return {
        reachable: true,
        sessions: await count('interview_sessions'),
        answers: await count('session_answers')
      };
    });
  } catch {
    return { reachable: false, sessions: 0, answers: 0 };
  }
}

export function sameFingerprint(a: DatabaseFingerprint, b: DatabaseFingerprint): boolean {
  return a.reachable === b.reachable && a.sessions === b.sessions && a.answers === b.answers;
}

/**
 * Sweep leftovers from interrupted runs (Ctrl-C, crash, killed terminal), where
 * teardown never executed. Only prefixed databases are considered, and only
 * once the timestamp in the name is old enough that they cannot belong to a run
 * happening right now.
 */
export async function purgeStaleDatabases(now = Date.now()): Promise<readonly string[]> {
  const removed: string[] = [];

  await withAdmin(async (client) => {
    const { rows } = await client.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [`${NAME_PREFIX}%`]
    );

    for (const { datname } of rows) {
      if (datname === E2E_DATABASE_NAME) continue;   // never the current run

      const stamp = datname.slice(NAME_PREFIX.length).split('_')[0] ?? '';
      const createdAt = parseInt(stamp, 36);
      if (!Number.isFinite(createdAt) || now - createdAt < STALE_AFTER_MS) continue;

      try {
        assertDisposable(datname);
        await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
        removed.push(datname);
      } catch {
        // A database still in use by a concurrent run is not our problem —
        // leaving it costs nothing and dropping it could break them.
      }
    }
  });

  return removed;
}

/**
 * Idempotent: the webServer command normally creates the database first (it has
 * to — see `ensure-e2e-database.js`), so by the time globalSetup calls this it
 * usually already exists.
 */
export async function prepareE2eDatabase(): Promise<void> {
  assertDisposable(E2E_DATABASE_NAME);
  await withAdmin(async (client) => {
    const { rows } = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [E2E_DATABASE_NAME]
    );
    if (rows.length > 0) return;

    // Identifiers cannot be parameterized. The name is generated by this
    // module and validated by assertDisposable, so it is never user input.
    await client.query(`CREATE DATABASE "${E2E_DATABASE_NAME}"`);
  });
}

/**
 * Drop this run's database.
 *
 * WITH (FORCE) terminates any backend still connected: Playwright stops the
 * webServer AFTER globalTeardown, so the backend's pool is typically still
 * open at this point and a plain DROP would fail with "database is being
 * accessed by other users".
 */
export async function removeE2eDatabase(): Promise<boolean> {
  assertDisposable(E2E_DATABASE_NAME);
  try {
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${E2E_DATABASE_NAME}" WITH (FORCE)`);
    });
    return true;
  } catch {
    return false;
  }
}

/** Does this run's database still exist? Used by teardown to report honestly. */
export async function e2eDatabaseExists(): Promise<boolean> {
  try {
    return await withAdmin(async (client) => {
      const { rows } = await client.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [E2E_DATABASE_NAME]
      );
      return rows.length > 0;
    });
  } catch {
    return false;
  }
}
