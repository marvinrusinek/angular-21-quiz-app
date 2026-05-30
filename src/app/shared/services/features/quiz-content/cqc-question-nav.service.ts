import { inject, Injectable } from '@angular/core';
import { ParamMap } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { debounceTime, tap } from 'rxjs/operators';

import { QUESTION_ROUTE_REGEX } from '../../../constants/route-patterns';
import { SK_SEL_Q } from '../../../constants/session-keys';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { CqcFetGuardService } from './cqc-fet-guard.service';

import type { CodelabQuizContentComponent } from '../../../../containers/quiz/quiz-content/codelab-quiz-content.component';

type Host = CodelabQuizContentComponent;

/**
 * Manages question navigation and loading for CodelabQuizContentComponent.
 * Extracted from CqcOrchestratorService.
 *
 * Responsible for:
 * - stampQuestionTextNow: immediate question text stamping
 * - cleanupStaleStateForIndex: post-refresh stale state cleanup
 * - runQuestionIndexSet: question index change handling
 * - runLoadQuizDataFromRoute: route-based quiz data loading
 * - runLoadQuestion: question loading with FET recovery
 */
@Injectable({ providedIn: 'root' })
export class CqcQuestionNavService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly fetGuard = inject(CqcFetGuardService);

  /**
   * Unconditionally stamp the question text for idx into qText. Used by
   * runQuestionIndexSet on every navigation to guarantee the user sees
   * the question text before any FET / pipeline emission arrives. Safe
   * to retry — idempotent for a given idx+currentIndex.
   *
   * Returns true if the stamp was written, false otherwise.
   */
  stampQuestionTextNow(host: Host, idx: number): boolean {
    try {
      if (host.currentIndex !== idx) return false;
      if (this.fetGuard.hasInteractionEvidence(host, idx)) return false;
      
      const el = host.qText?.()?.nativeElement;
      if (!el) return false;  // qText element not found
        
      const display = this.fetGuard.buildQuestionDisplayHTML(host, idx);
      if (!display) {
        // buildQuestionDisplayHTML returned empty
        return false;
      }
      this.fetGuard.writeQText(host, display);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * If the current browser nav is a page refresh AND the target idx
   * differs from the index we refreshed on, wipe all stale restored
   * state for the target idx so downstream pipelines treat it as fresh.
   * Idempotent — safe to call from multiple entry points.
   */
  cleanupStaleStateForIndex(host: Host, idx: number): void {
    try {
      let isPageRefresh = false;
      try {
        const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
        isPageRefresh = navEntries.length > 0 && navEntries[0].type === 'reload';
      } catch { /* ignore */ }

      if (!isPageRefresh) return;

      if (host._refreshInitialIdx == null) {
        let urlIdx: number | null = null;
        try {
          const match = (window?.location?.pathname ?? '').match(QUESTION_ROUTE_REGEX);
          if (match && match[1]) {
            const oneBased = parseInt(match[1], 10);
            if (Number.isFinite(oneBased) && oneBased >= 1) urlIdx = oneBased - 1;
          }
        } catch { /* ignore */ }
        host._refreshInitialIdx = urlIdx ?? idx;
        if (host._refreshInitialIdx === idx) return;
      }

      if (host._refreshInitialIdx === idx) return;

      if (!host._postRefreshCleanedIndices) {
        host._postRefreshCleanedIndices = new Set<number>();
      }
      if (host._postRefreshCleanedIndices.has(idx)) return;
      host._postRefreshCleanedIndices.add(idx);

      try {
        host.quizStateService._hasUserInteracted?.delete(idx);
        host.quizStateService._answeredQuestionIndices?.delete(idx);
        (host.quizStateService as any).persistInteractionState?.();
      } catch { /* ignore */ }
      try {
        host.selectedOptionService.selectedOptionsMap?.delete(idx);
        (host.selectedOptionService as any)._refreshBackup?.delete(idx);
      } catch { /* ignore */ }
      try {
        host.quizService.selectedOptionsMap?.delete(idx);
      } catch { /* ignore */ }
      try {
        sessionStorage.removeItem(SK_SEL_Q + idx);
      } catch { /* ignore */ }
      try {
        host.explanationTextService.fetByIndex?.delete(idx);
        delete (host.explanationTextService.formattedExplanations as any)[idx];
      } catch { /* ignore */ }
      try {
        host.quizStateService.setDisplayState({ mode: 'question', answered: false }, { force: true });
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }

  runQuestionIndexSet(host: Host, idx: number): void {
    host.currentIndex = idx;
    host._fetLocked = false;
    host._lockedForIndex = -1;
    host.timedOutIdxSig.set(-1);
    host.timedOutIdxSubject.next(-1);
    (window as any).__quizTimerExpired = false;

    if (!this.fetGuard.hasInteractionEvidence(host, idx)) {
      host._lastDisplayedText = '';
      host.qTextHtmlSig?.set('');
    }

    this.cleanupStaleStateForIndex(host, idx);

    const stamped = this.stampQuestionTextNow(host, idx);
    if (!stamped && host.qText?.()?.nativeElement && 
      !this.fetGuard.hasInteractionEvidence(host, idx)
    ) {
      this.fetGuard.writeQText(host, '');
    }

    if (!Array.isArray(host._questionStampRetryTimers)) {
      host._questionStampRetryTimers = [];
    }
    for (const t of host._questionStampRetryTimers) clearTimeout(t);
    host._questionStampRetryTimers = [];
    const delays = [0, 50, 150, 400, 900];
    for (const d of delays) {
      host._questionStampRetryTimers.push(
        setTimeout(() => this.stampQuestionTextNow(host, idx), d)
      );
    }

    host.questionIndexSig.set(idx);
    host.questionIndexSubject.next(idx);

    const ets = host.explanationTextService;
    ets._activeIndex = idx;

    const isShuffled = host.quizService.isShuffleEnabled() && Array.isArray(host.quizService.shuffledQuestions) && host.quizService.shuffledQuestions.length > 0;
    const currentQuestion = isShuffled
      ? host.quizService.shuffledQuestions[idx]
      : host.quizService.questions[idx];

    const hasSelectedOption = currentQuestion?.options?.some((o: Option) => o.selected) ?? false;
    const quizServiceHasSelections = host.quizService.selectedOptionsMap?.has(idx) ?? false;
    const selectedOptionServiceHasSelections = (host.selectedOptionService.selectedOptionsMap?.get(idx)?.length ?? 0) > 0;
    const hasTrackedInteraction = host.quizStateService.hasUserInteracted(idx);
    const hasAnswerEvidence =
      hasSelectedOption || quizServiceHasSelections || selectedOptionServiceHasSelections || hasTrackedInteraction;

    const selectedForIdx = (host.selectedOptionService.selectedOptionsMap?.get(idx) ?? []) as Option[];
    const isActuallyResolved = currentQuestion && host.selectedOptionService.isQuestionResolvedCorrectly(currentQuestion, selectedForIdx);

    if (isActuallyResolved && !host.isNavigatingToPrevious()) {
      host.quizStateService.setDisplayState({ mode: 'explanation', answered: true });
    } else {
      host.quizStateService.setDisplayState({ mode: 'question', answered: false });

      if (!hasAnswerEvidence) {
        ets.resetForIndex(idx);
        ets.latestExplanation = '';
        ets.latestExplanationIndex = -1;
        ets.formattedExplanationSig.set('');

        try { (ets as any)._fetSubject?.next({ idx: -1, text: '', token: 0 }); } catch { }
        try { ets.fetByIndex?.delete(idx); } catch { }
        try { delete (ets.formattedExplanations as any)[idx]; } catch { }

        host._lastQuestionTextByIndex?.delete(idx);
        host.quizService.selectedOptionsMap?.delete(idx);
        host.selectedOptionService.selectedOptionsMap?.delete(idx);
        host._fetDisplayedThisSession?.delete(idx);
        ets.setShouldDisplayExplanation(false, { force: true });
        ets.setIsExplanationTextDisplayed(false, { force: true });
      }
    }

    host.resetExplanationView();

    host.cdRef.markForCheck();
  }

  runLoadQuizDataFromRoute(host: Host): void {
    host.activatedRoute.paramMap.subscribe(async (params: ParamMap) => {
      const quizId = params.get('quizId');
      const questionIndex = Number(params?.get('questionIndex') ?? 1);
      const zeroBasedIndex = questionIndex - 1;

      if (quizId) {
        host.setQuizId(quizId);
        host.quizService.quizId = quizId;
        host.quizService.setQuizId(quizId);
        localStorage.setItem('quizId', quizId);
        host.currentQuestionIndexValue = zeroBasedIndex;

        try {
          host.quizService.scoringService?.restoreScoreFromPersistence?.(quizId);
        } catch { /* ignore */ }

        host.currentIndex = zeroBasedIndex;

        this.cleanupStaleStateForIndex(host, zeroBasedIndex);

        this.stampQuestionTextNow(host, zeroBasedIndex);
        if (!Array.isArray(host._questionStampRetryTimers)) {
          host._questionStampRetryTimers = [];
        }
        for (const t of host._questionStampRetryTimers) clearTimeout(t);
        host._questionStampRetryTimers = [];
        const routeDelays = [0, 50, 150, 400, 900];
        for (const d of routeDelays) {
          host._questionStampRetryTimers.push(
            setTimeout(() => this.stampQuestionTextNow(host, zeroBasedIndex), d)
          );
        }

        host.questionIndexSig.set(zeroBasedIndex);
        host.questionIndexSubject.next(zeroBasedIndex);

        await host.loadQuestion(quizId, zeroBasedIndex);
      }
    });

    host.currentQuestion$
      .pipe(
        debounceTime(200),
        tap((question: QuizQuestion | null) => {
          if (question) host.updateCorrectAnswersDisplay(question).subscribe();
        })
      )
      .subscribe();
  }

  async runLoadQuestion(host: Host, quizId: string, zeroBasedIndex: number): Promise<void> {
    if (zeroBasedIndex == null || isNaN(zeroBasedIndex)) return;

    try {
      const questions = (await firstValueFrom(
        host.quizDataService.getQuestionsForQuiz(quizId)
      )) as QuizQuestion[];
      if (
        questions &&
        questions.length > 0 &&
        zeroBasedIndex >= 0 &&
        zeroBasedIndex < questions.length
      ) {
        let question = questions[zeroBasedIndex];
        if (host.quizService.isShuffleEnabled() &&
          host.quizService.shuffledQuestions?.length > zeroBasedIndex) {
          question = host.quizService.shuffledQuestions[zeroBasedIndex];
        }

        host.currentQuestionSig.set(question);

        host.explanationTextService.resetExplanationState();
        host.explanationTextService.resetExplanationText();

        host.quizService.setCurrentQuestion(question);

        if (Array.isArray(host._eagerFetRetryTimers)) {
          for (const t of host._eagerFetRetryTimers) clearTimeout(t);
        }
        host._eagerFetRetryTimers = [];
        host._fetLockedForIndex = -1;

        try {
          let isPageRefresh = false;
          try {
            const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
            isPageRefresh = navEntries.length > 0 && navEntries[0].type === 'reload';
          } catch { /* ignore */ }
          if (host._refreshInitialLoadConsumed == null) {
            host._refreshInitialLoadConsumed = false;
          }
          const isInitialLoadAfterRefresh = isPageRefresh && !host._refreshInitialLoadConsumed;
          if (isInitialLoadAfterRefresh) {
            host._refreshInitialIdx = zeroBasedIndex;
          }
          host._refreshInitialLoadConsumed = true;

          const isPostRefreshNavToDifferentIdx =
            isPageRefresh
            && typeof host._refreshInitialIdx === 'number'
            && host._refreshInitialIdx !== zeroBasedIndex;
          if (isPostRefreshNavToDifferentIdx) {
            try {
              host.quizStateService._hasUserInteracted?.delete(zeroBasedIndex);
              host.quizStateService._answeredQuestionIndices?.delete(zeroBasedIndex);
              (host.quizStateService as any).persistInteractionState?.();
            } catch { /* ignore */ }
            try {
              host.selectedOptionService.selectedOptionsMap?.delete(zeroBasedIndex);
            } catch { /* ignore */ }
            try {
              sessionStorage.removeItem(SK_SEL_Q + zeroBasedIndex);
            } catch { /* ignore */ }
            try {
              host.explanationTextService.fetByIndex?.delete(zeroBasedIndex);
              delete (host.explanationTextService.formattedExplanations as any)[zeroBasedIndex];
            } catch { /* ignore */ }
          }

          const ets = host.explanationTextService;
          const hasClicked = host.quizStateService.hasClickedInSession?.(zeroBasedIndex) ?? false;

          let isResolvedFromPersistence = false;
          try {
            let storedSelections: any[] = [];
            try {
              const raw = sessionStorage.getItem(SK_SEL_Q + zeroBasedIndex);
              if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) storedSelections = parsed;
              }
            } catch { /* ignore */ }
            if (storedSelections.length === 0) {
              storedSelections =
                host.selectedOptionService.getSelectedOptionsForQuestion?.(zeroBasedIndex)
                ?? [];
            }
            if (storedSelections.length > 0 && question) {
              isResolvedFromPersistence =
                host.selectedOptionService.isQuestionResolvedLeniently?.(question, storedSelections)
                ?? false;
            }
          } catch { /* ignore */ }

          const shouldInject = hasClicked && !!question?.explanation && isResolvedFromPersistence;
          if (shouldInject) {
            const correctIndices = ets.getCorrectOptionIndices(question, question.options, zeroBasedIndex);
            if (correctIndices.length > 0) {
              const formattedFet = ets.formatExplanation(question, correctIndices, question.explanation);
              if (formattedFet) {
                host._fetLockedForIndex = zeroBasedIndex;
                const injectNow = () => {
                  if (host.currentIndex !== zeroBasedIndex) return;
                  try {
                    ets.storeFormattedExplanation(zeroBasedIndex, question.explanation, question, question.options, true);
                  } catch { /* ignore */ }
                  this.fetGuard.writeQText(host, formattedFet);
                };
                injectNow();
                if (!Array.isArray(host._eagerFetRetryTimers)) {
                  host._eagerFetRetryTimers = [];
                }
                host._eagerFetRetryTimers.push(setTimeout(injectNow, 0));
                host._eagerFetRetryTimers.push(setTimeout(injectNow, 50));
                host._eagerFetRetryTimers.push(setTimeout(injectNow, 200));
                host._eagerFetRetryTimers.push(setTimeout(injectNow, 500));
                host._eagerFetRetryTimers.push(setTimeout(injectNow, 1000));
              }
            } else {
              // No correct indices found — cannot format FET
            }
          }

          if (hasClicked && !isResolvedFromPersistence) {
            const display = this.fetGuard.buildQuestionDisplayHTML(host, zeroBasedIndex);
            if (display && host.currentIndex === zeroBasedIndex) {
              this.fetGuard.writeQText(host, display);
            }
          }
        } catch (err) {
          // Eager FET regeneration failed
        }
      }
    } catch (error: any) {
    }
  }
}
