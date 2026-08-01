import { TestBed } from '@angular/core/testing';

import { TopicPerformanceHistoryService } from './topic-performance-history.service';
import { SK_TOPIC_PERFORMANCE_HISTORY } from '../../constants/session-keys';
import { calculateWeakTopics, TopicAttemptLike } from '../../utils/weak-areas';

function service(): TopicPerformanceHistoryService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [TopicPerformanceHistoryService] });
  return TestBed.inject(TopicPerformanceHistoryService);
}

const stored = (): unknown =>
  JSON.parse(localStorage.getItem(SK_TOPIC_PERFORMANCE_HISTORY) ?? 'null');

describe('TopicPerformanceHistoryService — recording', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('records an attempt once and exposes it for aggregation', () => {
    const svc = service();
    svc.record('att-1', 'topic-quiz', [{ topicId: 'rxjs', topicName: 'RxJS', correct: 2, total: 10 }]);

    expect(svc.records()).toHaveLength(1);
    expect(svc.records()[0]).toMatchObject({
      attemptId: 'att-1', source: 'topic-quiz', topicId: 'rxjs', correct: 2, total: 10
    });
    expect(svc.asAttempts()[0].topicPerformance[0]).toMatchObject({ correct: 2, total: 10 });
  });

  it('DEDUPES by attemptId — remount, refresh and revisit record nothing new', () => {
    const svc = service();
    const topics = [{ topicId: 'rxjs', correct: 2, total: 10 }];

    svc.record('att-1', 'topic-quiz', topics);
    svc.record('att-1', 'topic-quiz', topics);   // Results remount
    svc.record('att-1', 'topic-quiz', topics);   // revisit
    expect(svc.records()).toHaveLength(1);
    expect(svc.hasRecorded('att-1')).toBe(true);

    // A fresh service instance (i.e. a page reload) still refuses the duplicate,
    // because the check runs against PERSISTED state, not an in-memory flag.
    const reloaded = service();
    expect(reloaded.records()).toHaveLength(1);
    reloaded.record('att-1', 'topic-quiz', topics);
    expect(reloaded.records()).toHaveLength(1);
  });

  it('records one row per topic for a multi-topic attempt', () => {
    const svc = service();
    svc.record('att-1', 'weak-areas-practice', [
      { topicId: 'rxjs', correct: 1, total: 4 },
      { topicId: 'signals', correct: 3, total: 6 }
    ]);
    expect(svc.records()).toHaveLength(2);
    expect(svc.records().every((r) => r.attemptId === 'att-1')).toBe(true);
  });

  it('never destroys valid older entries when appending', () => {
    const svc = service();
    svc.record('att-1', 'topic-quiz', [{ topicId: 'rxjs', correct: 1, total: 5 }]);
    svc.record('att-2', 'weak-areas-practice', [{ topicId: 'signals', correct: 2, total: 5 }]);
    expect(svc.records().map((r) => r.attemptId)).toEqual(['att-1', 'att-2']);
  });

  it('ignores empty, zero-total and malformed inputs', () => {
    const svc = service();
    svc.record('', 'topic-quiz', [{ topicId: 'rxjs', correct: 1, total: 5 }]);      // no id
    svc.record('att-1', 'topic-quiz', []);                                          // no topics
    svc.record('att-2', 'topic-quiz', [{ topicId: 'rxjs', correct: 0, total: 0 }]);  // empty sample
    svc.record('att-3', 'topic-quiz', [{ topicId: '', correct: 1, total: 5 }]);      // no topic id
    expect(svc.records()).toEqual([]);
    expect(stored()).toBeNull();   // nothing was written at all
  });

  it('clamps a nonsensical correct > total rather than discarding the record', () => {
    const svc = service();
    svc.record('att-1', 'topic-quiz', [{ topicId: 'rxjs', correct: 99, total: 10 }]);
    expect(svc.records()[0]).toMatchObject({ correct: 10, total: 10 });
  });
});

describe('TopicPerformanceHistoryService — resilient loading', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('survives malformed storage without throwing', () => {
    localStorage.setItem(SK_TOPIC_PERFORMANCE_HISTORY, '{ not json');
    expect(() => service()).not.toThrow();
    expect(service().records()).toEqual([]);
  });

  it('keeps the GOOD records when some stored entries are malformed', () => {
    localStorage.setItem(SK_TOPIC_PERFORMANCE_HISTORY, JSON.stringify({
      version: 1,
      records: [
        null,
        { attemptId: 'good', source: 'topic-quiz', completedAt: '2026-07-01T10:00:00.000Z', topicId: 'rxjs', topicName: 'RxJS', correct: 1, total: 5 },
        { attemptId: 'bad-source', source: 'interview', completedAt: '2026-07-01T10:00:00.000Z', topicId: 'x', correct: 1, total: 5 },
        { attemptId: 'no-date', source: 'topic-quiz', completedAt: 'nope', topicId: 'x', correct: 1, total: 5 },
        { attemptId: 'zero', source: 'topic-quiz', completedAt: '2026-07-01T10:00:00.000Z', topicId: 'x', correct: 0, total: 0 }
      ]
    }));
    const svc = service();
    expect(svc.records().map((r) => r.attemptId)).toEqual(['good']);
  });

  it('accepts a bare array (legacy shape) as well as the versioned envelope', () => {
    localStorage.setItem(SK_TOPIC_PERFORMANCE_HISTORY, JSON.stringify([
      { attemptId: 'legacy', source: 'topic-quiz', completedAt: '2026-07-01T10:00:00.000Z', topicId: 'rxjs', correct: 1, total: 5 }
    ]));
    expect(service().records().map((r) => r.attemptId)).toEqual(['legacy']);
  });

  it('de-duplicates hand-edited storage on load', () => {
    const row = { attemptId: 'dup', source: 'topic-quiz', completedAt: '2026-07-01T10:00:00.000Z', topicId: 'rxjs', correct: 1, total: 5 };
    localStorage.setItem(SK_TOPIC_PERFORMANCE_HISTORY, JSON.stringify({ version: 1, records: [row, row, row] }));
    expect(service().records()).toHaveLength(1);
  });
});

describe('Weak areas — merging sources without double-counting', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  const interviewAttempt = (completedAt: string, correct: number, total: number): TopicAttemptLike => ({
    completedAt,
    topicPerformance: [{ topicId: 'rxjs', topicName: 'RxJS', correct, total, percentage: (correct / total) * 100 }]
  });

  it('merges interview + topic-quiz + practice through ONE accuracy formula', () => {
    const svc = service();
    svc.record('quiz-1', 'topic-quiz', [{ topicId: 'rxjs', correct: 1, total: 5 }]);
    svc.record('practice-1', 'weak-areas-practice', [{ topicId: 'rxjs', correct: 2, total: 5 }]);

    const merged = [interviewAttempt('2026-07-01T10:00:00.000Z', 1, 10), ...svc.asAttempts()];
    const weak = calculateWeakTopics(merged);

    // Raw sums across ALL three sources: (1+1+2)/(10+5+5) = 4/20 = 20%.
    expect(weak).toHaveLength(1);
    expect(weak[0]).toMatchObject({ topicId: 'rxjs', correct: 4, total: 20 });
    expect(weak[0].percentage).toBeCloseTo(20, 5);
  });

  it('a re-recorded attempt does NOT inflate the merged aggregate', () => {
    const svc = service();
    svc.record('quiz-1', 'topic-quiz', [{ topicId: 'rxjs', correct: 1, total: 5 }]);
    const before = calculateWeakTopics(svc.asAttempts())[0];

    svc.record('quiz-1', 'topic-quiz', [{ topicId: 'rxjs', correct: 1, total: 5 }]);   // duplicate
    const after = calculateWeakTopics(svc.asAttempts())[0];

    expect(after).toEqual(before);
    expect(after).toMatchObject({ correct: 1, total: 5 });
  });

  it('practice results feed back in, so improvement can clear a weak topic', () => {
    const svc = service();
    // Start weak: 1/10 = 10%.
    const weakBefore = calculateWeakTopics([interviewAttempt('2026-07-01T10:00:00.000Z', 1, 10)]);
    expect(weakBefore.map((t) => t.topicId)).toEqual(['rxjs']);

    // A strong practice run lifts the raw aggregate above the threshold.
    svc.record('practice-1', 'weak-areas-practice', [{ topicId: 'rxjs', correct: 40, total: 40 }]);
    const merged = [interviewAttempt('2026-07-01T10:00:00.000Z', 1, 10), ...svc.asAttempts()];
    // (1+40)/(10+40) = 82% → no longer weak.
    expect(calculateWeakTopics(merged)).toEqual([]);
  });
});
