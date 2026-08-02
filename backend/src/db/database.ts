import Database from 'better-sqlite3';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * SQLite lifecycle.
 *
 * better-sqlite3 is used deliberately:
 *   - SYNCHRONOUS, so a transaction is an ordinary function call and cannot be
 *     accidentally interleaved by an await. Session creation writes a session
 *     plus its questions and options atomically; that is far easier to get
 *     right without async seams.
 *   - prepared statements and real transactions out of the box
 *   - no ORM, so the schema in the migration IS the schema
 *
 * Session writes are small and infrequent (one per assessment lifecycle event),
 * so serialized writes are not a bottleneck at this scale.
 */

export class DatabaseError extends Error {
  public override readonly name = 'DatabaseError';
}

export interface DatabaseHandle {
  readonly db: Database.Database;
  readonly close: () => void;
  /** Absolute path, or ':memory:'. Internal use only — never serialized. */
  readonly location: string;
}

export interface OpenOptions {
  /** File path, or ':memory:' for unit tests that do not test persistence. */
  readonly databasePath: string;
  /** Root for relative paths. Defaults to the process working directory. */
  readonly rootDir?: string;
  /** Skip WAL — used for in-memory databases, where it does not apply. */
  readonly disableWal?: boolean;
}

function describe(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? 'database file';
}

/**
 * Resolve the database path the SAME way the quiz data path is resolved:
 * relative to the process working directory, never `__dirname` (which differs
 * between ts-node and a compiled build — the bug found in Stage 3).
 */
export function resolveDatabasePath(databasePath: string, rootDir?: string): string {
  if (typeof databasePath !== 'string' || databasePath.trim().length === 0) {
    throw new DatabaseError('Database path is not configured');
  }
  const trimmed = databasePath.trim();
  if (trimmed === ':memory:') return trimmed;

  const root = resolve(rootDir ?? process.cwd());
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed);
}

export function openDatabase(options: OpenOptions): DatabaseHandle {
  const location = resolveDatabasePath(options.databasePath, options.rootDir);
  const inMemory = location === ':memory:';

  if (!inMemory) {
    // A directory where a file belongs is a configuration mistake, not
    // something to create or overwrite.
    try {
      if (statSync(location).isDirectory()) {
        throw new DatabaseError(`Database path is a directory, not a file: ${describe(location)}`);
      }
    } catch (err: unknown) {
      if (err instanceof DatabaseError) throw err;
      // Not existing yet is the normal first-run case.
    }

    try {
      mkdirSync(dirname(location), { recursive: true });
    } catch {
      throw new DatabaseError(`Database directory could not be created: ${describe(location)}`);
    }
  }

  let db: Database.Database;
  try {
    db = new Database(location);
  } catch {
    // SQLite's message can embed the absolute path.
    throw new DatabaseError(`Database could not be opened: ${describe(location)}`);
  }

  try {
    applyPragmas(db, { disableWal: options.disableWal ?? inMemory });
  } catch (err: unknown) {
    db.close();
    throw err instanceof DatabaseError
      ? err
      : new DatabaseError(`Database settings could not be applied: ${describe(location)}`);
  }

  let closed = false;
  return {
    db,
    location,
    close: () => {
      // Idempotent — shutdown handlers and test teardown may both fire.
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {
        /* already closed by the driver */
      }
    }
  };
}

/**
 * PRAGMAs, and why:
 *
 *   foreign_keys = ON   SQLite defaults this OFF per connection. Every cascade
 *                       and orphan guarantee in the schema depends on it, so it
 *                       is set on every connection and asserted by a test.
 *
 *   journal_mode = WAL  Readers do not block the writer, which matters once
 *                       resume/answer/submit overlap. Skipped for :memory:,
 *                       where it does not apply.
 *
 *   busy_timeout = 5000 Wait rather than failing instantly when two requests
 *                       touch the database at once. Cheaper and more honest
 *                       than a homegrown mutex.
 *
 *   synchronous = FULL  Durability across process restart is a stated Stage 4
 *                       requirement; WAL's default NORMAL can lose the last
 *                       commit on an OS crash.
 */
function applyPragmas(db: Database.Database, options: { disableWal: boolean }): void {
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  if (!options.disableWal) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  }

  const enabled = db.pragma('foreign_keys', { simple: true });
  if (enabled !== 1) {
    throw new DatabaseError('Foreign key enforcement could not be enabled');
  }
}
