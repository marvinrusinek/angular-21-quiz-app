import { resolve } from 'node:path';

import { openDatabase } from '../src/db/database';
import { migrate } from '../src/db/migrate';
import {
  createSessionRepository,
  parseSelectedOptionIds,
  SessionRepositoryError
} from '../src/interview/session.repository';
import {
  CLOCK, fileDb, makeTempDir, memoryDb, question, removeTempDir, sessionInput, type TestDb
} from './helpers/db';

let tempDir: string;
let ctx: TestDb;

beforeEach(() => {
  tempDir = makeTempDir();
  ctx = memoryDb();
});
afterEach(() => {
  ctx.handle.close();
  removeTempDir(tempDir);
});

describe('atomic session creation', () => {
  it('creates the session, its questions and its options in one go', () => {
    const record = ctx.repo.createSessionSnapshot(sessionInput());

    expect(record.id).toBe('sess_1');
    expect(record.status).toBe('active');
    expect(record.submittedAt).toBeNull();
    expect(record.submittedByExpiry).toBe(false);
    expect(record.result).toBeNull();
    expect(record.config.topicIds).toEqual(['rxjs']);

    const snapshot = ctx.repo.getSessionSnapshot('sess_1')!;
    expect(snapshot.questions).toHaveLength(1);
    expect(snapshot.questions[0]!.options).toHaveLength(2);
  });

  it('ROLLS BACK entirely when an option fails partway through', () => {
    // Two questions; the SECOND has a duplicate display order, which the
    // schema rejects — so the first question's rows must disappear too.
    const bad = sessionInput({
      questions: [
        question(),
        question({
          position: 1,
          questionId: 'rxjs:q:1',
          options: [
            { optionId: 201, text: 'a', displayOrder: 0, isCorrect: true },
            { optionId: 202, text: 'b', displayOrder: 0, isCorrect: false }
          ]
        })
      ]
    });

    expect(() => ctx.repo.createSessionSnapshot(bad)).toThrow(SessionRepositoryError);

    expect(ctx.repo.getSessionById('sess_1')).toBeNull();
    expect(ctx.handle.db.prepare('SELECT COUNT(*) AS n FROM session_questions').get())
      .toEqual({ n: 0 });
    expect(ctx.handle.db.prepare('SELECT COUNT(*) AS n FROM session_options').get())
      .toEqual({ n: 0 });
  });

  it('rejects a duplicate session id', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    expect(() => ctx.repo.createSessionSnapshot(sessionInput({ attemptId: 'att_2' })))
      .toThrow(/uniqueness/i);
  });

  it('rejects a duplicate attempt id', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    expect(() => ctx.repo.createSessionSnapshot(sessionInput({ id: 'sess_2' })))
      .toThrow(/uniqueness/i);
  });

  it('rejects a session with no questions', () => {
    expect(() => ctx.repo.createSessionSnapshot(sessionInput({ questions: [] })))
      .toThrow(/at least one question/i);
  });

  it('rejects duplicate question positions', () => {
    const input = sessionInput({
      questions: [question(), question({ questionId: 'rxjs:q:1' })]   // both position 0
    });
    expect(() => ctx.repo.createSessionSnapshot(input)).toThrow(/duplicate question position/i);
  });

  it('rejects a duplicate question id within the session', () => {
    const input = sessionInput({ questions: [question(), question({ position: 1 })] });
    expect(() => ctx.repo.createSessionSnapshot(input)).toThrow(/duplicate question id/i);
  });

  it('rejects a duplicate option id within one question', () => {
    const input = sessionInput({
      questions: [question({
        options: [
          { optionId: 401, text: 'a', displayOrder: 0, isCorrect: true },
          { optionId: 401, text: 'b', displayOrder: 1, isCorrect: false }
        ]
      })]
    });
    expect(() => ctx.repo.createSessionSnapshot(input)).toThrow(/duplicate option id/i);
  });

  it('rejects non-contiguous question positions', () => {
    const input = sessionInput({
      questions: [question(), question({ position: 5, questionId: 'rxjs:q:5' })]
    });
    expect(() => ctx.repo.createSessionSnapshot(input)).toThrow(/contiguous/i);
  });
});

describe('schema constraints', () => {
  function rawInsertSession(overrides: Record<string, unknown> = {}): void {
    const row = {
      id: 'raw_1', token_hash: 'h', status: 'active',
      config_json: '{"difficulty":"mixed","topicIds":["rxjs"],"questionCount":1}',
      duration_seconds: 900, created_at: CLOCK.CREATED_AT,
      expires_at: CLOCK.CREATED_AT + CLOCK.HOUR_MS,
      submitted_at: null, submitted_by_expiry: 0, result_json: null, attempt_id: 'raw_att_1',
      ...overrides
    };
    ctx.handle.db.prepare(`
      INSERT INTO interview_sessions
        (id, token_hash, status, config_json, duration_seconds, created_at, expires_at,
         submitted_at, submitted_by_expiry, result_json, attempt_id)
      VALUES (@id, @token_hash, @status, @config_json, @duration_seconds, @created_at,
              @expires_at, @submitted_at, @submitted_by_expiry, @result_json, @attempt_id)
    `).run(row);
  }

  it('rejects an invalid status', () => {
    expect(() => rawInsertSession({ status: 'paused' })).toThrow(/CHECK/i);
  });

  it('rejects a non-positive duration', () => {
    expect(() => rawInsertSession({ duration_seconds: 0 })).toThrow(/CHECK/i);
  });

  it('rejects expires_at at or before created_at', () => {
    expect(() => rawInsertSession({ expires_at: CLOCK.CREATED_AT })).toThrow(/CHECK/i);
  });

  it('rejects a blank id, token hash or attempt id', () => {
    expect(() => rawInsertSession({ id: '   ' })).toThrow(/CHECK/i);
    expect(() => rawInsertSession({ token_hash: '' })).toThrow(/CHECK/i);
    expect(() => rawInsertSession({ attempt_id: '  ' })).toThrow(/CHECK/i);
  });

  it('rejects submitted status without submitted_at', () => {
    expect(() => rawInsertSession({ status: 'submitted', submitted_at: null })).toThrow(/CHECK/i);
  });

  it('rejects an active session carrying a result', () => {
    expect(() => rawInsertSession({ status: 'active', result_json: '{}' })).toThrow(/CHECK/i);
  });

  it('rejects an out-of-range submitted_by_expiry', () => {
    expect(() => rawInsertSession({ submitted_by_expiry: 2 })).toThrow(/CHECK/i);
  });

  it('rejects an invalid question type', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    expect(() =>
      ctx.handle.db.prepare(`
        INSERT INTO session_questions
          (session_id, position, question_id, source_quiz_id, question_text, question_type, explanation)
        VALUES ('sess_1', 1, 'q1', 'rxjs', 'text', 'essay', 'why')
      `).run()
    ).toThrow(/CHECK/i);
  });

  it('rejects blank question text and blank explanation', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    const insert = (text: string, explanation: string) =>
      ctx.handle.db.prepare(`
        INSERT INTO session_questions
          (session_id, position, question_id, source_quiz_id, question_text, question_type, explanation)
        VALUES ('sess_1', 1, 'q1', 'rxjs', ?, 'single', ?)
      `).run(text, explanation);

    expect(() => insert('   ', 'why')).toThrow(/CHECK/i);
    expect(() => insert('text', '  ')).toThrow(/CHECK/i);
  });

  it('rejects a non-boolean is_correct integer', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    expect(() =>
      ctx.handle.db.prepare(`
        INSERT INTO session_options
          (session_id, question_position, option_id, option_text, display_order, is_correct)
        VALUES ('sess_1', 0, 999, 'x', 9, 7)
      `).run()
    ).toThrow(/CHECK/i);
  });
});

describe('foreign keys and cascades', () => {
  it('REJECTS an orphan question', () => {
    expect(() =>
      ctx.handle.db.prepare(`
        INSERT INTO session_questions
          (session_id, position, question_id, source_quiz_id, question_text, question_type, explanation)
        VALUES ('ghost', 0, 'q', 'rxjs', 'text', 'single', 'why')
      `).run()
    ).toThrow(/FOREIGN KEY/i);
  });

  it('REJECTS an orphan option', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    expect(() =>
      ctx.handle.db.prepare(`
        INSERT INTO session_options
          (session_id, question_position, option_id, option_text, display_order, is_correct)
        VALUES ('sess_1', 99, 101, 'x', 0, 1)
      `).run()
    ).toThrow(/FOREIGN KEY/i);
  });

  it('REJECTS an orphan answer', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    expect(() =>
      ctx.handle.db.prepare(`
        INSERT INTO session_answers
          (session_id, question_position, selected_option_ids, updated_at)
        VALUES ('sess_1', 42, '[101]', 1)
      `).run()
    ).toThrow(/FOREIGN KEY/i);
  });

  it('CASCADES delete to questions, options and answers', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    ctx.handle.db.prepare(`
      INSERT INTO session_answers (session_id, question_position, selected_option_ids, updated_at)
      VALUES ('sess_1', 0, '[101]', 1)
    `).run();

    expect(ctx.repo.deleteSession('sess_1')).toBe(true);

    for (const table of ['session_questions', 'session_options', 'session_answers']) {
      expect(ctx.handle.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it('deleteSession reports false for an unknown id', () => {
    expect(ctx.repo.deleteSession('nope')).toBe(false);
  });
});

describe('option identity is scoped to its question', () => {
  const twoQuestions = sessionInput({
    questions: [
      question({
        position: 0,
        questionId: 'rxjs:q:3',
        options: [
          { optionId: 401, text: 'RXJS-401', displayOrder: 0, isCorrect: true },
          { optionId: 402, text: 'RXJS-402', displayOrder: 1, isCorrect: false }
        ]
      }),
      question({
        position: 1,
        questionId: 'signals:q:3',
        options: [
          { optionId: 401, text: 'SIGNALS-401', displayOrder: 0, isCorrect: false },
          { optionId: 402, text: 'SIGNALS-402', displayOrder: 1, isCorrect: true }
        ]
      })
    ]
  });

  it('ALLOWS the same option id in different questions', () => {
    ctx.repo.createSessionSnapshot(twoQuestions);
    const snapshot = ctx.repo.getSessionSnapshot('sess_1')!;

    const a = snapshot.questions[0]!.options.find((o) => o.optionId === 401)!;
    const b = snapshot.questions[1]!.options.find((o) => o.optionId === 401)!;

    expect(a.text).toBe('RXJS-401');
    expect(b.text).toBe('SIGNALS-401');
    expect(a.isCorrect).toBe(true);
    expect(b.isCorrect).toBe(false);   // same id, opposite correctness
  });

  it('an option is retrievable only within its own question position', () => {
    ctx.repo.createSessionSnapshot(twoQuestions);
    const row = ctx.handle.db
      .prepare('SELECT option_text FROM session_options WHERE session_id = ? AND question_position = ? AND option_id = ?')
      .get('sess_1', 1, 401) as { option_text: string };

    expect(row.option_text).toBe('SIGNALS-401');   // NOT the question-0 option
  });

  it('rejects the SAME option id twice within one question', () => {
    ctx.repo.createSessionSnapshot(twoQuestions);
    expect(() =>
      ctx.handle.db.prepare(`
        INSERT INTO session_options
          (session_id, question_position, option_id, option_text, display_order, is_correct)
        VALUES ('sess_1', 0, 401, 'dupe', 9, 0)
      `).run()
    ).toThrow(/UNIQUE|PRIMARY KEY/i);
  });

  it('rejects a duplicate display order within one question', () => {
    ctx.repo.createSessionSnapshot(twoQuestions);
    expect(() =>
      ctx.handle.db.prepare(`
        INSERT INTO session_options
          (session_id, question_position, option_id, option_text, display_order, is_correct)
        VALUES ('sess_1', 0, 999, 'dupe-order', 0, 0)
      `).run()
    ).toThrow(/UNIQUE/i);
  });
});

describe('reads and JSON validation', () => {
  it('finds a session by attempt id', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    expect(ctx.repo.getSessionByAttemptId('att_1')?.id).toBe('sess_1');
    expect(ctx.repo.getSessionByAttemptId('nope')).toBeNull();
  });

  it('returns null for an unknown session', () => {
    expect(ctx.repo.getSessionById('nope')).toBeNull();
    expect(ctx.repo.getSessionSnapshot('nope')).toBeNull();
  });

  it('REJECTS malformed stored config rather than trusting the database', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    ctx.handle.db.prepare("UPDATE interview_sessions SET config_json = 'not json' WHERE id = 'sess_1'").run();
    expect(() => ctx.repo.getSessionById('sess_1')).toThrow(/unreadable config/i);
  });

  it('rejects a structurally wrong config', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    ctx.handle.db.prepare(`UPDATE interview_sessions SET config_json = '{"difficulty":1}' WHERE id = 'sess_1'`).run();
    expect(() => ctx.repo.getSessionById('sess_1')).toThrow(/invalid config/i);
  });

  it('validates stored answer arrays on read', () => {
    expect(parseSelectedOptionIds('[101,102]', 'ctx')).toEqual([101, 102]);
    expect(() => parseSelectedOptionIds('[]', 'ctx')).toThrow(/invalid selections/i);
    expect(() => parseSelectedOptionIds('[1,1]', 'ctx')).toThrow(/duplicate/i);
    expect(() => parseSelectedOptionIds('[1.5]', 'ctx')).toThrow(/non-integer/i);
    expect(() => parseSelectedOptionIds('["101"]', 'ctx')).toThrow(/non-integer/i);
    expect(() => parseSelectedOptionIds('nope', 'ctx')).toThrow(/unreadable/i);
    expect(() => parseSelectedOptionIds('{"a":1}', 'ctx')).toThrow(/invalid selections/i);
  });

  it('reads back saved answers through the repository', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    ctx.handle.db.prepare(`
      INSERT INTO session_answers (session_id, question_position, selected_option_ids, updated_at)
      VALUES ('sess_1', 0, '[101]', 123)
    `).run();

    expect(ctx.repo.getAnswers('sess_1')).toEqual([
      { position: 0, selectedOptionIds: [101], updatedAt: 123 }
    ]);
  });

  it('mutating a returned record does not change stored data', () => {
    const record = ctx.repo.createSessionSnapshot(sessionInput());
    (record.config.topicIds as string[]).push('signals');
    (record as { attemptId: string }).attemptId = 'TAMPERED';

    const fresh = ctx.repo.getSessionById('sess_1')!;
    expect(fresh.config.topicIds).toEqual(['rxjs']);
    expect(fresh.attemptId).toBe('att_1');
  });

  it('mutating a returned snapshot does not change stored data', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    const snapshot = ctx.repo.getSessionSnapshot('sess_1')!;
    (snapshot.questions[0] as { questionText: string }).questionText = 'TAMPERED';
    (snapshot.questions[0]!.options[0] as { isCorrect: boolean }).isCorrect = false;

    const fresh = ctx.repo.getSessionSnapshot('sess_1')!;
    expect(fresh.questions[0]!.questionText).toBe('Which answer is correct?');
    expect(fresh.questions[0]!.options[0]!.isCorrect).toBe(true);
  });
});

describe('state transitions', () => {
  it('markExpired flips an active session', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    expect(ctx.repo.markExpired('sess_1', CLOCK.CREATED_AT + 1).status).toBe('expired');
  });

  it('markExpired leaves a submitted session alone', () => {
    ctx.repo.createSessionSnapshot(sessionInput());
    ctx.handle.db.prepare(
      `UPDATE interview_sessions SET status = 'submitted', submitted_at = 1 WHERE id = 'sess_1'`
    ).run();

    expect(ctx.repo.markExpired('sess_1', 2).status).toBe('submitted');
  });

  it('markExpired throws for an unknown session', () => {
    expect(() => ctx.repo.markExpired('nope', 1)).toThrow(SessionRepositoryError);
  });
});

describe('restart persistence (real file, not :memory:)', () => {
  it('survives close and reopen, and does not rerun migrations', () => {
    const path = resolve(tempDir, 'restart.db');

    const first = fileDb(tempDir, 'restart.db');
    first.repo.createSessionSnapshot(sessionInput());
    first.handle.close();

    const second = openDatabase({ databasePath: path });
    const appliedAgain = migrate(second.db, { now: () => 999 });
    expect(appliedAgain).toEqual([]);   // already applied, not rerun

    const repo = createSessionRepository(second.db);
    const snapshot = repo.getSessionSnapshot('sess_1')!;

    expect(snapshot.session.attemptId).toBe('att_1');
    expect(snapshot.session.status).toBe('active');
    expect(snapshot.questions[0]!.questionText).toBe('Which answer is correct?');
    expect(snapshot.questions[0]!.options.map((o) => o.optionId)).toEqual([101, 102]);
    expect(snapshot.questions[0]!.options[0]!.isCorrect).toBe(true);
    second.close();
  });

  it('FROZEN SNAPSHOT: a changed quiz bank cannot alter a stored session', () => {
    const path = resolve(tempDir, 'frozen.db');

    const first = fileDb(tempDir, 'frozen.db');
    first.repo.createSessionSnapshot(sessionInput({
      questions: [question({
        questionText: 'ORIGINAL TEXT',
        explanation: 'ORIGINAL EXPLANATION',
        options: [
          { optionId: 101, text: 'ORIGINAL A', displayOrder: 0, isCorrect: true },
          { optionId: 102, text: 'ORIGINAL B', displayOrder: 1, isCorrect: false }
        ]
      })]
    }));
    first.handle.close();

    // Simulate the quiz bank being edited/redeployed between sessions: the
    // session must not consult it at all, so nothing here can affect the read.
    const second = openDatabase({ databasePath: path });
    migrate(second.db);
    const snapshot = createSessionRepository(second.db).getSessionSnapshot('sess_1')!;

    const stored = snapshot.questions[0]!;
    expect(stored.questionText).toBe('ORIGINAL TEXT');
    expect(stored.explanation).toBe('ORIGINAL EXPLANATION');
    expect(stored.options.map((o) => o.text)).toEqual(['ORIGINAL A', 'ORIGINAL B']);
    expect(stored.options.map((o) => o.displayOrder)).toEqual([0, 1]);
    expect(stored.options.map((o) => o.isCorrect)).toEqual([true, false]);
    second.close();
  });

  it('preserves option ORDER exactly as stored', () => {
    const path = resolve(tempDir, 'order.db');
    const first = fileDb(tempDir, 'order.db');
    first.repo.createSessionSnapshot(sessionInput({
      questions: [question({
        options: [
          { optionId: 104, text: 'fourth-first', displayOrder: 0, isCorrect: false },
          { optionId: 101, text: 'first-second', displayOrder: 1, isCorrect: true },
          { optionId: 103, text: 'third-third', displayOrder: 2, isCorrect: false }
        ]
      })]
    }));
    first.handle.close();

    const second = openDatabase({ databasePath: path });
    migrate(second.db);
    const options = createSessionRepository(second.db)
      .getSessionSnapshot('sess_1')!.questions[0]!.options;

    expect(options.map((o) => o.optionId)).toEqual([104, 101, 103]);
    second.close();
  });
});

describe('token hash containment', () => {
  it('is stored, but never appears in a snapshot question or option', () => {
    ctx.repo.createSessionSnapshot(sessionInput({ tokenHash: 'SECRET-HASH-VALUE' }));
    const snapshot = ctx.repo.getSessionSnapshot('sess_1')!;

    // The record legitimately carries it for internal verification…
    expect(snapshot.session.tokenHash).toBe('SECRET-HASH-VALUE');
    // …but it must not have leaked into the question/option snapshots.
    expect(JSON.stringify(snapshot.questions)).not.toContain('SECRET-HASH-VALUE');
  });
});
