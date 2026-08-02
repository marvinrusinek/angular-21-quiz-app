import type Database from 'better-sqlite3';

import type { QuestionType } from '../quiz/quiz.types';
import { computeTimeUsedSeconds, scoreInterview } from './result.scoring';
import {
  assertResultInvariants,
  parseFrozenResult,
  type FrozenInterviewResult
} from './result.types';
import type {
  CreateSessionInput,
  InterviewSessionConfig,
  InterviewSessionRecord,
  InterviewSessionSnapshot,
  SessionAnswerRecord,
  SessionOptionSnapshot,
  SessionQuestionSnapshot,
  SessionStatus
} from './session.types';

/**
 * Interview session persistence.
 *
 * Every statement is PARAMETERIZED — no value is ever interpolated into SQL.
 * Raw rows never leave this module: each read converts snake_case columns into
 * an explicit object, and every JSON column is parsed AND revalidated, because
 * "this process wrote it" is not a guarantee that it is still well-formed.
 */

export type SessionRepositoryErrorCategory =
  | 'VALIDATION'
  | 'CONSTRAINT'
  | 'NOT_FOUND'
  | 'CORRUPT_DATA'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_ACTIVE'
  | 'SESSION_EXPIRED'
  | 'QUESTION_NOT_IN_SESSION'
  | 'OPTION_NOT_IN_QUESTION'
  | 'INVALID_SELECTION_COUNT';

export class SessionRepositoryError extends Error {
  public override readonly name = 'SessionRepositoryError';
  /** Coarse category for logs and HTTP translation. Never carries values or SQL. */
  public readonly category: SessionRepositoryErrorCategory;

  constructor(category: SessionRepositoryErrorCategory, message: string) {
    super(message);
    this.category = category;
  }
}

export interface SaveAnswerInput {
  readonly sessionId: string;
  readonly questionId: string;
  /** The COMPLETE current selection. Empty clears the answer. */
  readonly selectedOptionIds: readonly number[];
  /** Captured ONCE by the caller and used for the whole transaction. */
  readonly now: number;
}

export interface SavedAnswerState {
  readonly questionId: string;
  readonly selectedOptionIds: readonly number[];
  readonly answeredCount: number;
  readonly questionCount: number;
}

const QUESTION_TYPES: readonly QuestionType[] = ['single', 'multiple', 'trueFalse'];

// ── row shapes (module-private) ─────────────────────────────────────

interface SessionRow {
  id: string;
  token_hash: string;
  status: string;
  config_json: string;
  duration_seconds: number;
  created_at: number;
  expires_at: number;
  submitted_at: number | null;
  submitted_by_expiry: number;
  result_json: string | null;
  attempt_id: string;
}

interface QuestionRow {
  position: number;
  question_id: string;
  source_quiz_id: string;
  question_text: string;
  question_type: string;
  explanation: string;
}

interface OptionRow {
  question_position: number;
  option_id: number;
  option_text: string;
  display_order: number;
  is_correct: number;
}

interface AnswerRow {
  question_position: number;
  selected_option_ids: string;
  updated_at: number;
}

// ── JSON validators ─────────────────────────────────────────────────

function parseConfig(raw: string, sessionId: string): InterviewSessionConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionRepositoryError('CORRUPT_DATA', `Session ${sessionId} has unreadable config`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SessionRepositoryError('CORRUPT_DATA', `Session ${sessionId} has an invalid config`);
  }

  const candidate = parsed as Record<string, unknown>;
  const topicIds = candidate['topicIds'];
  const questionCount = candidate['questionCount'];
  const difficulty = candidate['difficulty'];

  if (
    typeof difficulty !== 'string' ||
    !Array.isArray(topicIds) ||
    !topicIds.every((id): id is string => typeof id === 'string') ||
    typeof questionCount !== 'number' ||
    !Number.isInteger(questionCount)
  ) {
    throw new SessionRepositoryError('CORRUPT_DATA', `Session ${sessionId} has an invalid config`);
  }

  const config: InterviewSessionConfig = {
    difficulty,
    topicIds: [...topicIds],
    questionCount,
    ...(typeof candidate['presetId'] === 'string' ? { presetId: candidate['presetId'] } : {}),
    ...(typeof candidate['presetName'] === 'string' ? { presetName: candidate['presetName'] } : {})
  };
  return config;
}

/**
 * Validate a stored answer array: an array of unique integers, non-empty.
 * Full correctness/type-arity checking belongs to the answer service (Stage 7);
 * this is the structural floor.
 */
export function parseSelectedOptionIds(raw: string, context: string): readonly number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionRepositoryError('CORRUPT_DATA', `${context} has unreadable selections`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new SessionRepositoryError('CORRUPT_DATA', `${context} has invalid selections`);
  }
  const ids: number[] = [];
  for (const value of parsed) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new SessionRepositoryError('CORRUPT_DATA', `${context} has a non-integer selection`);
    }
    if (ids.includes(value)) {
      throw new SessionRepositoryError('CORRUPT_DATA', `${context} has duplicate selections`);
    }
    ids.push(value);
  }
  return ids;
}

function parseResult(raw: string | null, sessionId: string): unknown | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new SessionRepositoryError('CORRUPT_DATA', `Session ${sessionId} has an unreadable result`);
  }
}

function toStatus(raw: string, sessionId: string): SessionStatus {
  if (raw === 'active' || raw === 'submitted' || raw === 'expired') return raw;
  throw new SessionRepositoryError('CORRUPT_DATA', `Session ${sessionId} has an unknown status`);
}

function toQuestionType(raw: string, context: string): QuestionType {
  const match = QUESTION_TYPES.find((type) => type === raw);
  if (!match) {
    throw new SessionRepositoryError('CORRUPT_DATA', `${context} has an unknown question type`);
  }
  return match;
}

// ── input validation (TypeScript-side) ──────────────────────────────

function validateCreateInput(input: CreateSessionInput): void {
  const fail = (message: string): never => {
    throw new SessionRepositoryError('VALIDATION', message);
  };

  if (input.questions.length === 0) fail('A session must contain at least one question');

  const positions = new Set<number>();
  const questionIds = new Set<string>();

  for (const question of input.questions) {
    if (!Number.isInteger(question.position) || question.position < 0) {
      fail('Question position must be a non-negative integer');
    }
    if (positions.has(question.position)) fail('Duplicate question position');
    positions.add(question.position);

    if (questionIds.has(question.questionId)) fail('Duplicate question id within the session');
    questionIds.add(question.questionId);

    if (question.options.length === 0) fail('A question must contain at least one option');

    const optionIds = new Set<number>();
    const displayOrders = new Set<number>();
    for (const option of question.options) {
      if (optionIds.has(option.optionId)) fail('Duplicate option id within a question');
      optionIds.add(option.optionId);
      if (displayOrders.has(option.displayOrder)) fail('Duplicate display order within a question');
      displayOrders.add(option.displayOrder);
    }
  }

  // Positions must be a dense 0..n-1 range so ordering is unambiguous.
  for (let i = 0; i < input.questions.length; i++) {
    if (!positions.has(i)) fail('Question positions must be contiguous from zero');
  }
}

// ── repository ──────────────────────────────────────────────────────

/**
 * The narrow record used for bearer verification. Deliberately separate from
 * InterviewSessionRecord so the token hash is fetched only where it is actually
 * needed, instead of riding along on every read.
 */
export interface SessionAuthenticationRecord {
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly status: SessionStatus;
  readonly expiresAt: number;
}

export interface SessionRepository {
  createSessionSnapshot(input: CreateSessionInput): InterviewSessionRecord;
  /** Token-hash access, scoped to verification. */
  getSessionAuthenticationRecord(sessionId: string): SessionAuthenticationRecord | null;
  /** Atomically flip an ACTIVE session to expired when its deadline has passed. */
  markExpiredIfDue(sessionId: string, now: number): InterviewSessionRecord | null;
  getSessionById(sessionId: string): InterviewSessionRecord | null;
  getSessionByAttemptId(attemptId: string): InterviewSessionRecord | null;
  getSessionSnapshot(sessionId: string): InterviewSessionSnapshot | null;
  getAnswers(sessionId: string): readonly SessionAnswerRecord[];
  markExpired(sessionId: string, expiredAt: number): InterviewSessionRecord;
  deleteSession(sessionId: string): boolean;
  /**
   * Save or clear ONE question's selection, entirely inside a single
   * transaction: state check, expiry check, membership checks and the write all
   * happen without an interleaving point. Returns the resulting state.
   */
  saveAnswer(input: SaveAnswerInput): SavedAnswerState;
  /**
   * Score and close the session in ONE transaction. Idempotent: an already
   * submitted session returns its stored result and is never rescored.
   */
  finalizeSession(input: FinalizeSessionInput): FrozenInterviewResult;
  /** The frozen result, or null when the session has not been submitted. */
  getSubmittedResult(sessionId: string): FrozenInterviewResult | null;
}

export interface FinalizeSessionInput {
  readonly sessionId: string;
  /** Captured ONCE by the caller and used for the whole transaction. */
  readonly now: number;
  /** Resolved at finalization and frozen into the result. */
  readonly topicTitleFor: (topicId: string) => string;
}

export function createSessionRepository(db: Database.Database): SessionRepository {
  const insertSession = db.prepare(`
    INSERT INTO interview_sessions
      (id, token_hash, status, config_json, duration_seconds,
       created_at, expires_at, submitted_at, submitted_by_expiry, result_json, attempt_id)
    VALUES (?, ?, 'active', ?, ?, ?, ?, NULL, 0, NULL, ?)
  `);

  const insertQuestion = db.prepare(`
    INSERT INTO session_questions
      (session_id, position, question_id, source_quiz_id, question_text, question_type, explanation)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertOption = db.prepare(`
    INSERT INTO session_options
      (session_id, question_position, option_id, option_text, display_order, is_correct)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const selectSession = db.prepare('SELECT * FROM interview_sessions WHERE id = ?');
  const selectByAttempt = db.prepare('SELECT * FROM interview_sessions WHERE attempt_id = ?');
  const selectQuestions = db.prepare(
    `SELECT position, question_id, source_quiz_id, question_text, question_type, explanation
     FROM session_questions WHERE session_id = ? ORDER BY position`
  );
  const selectOptions = db.prepare(
    `SELECT question_position, option_id, option_text, display_order, is_correct
     FROM session_options WHERE session_id = ? ORDER BY question_position, display_order`
  );
  const selectAnswers = db.prepare(
    `SELECT question_position, selected_option_ids, updated_at
     FROM session_answers WHERE session_id = ? ORDER BY question_position`
  );
  const updateExpired = db.prepare(
    `UPDATE interview_sessions SET status = 'expired' WHERE id = ? AND status = 'active'`
  );
  const expireIfDue = db.prepare(
    `UPDATE interview_sessions SET status = 'expired'
     WHERE id = ? AND status = 'active' AND expires_at <= ?`
  );
  const selectAuth = db.prepare(
    'SELECT id, token_hash, status, expires_at FROM interview_sessions WHERE id = ?'
  );
  const deleteStatement = db.prepare('DELETE FROM interview_sessions WHERE id = ?');

  /**
   * ONE transaction covering the session row, every question and every option.
   * A failure anywhere — a constraint violation on the last option included —
   * leaves no session, no questions and no options behind.
   */
  const createTransaction = db.transaction((input: CreateSessionInput): void => {
    insertSession.run(
      input.id,
      input.tokenHash,
      JSON.stringify(input.config),
      input.durationSeconds,
      input.createdAt,
      input.expiresAt,
      input.attemptId
    );

    for (const question of input.questions) {
      insertQuestion.run(
        input.id,
        question.position,
        question.questionId,
        question.sourceQuizId,
        question.questionText,
        question.type,
        question.explanation
      );

      for (const option of question.options) {
        insertOption.run(
          input.id,
          question.position,
          option.optionId,
          option.text,
          option.displayOrder,
          option.isCorrect ? 1 : 0
        );
      }
    }
  });

  function toRecord(row: SessionRow): InterviewSessionRecord {
    return {
      id: row.id,
      tokenHash: row.token_hash,
      status: toStatus(row.status, row.id),
      config: parseConfig(row.config_json, row.id),
      durationSeconds: row.duration_seconds,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      submittedAt: row.submitted_at,
      submittedByExpiry: row.submitted_by_expiry === 1,
      result: parseResult(row.result_json, row.id),
      attemptId: row.attempt_id
    };
  }

  // Declared as a const and returned at the END of the factory, so every
  // prepared statement below it is initialized before the object escapes.
  const repository: SessionRepository = {
    createSessionSnapshot(input) {
      validateCreateInput(input);

      try {
        createTransaction(input);
      } catch (err: unknown) {
        // Classify on SQLite's STABLE error code, not its human-readable
        // message: the message text is not part of any contract and differs
        // between environments, which silently degraded every constraint
        // violation to the generic branch. Surface a CATEGORY only — the raw
        // message can quote the values that were being inserted.
        const code = (err as { code?: unknown }).code;
        const sqliteCode = typeof code === 'string' ? code : '';

        if (sqliteCode === 'SQLITE_CONSTRAINT_PRIMARYKEY' || sqliteCode === 'SQLITE_CONSTRAINT_UNIQUE') {
          throw new SessionRepositoryError('CONSTRAINT', 'Session violates a uniqueness constraint');
        }
        if (sqliteCode.startsWith('SQLITE_CONSTRAINT')) {
          throw new SessionRepositoryError('CONSTRAINT', 'Session violates a schema constraint');
        }
        throw new SessionRepositoryError('CONSTRAINT', 'Session could not be created');
      }

      const created = this.getSessionById(input.id);
      if (!created) {
        throw new SessionRepositoryError('NOT_FOUND', 'Session vanished immediately after creation');
      }
      return created;
    },

    getSessionById(sessionId) {
      const row = selectSession.get(sessionId) as SessionRow | undefined;
      return row ? toRecord(row) : null;
    },

    getSessionAuthenticationRecord(sessionId) {
      const row = selectAuth.get(sessionId) as
        | { id: string; token_hash: string; status: string; expires_at: number }
        | undefined;
      if (!row) return null;
      return {
        sessionId: row.id,
        tokenHash: row.token_hash,
        status: toStatus(row.status, row.id),
        expiresAt: row.expires_at
      };
    },

    markExpiredIfDue(sessionId, now) {
      // Single UPDATE guarded on both status and deadline, so two concurrent
      // requests cannot both believe they performed the transition.
      expireIfDue.run(sessionId, now);
      return this.getSessionById(sessionId);
    },

    getSessionByAttemptId(attemptId) {
      const row = selectByAttempt.get(attemptId) as SessionRow | undefined;
      return row ? toRecord(row) : null;
    },

    getSessionSnapshot(sessionId) {
      const session = this.getSessionById(sessionId);
      if (!session) return null;

      const questionRows = selectQuestions.all(sessionId) as QuestionRow[];
      const optionRows = selectOptions.all(sessionId) as OptionRow[];

      const optionsByPosition = new Map<number, SessionOptionSnapshot[]>();
      for (const row of optionRows) {
        const list = optionsByPosition.get(row.question_position) ?? [];
        list.push({
          optionId: row.option_id,
          text: row.option_text,
          displayOrder: row.display_order,
          isCorrect: row.is_correct === 1
        });
        optionsByPosition.set(row.question_position, list);
      }

      const questions: SessionQuestionSnapshot[] = questionRows.map((row) => ({
        position: row.position,
        questionId: row.question_id,
        sourceQuizId: row.source_quiz_id,
        questionText: row.question_text,
        type: toQuestionType(row.question_type, `Session ${sessionId} question ${row.position}`),
        explanation: row.explanation,
        options: optionsByPosition.get(row.position) ?? []
      }));

      return { session, questions };
    },

    getAnswers(sessionId) {
      const rows = selectAnswers.all(sessionId) as AnswerRow[];
      return rows.map((row) => ({
        position: row.question_position,
        selectedOptionIds: parseSelectedOptionIds(
          row.selected_option_ids,
          `Session ${sessionId} answer ${row.question_position}`
        ),
        updatedAt: row.updated_at
      }));
    },

    markExpired(sessionId, expiredAt) {
      void expiredAt;   // recorded on submission (Stage 8), not on the status flip
      updateExpired.run(sessionId);
      const record = this.getSessionById(sessionId);
      if (!record) {
        throw new SessionRepositoryError('NOT_FOUND', 'Session not found');
      }
      return record;
    },

    deleteSession(sessionId) {
      return deleteStatement.run(sessionId).changes > 0;
    },

    saveAnswer(input) {
      // better-sqlite3 transactions are synchronous, so there is no await point
      // between the expiry check and the write — an answer cannot slip in after
      // the deadline.
      try {
        return saveAnswerTransaction(input) as SavedAnswerState;
      } catch (err: unknown) {
        // The transaction has already rolled back, so the rejected answer left
        // no trace. Record the expiry now, OUTSIDE it, so the state change
        // survives. The UPDATE is guarded on status = 'active', making it safe
        // to run repeatedly and under concurrency.
        if (err instanceof SessionRepositoryError && err.category === 'SESSION_EXPIRED') {
          expireNow.run(input.sessionId);
        }
        throw err;
      }
    },

    finalizeSession(input) {
      return finalizeTransaction(input) as FrozenInterviewResult;
    },

    getSubmittedResult(sessionId) {
      const row = selectResult.get(sessionId) as
        | { status: string; result_json: string | null }
        | undefined;
      if (!row || row.status !== 'submitted' || row.result_json === null) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(row.result_json);
      } catch {
        throw new SessionRepositoryError('CORRUPT_DATA', `Session ${sessionId} has an unreadable result`);
      }
      // Revalidated on every read — never regenerated.
      return parseFrozenResult(parsed, sessionId);
    }
  };

  // ── answer persistence ────────────────────────────────────────────

  const selectStateForUpdate = db.prepare(
    'SELECT id, status, expires_at FROM interview_sessions WHERE id = ?'
  );
  const selectQuestionByPublicId = db.prepare(
    `SELECT position, question_type FROM session_questions
     WHERE session_id = ? AND question_id = ?`
  );
  const selectOptionIdsForQuestion = db.prepare(
    `SELECT option_id FROM session_options
     WHERE session_id = ? AND question_position = ?`
  );
  const upsertAnswer = db.prepare(
    `INSERT INTO session_answers (session_id, question_position, selected_option_ids, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (session_id, question_position)
     DO UPDATE SET selected_option_ids = excluded.selected_option_ids,
                   updated_at          = excluded.updated_at`
  );
  const deleteAnswer = db.prepare(
    'DELETE FROM session_answers WHERE session_id = ? AND question_position = ?'
  );
  const countAnswers = db.prepare(
    'SELECT COUNT(*) AS n FROM session_answers WHERE session_id = ?'
  );
  const countQuestions = db.prepare(
    'SELECT COUNT(*) AS n FROM session_questions WHERE session_id = ?'
  );
  const expireNow = db.prepare(
    `UPDATE interview_sessions SET status = 'expired' WHERE id = ? AND status = 'active'`
  );

  const saveAnswerTransaction = db.transaction((input: SaveAnswerInput): SavedAnswerState => {
    const state = selectStateForUpdate.get(input.sessionId) as
      | { id: string; status: string; expires_at: number }
      | undefined;

    if (!state) {
      throw new SessionRepositoryError('SESSION_NOT_FOUND', 'Session not found');
    }
    if (state.status === 'submitted') {
      throw new SessionRepositoryError('SESSION_NOT_ACTIVE', 'Session already submitted');
    }
    if (state.status === 'expired') {
      throw new SessionRepositoryError('SESSION_EXPIRED', 'Session expired');
    }

    // BOUNDARY: now >= expiresAt is expired. A save exactly AT the deadline
    // fails, one millisecond before succeeds.
    //
    // The status flip deliberately does NOT happen here: throwing rolls the
    // transaction back, which would undo it. It is applied by the caller after
    // the rollback, so the rejected write vanishes while the expiry sticks.
    if (input.now >= state.expires_at) {
      throw new SessionRepositoryError('SESSION_EXPIRED', 'Session expired');
    }

    const question = selectQuestionByPublicId.get(input.sessionId, input.questionId) as
      | { position: number; question_type: string }
      | undefined;

    if (!question) {
      // Covers both "no such question" and "belongs to another session" — the
      // lookup is scoped by session_id, so neither is distinguishable.
      throw new SessionRepositoryError(
        'QUESTION_NOT_IN_SESSION',
        'Question does not belong to this session'
      );
    }

    const type = toQuestionType(question.question_type, `Session ${input.sessionId}`);
    const selected = [...input.selectedOptionIds];

    if (selected.length === 0) {
      deleteAnswer.run(input.sessionId, question.position);
      return finalState(input.sessionId, input.questionId, []);
    }

    // Single and trueFalse are both single-selection.
    if (type !== 'multiple' && selected.length !== 1) {
      throw new SessionRepositoryError(
        'INVALID_SELECTION_COUNT',
        'This question accepts exactly one selection'
      );
    }

    // Ownership is resolved from the FROZEN snapshot, scoped by session AND
    // question position — never from the numeric option-id formula, which
    // collides across questions by design.
    const owned = new Set(
      (selectOptionIdsForQuestion.all(input.sessionId, question.position) as { option_id: number }[])
        .map((row) => row.option_id)
    );

    if (selected.length > owned.size) {
      throw new SessionRepositoryError(
        'INVALID_SELECTION_COUNT',
        'More selections than this question has options'
      );
    }
    for (const optionId of selected) {
      if (!owned.has(optionId)) {
        throw new SessionRepositoryError(
          'OPTION_NOT_IN_QUESTION',
          'Selected option does not belong to this question'
        );
      }
    }

    // Canonical ascending order: selection order carries no meaning anywhere in
    // the app, so sorting makes repeated saves byte-identical and comparison
    // trivial.
    const canonical = [...selected].sort((a, b) => a - b);

    upsertAnswer.run(
      input.sessionId,
      question.position,
      JSON.stringify(canonical),
      input.now
    );

    return finalState(input.sessionId, input.questionId, canonical);
  });

  // ── finalization ──────────────────────────────────────────────────

  const selectResult = db.prepare(
    'SELECT status, result_json FROM interview_sessions WHERE id = ?'
  );
  const selectForFinalize = db.prepare(
    `SELECT id, status, config_json, duration_seconds, created_at, expires_at, result_json
     FROM interview_sessions WHERE id = ?`
  );
  /**
   * Conditional UPDATE: it only fires while the session is NOT already
   * submitted. Two concurrent finalizations therefore cannot both write — the
   * loser sees 0 changes and reads back the winner's frozen result.
   */
  const writeResult = db.prepare(
    `UPDATE interview_sessions
     SET status = 'submitted', submitted_at = ?, submitted_by_expiry = ?, result_json = ?
     WHERE id = ? AND status <> 'submitted'`
  );

  const finalizeTransaction = db.transaction((input: FinalizeSessionInput): FrozenInterviewResult => {
    const row = selectForFinalize.get(input.sessionId) as
      | {
          id: string; status: string; config_json: string; duration_seconds: number;
          created_at: number; expires_at: number; result_json: string | null;
        }
      | undefined;

    if (!row) throw new SessionRepositoryError('SESSION_NOT_FOUND', 'Session not found');

    // IDEMPOTENT: an already-submitted session returns its stored result and is
    // never rescored, so a manual submit racing an expiry submit yields ONE result.
    if (row.status === 'submitted') {
      if (row.result_json === null) {
        throw new SessionRepositoryError('CORRUPT_DATA', 'Submitted session has no stored result');
      }
      return parseFrozenResult(JSON.parse(row.result_json), input.sessionId);
    }

    const config = parseConfig(row.config_json, row.id);

    const questionRows = selectQuestions.all(input.sessionId) as QuestionRow[];
    const optionRows = selectOptions.all(input.sessionId) as OptionRow[];
    const answerRows = selectAnswers.all(input.sessionId) as AnswerRow[];

    const optionsByPosition = new Map<number, SessionOptionSnapshot[]>();
    for (const option of optionRows) {
      const list = optionsByPosition.get(option.question_position) ?? [];
      list.push({
        optionId: option.option_id,
        text: option.option_text,
        displayOrder: option.display_order,
        isCorrect: option.is_correct === 1
      });
      optionsByPosition.set(option.question_position, list);
    }

    const questions: SessionQuestionSnapshot[] = questionRows.map((question) => ({
      position: question.position,
      questionId: question.question_id,
      sourceQuizId: question.source_quiz_id,
      questionText: question.question_text,
      type: toQuestionType(question.question_type, `Session ${input.sessionId}`),
      explanation: question.explanation,
      options: optionsByPosition.get(question.position) ?? []
    }));

    const answersByPosition = new Map<number, readonly number[]>(
      answerRows.map((answer) => [
        answer.question_position,
        parseSelectedOptionIds(
          answer.selected_option_ids,
          `Session ${input.sessionId} answer ${answer.question_position}`
        )
      ])
    );

    const scored = scoreInterview({ questions, answersByPosition, topicTitleFor: input.topicTitleFor });

    // A deadline that has already passed means the attempt ended by EXPIRY,
    // regardless of which call finalized it — including a session Stage 7
    // already flipped to 'expired'.
    const submittedByExpiry = input.now >= row.expires_at || row.status === 'expired';
    const submittedAt = Math.min(input.now, row.expires_at);

    const timing = computeTimeUsedSeconds({
      now: input.now,
      expiresAt: row.expires_at,
      durationSeconds: row.duration_seconds
    });

    const result: FrozenInterviewResult = {
      sessionId: row.id,
      status: 'submitted',
      submittedAt,
      submittedByExpiry,
      total: scored.total,
      answered: scored.answered,
      unanswered: scored.unanswered,
      correct: scored.correct,
      incorrect: scored.incorrect,
      percentage: scored.percentage,
      durationSeconds: row.duration_seconds,
      timeUsedSeconds: timing.timeUsedSeconds,
      timeRemainingSeconds: timing.timeRemainingSeconds,
      config: {
        mode: config.presetId ? 'preset' : 'custom',
        ...(config.presetId ? { presetId: config.presetId } : { difficulty: config.difficulty }),
        topicIds: [...config.topicIds],
        questionCount: config.questionCount
      },
      performance: { byTopic: scored.byTopic },
      review: scored.review
    };

    // Validate BEFORE writing: a result that fails its invariants must never
    // become durable.
    assertResultInvariants(result);

    const changes = writeResult.run(
      submittedAt,
      submittedByExpiry ? 1 : 0,
      JSON.stringify(result),
      input.sessionId
    ).changes;

    if (changes === 0) {
      // Someone else submitted between our read and our write — return theirs.
      const winner = selectResult.get(input.sessionId) as { result_json: string | null };
      if (!winner?.result_json) {
        throw new SessionRepositoryError('CORRUPT_DATA', 'Concurrent finalization left no result');
      }
      return parseFrozenResult(JSON.parse(winner.result_json), input.sessionId);
    }

    return result;
  });

  function finalState(
    sessionId: string,
    questionId: string,
    selectedOptionIds: readonly number[]
  ): SavedAnswerState {
    return {
      questionId,
      selectedOptionIds,
      // Derived from persisted rows — never from anything the client sent.
      answeredCount: (countAnswers.get(sessionId) as { n: number }).n,
      questionCount: (countQuestions.get(sessionId) as { n: number }).n
    };
  }

  return repository;
}
