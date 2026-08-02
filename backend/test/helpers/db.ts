import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { openDatabase, type DatabaseHandle } from '../../src/db/database';
import { migrate } from '../../src/db/migrate';
import { createSessionRepository, type SessionRepository } from '../../src/interview/session.repository';
import type { CreateSessionInput, CreateSessionQuestionInput } from '../../src/interview/session.types';

/** Every file-backed test gets its own temp directory; nothing is shared. */
export function makeTempDir(): string {
  return mkdtempSync(resolve(tmpdir(), 'quiz-backend-test-'));
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface TestDb {
  readonly handle: DatabaseHandle;
  readonly repo: SessionRepository;
}

/** In-memory: fast, for tests that do NOT exercise persistence. */
export function memoryDb(): TestDb {
  const handle = openDatabase({ databasePath: ':memory:' });
  migrate(handle.db, { now: () => 1_700_000_000_000 });
  return { handle, repo: createSessionRepository(handle.db) };
}

/** File-backed: required for restart/persistence tests. */
export function fileDb(dir: string, name = 'sessions.db'): TestDb {
  const handle = openDatabase({ databasePath: resolve(dir, name) });
  migrate(handle.db, { now: () => 1_700_000_000_000 });
  return { handle, repo: createSessionRepository(handle.db) };
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
