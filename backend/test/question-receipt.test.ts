import request from 'supertest';
import type { Express } from 'express';

import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { fromPool, type DatabaseHandle } from '../src/db/database';
import { migrate } from '../src/db/migrate';
import { createSessionRepository } from '../src/interview/session.repository';
import { InterviewSessionService } from '../src/interview/session.service';
import { seededRandomSource } from '../src/interview/assessment.random';
import { createQuizRepositoryFromDatabase } from '../src/quiz/quiz.repository';
import {
  QUESTION_DURATION_SECONDS,
  decodeQuestionReceiptUnverified
} from '../src/quiz/question-receipt';
import { createTestPool } from './helpers/pg-mem-pool';

/**
 * PER-QUESTION signed receipts.
 *
 * The Topic Quiz timer is per-question, so the deadline that authorizes a
 * timeout reveal must be per-question too. The attempt receipt's whole-quiz
 * deadline (30s × question count) is nowhere near expiry when question 3 of 10
 * times out at t=30s, so it could never authorize that reveal.
 *
 * The property these tests protect: a reveal is authorized ONLY by a signed
 * deadline for THAT question, and nothing a client sends can move it.
 */

const START = 1_700_000_000_000;
const Q1 = 'Which answer is correct?';
const Q2 = 'Select every operator';
const SIGNALS_Q = 'What does computed() return?';

let clock = START;

const BANK = {
  quizzes: [
    {
      quizId: 'rxjs',
      milestone: 'RxJS', summary: 's', image: 'i', difficulty: 'beginner',
      questions: [
        {
          questionText: Q1,
          explanation: 'Because a Subject multicasts.',
          options: [
            { text: 'A multicast observable', correct: true },
            { text: 'A pipe' }
          ]
        },
        {
          questionText: Q2,
          explanation: 'map and filter are operators.',
          options: [
            { text: 'map', correct: true },
            { text: 'filter', correct: true },
            { text: 'Observable' }
          ]
        }
      ]
    },
    {
      quizId: 'signals',
      milestone: 'Signals', summary: 's', image: 'i', difficulty: 'advanced',
      questions: [
        {
          questionText: SIGNALS_Q,
          explanation: 'A read-only signal.',
          options: [{ text: 'A read-only signal', correct: true }, { text: 'A promise' }]
        }
      ]
    }
  ]
};

let handle: DatabaseHandle;
let app: Express;

async function seed(db: DatabaseHandle): Promise<void> {
  for (const [qi, quiz] of BANK.quizzes.entries()) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO quizzes (quiz_id, milestone, summary, image, difficulty, facts_json, display_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [quiz.quizId, quiz.milestone, quiz.summary, quiz.image, quiz.difficulty, '[]', qi]
    );
    const quizPk = Number(rows[0]!['id']);

    for (const [qqi, question] of quiz.questions.entries()) {
      const type = question.options.filter((o) => 'correct' in o).length > 1 ? 'multiple' : 'single';
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO questions (quiz_pk, question_text, question_type, explanation, display_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [quizPk, question.questionText, type, question.explanation, qqi]
      );
      const questionPk = Number(inserted.rows[0]!['id']);

      for (const [oi, option] of question.options.entries()) {
        await db.query(
          `INSERT INTO options (question_pk, option_text, display_order, is_correct)
           VALUES ($1,$2,$3,$4)`,
          [questionPk, option.text, oi, 'correct' in option ? 1 : 0]
        );
      }
    }
  }
}

beforeEach(async () => {
  clock = START;
  handle = fromPool(createTestPool().pool, 'pg-mem');
  await migrate(handle, { now: () => START });
  await seed(handle);

  const quizRepository = await createQuizRepositoryFromDatabase(handle);
  const sessionRepository = createSessionRepository(handle);
  app = createApp(
    loadConfig({ NODE_ENV: 'test', ALLOWED_ORIGINS: 'http://localhost:4200' } as NodeJS.ProcessEnv),
    {
      quizRepository,
      sessionRepository,
      interviewSessionService: new InterviewSessionService({
        quizRepository, sessionRepository, now: () => clock, random: seededRandomSource(3)
      }),
      now: () => clock
    }
  );
});
afterEach(() => handle.close());

async function startAttempt(quizId = 'rxjs') {
  const res = await request(app).post(`/api/quizzes/${quizId}/attempts`).send({});
  expect(res.status).toBe(201);
  return res.body as { attemptReceipt: string };
}

function startQuestionRaw(quizId: string, questionText: unknown, attemptReceipt: unknown) {
  const req = request(app).post(`/api/quizzes/${quizId}/questions/start`);
  if (typeof attemptReceipt === 'string') req.set('X-Attempt-Receipt', attemptReceipt);
  return req.send({ questionText });
}

async function startQuestion(quizId: string, questionText: string, attemptReceipt: string) {
  const res = await startQuestionRaw(quizId, questionText, attemptReceipt);
  expect(res.status).toBe(201);
  return res.body as {
    questionReceipt: string; startedAt: number; expiresAt: number;
    durationSeconds: number; questionText: string; quizId: string;
  };
}

function check(quizId: string, questionReceipt: string, body: unknown) {
  return request(app)
    .post(`/api/quizzes/${quizId}/check`)
    .set('X-Question-Receipt', questionReceipt)
    .send(body as object);
}

describe('starting a question', () => {
  it('Q1 starts with a 30-second signed deadline', async () => {
    const { attemptReceipt } = await startAttempt();
    const started = await startQuestion('rxjs', Q1, attemptReceipt);

    expect(started.quizId).toBe('rxjs');
    expect(started.questionText).toBe(Q1);
    expect(started.durationSeconds).toBe(QUESTION_DURATION_SECONDS);
    expect(started.startedAt).toBe(START);
    expect(started.expiresAt).toBe(START + QUESTION_DURATION_SECONDS * 1000);
  });

  it('Q2 gets its OWN 30-second deadline when activated later', async () => {
    const { attemptReceipt } = await startAttempt();
    const first = await startQuestion('rxjs', Q1, attemptReceipt);

    // The user spends 20 seconds on Q1, then advances.
    clock = START + 20_000;
    const second = await startQuestion('rxjs', Q2, attemptReceipt);

    expect(second.startedAt).toBe(START + 20_000);
    expect(second.expiresAt).toBe(START + 20_000 + QUESTION_DURATION_SECONDS * 1000);

    // Q1's signed deadline is untouched — a receipt is immutable once issued.
    expect(first.expiresAt).toBe(START + QUESTION_DURATION_SECONDS * 1000);
    expect(second.expiresAt).not.toBe(first.expiresAt);
  });

  it('a receipt already issued for Q1 keeps its deadline after Q2 starts', async () => {
    const { attemptReceipt } = await startAttempt();
    const first = await startQuestion('rxjs', Q1, attemptReceipt);

    clock = START + 5_000;
    await startQuestion('rxjs', Q2, attemptReceipt);

    // Re-decoding the ORIGINAL receipt shows the original deadline: the server
    // holds no per-question state that starting Q2 could have mutated.
    const payload = decodeQuestionReceiptUnverified(first.questionReceipt) as Record<string, unknown>;
    expect(payload['expiresAt']).toBe(START + QUESTION_DURATION_SECONDS * 1000);
    expect(payload['questionText']).toBe(Q1);
  });

  it('requires a valid attempt receipt', async () => {
    expect((await startQuestionRaw('rxjs', Q1, undefined)).status).toBe(401);
    expect((await startQuestionRaw('rxjs', Q1, 'garbage')).status).toBe(401);
  });

  it('refuses an attempt receipt issued for ANOTHER quiz', async () => {
    const { attemptReceipt } = await startAttempt('signals');

    // The signals attempt must not start timers inside rxjs.
    expect((await startQuestionRaw('rxjs', Q1, attemptReceipt)).status).toBe(401);
  });

  it('refuses a question that belongs to another quiz', async () => {
    const { attemptReceipt } = await startAttempt('rxjs');
    expect((await startQuestionRaw('rxjs', SIGNALS_Q, attemptReceipt)).status).toBe(400);
  });
});

describe('the receipt payload', () => {
  it('is readable and carries NO correctness, explanation or identifiers', async () => {
    const { attemptReceipt } = await startAttempt();
    const started = await startQuestion('rxjs', Q1, attemptReceipt);

    const payload = decodeQuestionReceiptUnverified(started.questionReceipt) as Record<string, unknown>;

    // Exactly the timing metadata, and nothing else.
    expect(Object.keys(payload).sort())
      .toEqual(['expiresAt', 'questionText', 'quizId', 'startedAt', 'v']);

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('multicast');            // the answer text
    expect(serialized).not.toContain('Subject multicasts');   // the explanation
    for (const banned of [
      'correct', 'isCorrect', 'correctOptionTexts', 'explanation', 'options',
      'questionId', 'optionId', 'questionIndex', 'optionIndex', 'id'
    ]) {
      expect(payload).not.toHaveProperty(banned);
    }
  });

  it('does not leak the receipt or the answer key in the start response', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await startQuestionRaw('rxjs', Q1, attemptReceipt);

    expect(Object.keys(res.body).sort()).toEqual(
      ['durationSeconds', 'expiresAt', 'questionReceipt', 'questionText', 'quizId', 'startedAt']
    );
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('multicast');
    expect(serialized).not.toContain('Subject multicasts');
  });
});

describe('expiry is authorized per question', () => {
  const partial = { questionText: Q2, selectedOptionTexts: ['map'] };

  it('DENIES the reveal before this question\'s deadline', async () => {
    const { attemptReceipt } = await startAttempt();
    const started = await startQuestion('rxjs', Q2, attemptReceipt);

    clock = started.expiresAt - 1;

    const res = await check('rxjs', started.questionReceipt, partial);
    expect(res.body.status).toBe('incomplete');
    expect(res.body).not.toHaveProperty('explanation');
    expect(res.body).not.toHaveProperty('correctOptionTexts');
  });

  it('AUTHORIZES the reveal at the deadline', async () => {
    const { attemptReceipt } = await startAttempt();
    const started = await startQuestion('rxjs', Q2, attemptReceipt);

    clock = started.expiresAt;

    const res = await check('rxjs', started.questionReceipt, partial);
    expect(res.body).toEqual({
      status: 'expired',
      correctOptionTexts: ['map', 'filter'],
      explanation: 'map and filter are operators.'
    });
  });

  it('expiring Q1 does NOT authorize revealing Q2', async () => {
    const { attemptReceipt } = await startAttempt();
    const q1 = await startQuestion('rxjs', Q1, attemptReceipt);

    clock = q1.expiresAt + 1;

    // Q1's expired receipt is real, and Q1 itself now reveals…
    expect((await check('rxjs', q1.questionReceipt, { questionText: Q1, selectedOptionTexts: [] })).body.status)
      .toBe('expired');

    // …but it is bound to Q1, so it cannot drain the rest of the bank. Without
    // the binding, one 30-second wait would reveal every question.
    const res = await check('rxjs', q1.questionReceipt, { questionText: Q2, selectedOptionTexts: [] });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain('filter');
  });

  it('a question started LATER is not expired by an earlier question\'s deadline', async () => {
    const { attemptReceipt } = await startAttempt();
    const q1 = await startQuestion('rxjs', Q1, attemptReceipt);

    // Q1 has expired; the user is now on Q2, whose own 30s has just begun.
    clock = q1.expiresAt + 1;
    const q2 = await startQuestion('rxjs', Q2, attemptReceipt);

    const res = await check('rxjs', q2.questionReceipt, partial);
    expect(res.body.status).toBe('incomplete');
    expect(res.body).not.toHaveProperty('explanation');
  });
});

describe('receipt integrity', () => {
  it('rejects a TAMPERED expiresAt', async () => {
    const { attemptReceipt } = await startAttempt();
    const started = await startQuestion('rxjs', Q2, attemptReceipt);

    // Move the deadline into the past to claim expiry — the whole point of
    // signing. The signature no longer matches the payload.
    const payload = decodeQuestionReceiptUnverified(started.questionReceipt) as Record<string, unknown>;
    const forged = Buffer.from(JSON.stringify({ ...payload, expiresAt: START + 1 }), 'utf8')
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const signature = started.questionReceipt.split('.')[1];

    const res = await check('rxjs', `${forged}.${signature}`, { questionText: Q2, selectedOptionTexts: [] });
    expect(res.status).toBe(401);
  });

  it('rejects a receipt for ANOTHER question', async () => {
    const { attemptReceipt } = await startAttempt();
    const q1 = await startQuestion('rxjs', Q1, attemptReceipt);

    const res = await check('rxjs', q1.questionReceipt, { questionText: Q2, selectedOptionTexts: ['map'] });
    expect(res.status).toBe(401);
  });

  it('rejects a receipt for ANOTHER quiz', async () => {
    const { attemptReceipt } = await startAttempt('signals');
    const other = await startQuestion('signals', SIGNALS_Q, attemptReceipt);

    const res = await check('rxjs', other.questionReceipt, { questionText: Q1, selectedOptionTexts: [] });
    expect(res.status).toBe(401);
  });

  it('rejects a missing receipt', async () => {
    const res = await request(app)
      .post('/api/quizzes/rxjs/check')
      .send({ questionText: Q1, selectedOptionTexts: [] });
    expect(res.status).toBe(401);
  });

  it('accepts a question text that differs only by case and spacing', async () => {
    const { attemptReceipt } = await startAttempt();
    // Started with sloppy text; the receipt stores the bank's exact string.
    const started = await startQuestion('rxjs', '  which   ANSWER is CORRECT?  ', attemptReceipt);
    expect(started.questionText).toBe(Q1);

    // …and the check matches canonically, so the client is not locked out.
    const res = await check('rxjs', started.questionReceipt, {
      questionText: 'WHICH answer IS correct?',
      selectedOptionTexts: ['A multicast observable']
    });
    expect(res.body.status).toBe('resolved');
    expect(res.body.correct).toBe(true);
  });
});
