import { TestBed } from '@angular/core/testing';

import { Quiz } from '../../../models/Quiz.model';
import { setQuizDataCache } from '../../../quiz-data-cache';

import { FeedbackPolicyService } from './feedback-policy.service';
import { InterviewSessionService } from './interview-session.service';

function makeCatalogQuiz(quizId: string, n: number): Quiz {
  const questions = Array.from({ length: n }, (_, i) => ({
    questionText: `${quizId}-q${i + 1}`,
    options: [{ text: 'A', correct: true }, { text: 'B' }],
    explanation: 'e'
  }));
  return { quizId, milestone: quizId, summary: '', image: '', difficulty: 'beginner', questions };
}

describe('InterviewSessionService — feedback lifecycle', () => {
  let session: InterviewSessionService;
  let policy: FeedbackPolicyService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    session = TestBed.inject(InterviewSessionService);
    policy = TestBed.inject(FeedbackPolicyService);
  });

  it('activateDeferredFeedback() defers correctness feedback', () => {
    expect(policy.feedbackMode()).toBe('immediate');
    session.activateDeferredFeedback();
    expect(policy.feedbackMode()).toBe('deferred');
  });

  it('clear() resets feedback to immediate so it cannot leak into normal quizzes', () => {
    session.activateDeferredFeedback();
    expect(policy.isDeferred()).toBe(true);

    session.clear();

    // Leaving / completing the interview restores immediate feedback.
    expect(policy.feedbackMode()).toBe('immediate');
    expect(policy.isDeferred()).toBe(false);
  });
});

describe('InterviewSessionService — navigation + answers', () => {
  let session: InterviewSessionService;

  beforeEach(() => {
    setQuizDataCache([makeCatalogQuiz('ts', 10)], []);
    TestBed.configureTestingModule({});
    session = TestBed.inject(InterviewSessionService);
    session.start({ difficulty: 'mixed', topicIds: ['ts'], questionCount: 10 });
  });

  afterEach(() => setQuizDataCache([], []));

  it('starts at index 0 with the requested total', () => {
    expect(session.currentIndex()).toBe(0);
    expect(session.total()).toBe(10);
  });

  it('next()/previous() move and clamp at the ends', () => {
    session.next();
    expect(session.currentIndex()).toBe(1);
    session.previous();
    session.previous();                 // clamp at 0
    expect(session.currentIndex()).toBe(0);
    session.goTo(9);
    session.next();                     // clamp at last
    expect(session.currentIndex()).toBe(9);
  });

  it('goTo() clamps out-of-range indices', () => {
    session.goTo(100);
    expect(session.currentIndex()).toBe(9);
    session.goTo(-5);
    expect(session.currentIndex()).toBe(0);
  });

  it('records answers and reports answered indices (never correctness)', () => {
    session.setAnswer(0, [101]);
    session.setAnswer(3, [104, 105]);
    expect(session.isAnswered(0)).toBe(true);
    expect(session.isAnswered(1)).toBe(false);
    expect([...session.answeredIndices()].sort((a, b) => a - b)).toEqual([0, 3]);
    expect(session.answeredCount()).toBe(2);
    expect(session.unansweredCount()).toBe(8);
  });

  it('clear() resets index, answers, and status', () => {
    session.goTo(5);
    session.setAnswer(5, [1]);
    session.clear();
    expect(session.currentIndex()).toBe(0);
    expect(session.answeredCount()).toBe(0);
    expect(session.hasActiveSession()).toBe(false);
  });
});
