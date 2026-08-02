import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { openDatabase, DatabaseError, resolveDatabasePath } from '../src/db/database';
import {
  getAppliedMigrations,
  listMigrationFiles,
  migrate,
  migrationsDirectory,
  MigrationError
} from '../src/db/migrate';
import { makeTempDir, removeTempDir } from './helpers/db';

let tempDir: string;
beforeEach(() => { tempDir = makeTempDir(); });
afterEach(() => removeTempDir(tempDir));

const CLOCK = () => 1_700_000_000_000;

describe('database open + PRAGMAs', () => {
  it('opens an in-memory database', () => {
    const handle = openDatabase({ databasePath: ':memory:' });
    expect(handle.location).toBe(':memory:');
    handle.close();
  });

  it('creates the parent directory for a file database', () => {
    const path = resolve(tempDir, 'nested/deeper/sessions.db');
    const handle = openDatabase({ databasePath: path });
    expect(existsSync(path)).toBe(true);
    handle.close();
  });

  it('ENABLES foreign keys — SQLite defaults them off', () => {
    const handle = openDatabase({ databasePath: ':memory:' });
    expect(handle.db.pragma('foreign_keys', { simple: true })).toBe(1);
    handle.close();
  });

  it('sets a busy timeout', () => {
    const handle = openDatabase({ databasePath: ':memory:' });
    expect(handle.db.pragma('busy_timeout', { simple: true })).toBe(5000);
    handle.close();
  });

  it('uses WAL for file databases but not for :memory:', () => {
    const file = openDatabase({ databasePath: resolve(tempDir, 'wal.db') });
    expect(String(file.db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    file.close();

    const memory = openDatabase({ databasePath: ':memory:' });
    expect(String(memory.db.pragma('journal_mode', { simple: true })).toLowerCase()).not.toBe('wal');
    memory.close();
  });

  it('rejects a directory used as the database file', () => {
    mkdirSync(resolve(tempDir, 'adir'));
    expect(() => openDatabase({ databasePath: resolve(tempDir, 'adir') }))
      .toThrow(/directory, not a file/i);
  });

  it('rejects a blank path', () => {
    expect(() => openDatabase({ databasePath: '   ' })).toThrow(DatabaseError);
  });

  it('resolves relative paths against the working directory, like the quiz path', () => {
    expect(resolveDatabasePath('./data/sessions.db')).toBe(
      resolve(process.cwd(), 'data/sessions.db')
    );
    expect(resolveDatabasePath(':memory:')).toBe(':memory:');
  });

  it('close() is idempotent', () => {
    const handle = openDatabase({ databasePath: ':memory:' });
    handle.close();
    expect(() => handle.close()).not.toThrow();
  });

  it('errors name only the basename, never an absolute path', () => {
    mkdirSync(resolve(tempDir, 'dir2'));
    try {
      openDatabase({ databasePath: resolve(tempDir, 'dir2') });
      throw new Error('expected failure');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('dir2');
      expect(message).not.toContain(tempDir);
    }
  });
});

describe('migration discovery', () => {
  it('finds the real migration set in numeric order', () => {
    const files = listMigrationFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]!.version).toBe(1);
    for (let i = 1; i < files.length; i++) {
      expect(files[i]!.version).toBeGreaterThan(files[i - 1]!.version);
    }
  });

  it('the migrations directory sits next to the compiled module', () => {
    expect(existsSync(migrationsDirectory())).toBe(true);
    expect(existsSync(resolve(migrationsDirectory(), '001_interview_sessions.sql'))).toBe(true);
  });

  it('sorts NUMERICALLY, not lexicographically', () => {
    const dir = resolve(tempDir, 'migrations');
    mkdirSync(dir);
    writeFileSync(resolve(dir, '002_b.sql'), 'CREATE TABLE b (x INTEGER);');
    writeFileSync(resolve(dir, '010_c.sql'), 'CREATE TABLE c (x INTEGER);');
    writeFileSync(resolve(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');

    expect(listMigrationFiles(dir).map((f) => f.version)).toEqual([1, 2, 10]);
  });

  it('REJECTS a duplicate version', () => {
    const dir = resolve(tempDir, 'dupe');
    mkdirSync(dir);
    writeFileSync(resolve(dir, '001_a.sql'), 'SELECT 1;');
    writeFileSync(resolve(dir, '001_b.sql'), 'SELECT 1;');
    expect(() => listMigrationFiles(dir)).toThrow(/duplicate migration version/i);
  });

  it('rejects a badly named file', () => {
    const dir = resolve(tempDir, 'badname');
    mkdirSync(dir);
    writeFileSync(resolve(dir, 'oops.sql'), 'SELECT 1;');
    expect(() => listMigrationFiles(dir)).toThrow(/must look like/i);
  });

  it('rejects an empty migration directory', () => {
    const dir = resolve(tempDir, 'empty');
    mkdirSync(dir);
    expect(() => listMigrationFiles(dir)).toThrow(/no migrations/i);
  });

  it('rejects a missing directory', () => {
    expect(() => listMigrationFiles(resolve(tempDir, 'nope'))).toThrow(MigrationError);
  });
});

describe('migration application', () => {
  it('creates the version table and records the migration', () => {
    const handle = openDatabase({ databasePath: ':memory:' });
    const applied = migrate(handle.db, { now: CLOCK });

    expect(applied).toEqual([1]);
    const records = getAppliedMigrations(handle.db);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      version: 1,
      name: 'interview_sessions',
      appliedAt: CLOCK()
    });
    handle.close();
  });

  it('is IDEMPOTENT — a second run applies nothing', () => {
    const handle = openDatabase({ databasePath: ':memory:' });
    expect(migrate(handle.db, { now: CLOCK })).toEqual([1]);
    expect(migrate(handle.db, { now: CLOCK })).toEqual([]);
    expect(getAppliedMigrations(handle.db)).toHaveLength(1);
    handle.close();
  });

  it('creates every expected table', () => {
    const handle = openDatabase({ databasePath: ':memory:' });
    migrate(handle.db, { now: CLOCK });

    const names = (handle.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[]).map((row) => row.name);

    for (const table of [
      'interview_sessions', 'session_questions', 'session_options',
      'session_answers', 'schema_migrations'
    ]) {
      expect(names).toContain(table);
    }
    handle.close();
  });

  it('does NOT create a global unique index on option_id', () => {
    const handle = openDatabase({ databasePath: ':memory:' });
    migrate(handle.db, { now: CLOCK });

    const indexes = handle.db.prepare('PRAGMA index_list(session_options)').all() as {
      unique: number; name: string;
    }[];
    for (const index of indexes) {
      if (index.unique !== 1) continue;
      const columns = (handle.db.prepare(`PRAGMA index_info(${index.name})`).all() as {
        name: string;
      }[]).map((c) => c.name);
      // Any unique index MUST be scoped by session + question position.
      if (columns.includes('option_id')) {
        expect(columns).toContain('session_id');
        expect(columns).toContain('question_position');
      }
    }
    handle.close();
  });

  it('rolls back COMPLETELY when a migration fails — nothing is recorded', () => {
    const dir = resolve(tempDir, 'failing');
    mkdirSync(dir);
    writeFileSync(resolve(dir, '001_ok.sql'), 'CREATE TABLE ok (x INTEGER);');
    // Valid first statement, invalid second — proves the transaction covers the
    // whole file, not just the first statement.
    writeFileSync(
      resolve(dir, '002_bad.sql'),
      'CREATE TABLE partial (x INTEGER);\nTHIS IS NOT SQL;'
    );

    const handle = openDatabase({ databasePath: ':memory:' });
    expect(() => migrate(handle.db, { directory: dir, now: CLOCK }))
      .toThrow(/migration 2 failed/i);

    const tables = (handle.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]).map((row) => row.name);

    expect(tables).toContain('ok');          // migration 1 stands
    expect(tables).not.toContain('partial'); // migration 2 fully rolled back
    expect(getAppliedMigrations(handle.db).map((m) => m.version)).toEqual([1]);
    handle.close();
  });

  it('failure messages carry the migration NUMBER but no SQL values', () => {
    const dir = resolve(tempDir, 'failing2');
    mkdirSync(dir);
    writeFileSync(resolve(dir, '001_bad.sql'), "INSERT INTO nope VALUES ('SECRET-VALUE');");

    const handle = openDatabase({ databasePath: ':memory:' });
    try {
      migrate(handle.db, { directory: dir, now: CLOCK });
      throw new Error('expected failure');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/migration 1 failed/i);
      expect(message).not.toContain('SECRET-VALUE');
    }
    handle.close();
  });

  it('applies pending migrations on an already-migrated database', () => {
    const dir = resolve(tempDir, 'incremental');
    mkdirSync(dir);
    writeFileSync(resolve(dir, '001_a.sql'), 'CREATE TABLE a (x INTEGER);');

    const handle = openDatabase({ databasePath: ':memory:' });
    expect(migrate(handle.db, { directory: dir, now: CLOCK })).toEqual([1]);

    writeFileSync(resolve(dir, '002_b.sql'), 'CREATE TABLE b (x INTEGER);');
    expect(migrate(handle.db, { directory: dir, now: CLOCK })).toEqual([2]);
    expect(getAppliedMigrations(handle.db).map((m) => m.version)).toEqual([1, 2]);
    handle.close();
  });
});

describe('the migration SQL itself', () => {
  it('contains no interpolation placeholders and is committed as .sql', () => {
    const sql = readFileSync(resolve(migrationsDirectory(), '001_interview_sessions.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE interview_sessions');
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).not.toContain('${');
  });
});
