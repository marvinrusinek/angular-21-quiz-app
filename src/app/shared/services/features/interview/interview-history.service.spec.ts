import { TestBed } from '@angular/core/testing';

import { InterviewResult, InterviewTopicScore } from '../../../models/InterviewResult.model';
import {
  INTERVIEW_HISTORY_MAX,
  InterviewAttemptHistoryEntry
} from '../../../models/interview-history.model';
import { SK_INTERVIEW_HISTORY } from '../../../constants/session-keys';
import {
  buildReviewSnapshot,
  filterAttempts,
  InterviewHistoryService,
  summarizeTrends,
  validateAttemptEntry,
  validateHistoryStore,
  validateReviewSnapshots
} from './interview-history.service';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { QuestionType } from '../../../models/question-type.enum';

// ── factories ─────────────────────────────────────────────────────────
function topic(quizId: string, correct: number, total: number): InterviewTopicScore {
  return { quizId, title: quizId.toUpperCase(), correct, total, percentage: Math.round((correct / total) * 100) };
}

// A distinct InterviewResult with a given percentage/score (new object each call
// so the dedup-by-reference guard never collapses two genuine attempts).
function makeResult(pct: number, over: Partial<InterviewResult> = {}): InterviewResult {
  return {
    total: 100,
    answered: 100,
    unanswered: 0,
    correct: pct,
    incorrect: 100 - pct,
    percentage: pct,
    timeUsedSeconds: 120,
    timeRemainingSeconds: 0,
    difficulty: 'mixed',
    topicIds: ['a'],
    perTopic: [topic('a', pct, 100)],
    submittedByExpiry: false,
    focusChanges: 0,
    ...over
  };
}

function entry(pct: number, over: Partial<InterviewAttemptHistoryEntry> = {}): InterviewAttemptHistoryEntry {
  return {
    id: `id-${pct}-${Math.round(pct * 7)}`,
    completedAt: '2026-07-22T10:00:00.000Z',
    score: pct,
    totalQuestions: 100,
    percentage: pct,
    completionReason: 'submitted',
    durationSeconds: 120,
    configuredDifficulty: 'mixed',
    selectedTopicIds: ['a'],
    topicPerformance: [{ topicId: 'a', topicName: 'A', correct: pct, total: 100, percentage: pct }],
    ...over
  };
}

function seed(attempts: InterviewAttemptHistoryEntry[], version: unknown = 1): void {
  localStorage.setItem(SK_INTERVIEW_HISTORY, JSON.stringify({ version, attempts }));
}

function freshService(): InterviewHistoryService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({});
  return TestBed.inject(InterviewHistoryService);
}

describe('InterviewHistoryService — persistence', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('1. first completed interview creates the first history entry', () => {
    const svc = freshService();
    expect(svc.history()).toHaveLength(0);
    svc.record(makeResult(70));
    expect(svc.history()).toHaveLength(1);
    expect(svc.history()[0]).toMatchObject({ score: 70, percentage: 70, totalQuestions: 100 });
  });

  it('2. submitted interviews are saved as "submitted"', () => {
    const svc = freshService();
    svc.record(makeResult(80, { submittedByExpiry: false }));
    expect(svc.history()[0].completionReason).toBe('submitted');
  });

  it('3. timer-expired interviews are saved as "time-expired"', () => {
    const svc = freshService();
    svc.record(makeResult(50, { submittedByExpiry: true }));
    expect(svc.history()[0].completionReason).toBe('time-expired');
  });

  it('4. abandoned interviews (no finalized result) are not saved', () => {
    const svc = freshService();
    svc.record(null);
    svc.record(undefined);
    expect(svc.history()).toHaveLength(0);
    expect(localStorage.getItem(SK_INTERVIEW_HISTORY)).toBeNull();
  });

  it('5. re-recording the same result object does not duplicate (re-render safe)', () => {
    const svc = freshService();
    const r = makeResult(64);
    svc.record(r);
    svc.record(r);   // e.g. a stray Results re-render calling through again
    svc.record(r);
    expect(svc.history()).toHaveLength(1);
  });

  it('6. reloading an already-saved result does not duplicate (refresh safe)', () => {
    const svc = freshService();
    svc.record(makeResult(88));
    expect(svc.history()).toHaveLength(1);

    // Simulate a refresh: a brand-new service instance loads from storage.
    const reloaded = freshService();
    expect(reloaded.history()).toHaveLength(1);
    expect(reloaded.history()[0].percentage).toBe(88);
  });

  it('7. the oldest entry is removed once 20 attempts are exceeded', () => {
    const svc = freshService();
    for (let i = 1; i <= INTERVIEW_HISTORY_MAX + 1; i++) svc.record(makeResult(i));
    const hist = svc.history();
    expect(hist).toHaveLength(INTERVIEW_HISTORY_MAX);
    // 21 recorded (scores 1..21); oldest (1) dropped → window is 2..21.
    expect(hist[0].score).toBe(2);
    expect(hist[hist.length - 1].score).toBe(21);
  });

  it('8. attempts remain in chronological (insertion) order', () => {
    const svc = freshService();
    [30, 55, 42, 91].forEach((p) => svc.record(makeResult(p)));
    expect(svc.history().map((e) => e.score)).toEqual([30, 55, 42, 91]);
  });

  it('clear() empties history and removes the store', () => {
    const svc = freshService();
    svc.record(makeResult(70));
    svc.clear();
    expect(svc.history()).toHaveLength(0);
    expect(localStorage.getItem(SK_INTERVIEW_HISTORY)).toBeNull();
  });

  it('assigns increasing lifetime attempt numbers', () => {
    const svc = freshService();
    svc.record(makeResult(70));
    svc.record(makeResult(80));
    svc.record(makeResult(90));
    expect(svc.history().map((e) => e.attemptNumber)).toEqual([1, 2, 3]);
  });

  it('keeps attempt numbers monotonic as older entries age out', () => {
    const svc = freshService();
    for (let i = 1; i <= INTERVIEW_HISTORY_MAX + 2; i++) svc.record(makeResult(i));
    const nums = svc.history().map((e) => e.attemptNumber);
    // 22 recorded; retained window is numbers 3..22 (not renumbered to 1..20).
    expect(nums[0]).toBe(3);
    expect(nums[nums.length - 1]).toBe(INTERVIEW_HISTORY_MAX + 2);
  });

  it('durably skips an attempt already persisted (same id, new result object)', () => {
    const svc = freshService();
    svc.record(makeResult(70), 'att-X');
    svc.record(makeResult(70), 'att-X');   // distinct object, same attempt id
    expect(svc.history()).toHaveLength(1);
    expect(svc.history()[0].id).toBe('att-X');
  });

  it('records distinct attempt ids separately', () => {
    const svc = freshService();
    svc.record(makeResult(70), 'att-a');
    svc.record(makeResult(70), 'att-b');
    expect(svc.history().map((e) => e.id)).toEqual(['att-a', 'att-b']);
  });

  it('durable dedup survives service recreation (reload)', () => {
    const s1 = freshService();
    s1.record(makeResult(70), 'att-keep');
    const s2 = freshService();               // reloads persisted history
    s2.record(makeResult(70), 'att-keep');   // same attempt id, fresh object
    expect(s2.history()).toHaveLength(1);
  });

  it('clamps a stored score that would exceed the question count', () => {
    const svc = freshService();
    svc.record(makeResult(80, { correct: 999, total: 10, percentage: 100, perTopic: [topic('a', 10, 10)] }));
    const e = svc.history()[0];
    expect(e.score).toBeLessThanOrEqual(e.totalQuestions);
  });

  it('reuses Topic Performance analytics for topicPerformance', () => {
    const svc = freshService();
    svc.record(makeResult(75, { perTopic: [topic('forms', 4, 5), topic('http', 1, 2)], correct: 5, total: 7, percentage: 71 }));
    const tp = svc.history()[0].topicPerformance;
    expect(tp.map((t) => t.topicId).sort()).toEqual(['forms', 'http']);
    expect(tp.find((t) => t.topicId === 'forms')).toMatchObject({ correct: 4, total: 5, percentage: 80 });
  });
});

describe('per-question review snapshot', () => {
  // Q1 single (A correct), Q2 multi (C+E correct) with a topic + type.
  const questions: QuizQuestion[] = [
    {
      questionText: 'Q1', explanation: 'E1', type: QuestionType.SingleAnswer, sourceQuizId: 'topicA',
      options: [{ text: 'A', correct: true, optionId: 1 }, { text: 'B', optionId: 2 }]
    },
    {
      questionText: 'Q2', explanation: 'E2', type: QuestionType.MultipleAnswer, sourceQuizId: 'topicB',
      options: [{ text: 'C', correct: true, optionId: 3 }, { text: 'D', optionId: 4 }, { text: 'E', correct: true, optionId: 5 }]
    }
  ];

  it('buildReviewSnapshot captures options, correctness, topic/type and the selection', () => {
    const snap = buildReviewSnapshot(questions, { 0: [1], 1: [3] });
    expect(snap).toHaveLength(2);
    expect(snap[0]).toMatchObject({
      questionText: 'Q1', explanation: 'E1', type: QuestionType.SingleAnswer, sourceQuizId: 'topicA',
      selectedOptionIds: [1]
    });
    expect(snap[0].options).toEqual([
      { optionId: 1, text: 'A', correct: true },
      { optionId: 2, text: 'B', correct: false }
    ]);
    // Unanswered → empty selection; options with no id are dropped.
    expect(buildReviewSnapshot(questions, {})[1].selectedOptionIds).toEqual([]);
  });

  it('record(...) persists the snapshot when the live source is supplied', () => {
    localStorage.clear();
    const svc = freshService();
    svc.record(makeResult(50), 'att-r', { questions, answersByIndex: { 0: [1], 1: [3, 5] } });
    const saved = svc.history()[0];
    expect(saved.review).toBeDefined();
    expect(saved.review).toHaveLength(2);
    expect(saved.review![1].selectedOptionIds).toEqual([3, 5]);
  });

  it('record(...) without a source leaves review undefined (compact, back-compat)', () => {
    localStorage.clear();
    const svc = freshService();
    svc.record(makeResult(50), 'att-n');
    expect(svc.history()[0].review).toBeUndefined();
  });

  it('validateReviewSnapshots round-trips a persisted snapshot and drops junk', () => {
    const snap = buildReviewSnapshot(questions, { 0: [1], 1: [3, 5] });
    const roundTripped = validateReviewSnapshots(JSON.parse(JSON.stringify(snap)));
    expect(roundTripped).toEqual(snap);
    // Non-array / empty → undefined (falls back to the "not retained" note).
    expect(validateReviewSnapshots(undefined)).toBeUndefined();
    expect(validateReviewSnapshots('nope')).toBeUndefined();
    expect(validateReviewSnapshots([])).toBeUndefined();
    // A selection referencing an unknown option id is dropped.
    const tampered = [{ questionText: 'Q', explanation: '', options: [{ optionId: 1, text: 'A', correct: true }], selectedOptionIds: [1, 99] }];
    expect(validateReviewSnapshots(tampered)![0].selectedOptionIds).toEqual([1]);
    // A question with no valid options is unusable → dropped.
    expect(validateReviewSnapshots([{ questionText: 'Q', options: [] }])).toBeUndefined();
  });

  it('validateAttemptEntry keeps a valid review and legacy entries stay review-free', () => {
    const snap = buildReviewSnapshot(questions, { 0: [1], 1: [3, 5] });
    const withReview = validateAttemptEntry({ ...entry(50), review: JSON.parse(JSON.stringify(snap)) });
    expect(withReview?.review).toEqual(snap);
    // Legacy entry (no review key) validates fine with review undefined.
    expect(validateAttemptEntry(entry(50))?.review).toBeUndefined();
  });
});

describe('validateHistoryStore / validateAttemptEntry', () => {
  it('9. invalid JSON fails safely (returns [])', () => {
    localStorage.clear();
    localStorage.setItem(SK_INTERVIEW_HISTORY, '{ not valid json');
    const svc = freshService();   // load() → readLocalJson swallows → validate(null) → []
    expect(svc.history()).toEqual([]);
    localStorage.clear();
  });

  it('10. unsupported storage version fails safely', () => {
    expect(validateHistoryStore({ version: 2, attempts: [entry(70)] })).toEqual([]);
    expect(validateHistoryStore({ version: 'x', attempts: [entry(70)] })).toEqual([]);
  });

  it('11. malformed entries are ignored, valid ones kept, without crashing', () => {
    const out = validateHistoryStore({
      version: 1,
      attempts: [entry(70), null, 42, { id: '', completedAt: 'x', score: 1, totalQuestions: 1, percentage: 1 }, entry(90)]
    });
    expect(out.map((e) => e.percentage)).toEqual([70, 90]);
  });

  it('11b. a non-array attempts field fails safely', () => {
    expect(validateHistoryStore({ version: 1, attempts: 'nope' })).toEqual([]);
    expect(validateHistoryStore(null)).toEqual([]);
    expect(validateHistoryStore('str')).toEqual([]);
  });

  it('12. numeric fields are validated and impossible percentages clamped', () => {
    expect(validateAttemptEntry(entry(70, { percentage: 175 }))?.percentage).toBe(100);
    expect(validateAttemptEntry(entry(70, { percentage: -20 }))?.percentage).toBe(0);
    expect(validateAttemptEntry(entry(70, { score: Number.NaN as unknown as number }))).toBeNull();
    expect(validateAttemptEntry(entry(70, { totalQuestions: 0 }))).toBeNull();
    expect(validateAttemptEntry(entry(70, { percentage: 'nope' as unknown as number }))).toBeNull();
  });

  it('honours the retention window when loading an over-long store', () => {
    const many = Array.from({ length: 30 }, (_, i) => entry(i + 1, { id: `e${i}` }));
    expect(validateHistoryStore({ version: 1, attempts: many })).toHaveLength(INTERVIEW_HISTORY_MAX);
  });

  it('rejects internally-inconsistent records (score > totalQuestions)', () => {
    expect(validateAttemptEntry(entry(70, { score: 150, totalQuestions: 100 }))).toBeNull();
  });

  it('rejects an unparseable completedAt', () => {
    expect(validateAttemptEntry(entry(70, { completedAt: 'not a date' }))).toBeNull();
    expect(validateAttemptEntry(entry(70, { completedAt: '' }))).toBeNull();
  });

  it('treats a negative duration as not recorded (undefined)', () => {
    expect(validateAttemptEntry(entry(70, { durationSeconds: -5 }))?.durationSeconds).toBeUndefined();
    expect(validateAttemptEntry(entry(70, { durationSeconds: 120 }))?.durationSeconds).toBe(120);
  });

  it('drops topics with non-positive total or out-of-range correct', () => {
    const out = validateAttemptEntry(entry(70, {
      topicPerformance: [
        { topicId: 'ok', topicName: 'OK', correct: 2, total: 4, percentage: 50 },
        { topicId: 'zero', topicName: 'Z', correct: 0, total: 0, percentage: 0 },
        { topicId: 'over', topicName: 'O', correct: 5, total: 3, percentage: 100 }
      ]
    }));
    expect(out?.topicPerformance.map((t) => t.topicId)).toEqual(['ok']);
  });

  it('defensively orders entries chronologically by completedAt', () => {
    const out = validateHistoryStore({
      version: 1,
      attempts: [
        entry(70, { id: 'late', completedAt: '2026-07-20T10:00:00.000Z' }),
        entry(80, { id: 'early', completedAt: '2026-07-10T10:00:00.000Z' })
      ]
    });
    expect(out.map((e) => e.id)).toEqual(['early', 'late']);
  });

  it('de-duplicates entries by id on load (keeps the first)', () => {
    const out = validateHistoryStore({
      version: 1,
      attempts: [entry(70, { id: 'same' }), entry(90, { id: 'same' }), entry(60, { id: 'other' })]
    });
    expect(out.map((e) => e.id)).toEqual(['same', 'other']);
    expect(out[0].percentage).toBe(70);
  });

  it('preserves a valid persisted attemptNumber', () => {
    expect(validateAttemptEntry(entry(70, { attemptNumber: 7 }))?.attemptNumber).toBe(7);
    expect(validateAttemptEntry(entry(70, { attemptNumber: -1 }))?.attemptNumber).toBeUndefined();
  });
});

describe('InterviewHistoryService — attemptNumber migration', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('migrates legacy records (no attemptNumber) by chronological position and persists', () => {
    // Seed legacy entries WITHOUT attemptNumber.
    seed([entry(70, { id: 'a' }), entry(80, { id: 'b' }), entry(90, { id: 'c' })]);
    const svc = freshService();
    expect(svc.history().map((e) => e.attemptNumber)).toEqual([1, 2, 3]);
    // Persisted back so numbering is stable on the next load.
    const stored = JSON.parse(localStorage.getItem(SK_INTERVIEW_HISTORY)!);
    expect(stored.attempts.every((a: { attemptNumber?: number }) => typeof a.attemptNumber === 'number')).toBe(true);
  });

  it('continues numbering from the migrated max', () => {
    seed([entry(70, { id: 'a' }), entry(80, { id: 'b' })]);   // → 1, 2
    const svc = freshService();
    svc.record(makeResult(95));
    expect(svc.history().map((e) => e.attemptNumber)).toEqual([1, 2, 3]);
  });
});

describe('filterAttempts (client-side)', () => {
  const submitted1 = entry(70, { id: 's1', completionReason: 'submitted' });
  const expired = entry(50, { id: 'e1', completionReason: 'time-expired' });
  const submitted2 = entry(90, { id: 's2', completionReason: 'submitted' });
  const list = [submitted1, expired, submitted2];

  it('6. submitted only', () => {
    expect(filterAttempts(list, 'submitted').map((a) => a.id)).toEqual(['s1', 's2']);
  });

  it('7. time expired only', () => {
    expect(filterAttempts(list, 'time-expired').map((a) => a.id)).toEqual(['e1']);
  });

  it('8. all interviews (order preserved)', () => {
    expect(filterAttempts(list, 'all').map((a) => a.id)).toEqual(['s1', 'e1', 's2']);
  });

  it('returns a copy (does not mutate input)', () => {
    const out = filterAttempts(list, 'all');
    expect(out).not.toBe(list);
    expect(out).toEqual(list);
  });
});

describe('summarizeTrends — calculations', () => {
  it('13/14/15/16. latest, best, average and change are correct', () => {
    const t = summarizeTrends([entry(70), entry(90), entry(84)]);
    expect(t.latest).toBe(84);
    expect(t.best).toBe(90);
    expect(t.average).toBe(Math.round((70 + 90 + 84) / 3));  // 81
    expect(t.change).toBe(84 - 90);                           // -6 percentage points
  });

  it('17. different question counts compare correctly via percentages', () => {
    // 7/10 (70%) then 17/20 (85%) → +15 pts despite different counts.
    const t = summarizeTrends([
      entry(70, { score: 7, totalQuestions: 10 }),
      entry(85, { score: 17, totalQuestions: 20 })
    ]);
    expect(t.change).toBe(15);
    expect(t.direction).toBe('improving');
  });

  it('18. a first attempt makes no trend claim', () => {
    const t = summarizeTrends([entry(80)]);
    expect(t.count).toBe(1);
    expect(t.change).toBeNull();
    expect(t.direction).toBe('none');
    expect(t.interpretation).toBe('');
  });

  it('empty history summarizes to nulls', () => {
    const t = summarizeTrends([]);
    expect(t).toMatchObject({ count: 0, latest: null, best: null, average: null, change: null, direction: 'none' });
  });

  it('interpretation follows the ±5 point thresholds', () => {
    expect(summarizeTrends([entry(70), entry(76)]).direction).toBe('improving');   // +6
    expect(summarizeTrends([entry(70), entry(72)]).direction).toBe('steady');      // +2
    expect(summarizeTrends([entry(80), entry(72)]).direction).toBe('declining');   // -8
    expect(summarizeTrends([entry(70), entry(74)]).direction).toBe('steady');      // +4 (dead band)
    expect(summarizeTrends([entry(70), entry(75)]).direction).toBe('improving');   // +5 (threshold)
  });

  describe('isPersonalBest', () => {
    it('is true when the latest strictly beats every previous attempt', () => {
      expect(summarizeTrends([entry(70), entry(80), entry(92)]).isPersonalBest).toBe(true);
    });

    it('is false when the latest merely ties the previous best', () => {
      expect(summarizeTrends([entry(90), entry(70), entry(90)]).isPersonalBest).toBe(false);
    });

    it('is false when the latest is not the highest', () => {
      expect(summarizeTrends([entry(95), entry(80)]).isPersonalBest).toBe(false);
    });

    it('is false for a first attempt (nothing to beat)', () => {
      expect(summarizeTrends([entry(100)]).isPersonalBest).toBe(false);
    });

    it('is false for empty history', () => {
      expect(summarizeTrends([]).isPersonalBest).toBe(false);
    });
  });

  it('marks only the last point as latest and numbers points 1-based', () => {
    const t = summarizeTrends([entry(70), entry(80), entry(90)]);
    expect(t.points.map((p) => p.index)).toEqual([1, 2, 3]);
    expect(t.points.map((p) => p.isLatest)).toEqual([false, false, true]);
  });
});
