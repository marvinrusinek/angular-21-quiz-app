import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import { PracticeSessionService } from './practice-session.service';
import { AssessmentBuilderService } from '../assessment/assessment-builder.service';
import { TopicPerformanceHistoryService } from '../../progress/topic-performance-history.service';
import { WeakAreasService } from '../../progress/weak-areas.service';
import {
  SK_COMPLETED_QUIZ_IDS,
  SK_CORRECT_ANSWERS_COUNT,
  SK_INTERVIEW_CERTIFICATE,
  SK_INTERVIEW_CERTIFICATE_QUAL,
  SK_INTERVIEW_HISTORY,
  SK_QUIZ_ACHIEVEMENTS,
  SK_QUIZ_BEST_SCORES,
  SK_STARTED_QUIZ_IDS,
  SK_TOPIC_PERFORMANCE_HISTORY
} from '../../../constants/session-keys';
import { setQuizDataCache } from '../../../quiz-data-cache';
import { Quiz } from '../../../models/Quiz.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import quizData from '../../../../../assets/data/quiz.json';

const REAL_CATALOG = ((quizData as { quizzes?: unknown[] }).quizzes ?? quizData) as Quiz[];

const weakIds = signal<string[]>(['rxjs', 'signals']);
const weakAreasStub = { weakTopicIds: weakIds } as unknown as WeakAreasService;

/**
 * Every store Weak Areas Practice must leave ALONE. Interview analytics,
 * certificates, High Scores, achievements, best scores and quiz completion
 * counts all read from these; practice writes only to
 * topicPerformanceHistory:v1.
 */
const UNTOUCHABLE: Record<string, string> = {
  [SK_INTERVIEW_HISTORY]: JSON.stringify({ version: 1, attempts: [{ id: 'interview-1' }] }),
  [SK_INTERVIEW_CERTIFICATE]: JSON.stringify({ unlocked: true, id: 'cert-1' }),
  [SK_INTERVIEW_CERTIFICATE_QUAL]: '2026-01-01T00:00:00.000Z',
  [SK_QUIZ_BEST_SCORES]: JSON.stringify({ rxjs: 80 }),
  [SK_QUIZ_ACHIEVEMENTS]: JSON.stringify(['first-quiz']),
  [SK_COMPLETED_QUIZ_IDS]: JSON.stringify(['rxjs']),
  [SK_STARTED_QUIZ_IDS]: JSON.stringify(['rxjs']),
  [SK_CORRECT_ANSWERS_COUNT]: '4',
  highScoresLocal: JSON.stringify([{ quizId: 'rxjs', score: 80, attemptId: 'att_1' }]),
  questionCorrectness: JSON.stringify({ 0: true })
};

function service(): PracticeSessionService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      PracticeSessionService,
      AssessmentBuilderService,
      TopicPerformanceHistoryService,
      { provide: WeakAreasService, useValue: weakAreasStub }
    ]
  });
  return TestBed.inject(PracticeSessionService);
}

function correctIdsFor(question: QuizQuestion): number[] {
  return (question.options ?? [])
    .filter((o) => o.correct === true)
    .map((o) => o.optionId)
    .filter((id): id is number => id != null);
}

function runFullPractice(svc: PracticeSessionService): void {
  svc.start();
  for (let i = 0; i < svc.total(); i++) svc.select(i, correctIdsFor(svc.questions()[i]));
  svc.goTo(svc.total() - 1);
  svc.submit();
}

describe('Weak Areas Practice — regression boundaries', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    setQuizDataCache(REAL_CATALOG, []);
    weakIds.set(['rxjs', 'signals']);
    for (const [key, value] of Object.entries(UNTOUCHABLE)) localStorage.setItem(key, value);
  });
  afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

  it('completing a practice session leaves EVERY other store byte-identical', () => {
    const svc = service();
    runFullPractice(svc);

    for (const [key, value] of Object.entries(UNTOUCHABLE)) {
      expect(`${key}=${localStorage.getItem(key)}`).toBe(`${key}=${value}`);
    }
  });

  it('writes ONLY topicPerformanceHistory:v1', () => {
    const before = new Set(Object.keys(localStorage));
    const svc = service();
    runFullPractice(svc);

    const added = Object.keys(localStorage).filter((key) => !before.has(key));
    expect(added).toEqual([SK_TOPIC_PERFORMANCE_HISTORY]);
  });

  it('does not add an Interview History attempt — interview counts stay interview-only', () => {
    const svc = service();
    runFullPractice(svc);

    const history = JSON.parse(localStorage.getItem(SK_INTERVIEW_HISTORY)!);
    expect(history.attempts.length).toBe(1);
    expect(history.attempts[0].id).toBe('interview-1');
  });

  it('does not add a High Scores row', () => {
    const svc = service();
    runFullPractice(svc);
    expect(JSON.parse(localStorage.getItem('highScoresLocal')!).length).toBe(1);
  });

  it('does not change best scores, achievements or quiz completion counts', () => {
    const svc = service();
    runFullPractice(svc);

    expect(JSON.parse(localStorage.getItem(SK_QUIZ_BEST_SCORES)!)).toEqual({ rxjs: 80 });
    expect(JSON.parse(localStorage.getItem(SK_QUIZ_ACHIEVEMENTS)!)).toEqual(['first-quiz']);
    expect(JSON.parse(localStorage.getItem(SK_COMPLETED_QUIZ_IDS)!)).toEqual(['rxjs']);
  });

  it('does not disturb the topic quiz score state', () => {
    const svc = service();
    runFullPractice(svc);

    expect(localStorage.getItem(SK_CORRECT_ANSWERS_COUNT)).toBe('4');
    expect(JSON.parse(localStorage.getItem('questionCorrectness')!)).toEqual({ 0: true });
  });

  it('records ONLY weak-areas-practice rows, never topic-quiz ones', () => {
    const svc = service();
    runFullPractice(svc);

    const records = TestBed.inject(TopicPerformanceHistoryService).records();
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.source === 'weak-areas-practice')).toBe(true);
    expect(records.every((r) => r.attemptId.startsWith('practice:'))).toBe(true);
  });

  it('leaves the practice session confined to its OWN sessionStorage key', () => {
    const svc = service();
    svc.start();
    expect(Object.keys(sessionStorage)).toEqual(['weakAreasPracticeSession:v1']);
  });
});
