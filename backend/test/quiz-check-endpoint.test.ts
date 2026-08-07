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
import { decodeAttemptReceiptUnverified } from '../src/quiz/attempt-receipt';
import { createTestPool } from './helpers/pg-mem-pool';

/**
 * POST /api/quizzes/:quizId/attempts and /check.
 *
 * The check endpoint is the ONLY place correctness leaves the server, and it
 * leaves one question at a time in response to an answer actually given.
 *
 * MULTI-ANSWER RULE UNDER TEST: a question resolves when
 * `correctSet ⊆ selectedSet` — NOT exact equality. Extra incorrect selections
 * do not prevent resolution and do not make it incorrect. This mirrors the
 * shipped Angular behaviour, audited before implementation.
 */

const START = 1_700_000_000_000;
let clock = START;

const BANK = {
  quizzes: [
    {
      quizId: 'rxjs',
      milestone: 'RxJS', summary: 's', image: 'i', difficulty: 'beginner', facts: [],
      questions: [
        {
          questionText: 'Which answer is correct?',
          explanation: 'Because a Subject multicasts.',
          options: [
            { text: 'A multicast observable', correct: true },
            { text: 'A pipe' },
            { text: 'A directive' }
          ]
        },
        {
          questionText: 'Select every operator',
          explanation: 'map and filter are operators.',
          options: [
            { text: 'map', correct: true },
            { text: 'filter', correct: true },
            { text: 'Observable' },
            { text: 'Subject' }
          ]
        },
        {
          questionText: 'Is a Subject also an Observable?',
          explanation: 'Yes — Subject extends Observable.',
          options: [{ text: 'True', correct: true }, { text: 'False' }]
        },
        {
          questionText: 'Which selector is used for routing?',
          explanation: 'The router outlet.',
          options: [
            { text: '<router-outlet>', correct: true },
            { text: "this.http.get<User>('/api/users/1')" }
          ]
        }
      ]
    },
    {
      quizId: 'signals',
      milestone: 'Signals', summary: 's', image: 'i', difficulty: 'advanced', facts: [],
      questions: [
        {
          questionText: 'What does computed() return?',
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
      const correctCount = question.options.filter((o) => 'correct' in o).length;
      const texts = question.options.map((o) => o.text.trim().toLowerCase()).sort();
      const type = correctCount > 1 ? 'multiple'
        : (question.options.length === 2 && texts[0] === 'false' && texts[1] === 'true')
          ? 'trueFalse' : 'single';

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
  return res.body as { attemptReceipt: string; expiresAt: number; durationSeconds: number };
}

function check(quizId: string, receipt: string, body: unknown) {
  return request(app)
    .post(`/api/quizzes/${quizId}/check`)
    .set('X-Attempt-Receipt', receipt)
    .send(body as object);
}

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const i of value) keysDeep(i, out); return out; }
  for (const [k, n] of Object.entries(value)) { out.push(k); keysDeep(n, out); }
  return out;
}

// ── attempts ────────────────────────────────────────────────────────

describe('POST /attempts', () => {
  it('issues a receipt with server-derived timing', async () => {
    const res = await request(app).post('/api/quizzes/rxjs/attempts').send({});

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort())
      .toEqual(['attemptReceipt', 'durationSeconds', 'expiresAt', 'quizId', 'startedAt']);
    expect(res.body.quizId).toBe('rxjs');
    expect(res.body.startedAt).toBe(START);
    expect(res.body.durationSeconds).toBe(4 * 30);          // 4 questions × 30s
    expect(res.body.expiresAt).toBe(START + 4 * 30 * 1000);
  });

  it('the receipt payload is readable and carries only timing metadata', async () => {
    const { attemptReceipt } = await startAttempt();
    const payload = decodeAttemptReceiptUnverified(attemptReceipt) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['expiresAt', 'quizId', 'startedAt', 'v']);
  });

  it('404s for an unknown quiz', async () => {
    expect((await request(app).post('/api/quizzes/nope/attempts').send({})).status).toBe(404);
  });

  it('leaks nothing through the attempt response', async () => {
    const keys = new Set(keysDeep((await request(app).post('/api/quizzes/rxjs/attempts').send({})).body));
    for (const banned of ['questionId', 'optionId', 'id', 'correct', 'isCorrect',
                          'explanation', 'questions', 'options', 'secret', 'signature']) {
      expect(keys.has(banned)).toBe(false);
    }
  });
});

// ── single / trueFalse ──────────────────────────────────────────────

describe('single and trueFalse resolve on any answer', () => {
  it('CORRECT single resolves with correct: true', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Which answer is correct?',
      selectedOptionTexts: ['A multicast observable']
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'resolved',
      correct: true,
      correctOptionTexts: ['A multicast observable'],
      explanation: 'Because a Subject multicasts.'
    });
  });

  it('INCORRECT single still resolves, with correct: false', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Which answer is correct?',
      selectedOptionTexts: ['A pipe']
    });

    // Shipped behaviour: a wrong single answer reveals the answer immediately.
    expect(res.body.status).toBe('resolved');
    expect(res.body.correct).toBe(false);
    expect(res.body.correctOptionTexts).toEqual(['A multicast observable']);
  });

  it('CORRECT trueFalse resolves', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Is a Subject also an Observable?',
      selectedOptionTexts: ['True']
    });
    expect(res.body.status).toBe('resolved');
    expect(res.body.correct).toBe(true);
  });

  it('INCORRECT trueFalse resolves with correct: false', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Is a Subject also an Observable?',
      selectedOptionTexts: ['False']
    });
    expect(res.body.status).toBe('resolved');
    expect(res.body.correct).toBe(false);
  });

  it('rejects TWO selections on a single-answer question', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Which answer is correct?',
      selectedOptionTexts: ['A multicast observable', 'A pipe']
    });
    expect(res.status).toBe(400);
  });

  it('an empty selection is incomplete, not an error', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Which answer is correct?',
      selectedOptionTexts: []
    });
    expect(res.body.status).toBe('incomplete');
    expect(res.body.selectedVerdicts).toEqual([]);
    expect(res.body).not.toHaveProperty('explanation');
    expect(res.body).not.toHaveProperty('correctOptionTexts');
  });
});

// ── multiple: the audited superset rule ─────────────────────────────

describe('multiple-answer uses the SUPERSET rule (correctSet ⊆ selectedSet)', () => {
  const MULTI = 'Select every operator';   // correct: map, filter

  it('ALL CORRECT ONLY → resolved', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: MULTI, selectedOptionTexts: ['map', 'filter']
    });

    expect(res.body).toEqual({
      status: 'resolved',
      correct: true,
      correctOptionTexts: ['map', 'filter'],
      explanation: 'map and filter are operators.'
    });
  });

  it('ALL CORRECT PLUS ONE INCORRECT → resolved AND correct', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: MULTI, selectedOptionTexts: ['map', 'filter', 'Observable']
    });

    // The audited shipped behaviour: the stray wrong pick does not block
    // completion and does not cost the point. The UI then force-deselects it.
    expect(res.body.status).toBe('resolved');
    expect(res.body.correct).toBe(true);
    expect(res.body.correctOptionTexts).toEqual(['map', 'filter']);
  });

  it('ONE CORRECT ONLY → incomplete, with one remaining', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: MULTI, selectedOptionTexts: ['map']
    });

    expect(res.body).toEqual({
      status: 'incomplete',
      selectedVerdicts: [{ text: 'map', correct: true }],
      remainingCorrectCount: 1
    });
  });

  it('INCORRECT ONLY → incomplete, and that pick is marked incorrect', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: MULTI, selectedOptionTexts: ['Observable']
    });

    expect(res.body.status).toBe('incomplete');
    expect(res.body.selectedVerdicts).toEqual([{ text: 'Observable', correct: false }]);
    expect(res.body.remainingCorrectCount).toBe(2);
  });

  it('MISSING ONE CORRECT PLUS ONE INCORRECT → incomplete', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: MULTI, selectedOptionTexts: ['map', 'Observable']
    });

    expect(res.body.status).toBe('incomplete');
    expect(res.body.selectedVerdicts).toEqual([
      { text: 'map', correct: true },
      { text: 'Observable', correct: false }
    ]);
    expect(res.body.remainingCorrectCount).toBe(1);
  });

  it('remainingCorrectCount counts ONLY missing correct options', async () => {
    const { attemptReceipt } = await startAttempt();

    // Three incorrect-ish selections do not reduce the remaining count.
    const res = await check('rxjs', attemptReceipt, {
      questionText: MULTI, selectedOptionTexts: ['Observable', 'Subject']
    });
    expect(res.body.remainingCorrectCount).toBe(2);
  });

  it('NEVER reveals correctness for UNSELECTED options while incomplete', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: MULTI, selectedOptionTexts: ['map']
    });

    // Only the user's own pick appears. 'filter' is correct but must not be
    // named, or partial play becomes an enumeration oracle.
    expect(res.body.selectedVerdicts).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('filter');
    expect(res.body).not.toHaveProperty('correctOptionTexts');
    expect(res.body).not.toHaveProperty('explanation');
  });
});

// ── validation and scoping ──────────────────────────────────────────

describe('validation rejects safely', () => {
  it('rejects a DUPLICATE selected text', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Select every operator', selectedOptionTexts: ['map', 'map']
    });
    expect(res.status).toBe(400);
  });

  it('rejects an option belonging to ANOTHER question', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Which answer is correct?', selectedOptionTexts: ['map']
    });
    expect(res.status).toBe(400);
  });

  it('rejects a question from ANOTHER quiz', async () => {
    const { attemptReceipt } = await startAttempt('rxjs');
    const res = await check('rxjs', attemptReceipt, {
      questionText: 'What does computed() return?',   // belongs to `signals`
      selectedOptionTexts: ['A read-only signal']
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown question and unknown option text', async () => {
    const { attemptReceipt } = await startAttempt();
    expect((await check('rxjs', attemptReceipt, {
      questionText: 'No such question', selectedOptionTexts: ['map']
    })).status).toBe(400);
    expect((await check('rxjs', attemptReceipt, {
      questionText: 'Select every operator', selectedOptionTexts: ['no such option']
    })).status).toBe(400);
  });

  it('rejects more selections than the question has options', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Is a Subject also an Observable?',
      selectedOptionTexts: ['True', 'False', 'Maybe']
    });
    expect(res.status).toBe(400);
  });

  it('gives an IDENTICAL body for every rejection — no oracle', async () => {
    const { attemptReceipt } = await startAttempt();
    const bodies = new Set<string>();
    for (const body of [
      { questionText: 'No such question', selectedOptionTexts: ['map'] },
      { questionText: 'Select every operator', selectedOptionTexts: ['no such option'] },
      { questionText: 'Select every operator', selectedOptionTexts: ['map', 'map'] },
      { questionText: 'What does computed() return?', selectedOptionTexts: ['A promise'] }
    ]) {
      bodies.add(JSON.stringify((await check('rxjs', attemptReceipt, body)).body));
    }
    expect(bodies.size).toBe(1);
  });

  it('matches text case-insensitively and whitespace-insensitively', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: '  which   ANSWER is CORRECT?  ',
      selectedOptionTexts: ['  A MULTICAST   observable ']
    });
    expect(res.body.status).toBe('resolved');
    // The reveal returns the EXACT stored strings, not the client's casing.
    expect(res.body.correctOptionTexts).toEqual(['A multicast observable']);
  });

  it('handles HTML-like option text exactly', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Which selector is used for routing?',
      selectedOptionTexts: ['<router-outlet>']
    });
    expect(res.body.status).toBe('resolved');
    expect(res.body.correct).toBe(true);
    expect(res.body.correctOptionTexts).toEqual(['<router-outlet>']);
  });
});

// ── receipt enforcement ─────────────────────────────────────────────

describe('the receipt is the authorization', () => {
  const BODY = { questionText: 'Which answer is correct?', selectedOptionTexts: ['A pipe'] };

  it('401s with no receipt', async () => {
    expect((await request(app).post('/api/quizzes/rxjs/check').send(BODY)).status).toBe(401);
  });

  it('401s with a malformed or tampered receipt', async () => {
    const { attemptReceipt } = await startAttempt();
    const [encoded, signature] = attemptReceipt.split('.') as [string, string];

    expect((await check('rxjs', 'garbage', BODY)).status).toBe(401);
    expect((await check('rxjs', `${encoded}.${'A' + signature.slice(1)}`, BODY)).status).toBe(401);

    // Forged deadline — the attack the signature exists to stop.
    const forged = Buffer.from(JSON.stringify({
      v: 1, quizId: 'rxjs', startedAt: START, expiresAt: START + 999_999_999
    }), 'utf8').toString('base64url');
    expect((await check('rxjs', `${forged}.${signature}`, BODY)).status).toBe(401);
  });

  it('401s when the receipt is for a DIFFERENT quiz', async () => {
    const { attemptReceipt } = await startAttempt('signals');
    expect((await check('rxjs', attemptReceipt, BODY)).status).toBe(401);
  });

  it('a rejected check reveals nothing', async () => {
    const res = await request(app).post('/api/quizzes/rxjs/check').send(BODY);
    const keys = new Set(keysDeep(res.body));
    expect(keys.has('correctOptionTexts')).toBe(false);
    expect(keys.has('explanation')).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('multicast');
  });
});

// ── expiry ──────────────────────────────────────────────────────────

describe('expiry is server-authoritative', () => {
  it('reveals after the signed deadline, even with a PARTIAL selection', async () => {
    const { attemptReceipt, expiresAt } = await startAttempt();

    clock = expiresAt + 1;   // server clock crosses the deadline

    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Select every operator', selectedOptionTexts: ['map']
    });

    expect(res.body).toEqual({
      status: 'expired',
      correctOptionTexts: ['map', 'filter'],
      explanation: 'map and filter are operators.'
    });
  });

  it('reveals after expiry with NO selection at all', async () => {
    const { attemptReceipt, expiresAt } = await startAttempt();
    clock = expiresAt + 1;

    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Select every operator', selectedOptionTexts: []
    });
    expect(res.body.status).toBe('expired');
  });

  it('IGNORES a client claim of expiry', async () => {
    const { attemptReceipt } = await startAttempt();

    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Select every operator',
      selectedOptionTexts: ['map'],
      // None of these may influence anything.
      expired: true,
      submittedByExpiry: true,
      timeRemainingSeconds: 0,
      expiresAt: 1
    });

    expect(res.body.status).toBe('incomplete');
    expect(res.body).not.toHaveProperty('explanation');
  });

  it('reveals ONE question only — never the whole bank', async () => {
    const { attemptReceipt, expiresAt } = await startAttempt();
    clock = expiresAt + 1;

    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Which answer is correct?', selectedOptionTexts: []
    });

    expect(res.body.correctOptionTexts).toEqual(['A multicast observable']);
    // No other question's data appears.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('map');
    expect(serialized).not.toContain('router-outlet');
    expect(serialized).not.toContain('operators');
  });
});

// ── response shape security ─────────────────────────────────────────

describe('the check route is rate limited, question delivery is not', () => {
  const BODY = { questionText: 'Which answer is correct?', selectedOptionTexts: ['A pipe'] };

  it('engages after sustained checking, and /questions stays open', async () => {
    const { attemptReceipt } = await startAttempt();

    // Capacity is 40 with 1 token/sec refill. The clock is frozen for this
    // test, so nothing refills and the bucket drains deterministically.
    let limited = false;
    for (let i = 0; i < 60 && !limited; i++) {
      const res = await check('rxjs', attemptReceipt, BODY);
      if (res.status === 429) {
        limited = true;
        expect(res.body).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
        expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      }
    }
    expect(limited).toBe(true);

    // Question delivery must be unaffected — it exposes only authorized text.
    expect((await request(app).get('/api/quizzes/rxjs/questions')).status).toBe(200);
    expect((await request(app).get('/api/quizzes')).status).toBe(200);
  });

  it('refills as the injected clock advances', async () => {
    const { attemptReceipt } = await startAttempt();

    let blocked = false;
    for (let i = 0; i < 60 && !blocked; i++) {
      blocked = (await check('rxjs', attemptReceipt, BODY)).status === 429;
    }
    expect(blocked).toBe(true);

    clock += 5_000;   // five tokens back
    expect((await check('rxjs', attemptReceipt, BODY)).status).toBe(200);
  });
});

describe('reveal responses carry no identifiers or bulk data', () => {
  it('resolved response has EXACTLY the approved keys', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Which answer is correct?', selectedOptionTexts: ['A pipe']
    });
    expect(Object.keys(res.body).sort())
      .toEqual(['correct', 'correctOptionTexts', 'explanation', 'status']);
  });

  it('incomplete response has EXACTLY the approved keys', async () => {
    const { attemptReceipt } = await startAttempt();
    const res = await check('rxjs', attemptReceipt, {
      questionText: 'Select every operator', selectedOptionTexts: ['map']
    });
    expect(Object.keys(res.body).sort())
      .toEqual(['remainingCorrectCount', 'selectedVerdicts', 'status']);
    expect(Object.keys(res.body.selectedVerdicts[0]).sort()).toEqual(['correct', 'text']);
  });

  it('no identifiers appear in any reveal', async () => {
    const { attemptReceipt } = await startAttempt();
    for (const body of [
      { questionText: 'Which answer is correct?', selectedOptionTexts: ['A pipe'] },
      { questionText: 'Select every operator', selectedOptionTexts: ['map'] }
    ]) {
      const keys = new Set(keysDeep((await check('rxjs', attemptReceipt, body)).body));
      for (const banned of ['questionId', 'optionId', 'id', 'displayOrder',
                            'isCorrect', 'correctOptionIds', 'questions', 'options']) {
        expect(keys.has(banned)).toBe(false);
      }
    }
  });
});
