import type { DatabaseHandle, Queryable } from './database';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DatabaseError } from './database';

/**
 * A deliberately small migration runner.
 *
 * Migrations are plain `.sql` files named `NNN_description.sql`. They are read
 * from a directory CO-LOCATED with this module (`__dirname/migrations`), which
 * is the correct use of `__dirname`: the files ship next to the code in both
 * `src/` and `dist/`. The build copies them, and a test asserts they are
 * present after compilation.
 *
 * Each migration runs inside a transaction together with the bookkeeping insert,
 * so a failure leaves NO trace — never a half-applied schema recorded as done.
 */

export class MigrationError extends Error {
  public override readonly name = 'MigrationError';
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: number;
}

const FILENAME_PATTERN = /^(\d{3,})_([A-Za-z0-9_-]+)\.sql$/;

export function migrationsDirectory(): string {
  return resolve(__dirname, 'migrations');
}

interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
}

export function listMigrationFiles(directory = migrationsDirectory()): readonly MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    throw new MigrationError('Migration directory could not be read');
  }

  const files: MigrationFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.sql')) continue;
    const match = FILENAME_PATTERN.exec(entry);
    if (!match) {
      throw new MigrationError(
        `Migration file name must look like 001_description.sql — found "${entry}"`
      );
    }
    files.push({
      version: Number(match[1]),
      name: match[2] as string,
      fileName: entry
    });
  }

  if (files.length === 0) {
    throw new MigrationError('No migrations found');
  }

  // Deterministic NUMERIC order — not the lexicographic order readdir gives,
  // which would place 100 before 20.
  files.sort((a, b) => a.version - b.version);

  for (let i = 1; i < files.length; i++) {
    if (files[i]!.version === files[i - 1]!.version) {
      throw new MigrationError(`Duplicate migration version ${files[i]!.version}`);
    }
  }
  if (files[0]!.version < 1) {
    throw new MigrationError('Migration versions must start at 1');
  }

  return files;
}

async function ensureVersionTable(db: Queryable): Promise<void> {
  // applied_at is epoch MILLISECONDS, so BIGINT — Postgres INTEGER is 32-bit
  // and would overflow.
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT   NOT NULL,
      applied_at BIGINT NOT NULL
    );
  `);
}

export async function getAppliedMigrations(db: DatabaseHandle): Promise<readonly AppliedMigration[]> {
  await ensureVersionTable(db);
  const { rows } = await db.query<{ version: number; name: string; applied_at: string | number }>(
    'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
  );

  // pg returns BIGINT as a STRING to avoid precision loss. Every timestamp here
  // is epoch ms, which is well inside Number.MAX_SAFE_INTEGER, so converting is
  // safe — and callers expect a number.
  return rows.map((row) => ({
    version: Number(row.version),
    name: row.name,
    appliedAt: Number(row.applied_at)
  }));
}

export interface MigrateOptions {
  readonly directory?: string;
  /** Injected clock, so tests do not depend on the wall clock. */
  readonly now?: () => number;
}

/**
 * Apply every pending migration in order. Returns the versions applied by THIS
 * call, so a second run reports an empty list rather than redoing work.
 */
export async function migrate(
  db: DatabaseHandle,
  options: MigrateOptions = {}
): Promise<readonly number[]> {
  const directory = options.directory ?? migrationsDirectory();
  const now = options.now ?? (() => Date.now());

  // getAppliedMigrations ensures the bookkeeping table itself, so there is no
  // separate ensure call here.
  const files = listMigrationFiles(directory);
  const applied = new Set((await getAppliedMigrations(db)).map((migration) => migration.version));
  const performed: number[] = [];

  for (const file of files) {
    if (applied.has(file.version)) continue;

    let sql: string;
    try {
      sql = readFileSync(resolve(directory, file.fileName), 'utf8');
    } catch {
      throw new MigrationError(`Migration ${file.version} could not be read`);
    }

    // Schema change + bookkeeping in ONE transaction: a failure rolls back
    // both, so a partially applied migration can never be recorded as applied.
    // Postgres supports transactional DDL, so this holds for CREATE TABLE too.
    try {
      await db.transaction(async (client) => {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
          [file.version, file.name, now()]
        );
      });
    } catch (err: unknown) {
      // Report the migration NUMBER and the SQLSTATE — never the driver's
      // message. Driver messages are not a controlled surface: some drivers
      // (and pg-mem) echo the whole failing statement, literal values included,
      // and a migration's values can be anything the schema carries.
      //
      // The full error still goes to the server's own log, which is private.
      console.error(`[migrate] migration ${file.version} failed:`, err);

      const sqlState = (err as { code?: unknown } | null)?.code;
      const code = typeof sqlState === 'string' && sqlState.length > 0 ? sqlState : 'unknown';
      throw new MigrationError(`Migration ${file.version} failed (SQLSTATE ${code})`);
    }

    performed.push(file.version);
  }

  return performed;
}

/** Convenience for startup: migrate or fail with a safe message. */
export async function migrateOrThrow(
  db: DatabaseHandle,
  options: MigrateOptions = {}
): Promise<readonly number[]> {
  try {
    return await migrate(db, options);
  } catch (err: unknown) {
    if (err instanceof MigrationError) throw err;
    throw new DatabaseError('Database migration failed');
  }
}
