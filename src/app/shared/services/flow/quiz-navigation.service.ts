import { Injectable, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { ActivatedRoute, ActivatedRouteSnapshot, Router } from '@angular/router';
import { firstValueFrom, Observable, of, Subject } from 'rxjs';
import { catchError, take } from 'rxjs/operators';

import { QuestionType } from '../../models/question-type.enum';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

import { ExplanationTextService } from '../features/explanation/explanation-text.service';
import { NextButtonStateService } from '../state/next-button-state.service';
import { OptionLockStateService } from '../state/option-lock-state.service';
import { QqcQuestionLoaderService } from '../features/qqc/qqc-question-loader.service';
import { QuizDataService } from '../data/quizdata.service';
import { QuizQuestionManagerService } from '../flow/quizquestionmgr.service';
import { QuizService } from '../data/quiz.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';
import { SelectionMessageService } from '../features/selection-message/selection-message.service';
import { TimerService } from '../features/timer/timer.service';
import { SK_CORRECT_ANSWERS_COUNT, SK_SAVED_QUESTION_INDEX, SK_SELECTED_OPTIONS_MAP, SK_USER_ANSWERS } from '../../constants/session-keys';

import { isOptionCorrect } from '../../utils/is-option-correct';
import { norm } from '../../utils/text-norm';

/** Delay before clearing the backward-navigation signal after a Previous click. */
const PREVIOUS_NAV_SIGNAL_RESET_DELAY_MS = 500;

/** Duration of the MutationObserver lock that prevents stale FET writes from overwriting the target question text after a Next click. */
const NAV_LOCK_OBSERVER_DURATION_MS = 1200;

@Injectable({ providedIn: 'root' })
export class QuizNavigationService {
  // ── injects ─────────────────────────────────────────────────────
  private activatedRoute = inject(ActivatedRoute);
  private explanationTextService = inject(ExplanationTextService);
  private nextButtonStateService = inject(NextButtonStateService);
  private optionLockState = inject(OptionLockStateService);
  private quizDataService = inject(QuizDataService);
  private quizQuestionLoaderService = inject(QqcQuestionLoaderService);
  private quizQuestionManagerService = inject(QuizQuestionManagerService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private router = inject(Router);
  private selectedOptionService = inject(SelectedOptionService);
  private selectionMessageService = inject(SelectionMessageService);
  private timerService = inject(TimerService);

  // ── signals ─────────────────────────────────────────────────────
  /** Signal-first source of truth for backward-navigation state */
  readonly isNavigatingToPreviousSig = signal<boolean>(false);
  private readonly isNavigatingToPrevious$ = toObservable(this.isNavigatingToPreviousSig);

  // ── properties ──────────────────────────────────────────────────
  private quizId = '';

  isNavigating = false;
  quizCompleted = false;

  private navigationSuccessSubject = new Subject<void>();
  navigationSuccess$ = this.navigationSuccessSubject.asObservable();

  private navigatingBackSubject = new Subject<boolean>();
  navigatingBack$ = this.navigatingBackSubject.asObservable();

  private navigationToQuestionSubject = new Subject<{
    question: QuizQuestion,
    options: Option[]
  }>();
  public navigationToQuestion$ =
    this.navigationToQuestionSubject.asObservable();

  private explanationResetSubject = new Subject<void>();
  explanationReset$ = this.explanationResetSubject.asObservable();

  private resetUIForNewQuestionSubject = new Subject<void>();
  resetUIForNewQuestion$ = this.resetUIForNewQuestionSubject.asObservable();

  private renderResetSubject = new Subject<void>();
  renderReset$ = this.renderResetSubject.asObservable();

  // ── public methods ──────────────────────────────────────────────

  public async advanceToNextQuestion(): Promise<boolean> {
    if (this.isNavigating) return false;

    // Record elapsed time for current question before navigating
    const currentIndex = this.quizService.getCurrentQuestionIndex();
    if (currentIndex >= 0) {
      // Get elapsed time from the timer's current value if not already stored
      const currentElapsed = this.timerService.elapsedTimeSig() ?? 0;
      if (!this.timerService.elapsedTimes[currentIndex] && currentElapsed > 0) {
        this.timerService.elapsedTimes[currentIndex] = currentElapsed;
      }
    }

    try { this.resetExplanationAndState(); } catch (err: any) {
      console.error('QuizNavigationService.advanceToNextQuestion explanation reset failed:', err);
    }

    return await this.navigateWithOffset(1);  // defer navigation until state is clean
  }

  public async advanceToPreviousQuestion(): Promise<boolean> {
    // Signal backward navigation so display pipeline suppresses FET
    this.isNavigatingToPreviousSig.set(true);

    try {
      // Do not wipe everything; only clear transient display flags if necessary
      this.quizStateService.setLoading(false);

      // Clear only ephemeral fields (no deep reset)
      (this as any).displayExplanation = false;
      (this as any).explanationToDisplay = '';
      this.explanationTextService.setShouldDisplayExplanation(false);
    } catch (err: any) { }

    const result = await this.navigateWithOffset(-1);

    // After Previous navigation lands, push the correct selection message
    // for the target question. The check below uses multiple signals so
    // it survives even if one source hasn't updated yet:
    //   - quizStateService.isQuestionAnswered (in-memory answered set)
    //   - questionCorrectness map (set by scoreDirectly on correct click)
    //   - _multiAnswerPerfect map (set by SOC on multi-answer all-correct)
    //   - fetBypassForQuestion (set by SOC paths that show FET)
    const pushMsgForIdx = (targetIdx: number): void => {
      if (!Number.isFinite(targetIdx) || targetIdx < 0) return;
      const total = this.quizService.totalQuestions();
      const qs: any = this.quizService;
      const answered =
        this.quizStateService.isQuestionAnswered?.(targetIdx) === true
        || qs?.questionCorrectness?.get?.(targetIdx) === true
        || qs?._multiAnswerPerfect?.get?.(targetIdx) === true
        || this.explanationTextService?.fetBypassForQuestion?.get?.(targetIdx) === true;
      const isLast = total > 0 && targetIdx === total - 1;
      const msg = answered
        ? (isLast ? 'Answered ✓ Click Show Results...' : 'Answered ✓ Click Next to continue...')
        : 'Please select an option to continue...';
      this.selectionMessageService.pushMessage(msg, targetIdx);
    };

    try {
      // Read target idx from the route (authoritative), with currentQuestionIndex
      // as fallback. The route is 1-based; convert to 0-based.
      let targetIdx = -1;
      try {
        const urlIdx = this.readQuestionIndexFromRouterSnapshot();
        if (Number.isFinite(urlIdx) && urlIdx >= 1) targetIdx = urlIdx - 1;
      } catch { /* ignore */ }
      if (targetIdx < 0) targetIdx = this.quizService.currentQuestionIndex;
      pushMsgForIdx(targetIdx);
      // Re-push after a tick in case the answered-state maps populate late.
      setTimeout(() => pushMsgForIdx(targetIdx), 50);
      setTimeout(() => pushMsgForIdx(targetIdx), 200);
    } catch { /* ignore */ }

    // Reset flag after a short delay to allow display pipeline to process
    setTimeout(() => this.isNavigatingToPreviousSig.set(false), PREVIOUS_NAV_SIGNAL_RESET_DELAY_MS);

    return result;
  }

  private async navigateWithOffset(offset: number): Promise<boolean> {
    const currentRouteIndex = this.readQuestionIndexFromRouterSnapshot();
    
    const targetRouteIndex = currentRouteIndex + offset;

    // Simple Bounds Safety (only check min)
    if (targetRouteIndex < 1) return false;

    return this.navigateToQuestion(targetRouteIndex - 1);
  }

  public async navigateToQuestion(index: number): Promise<boolean> {
    // HARD reset render state before route change
    this.resetRenderStateBeforeNavigation(index);

    try {
      // Set navigating state
      this.isNavigating = true;
      this.quizStateService.setNavigating(true);
      this.quizStateService.setLoading(true);

      // Perform Router Navigation
      const navSuccess = await this.performRouterNavigation(index);
      if (!navSuccess) return false;

      // Reset timer state before emitting the new index to avoid immediate expiry
      this.timerService.stopTimer(undefined, { force: true });
      this.timerService.resetTimer();
      this.timerService.resetTimerFlagsFor(index);

      // Clear stale selections on both source AND destination unless the
      // question is timer-locked (then preserve the timeout-revealed state).
      // Per user requirement: questions should be COMPLETELY CLEAN on
      // revisit, regardless of what was clicked first visit. _multiAnswerPerfect
      // was previously used as a "preserve correct state" gate but it was
      // being set by buggy paths even on wrong-only clicks.
      const isResolved = (idx: number) => this.optionLockState.isQuestionLocked(idx);
      const sourceIdx = this.quizService.getCurrentQuestionIndex();
      if (sourceIdx >= 0 && sourceIdx !== index && !isResolved(sourceIdx)) {
        this.selectedOptionService.clearSelectionsForQuestion(sourceIdx);
      }
      if (!isResolved(index)) {
        this.selectedOptionService.clearSelectionsForQuestion(index);
      }
      // Wipe _multiAnswerPerfect for the destination unless the question
      // was actually scored correct (questionCorrectness). For a genuinely
      // perfectly-answered question we WANT the flag preserved so revisit
      // re-renders the green/gray highlight; only buggy stale flags need
      // wiping, and those won't have questionCorrectness set.
      // In shuffled mode, questionCorrectness is keyed by ORIGINAL index
      // (set by scoreDirectly), so map display→original before checking.
      const _isScoredAt = (idx: number): boolean => {
        if (this.quizService.questionCorrectness?.get?.(idx) === true) return true;
        try {
          const qs: any = this.quizService;
          const isShuf = qs?.isShuffleEnabled?.() && qs?.shuffledQuestions?.length > 0;
          if (isShuf) {
            let eqId = qs?.quizId || '';
            if (!eqId) { try { eqId = localStorage.getItem('lastQuizId') || ''; } catch {} }
            if (eqId) {
              const origIdx = qs?.scoringService?.quizShuffleService?.toOriginalIndex?.(eqId, idx);
              if (typeof origIdx === 'number' && origIdx >= 0) {
                return this.quizService.questionCorrectness?.get?.(origIdx) === true;
              }
            }
          }
        } catch { /* ignore */ }
        return false;
      };
      const _scoredDest = _isScoredAt(index);
      if (!_scoredDest) this.quizService._multiAnswerPerfect.delete(index);
      if (sourceIdx >= 0 && sourceIdx !== index && !_isScoredAt(sourceIdx)) {
        this.quizService._multiAnswerPerfect.delete(sourceIdx);
      }

      // Update Service State (Index) - Update AFTER router nav success
      this.quizService.setCurrentQuestionIndex(index);

      // Reset UI States for New Question
      this.resetExplanationAndState();
      this.selectedOptionService.setAnswered(false, true);

      // Clear all option selections when navigating to new question
      this.nextButtonStateService.reset();
      this.quizQuestionLoaderService.resetUI();

      // Fetch New Question Data
      const fresh = await this.fetchAndEmitQuestion(index);
      if (!fresh) return false;

      // Finalize
      this.notifyNavigationSuccess();

      return true;
    } catch (err: any) {
      console.error('QuizNavigationService.navigateToQuestion navigation failed:', err);
      return false;
    } finally {
      this.isNavigating = false;
      this.quizStateService.setNavigating(false);
      this.quizStateService.setLoading(false);
    }
  }

  private async performRouterNavigation(index: number): Promise<boolean> {
    const quizId = this.resolveEffectiveQuizId();
    if (!quizId) return false;

    this.quizId = quizId;
    this.quizService.setQuizId(quizId);

    const routeUrl = `/quiz/question/${quizId}/${index + 1}`;
    const currentUrl = this.router.url;
    const currentIndex = this.quizService.getCurrentQuestionIndex();

    // Handle same-URL reload scenario
    if (currentIndex === index && currentUrl === routeUrl) {
      await this.router.navigateByUrl('/', { skipLocationChange: true });
    }

    const navSuccess = await this.router.navigateByUrl(routeUrl);
    return navSuccess;
  }

  private async fetchAndEmitQuestion(index: number): Promise<any> {
    const fresh = await firstValueFrom(
      this.quizService.getQuestionByIndex(index)
    );
    if (!fresh) return null;

    this.quizService.setCurrentQuestionIndex(index);

    // Reset FET caches
    try {
      const ets: any = this.explanationTextService;
      ets._activeIndex = index;
      ets.formattedExplanationSig.set('');
      ets.shouldDisplayExplanationSubject?.next(false);
      ets.isExplanationTextDisplayedSubject?.next(false);

      if (ets._byIndex) {
        for (const subj of ets._byIndex.values()) subj?.next?.('');
      }

      if (ets._gate) {
        for (const gate of ets._gate.values()) gate?.next?.(false);
      }
    } catch (err: any) {
      console.error('QuizNavigationService.fetchAndEmitQuestion FET cache reset failed:', err);
    }

    // Prepare text
    const isMulti =
      (fresh.type as any) === QuestionType.MultipleAnswer ||
      (Array.isArray(fresh.options) &&
        fresh.options.filter((o) => o.correct).length > 1);

    const trimmedQ = (fresh.questionText ?? '').trim();
    const explanationRaw = (fresh.explanation ?? '').trim();
    const numCorrect = (fresh.options ?? []).filter((o) => o.correct).length;
    const totalOpts = (fresh.options ?? []).length;

    const banner = isMulti
      ? this.quizQuestionManagerService.getNumberOfCorrectAnswersText(
        numCorrect,
        totalOpts
      )
      : '';

    // WAIT for DOM to stabilize before final emission
    const qqls = this.quizQuestionLoaderService;
    await qqls.waitForDomStable(32);

    qqls._frozen = false;
    qqls._isVisualFrozen = false;
    qqls._renderFreezeUntil = 0;
    qqls._quietZoneUntil = performance.now() - 1;
    qqls.quietZoneUntilSig?.set(qqls._quietZoneUntil);

    const ets: any = this.explanationTextService;
    ets._hardMuteUntil = performance.now() - 1;

    // Emit question and banner
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        try {
          qqls.emitQuestionTextSafely(trimmedQ, index);

          requestAnimationFrame(() => {
            this.quizService.updateCorrectAnswersText(banner);
          });

          resolve();
        } catch (err) {
          qqls._frozen = false;
          qqls._isVisualFrozen = false;
          resolve();
        }
      });
    });

    return { fresh, explanationRaw };
  }

  public async resetUIAndNavigate(
    index: number,
    quizIdOverride?: string
  ): Promise<boolean> {
    try {
      const effectiveQuizId = this.resolveEffectiveQuizId(quizIdOverride);
      if (!effectiveQuizId) return false;

      if (quizIdOverride && this.quizService.quizId !== quizIdOverride) {
        this.quizService.setQuizId(quizIdOverride);
      }

      this.quizId = effectiveQuizId;

      // Fresh start guard: entering Q1 from intro/start should never reuse stale
      // same-tab score or selection state.
      if (index === 0) {
        this.quizService.resetScore();
        this.quizService.questionCorrectness.clear();
        this.quizService.selectedOptionsMap.clear();
        this.quizService.userAnswers = [];
        this.quizService.answers = [];
        this.selectedOptionService.resetSelectionState();
        this.selectedOptionService.clearAllSelectionsForQuiz(effectiveQuizId);

        try {
          localStorage.setItem(SK_SAVED_QUESTION_INDEX, '0');
          localStorage.setItem(SK_CORRECT_ANSWERS_COUNT, '0');
          localStorage.removeItem('questionCorrectness');
          localStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
          localStorage.removeItem(SK_USER_ANSWERS);
          sessionStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
        } catch { }
      }

      // Always ensure the quiz session is hydrated before attempting to access questions.
      await this.ensureSessionQuestions(effectiveQuizId);

      // Set question index in service so downstream subscribers know what we're targeting.
      this.quizService.setCurrentQuestionIndex(index);

      const question = await this.tryResolveQuestion(index);
      if (question) {
        this.quizService.setCurrentQuestion(question);

        const quiz = this.quizService.getActiveQuiz();
        const totalQuestions = quiz?.questions?.length ?? 0;
        if (totalQuestions > 0) {
          this.quizService.updateBadgeText(index + 1, totalQuestions);
        }
      }

      const routeUrl = `/quiz/question/${effectiveQuizId}/${index + 1}`;
      if (this.router.url === routeUrl) return true;

      const navSuccess = await this.router.navigateByUrl(routeUrl);
      return navSuccess;
    } catch (err: any) {
      console.error('QuizNavigationService.resetUIAndNavigate navigation failed:', err);
      return false;
    }
  }

  public resolveEffectiveQuizId(quizIdOverride?: string): string | null {
    if (quizIdOverride) {
      this.quizId = quizIdOverride;
      return quizIdOverride;
    }

    if (this.quizService.quizId) {
      this.quizId = this.quizService.quizId;
      return this.quizService.quizId;
    }

    if (this.quizId) return this.quizId;

    const routeQuizId = this.readQuizIdFromRouterSnapshot();
    if (routeQuizId) {
      this.quizId = routeQuizId;
      this.quizService.setQuizId(routeQuizId);
      return routeQuizId;
    }

    try {
      const stored = localStorage.getItem('quizId');
      if (stored) {
        this.quizId = stored;
        this.quizService.setQuizId(stored);
        return stored;
      }
    } catch {
      // Ignore storage access issues – we'll fall through to null.
    }

    return null;
  }

  public async ensureSessionQuestions(quizId: string): Promise<void> {
    try {
      await firstValueFrom(
        this.quizDataService.prepareQuizSession(quizId).pipe(
          take(1),
          catchError(() => {
            return of([]);
          })
        )
      );
    } catch (error: any) {
      console.error('QuizNavigationService.ensureSessionQuestions session hydration failed:', error);
    }
  }

  public async tryResolveQuestion(index: number): Promise<QuizQuestion | null> {
    try {
      return await firstValueFrom(
        this.quizService.getQuestionByIndex(index).pipe(
          catchError(() => {
            return of(null);
          })
        )
      );
    } catch (error: any) {
      console.error('QuizNavigationService.tryResolveQuestion question resolution failed:', error);
      return null;
    }
  }

  private resetExplanationAndState(): void {
    // Immediately reset explanation-related state to avoid stale data
    this.explanationTextService.resetExplanationState();
    this.quizStateService.setDisplayState({
      mode: 'question',
      answered: false
    });

    // Clear the old Q&A state before starting navigation
    this.quizQuestionLoaderService.clearQA();
  }

  public notifyNavigationSuccess(): void {
    this.navigationSuccessSubject.next();
  }

  private readQuizIdFromRouterSnapshot(): string | null {
    const direct = this.activatedRoute.snapshot.paramMap.get('quizId');
    if (direct) return direct;

    let snapshot: ActivatedRouteSnapshot | null =
      this.router.routerState.snapshot.root;
    while (snapshot) {
      const value = snapshot.paramMap?.get('quizId');
      if (value) return value;
      snapshot = snapshot.firstChild ?? null;
    }

    return null;
  }

  private readQuestionIndexFromRouterSnapshot(): number {
    const fromActiveRoute = this.activatedRoute.snapshot.paramMap.get('questionIndex');
    const parsedFromActiveRoute = Number.parseInt(fromActiveRoute ?? '', 10);
    if (Number.isFinite(parsedFromActiveRoute) && parsedFromActiveRoute > 0) {
      return parsedFromActiveRoute;
    }

    let snapshot: ActivatedRouteSnapshot | null =
      this.router.routerState.snapshot.root;
    while (snapshot) {
      const value = snapshot.paramMap?.get('questionIndex');
      const parsed = Number.parseInt(value ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
      snapshot = snapshot.firstChild ?? null;
    }

    // Last-resort fallback to service index (0-based -> 1-based)
    return (this.quizService.getCurrentQuestionIndex?.() ?? 0) + 1;
  }

  public resetRenderStateBeforeNavigation(targetIndex: number): void {
    // Shut down all explanation display state immediately
    this.explanationTextService.setShouldDisplayExplanation(false, {
      force: true
    });
    this.explanationTextService.setIsExplanationTextDisplayed(false);
    this.explanationTextService.closeAllGates();

    // Drop any lingering question text
    try {
      this.quizQuestionLoaderService?.questionToDisplaySig?.set('');
    } catch { }

    // Reset to question mode so next frame starts clean
    this.quizStateService.setDisplayState({
      mode: 'question',
      answered: false
    });
    this.quizStateService.setExplanationReady(false);

    // SYNC qText DOM write + post-nav lock: stamp the target question's
    // text directly into <h3 #qText> right now AND install a short-lived
    // MutationObserver that reverts any FET-looking write back to q-txt
    // for the next ~1200ms. Multiple async writers (timer-expiry
    // setTimeout cascades, visibility-restore replays, soc FET stamps)
    // race after a Next click and re-write the prior question's FET.
    // The lock resolves the race deterministically.
    try {
      const h3 = document.querySelector('codelab-quiz-content h3') as HTMLElement | null;
      if (h3) {
        const qs = this.quizService;
        const isShuffled = qs.isShuffleEnabled?.() && Array.isArray(qs.shuffledQuestions) && qs.shuffledQuestions.length > 0;
        const targetQ = isShuffled
          ? qs.shuffledQuestions?.[targetIndex]
          : qs.questions?.[targetIndex];
        const rawQText = (targetQ?.questionText ?? '').trim();

        // Build target HTML with multi-answer banner if applicable, so
        // the lock matches the canonical display HTML — otherwise blank-
        // reverts strip the banner and other writers re-add it, causing
        // banner flicker on Q(N) -> Q(N+1) transitions.
        let targetQText = rawQText;
        try {
          const qNormText = norm(rawQText);
          let numCorrect = 0;
          let totalOpts = (targetQ?.options ?? []).length;
          for (const quiz of ((qs as any)?.quizInitialState ?? []) as any[]) {
            for (const pq of quiz?.questions ?? []) {
              if (norm(pq?.questionText) !== qNormText) continue;
              const pOpts = pq?.options ?? [];
              numCorrect = pOpts.filter((o: any) => isOptionCorrect(o)).length;
              totalOpts = pOpts.length;
              break;
            }
            if (numCorrect > 0) break;
          }
          if (numCorrect === 0) {
            const sourceOpts = targetQ?.options ?? [];
            numCorrect = sourceOpts.filter((o: any) => isOptionCorrect(o)).length;
            totalOpts = sourceOpts.length;
          }
          if (numCorrect > 1 && totalOpts > 0) {
            const banner = this.quizQuestionManagerService.getNumberOfCorrectAnswersText(numCorrect, totalOpts);
            targetQText = `${rawQText} <span class="correct-count">${banner}</span>`;
          }
        } catch { }

        if (targetQText) {
          h3.innerHTML = targetQText;

          const w: any = window;
          if (w.__navLockObserver) {
            try { w.__navLockObserver.disconnect(); } catch { }
          }
          if (w.__navLockTimer) clearTimeout(w.__navLockTimer);

          const looksLikeFet = (s: string): boolean => {
            const lower = (s ?? '').toLowerCase();
            // "correct because" is the FET signature.
            // The multi-answer banner says "are correct" / "is correct"
            // without "because", so we must NOT match those — otherwise
            // the observer reverts banner writes back to bare q-txt.
            return lower.includes('correct because');
          };

          const targetHasBanner = targetQText !== rawQText;
          const enforce = (): void => {
            const now = (h3.innerHTML ?? '').trim();
            if (now === targetQText) return;
            if (!now) {
              h3.innerHTML = targetQText;
              return;
            }
            if (looksLikeFet(now) && !looksLikeFet(targetQText)) {
              h3.innerHTML = targetQText;
              return;
            }
            // Bare-question-text write when target has the banner —
            // restore the banner version so the user doesn't see the
            // count flicker in/out as different writers race.
            if (targetHasBanner && now === rawQText) h3.innerHTML = targetQText;
          };

          if (typeof MutationObserver !== 'undefined') {
            const observer = new MutationObserver(() => enforce());
            observer.observe(h3, { childList: true, characterData: true, subtree: true });
            w.__navLockObserver = observer;
            w.__navLockTimer = setTimeout(() => {
              try { observer.disconnect(); } catch { }
              w.__navLockObserver = null;
              w.__navLockTimer = null;
            }, NAV_LOCK_OBSERVER_DURATION_MS);
          }
        }
      }
    } catch (e) {
      console.error('QuizNavigationService.resetRenderStateBeforeNavigation DOM sync failed:', e);
    }
  }

  /**
   * Records elapsed time for the leaving question, stops the timer,
   * and navigates to results. Returns true if navigation was triggered.
   */
  recordElapsedAndGoToResults(currentQuestionIndex: number): void {
    const idx = this.quizService.getCurrentQuestionIndex?.() ?? currentQuestionIndex;
    const elapsed = this.timerService.elapsedTimeSig() ?? 0;
    if (idx != null && idx >= 0 && !this.timerService.elapsedTimes[idx] && elapsed > 0) {
      this.timerService.elapsedTimes[idx] = elapsed;
    }
    if (this.timerService.isTimerRunning) {
      this.timerService.stopTimer(() => {}, { force: true });
    }
    this.quizCompleted = true;
  }

  navigateToResults(): void {
    if (this.quizCompleted) return;

    // Ensure we have a robust quizId
    const targetQuizId = this.quizId 
      || this.resolveEffectiveQuizId() 
      || this.quizService.quizId;
    if (!targetQuizId) return;

    this.quizCompleted = true;

    // Use correct route path: /quiz/results/:quizId (not just results/)
    const routePath = `/quiz/results/${targetQuizId}`;

    this.router.navigateByUrl(routePath)
      .then((success) => {
        if (!success) {
          console.warn('Quiz navigation was cancelled:', {
            routePath,
            currentUrl: this.router.url
          });

          return;
        }
      })
      .catch((error) => {
        console.error('Quiz navigation failed:', {
          routePath,
          error
        });
      });
  }

  setIsNavigatingToPrevious(value: boolean): void {
    this.isNavigatingToPreviousSig.set(value);
  }

  getIsNavigatingToPrevious(): Observable<boolean> {
    return this.isNavigatingToPrevious$;
  }

  // Reset navigation state when switching quizzes
  resetForNewQuiz(): void {
    this.quizCompleted = false;
    this.isNavigating = false;
  }
}