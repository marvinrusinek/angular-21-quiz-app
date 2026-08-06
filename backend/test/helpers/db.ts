import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fromPool, type DatabaseHandle } from '../../src/db/database';
import { migrate } from '../../src/db/migrate';
import { createSessionRepository, type SessionRepository } from '../../src/interview/session.repository';
import type { CreateSessionInput, CreateSessionQuestionInput } from '../../src/interview/session.types';
import { createTestPool } from './pg-mem-pool';

export interface TestDb {
  readonly handle: DatabaseHandle;
  readonly repo: SessionRepository;
}

/**
 * A migrated, empty database for one test.
 *
 * Replaces the old SQLite in-memory handle. Each call is isolated, so tests
 * never share rows. Persistence tests reuse ONE handle rather than reopening a
 * file — the equivalent of a restart is now dropping and re-acquiring the
 * connection, not reopening a path.
 */
export async function memoryDb(): Promise<TestDb> {
  const { pool } = createTestPool();
  const handle = fromPool(pool, 'pg-mem');
  await migrate(handle, { now: () => 1_700_000_000_000 });
  return { handle, repo: createSessionRepository(handle) };
}

/**
 * Persistence across a "restart": the same underlying database, reached
 * through a NEW handle and repository, so nothing in-process is carried over.
 */
export function reopen(handle: DatabaseHandle): TestDb {
  return { handle, repo: createSessionRepository(handle) };
}

// ── temp directories ────────────────────────────────────────────────
// The database no longer lives on disk, but migration DISCOVERY still reads
// real `.sql` files, so those tests still need a scratch directory.

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'interview-test-'));
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ── fixtures ────────────────────────────────────────────────────────

const CREATED_AT = 1_700_000_000_000;   // fixed clock; never Date.now()
const HOUR_MS = 60 * 60 * 1000;

export function question(
  overrides: Partial<CreateSessionQuestionInput> = {}
): CreateSessionQuestionInput {
  return {
    position: 0,
    questionId: 'rxjs:q:0',
    sourceQuizId: 'rxjs',
    questionText: 'Which answer is correct?',
    type: 'single',
    explanation: 'Because a Subject multicasts.',
    options: [
      { optionId: 101, text: 'A multicast observable', displayOrder: 0, isCorrect: true },
      { optionId: 102, text: 'A pipe', displayOrder: 1, isCorrect: false }
    ],
    ...overrides
  };
}

export function sessionInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    id: 'sess_1',
    tokenHash: 'a'.repeat(64),
    attemptId: 'att_1',
    config: { difficulty: 'mixed', topicIds: ['rxjs'], questionCount: 1 },
    durationSeconds: 900,
    createdAt: CREATED_AT,
    expiresAt: CREATED_AT + HOUR_MS,
    questions: [question()],
    ...overrides
  };
}

export const CLOCK = { CREATED_AT, HOUR_MS };
