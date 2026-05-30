/**
 * SelectionMessageService integration tests.
 *
 * Guards the click → push → derived-signal pipeline that broke multiple
 * times during refactoring. The mock uses a REAL Angular signal for
 * currentQuestionIndexSig so the computed selectionMessageSig actually
 * re-evaluates when "nav" happens.
 *
 * Scenarios covered:
 *  - Click pushes override; derived signal reflects it
 *  - Nav transition invalidates a stale override
 *  - Revisiting an answered question derives "Answered ✓..." text
 *  - Last-question variant ("...Show Results...")
 *  - isCompletedInSession() public API (used by Show Results button gate)
 *  - resetAll() restores derived default
 *  - External maps (questionCorrectness etc.) don't influence the in-session
 *    answered probe
 */
import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { QuizService } from '../../../services/data/quiz.service';
import { SelectedOptionService } from '../../../services/state/selectedoption.service';
import { SelectionMessageService } from './selection-message.service';

describe('SelectionMessageService integration', () => {
  let service: SelectionMessageService;
  let quizServiceMock: any;
  let currentIdxSig: WritableSignal<number>;

  const CONTINUE_MSG = 'Please select an option to continue...';
  const NEXT_BTN_MSG = 'Please click the Next button to continue.';
  const SHOW_RESULTS_MSG = 'Please click the Show Results button.';
  const ANSWERED_NEXT = 'Answered ✓ Click Next to continue...';
  const ANSWERED_SHOW = 'Answered ✓ Click Show Results...';

  beforeEach(() => {
    currentIdxSig = signal(0);
    quizServiceMock = {
      // Real signal so the computed tracks it and re-runs on changes.
      currentQuestionIndexSig: currentIdxSig,
      currentQuestionIndex: 0,
      totalQuestions: () => 6,
      questions: [],
      shuffledQuestions: [],
      quizInitialState: [],
      isShuffleEnabled: jest.fn().mockReturnValue(false),
      currentQuestion: { value: null },
      scoringService: { questionCorrectness: new Map() },
      _multiAnswerPerfect: new Map(),
      getCurrentQuestionIndex: () => currentIdxSig(),
    };

    TestBed.configureTestingModule({
      providers: [
        SelectionMessageService,
        { provide: QuizService, useValue: quizServiceMock },
        { provide: SelectedOptionService, useValue: { selectedOptionsMap: new Map() } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      ],
    });
    service = TestBed.inject(SelectionMessageService);
  });

  // ── derived default ────────────────────────────────────────

  it('derives CONTINUE_MSG on Q1 unanswered', () => {
    expect(service.selectionMessageSig()).toBe(CONTINUE_MSG);
  });

  it('derives CONTINUE_MSG on any other unanswered question', () => {
    currentIdxSig.set(3);
    expect(service.selectionMessageSig()).toBe(CONTINUE_MSG);
  });

  // ── click override flow ────────────────────────────────────

  it('pushMessage at current idx is reflected by the computed signal', () => {
    service.pushMessage(NEXT_BTN_MSG, 0);
    expect(service.selectionMessageSig()).toBe(NEXT_BTN_MSG);
  });

  it('pushMessage at a non-current idx is IGNORED by the computed', () => {
    service.pushMessage(NEXT_BTN_MSG, 2);
    // Current idx is 0 — override targets idx 2 → not used
    expect(service.selectionMessageSig()).toBe(CONTINUE_MSG);
  });

  it('forceNextButtonMessage pushes NEXT_BTN_MSG for non-last questions', () => {
    service.forceNextButtonMessage(0);
    expect(service.selectionMessageSig()).toBe(NEXT_BTN_MSG);
  });

  it('forceNextButtonMessage pushes SHOW_RESULTS_MSG for the last question', () => {
    currentIdxSig.set(5);
    service.forceNextButtonMessage(5);
    expect(service.selectionMessageSig()).toBe(SHOW_RESULTS_MSG);
  });

  // ── nav transitions invalidate stale overrides ─────────────

  it('nav-away to a different idx: computed picks the NEW idx, not the override', () => {
    service.pushMessage(NEXT_BTN_MSG, 0);
    expect(service.selectionMessageSig()).toBe(NEXT_BTN_MSG);
    // Nav to Q2. Even if the nav-effect doesn't flush (test env), the computed
    // re-runs because currentQuestionIndexSig changed, and override.idx (0)
    // no longer matches current idx (1) — so the computed falls through to
    // derive(1). Q2 isn't in completed set → CONTINUE_MSG.
    currentIdxSig.set(1);
    expect(service.selectionMessageSig()).toBe(CONTINUE_MSG);
  });

  // ── revisit-answered → "Answered ✓..." ─────────────────────

  it('revisit-derivation: when override is gone, completed-set drives "Answered ✓ Click Next..."', () => {
    // Simulate "user clicked correct on Q1, then nav cleared the override".
    // We exercise the derivation directly by pushing the completion at idx 0,
    // then displacing the click override (by pushing a benign progress message
    // for a non-completion at idx 1), then navigating back to 0.
    service.pushMessage(NEXT_BTN_MSG, 0);          // marks 0 in completed-set
    currentIdxSig.set(1);
    service.pushMessage('Select 1 more correct answer to continue...', 1);
    currentIdxSig.set(0);
    // Override now targets idx 1 (last push); current idx is 0; override.idx !== idx
    // → derive(0); 0 is in completed-set → "Answered ✓..."
    expect(service.selectionMessageSig()).toBe(ANSWERED_NEXT);
  });

  it('revisit-derivation last Q: completed-set drives "Answered ✓ Click Show Results..."', () => {
    currentIdxSig.set(5);
    service.pushMessage(SHOW_RESULTS_MSG, 5);     // marks 5 in completed-set
    currentIdxSig.set(4);
    service.pushMessage('Select 1 more correct answer to continue...', 4);
    currentIdxSig.set(5);
    expect(service.selectionMessageSig()).toBe(ANSWERED_SHOW);
  });

  // ── isCompletedInSession public probe ──────────────────────

  it('isCompletedInSession() returns true only after a completion push', () => {
    expect(service.isCompletedInSession(0)).toBe(false);
    service.pushMessage(NEXT_BTN_MSG, 0);
    expect(service.isCompletedInSession(0)).toBe(true);
    expect(service.isCompletedInSession(1)).toBe(false);
  });

  it('isCompletedInSession() recognises SHOW_RESULTS_MSG and "Answered ✓..." too', () => {
    service.pushMessage(SHOW_RESULTS_MSG, 5);
    expect(service.isCompletedInSession(5)).toBe(true);

    service.pushMessage(ANSWERED_NEXT, 3);
    expect(service.isCompletedInSession(3)).toBe(true);
  });

  it('isCompletedInSession() ignores non-completion pushes', () => {
    service.pushMessage('Select 2 more correct answers to continue...', 1);
    expect(service.isCompletedInSession(1)).toBe(false);
  });

  // ── resetAll restores derived default ──────────────────────

  it('resetAll() clears the completed-set and override', () => {
    service.pushMessage(NEXT_BTN_MSG, 0);
    expect(service.isCompletedInSession(0)).toBe(true);

    service.resetAll();
    expect(service.isCompletedInSession(0)).toBe(false);
    // After reset the computed re-derives default for the current idx
    expect(service.selectionMessageSig()).toBe(CONTINUE_MSG);
  });

  // ── external-map leakage guard ─────────────────────────────

  it('does NOT derive "Answered ✓..." when only external questionCorrectness has the index', () => {
    // External map says Q1 correct — but the in-session push never happened.
    // The signal must not promote external maps into "Answered ✓..." text.
    quizServiceMock.scoringService.questionCorrectness.set(0, true);
    quizServiceMock._multiAnswerPerfect.set(0, true);
    expect(service.selectionMessageSig()).toBe(CONTINUE_MSG);
    expect(service.isCompletedInSession(0)).toBe(false);
  });
});
