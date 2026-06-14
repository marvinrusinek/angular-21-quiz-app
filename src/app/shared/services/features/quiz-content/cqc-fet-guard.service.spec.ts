import { TestBed } from '@angular/core/testing';

import { QuizDotStatusService } from '../../flow/quiz-dot-status.service';
import { CqcFetGuardService } from './cqc-fet-guard.service';

/**
 * Regression guard for the multi-answer revisit FET bug (fixed 2026-06-14,
 * commit 43cbd1e4). The MutationObserver heading watchdog reverts the FET to
 * question + banner whenever isMultiAnswerResolvedNow() returns false. That
 * method must honor the THREE durable resolution signals — a timed-out current
 * question, fetBypassForQuestion, and _multiAnswerPerfect — so a completed
 * multi-answer question stays "resolved" even after its live selections are
 * cleared on navigate-away/back. Removing the _multiAnswerPerfect branch
 * reintroduces the bug (the heading reverts to the question), and the first
 * test below will fail.
 *
 * isMultiAnswerResolvedNow is private; tested directly because it is the sole
 * resolution oracle the watchdog consults, and its three signals are clean
 * early-returns that read off the host (no deep wiring needed).
 */
describe('CqcFetGuardService.isMultiAnswerResolvedNow', () => {
  let service: CqcFetGuardService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        CqcFetGuardService,
        { provide: QuizDotStatusService, useValue: { timerExpiredUnanswered: new Set() } },
      ],
    });
    service = TestBed.inject(CqcFetGuardService);
  });

  const resolvedNow = (host: any): boolean | null =>
    (service as any).isMultiAnswerResolvedNow(host);

  // Minimal host: getActiveIdx falls back to currentQuestionIndex (the jsdom
  // pathname does not match QUESTION_ROUTE_REGEX), and every resolution signal
  // defaults to "not set".
  const hostFor = (idx: number, over: any = {}): any => ({
    quizService: {
      currentQuestionIndex: idx,
      _multiAnswerPerfect: new Map<number, boolean>(),
      ...(over.quizService ?? {}),
    },
    explanationTextService: {
      fetBypassForQuestion: new Map<number, boolean>(),
      ...(over.explanationTextService ?? {}),
    },
    timedOutIdxSubject: { getValue: () => -1, ...(over.timedOutIdxSubject ?? {}) },
  });

  it('resolves a completed multi-answer via _multiAnswerPerfect even when live selections are gone (revisit FET fix)', () => {
    const host = hostFor(1, {
      quizService: { currentQuestionIndex: 1, _multiAnswerPerfect: new Map([[1, true]]) },
    });
    expect(resolvedNow(host)).toBe(true);
  });

  it('resolves when fetBypassForQuestion is set for the active index (SOC auto-reveal)', () => {
    const host = hostFor(1, {
      explanationTextService: { fetBypassForQuestion: new Map([[1, true]]) },
    });
    expect(resolvedNow(host)).toBe(true);
  });

  it('resolves when the current question has timed out', () => {
    const host = hostFor(2, { timedOutIdxSubject: { getValue: () => 2 } });
    expect(resolvedNow(host)).toBe(true);
  });

  it('does NOT resolve when no completion signal is set and selections cannot satisfy the question', () => {
    const host = hostFor(1);
    expect(resolvedNow(host)).toBeNull();
  });
});
