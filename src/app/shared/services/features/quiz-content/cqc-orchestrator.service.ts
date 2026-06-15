﻿import { inject, Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ParamMap } from '@angular/router';
import {
  BehaviorSubject, combineLatest, firstValueFrom, forkJoin, Observable, of, Subject
} from 'rxjs';
import {
  catchError, distinctUntilChanged, filter, map, shareReplay, startWith,
  take, tap, withLatestFrom
} from 'rxjs/operators';

import {
  FET_WRITE_RETRY_CASCADE_MS,
  VISIBILITY_RESTORE_REPLAY_CASCADE_MS
} from '../../../constants/timing';
import { QuestionType } from '../../../models/question-type.enum';

import { CombinedQuestionDataType } from '../../../models/CombinedQuestionDataType.model';
import { Option } from '../../../models/Option.model';
import { QuestionPayload } from '../../../models/QuestionPayload.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { CqcDisplayTextService } from './cqc-display-text.service';
import { CqcFetGuardService } from './cqc-fet-guard.service';
import { CqcQuestionNavService } from './cqc-question-nav.service';
import { QuizDotStatusService } from '../../flow/quiz-dot-status.service';

import type { CodelabQuizContentComponent } from '../../../../containers/quiz/quiz-content/codelab-quiz-content.component';

type Host = CodelabQuizContentComponent;

/**
 * Orchestrates CodelabQuizContentComponent logic, extracted via the typed host pattern.
 */
@Injectable({ providedIn: 'root' })
export class CqcOrchestratorService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly fetGuard = inject(CqcFetGuardService);
  private readonly displayText = inject(CqcDisplayTextService);
  private readonly questionNav = inject(CqcQuestionNavService);
  private readonly dotStatusService = inject(QuizDotStatusService);

  async runOnInit(host: Host): Promise<void> {
    await this.runInitialSetup(host);
    this.setupFetSafetyNets(host);
    this.subscribeToTimerExpiryFetWrite(host);
  }

  /**
   * Initial setup: reset state (preserving F5-restored interaction evidence),
   * wire the reset/explanation/FET/display-text pipelines, load quiz data, and
   * await component init. Extracted verbatim from runOnInit's head.
   */
  private async runInitialSetup(host: Host): Promise<void> {
    host.resetInitialState();

    // Preserve sessionStorage-restored interaction state across F5 refresh.
    // `_hasUserInteracted` is restored by quizStateService.restoreInteractionState()
    // when performance.navigation.type === 'reload' — wiping it here would undo
    // that and break FET display after refresh.
    let isPageRefresh = false;
    try {
      const navEntries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      isPageRefresh = navEntries.length > 0 && navEntries[0].type === 'reload';
    } catch { /* ignore */ }
    if (!isPageRefresh) host.quizStateService._hasUserInteracted?.clear();

    host.quizStateService.resetInteraction();

    host.setupQuestionResetSubscription();
    host.resetExplanationService();

    host.setupShouldShowFet();
    host.setupFetToDisplay();

    host.initDisplayTextPipeline();
    host.subscribeToDisplayText();
    host.setupContentAvailability();

    host.emitContentAvailableState();
    host.loadQuizDataFromRoute();
    await host.initializeComponent();

    host.quizService.questions$
      .pipe(
        takeUntilDestroyed(host.destroyRef),
        filter((qs: any) => Array.isArray(qs) && qs.length > 0)
      )
      .subscribe(() => {});
  }

  /**
   * Wire the FET-display safety nets: the intended-qText/forceStamp delegates
   * (kept as closures so host._cqcComputeIntendedQText + the callers below stay
   * intact), the qText MutationObserver, and the visibility-replay handler.
   */
  private setupFetSafetyNets(host: Host): void {
    const computeIntendedQText = (): string => this.computeIntendedQText(host);
    host._cqcComputeIntendedQText = computeIntendedQText;
    const forceStampIfBlank = (_reason: string): void => this.forceStampIfBlank(host);

    this.setupQTextObserver(host, computeIntendedQText);
    this.setupVisibilityReplayHandler(host, forceStampIfBlank);
  }

  /**
   * Persistent MutationObserver safety net. The SCSS rule `h3:empty { display:
   * none }` means any transient blank collapses the heading; some restore paths
   * clear qText without routing through a controlled path. Watch qText and,
   * after an 80ms debounce, restore the intended HTML if it's still empty.
   * Extracted verbatim from runOnInit.
   */
  private setupQTextObserver(host: Host, computeIntendedQText: () => string): void {
    try {
      const el = host.qText?.()?.nativeElement;
      if (el && typeof MutationObserver !== 'undefined') {
        if (host._qTextObserver) {
          try { host._qTextObserver.disconnect(); } catch { /* ignore */ }
          host._qTextObserver = null;
        }
        let debounceTimer: any = null;
        const observer = new MutationObserver(() => {
          const innerNow = (el.innerHTML ?? '').trim();
          if (innerNow) return;
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            const innerLater = (el.innerHTML ?? '').trim();
            if (innerLater) return;
            // Always recompute via computeIntendedQText (which reads the
            // live index from the input signal). Using the cached
            // _lastDisplayedText was unsafe across navigation: after Next
            // from Q(N), if qText briefly emptied, this branch would
            // restore Q(N)'s FET — exactly the FET->q-txt flash bug.
            const restore = computeIntendedQText();
            if (restore) this.fetGuard.writeQText(host, restore);
          }, 80);
        });
        observer.observe(el, { childList: true, characterData: true, subtree: true });
        host._qTextObserver = observer;
      }
    } catch { /* ignore */ }
  }

  /**
   * Register the visibilitychange handler that replays forceStampIfBlank at a
   * cascade of delays to win races with the QQC visibility-restore flow.
   * Extracted verbatim from runOnInit.
   */
  private setupVisibilityReplayHandler(host: Host, forceStampIfBlank: (reason: string) => void): void {
    host._cqcVisibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      // Replay at several points to win races with the QQC visibility-restore
      // flow (which runs async with ~350ms + 400ms setTimeouts and may
      // overwrite or clear the qText DOM).
      forceStampIfBlank('visibility:0');
      for (const delay of VISIBILITY_RESTORE_REPLAY_CASCADE_MS) {
        setTimeout(() => forceStampIfBlank('visibility:' + delay), delay);
      }
    };
    document.addEventListener('visibilitychange', host._cqcVisibilityHandler);
  }

  /**
   * On timer expiry, resolve the LIVE question index (signal-first to avoid
   * stale Q(N) leaking into Q(N+1)), store the formatted explanation, and write
   * the FET directly to the qText DOM (bypassing the service/guard layers) with
   * navigation-guarded delayed retries. Extracted verbatim from runOnInit; this
   * is FET-display pipeline code — keep it byte-for-byte.
   */
  private subscribeToTimerExpiryFetWrite(host: Host): void {
    host.timerService.expired$
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe(() => this.handleTimerExpiry(host));
  }

  /**
   * Timer-expiry handler: resolve the LIVE question index (signal-first to avoid
   * stale Q(N) leaking into Q(N+1)), mark it timed out, store the formatted
   * explanation, write the FET to the DOM, and markForCheck. Extracted verbatim.
   */
  private handleTimerExpiry(host: Host): void {
    // Use signal-first idx resolution. host.currentIndex is a plain field
    // updated asynchronously by an effect, so it lags the signal by a
    // microtask. Reading it first prevents stale Q(N) timer expiry from
    // writing Q(N)'s FET into Q(N+1)'s heading after navigation.
    const sigIdx = host.questionIndex?.();
    const idx = (typeof sigIdx === 'number' && sigIdx >= 0)
      ? sigIdx
      : (host.currentIndex >= 0
          ? host.currentIndex
          : (host.quizService.getCurrentQuestionIndex?.() ?? host.currentQuestionIndexValue ?? 0));

    host.timedOutIdxSig.set(idx);
    host.timedOutIdxSubject.next(idx);
    // DURABLE timeout record (same idx as timedOutIdxSubject) — survives nav so
    // the heading re-asserts the FET on revisit for any timed-out question.
    this.dotStatusService.timedOutFetForced.add(idx);
    (window as any).__quizTimerExpired = true;

    const isShuffled = host.quizService.isShuffleEnabled?.() && Array.isArray(host.quizService.shuffledQuestions) && host.quizService.shuffledQuestions.length > 0;
    let q = isShuffled
      ? host.quizService.shuffledQuestions[idx]
      : host.quizService.questions?.[idx];

    q = q ?? null;
    if (q?.explanation) {
      const visualOpts = host.quizQuestionComponent?.()?.optionsToDisplay ?? q.options;
      host.explanationTextService.storeFormattedExplanation(idx, q.explanation, q, visualOpts);
    }

    this.writeTimerExpiryFetToDom(host, q, idx);

    host.cdRef.markForCheck();
  }

  /**
   * DIRECT DOM FET write on timer expiry — bypasses all service/guard layers.
   * Formats the FET (or falls back to the raw explanation) and writes it to the
   * qText element now plus on a retry cascade, each write guarded against the
   * user having navigated away (live index must still match). Extracted verbatim.
   */
  private writeTimerExpiryFetToDom(host: Host, q: any, idx: number): void {
    try {
      const el = host.qText?.()?.nativeElement;
      if (el && q) {
        const opts = q.options ?? host.quizQuestionComponent?.()?.optionsToDisplay ?? [];
        const correctIndices = host.explanationTextService.getCorrectOptionIndices(q, opts, idx);
        let fetHtml = '';
        if (correctIndices.length > 0) {
          fetHtml = host.explanationTextService.formatExplanation(q, correctIndices, q.explanation);
        }
        if (!fetHtml) fetHtml = q.explanation || '';
        if (fetHtml) {
          // Guard the delayed writes against the user navigating away
          // before they fire. Read from the input signal directly —
          // host.currentIndex is a plain field updated asynchronously
          // by an effect, so it lags the signal by a microtask and
          // would let stale Q(N) writes leak into Q(N+1).
          const expectedIdx = idx;
          const write = () => {
            const liveIdx = host.questionIndex?.() ?? host.currentIndex ?? 0;
            if (liveIdx !== expectedIdx) return;
            el.innerHTML = fetHtml;
            host.qTextHtmlSig?.set(fetHtml);
            host._lastDisplayedText = fetHtml;
            host._fetLockedForIndex = idx;
          };
          write();
          for (const delay of FET_WRITE_RETRY_CASCADE_MS) setTimeout(write, delay);
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * Build the intended qText HTML for the LIVE question index (signal-first, so
   * replays compute for the current question, never the prior one): prefer a
   * validated cached FET, else compute on-the-fly (FET if resolved, else the
   * question text), with fallbacks to the builder / last-displayed / raw
   * question text. Extracted verbatim from runOnInit's closure — FET-display
   * pipeline, keep byte-for-byte.
   */
  private computeIntendedQText(host: Host): string {
    // Read from the input signal — host.currentIndex lags by a microtask
    // because it's a plain field updated by an effect. Using the signal
    // means the MutationObserver and visibility-restore replays compute
    // the intended HTML for the LIVE question, never the prior one.
    const sigIdx = host.questionIndex?.();
    const idx = (typeof sigIdx === 'number' && sigIdx >= 0)
      ? sigIdx
      : (host.currentIndex >= 0
        ? host.currentIndex
        : (host.quizService.getCurrentQuestionIndex?.() ?? 0));

    // MULTI-ANSWER heading rule: show the question text + "(N answers are
    // correct)" banner UNLESS the question was answered correctly (all correct
    // selected). Only an all-correct multi-answer falls through to the FET;
    // incorrect / in-progress / expired-without-getting-it-right keep the
    // banner. buildQuestionDisplayHTML emits the `correct-count` banner only
    // for multi-answer, so single-answer is untouched (FET-in-heading below).
    // A question whose timer expired shows its FET on (re)display — including on
    // tab-return via forceStampIfBlank — regardless of completion or interaction.
    // Mirrors heading-model (isTimedOut -> FET). timedOutFetForced is durable
    // (survives navigate-away/back and tab hide/show). Single- and multi-answer.
    const timedOut = this.dotStatusService?.timedOutFetForced?.has(idx) === true;

    const banneredQ = this.fetGuard.buildQuestionDisplayHTML(host, idx);
    if (banneredQ && banneredQ.includes('correct-count')) {
      const answeredCorrectly = host.quizService?._multiAnswerPerfect?.get?.(idx) === true;
      if (!answeredCorrectly && !timedOut) {
        return banneredQ;
      }
    }

    let intended = '';
    if (timedOut || this.fetGuard.hasInteractionEvidence(host, idx)) {
      intended = this.resolveCachedFet(host, idx);
      // No (valid) cached FET — try on-the-fly if quiz data is available.
      if (!intended) intended = this.computeOnTheFlyFet(host, idx);
    }
    if (!intended) {
      intended = this.fetGuard.buildQuestionDisplayHTML(host, idx);
    }
    if (!intended) {
      intended = (host._lastDisplayedText ?? '').trim();
    }
    if (!intended) {
      try {
        const q = host.quizService.questions?.[idx];
        intended = (q?.questionText ?? '').trim();
      } catch {}
    }
    return intended;
  }

  /**
   * Resolve the cached FET for idx (only when the question is resolved in
   * storage), then validate it against the LIVE display-order question's raw
   * explanation — a shuffle mismatch (cache from a different question at this
   * numeric index) is treated as stale and returns ''. Extracted verbatim.
   */
  private resolveCachedFet(host: Host, idx: number): string {
    // Check FET caches first — but only if the question is resolved.
    // For multi-answer questions, the cache may have been populated by
    // an upstream path before all correct answers were selected.
    const isResolvedForCache = this.isResolvedOrConfirmed(host, idx);
    let cachedFet = isResolvedForCache
      ? ((host.explanationTextService.formattedExplanations?.[idx]?.explanation ?? '').trim()
        || (host.explanationTextService.fetByIndex?.get(idx) ?? '').trim())
      : '';
    if (cachedFet) {
      try {
        const displayQs = host.quizService.getQuestionsInDisplayOrder?.()
          ?? host.quizService.questions;
        const liveQ = displayQs?.[idx];
        const liveExpl = (liveQ?.explanation ?? '').toString().trim();
        if (liveExpl) {
          const cachedLower = cachedFet.toLowerCase();
          const liveLower = liveExpl.toLowerCase();
          // Cached FET should include the live explanation as substring.
          // If not, it's a stale cache from a different question at this
          // index (likely a shuffle mismatch).
          if (cachedLower.indexOf(liveLower) === -1) {
            cachedFet = '';
          }
        }
      } catch { /* ignore */ }
    }
    return cachedFet;
  }

  /**
   * Compute the FET on-the-fly from live quiz data: when the question is
   * resolved, format the explanation from its correct indices; when unresolved
   * (partial multi-answer), return the question display HTML. Returns '' when
   * no quiz data / no FET resolved (caller falls through to its fallbacks).
   * Extracted verbatim.
   */
  /**
   * Resolved for FET purposes: storage-resolved OR SOC-confirmed all-correct.
   * isQuestionResolvedFromStorage misses an all-correct multi-answer in shuffle
   * (the storage record is keyed/derived differently), which made the FET fall
   * back to question text even though _multiAnswerPerfect/fetBypass were set on
   * completion. Honor those authoritative completion signals so a fully-answered
   * multi-answer actually shows its FET.
   */
  private isResolvedOrConfirmed(host: Host, idx: number): boolean {
    if (this.fetGuard.isQuestionResolvedFromStorage(host, idx)) return true;
    if (host.quizService?._multiAnswerPerfect?.get?.(idx) === true) return true;
    if (host.explanationTextService?.fetBypassForQuestion?.get?.(idx) === true) return true;
    if (this.dotStatusService?.timedOutFetForced?.has(idx) === true) return true;
    return false;
  }

  private computeOnTheFlyFet(host: Host, idx: number): string {
    try {
      const questions = host.quizService.getQuestionsInDisplayOrder?.()
        ?? host.quizService.questions;
      const q = questions?.[idx];
      if (q?.explanation && q?.options?.length > 0) {
        // Check resolution to decide FET vs question text
        const isResolved = this.isResolvedOrConfirmed(host, idx);
        if (isResolved) {
          const correctIndices = host.explanationTextService.getCorrectOptionIndices(q, q.options, idx);
          if (correctIndices.length > 0) {
            return host.explanationTextService.formatExplanation(q, correctIndices, q.explanation);
          }
        } else {
          // Unresolved (partial multi-answer) — show question text
          return this.fetGuard.buildQuestionDisplayHTML(host, idx);
        }
      }
    } catch { /* ignore */ }
    return '';
  }

  /**
   * If the qText heading is blank (or differs from the intended HTML), restamp
   * it via the FET guard — unless the current content has the multi-answer
   * banner and the intended doesn't (preserve the nav-lock banner). Extracted
   * verbatim from runOnInit's closure.
   */
  private forceStampIfBlank(host: Host): void {
    const el = host.qText?.()?.nativeElement;
    if (!el) return;
    const current = (el.innerHTML ?? '').trim();
    const intended = this.computeIntendedQText(host);
    if (!intended) return;
    if (!current || current !== intended) {
      // If the h3 already has the multi-answer banner but the computed
      // intended text does not, preserve the current content — the banner
      // was correctly set by the navigation lock and should not be stripped.
      if (current && current.includes('correct-count') && !intended.includes('correct-count')) {
        return;
      }
      this.fetGuard.writeQText(host, intended);
    }
  }

  runOnDestroy(host: Host): void {
    if (host._cqcVisibilityHandler) {
      document.removeEventListener('visibilitychange', host._cqcVisibilityHandler);
      host._cqcVisibilityHandler = undefined;
    }
    if (host._qTextObserver) {
      try { host._qTextObserver.disconnect(); } catch { /* ignore */ }
      host._qTextObserver = null;
    }
    if (Array.isArray(host._questionStampRetryTimers)) {
      for (const t of host._questionStampRetryTimers) clearTimeout(t);
      host._questionStampRetryTimers = [];
    }
    this.fetGuard.uninstallFetWatchdog(host);
    host.combinedSub?.unsubscribe();
  }

  runInstallFetWatchdog(host: Host): void {
    this.fetGuard.installFetWatchdog(host);
  }

  runQuestionIndexSet(host: Host, idx: number): void {
    this.questionNav.runQuestionIndexSet(host, idx);
  }

  runSetupQuestionResetSubscription(host: Host): void {
    const q$ = host.questionToDisplay$();
    if (!q$) return;
    combineLatest([
      q$.pipe(startWith(''), distinctUntilChanged()),
      host.quizService.currentQuestionIndex$.pipe(
        startWith(host.quizService?.currentQuestionIndex ?? 0)
      )
    ])
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe((pair: any) => {
        const index: number = pair[1];
        if (host.lastQuestionIndexForReset !== index) {
          host.explanationTextService.setShouldDisplayExplanation(false);
          host.lastQuestionIndexForReset = index;

          host.quizService.isAnswered(index).pipe(take(1))
            .subscribe((isAnswered: boolean) => {
              if (!isAnswered) {
                host.quizStateService.setDisplayState({ mode: 'question', answered: false });
                host.explanationTextService.setIsExplanationTextDisplayed(false, { force: true });
              }
            });
        }
      });
  }

  runSubscribeToDisplayText(host: Host): void {
    this.displayText.runSubscribeToDisplayText(host);
  }

  runSetupContentAvailability(host: Host): void {
    host.isContentAvailable$ = host.combineCurrentQuestionAndOptions().pipe(
      map(({ currentQuestion, currentOptions }: { currentQuestion: QuizQuestion | null; currentOptions: Option[] }) => {
        return !!currentQuestion && currentOptions.length > 0;
      }),
      distinctUntilChanged(),
      catchError((_error: Error) => {
        return of(false);
      }),
      startWith(false)
    );

    host.isContentAvailable$
      .pipe(distinctUntilChanged())
      .subscribe(() => {});
  }

  runEmitContentAvailableState(host: Host): void {
    host.isContentAvailable$.pipe(takeUntilDestroyed(host.destroyRef)).subscribe({
      next: (isAvailable: boolean) => {
        host.isContentAvailableChange.emit(isAvailable);
        host.quizDataService.updateContentAvailableState(isAvailable);
      },
      error: () => { }
    });
  }

  runLoadQuizDataFromRoute(host: Host): void {
    this.questionNav.runLoadQuizDataFromRoute(host);
  }

  async runLoadQuestion(host: Host, quizId: string, zeroBasedIndex: number): Promise<void> {
    return this.questionNav.runLoadQuestion(host, quizId, zeroBasedIndex);
  }

  async runInitializeQuestionData(host: Host): Promise<void> {
    try {
      const params: ParamMap = await firstValueFrom(
        host.activatedRoute.paramMap.pipe(take(1))
      );

      const data: [QuizQuestion[], string[]] = await firstValueFrom(
        host.fetchQuestionsAndExplanationTexts(params).pipe(
          takeUntilDestroyed(host.destroyRef)
        )
      );

      const [questions, explanationTexts] = data;
      if (!questions || questions.length === 0) return;  // no questions found

      host.explanationTexts = explanationTexts;

      host.quizService.questions = questions;
      if (host.quizService.questions$ instanceof BehaviorSubject || 
        host.quizService.questions$ instanceof Subject
      ) {
        (host.quizService.questions$ as unknown as Subject<QuizQuestion[]>).next(questions);
      }

      for (const [index] of questions.entries()) {
        const explanation = host.explanationTexts[index] ?? 'No explanation available';
        host.explanationTextService.setExplanationTextForQuestionIndex(index, explanation);
      }

      host.explanationTextService.explanationsInitialized = true;

      host.initializeCurrentQuestionIndex();
    } catch {
    }
  }

  runFetchQuestionsAndExplanationTexts(host: Host, params: ParamMap): Observable<[QuizQuestion[], string[]]> {
    host.setQuizId(params.get('quizId') ?? '');
    const qid = host.quizId();
    if (!qid) {
      return of([[], []] as [QuizQuestion[], string[]]);  // no quizId provided
    }

    return forkJoin([
      host.quizDataService.getQuestionsForQuiz(qid).pipe(
        catchError((_error: Error) => {
          return of([] as QuizQuestion[]);
        })
      ),
      host.quizDataService.getAllExplanationTextsForQuiz(qid).pipe(
        catchError((_error: Error) => {
          return of([] as string[]);
        })
      )
    ]).pipe(
      map((results: any) => {
        const [questions, explanationTexts] = results;
        return [questions as QuizQuestion[], explanationTexts as string[]];
      })
    );
  }

  runUpdateCorrectAnswersDisplay(host: Host, question: QuizQuestion | null): Observable<void> {
    if (!question) return of(void 0);

    return host.quizQuestionManagerService
      .isMultipleAnswerQuestion(question)
      .pipe(
        tap((isMultipleAnswer: boolean) => {
          const correctAnswers = question.options.filter((option) => option.correct).length;
          const explanationDisplayed = host.explanationTextService.isExplanationTextDisplayedSig();
          const newCorrectAnswersText =
            isMultipleAnswer && !explanationDisplayed
              ? host.quizQuestionManagerService.getNumberOfCorrectAnswersText(
                correctAnswers,
                question.options?.length ?? 0
              )
              : '';

          if (host.correctAnswersTextSig() !== newCorrectAnswersText) {
            host.correctAnswersTextSig.set(newCorrectAnswersText);
          }
        }),
        map(() => void 0)
      );
  }

  runInitializeCombinedQuestionData(host: Host): void {
    const currentQuizAndOptions$ = host.combineCurrentQuestionAndOptions();

    currentQuizAndOptions$.pipe(takeUntilDestroyed(host.destroyRef)).subscribe({
      next: () => {},
      error: () => { }
    });

    host.setCombinedQuestionData$(combineLatest([
      currentQuizAndOptions$.pipe(
        startWith<{
          currentQuestion: QuizQuestion | null;
          currentOptions: Option[];
          explanation: string;
          currentIndex: number;
        } | null>(null)
      ),
      host.numberOfCorrectAnswers$.pipe(startWith(0)),
      host.isExplanationTextDisplayed$.pipe(startWith(false)),
      host.activeFetText$.pipe(startWith(''))
    ]).pipe(
      map((arr: any): CombinedQuestionDataType => this.mapToCombinedQuestionData(host, arr)),
      filter((data: CombinedQuestionDataType | null): data is CombinedQuestionDataType => data !== null),
      catchError((_error: Error) => of<CombinedQuestionDataType>(this.buildCombinedQuestionDataFallback())),
    ));
  }

  /** Project the combineLatest tuple into combined question data. Extracted verbatim. */
  private mapToCombinedQuestionData(host: Host, arr: any): CombinedQuestionDataType {
    const quiz: { currentQuestion: QuizQuestion | null; currentOptions: Option[]; explanation: string; currentIndex: number; } | null = arr[0];
    const numberOfCorrectAnswers: number | string = arr[1];
    const isExplanationDisplayed: boolean = arr[2];
    const formattedExplanation: string = arr[3];
    const safeQuizData = quiz?.currentQuestion
      ? quiz
      : { currentQuestion: null, currentOptions: [], explanation: '', currentIndex: 0 };

    const currentQuizData = this.buildCurrentQuizData(safeQuizData, !!isExplanationDisplayed);

    return host.calculateCombinedQuestionData(
      currentQuizData,
      +(numberOfCorrectAnswers ?? 0),
      !!isExplanationDisplayed,
      formattedExplanation ?? ''
    );
  }

  /** Build the pre-calculation combined-question-data shape from the safe quiz data. */
  private buildCurrentQuizData(safeQuizData: any, isExplanationDisplayed: boolean): CombinedQuestionDataType {
    const selectionMessage =
      'selectionMessage' in safeQuizData
        ? (safeQuizData as any).selectionMessage || ''
        : '';
    return {
      currentQuestion: safeQuizData.currentQuestion,
      currentOptions: safeQuizData.currentOptions ?? [],
      options: safeQuizData.currentOptions ?? [],
      questionText: safeQuizData.currentQuestion?.questionText || 'No question available',
      explanation: safeQuizData.explanation ?? '',
      correctAnswersText: '',
      isExplanationDisplayed,
      isNavigatingToPrevious: false,
      selectionMessage
    };
  }

  /** The error fallback for the combined-question-data stream. Extracted verbatim. */
  private buildCombinedQuestionDataFallback(): CombinedQuestionDataType {
    return {
      currentQuestion: {
        questionText: 'Error loading question',
        options: [],
        explanation: '',
        selectedOptions: [],
        answer: [],
        selectedOptionIds: [],
        type: undefined as any,
        maxSelections: 0
      },
      currentOptions: [],
      options: [],
      questionText: 'Error loading question',
      explanation: '',
      correctAnswersText: '',
      isExplanationDisplayed: false,
      isNavigatingToPrevious: false,
      selectionMessage: ''
    };
  }

  runCombineCurrentQuestionAndOptions(host: Host): Observable<{
    currentQuestion: QuizQuestion | null;
    currentOptions: Option[];
    explanation: string;
    currentIndex: number;
  }> {
    return host.quizService.questionPayload$.pipe(
      withLatestFrom(host.quizService.currentQuestionIndex$),
      filter(
        (value: [QuestionPayload | null, number]): value is [QuestionPayload, number] => {
          const [payload] = value;
          return (
            !!payload &&
            !!payload.question &&
            Array.isArray(payload.options) &&
            payload.options.length > 0
          );
        }
      ),
      map(([payload, index]: [QuestionPayload, number]) => ({
        payload,
        index: Number.isFinite(index)
          ? index
          : host.currentIndex >= 0
            ? host.currentIndex
            : 0
      })),
      map(({ payload, index }: { payload: QuestionPayload; index: number }) => {
        const normalizedOptions = payload.options
          .map((option, optionIndex) => ({
            ...option,
            optionId: typeof option.optionId === 'number' ? option.optionId : optionIndex + 1,
            displayOrder: typeof option.displayOrder === 'number' ? option.displayOrder : optionIndex
          }))
          .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));

        const normalizedQuestion: QuizQuestion = {
          ...payload.question,
          options: normalizedOptions
        };

        return {
          currentQuestion: normalizedQuestion,
          currentOptions: normalizedOptions,
          explanation:
            payload.explanation?.trim() ||
            payload.question.explanation?.trim() ||
            '',
          currentIndex: index
        };
      }),
      distinctUntilChanged(
        (prev: { currentQuestion: QuizQuestion; currentOptions: Option[]; explanation: string; currentIndex: number },
          curr: { currentQuestion: QuizQuestion; currentOptions: Option[]; explanation: string; currentIndex: number }) => {
          const norm = (s?: string) =>
            (s ?? '')
              .replace(/<[^>]*>/g, ' ')
              .replace(/&nbsp;/g, ' ')
              .trim()
              .toLowerCase()
              .replace(/\s+/g, ' ');

          const questionKey = (q: QuizQuestion | null | undefined, idx?: number) => {
            const textKey = norm(q?.questionText);
            return `${textKey}#${Number.isFinite(idx) ? idx : -1}`;
          };

          const sameQuestion =
            questionKey(prev.currentQuestion, prev.currentIndex) ===
            questionKey(curr.currentQuestion, curr.currentIndex);
          if (!sameQuestion) return false;

          if (prev.explanation !== curr.explanation) return false;

          return host.haveSameOptionOrder(prev.currentOptions, curr.currentOptions);
        }),
      shareReplay({ bufferSize: 1, refCount: true }),
      catchError((_error: Error) => {
        return of({
          currentQuestion: null,
          currentOptions: [],
          explanation: '',
          currentIndex: -1
        });
      })
    );
  }

  /** The "no question available" combined-question-data shape. Extracted verbatim. */
  private emptyCombinedQuestionData(): CombinedQuestionDataType {
    return {
      currentQuestion: null,
      currentOptions: [],
      options: [],
      questionText: 'No question available',
      explanation: '',
      correctAnswersText: '',
      isExplanationDisplayed: false,
      isNavigatingToPrevious: false,
      selectionMessage: ''
    };
  }

  runCalculateCombinedQuestionData(
    host: Host,
    currentQuizData: CombinedQuestionDataType,
    numberOfCorrectAnswers: number,
    isExplanationDisplayed: boolean,
    formattedExplanation: string
  ): CombinedQuestionDataType {
    const { currentQuestion, currentOptions } = currentQuizData;

    if (!currentQuestion) {
      return this.emptyCombinedQuestionData();
    }

    const normalizedCorrectCount = Number.isFinite(numberOfCorrectAnswers) ? numberOfCorrectAnswers : 0;

    const totalOptions = Array.isArray(currentOptions)
      ? currentOptions.length
      : Array.isArray(currentQuestion?.options)
        ? currentQuestion.options.length : 0;

    const isMultipleAnswerQuestion =
      currentQuestion.type === QuestionType.MultipleAnswer ||
      (Array.isArray(currentQuestion.options)
        ? currentQuestion.options.filter((option) => option.correct).length > 1
        : false);

    const correctAnswersText =
      isMultipleAnswerQuestion && normalizedCorrectCount > 0
        ? host.quizQuestionManagerService.getNumberOfCorrectAnswersText(
          normalizedCorrectCount, totalOptions
        )
        : '';

    const explanationText = isExplanationDisplayed
      ? formattedExplanation?.trim() || currentQuizData.explanation || currentQuestion.explanation || ''
      : '';

    return {
      currentQuestion: currentQuestion,
      currentOptions: currentOptions,
      options: currentOptions ?? [],
      questionText: currentQuestion.questionText,
      explanation: explanationText,
      correctAnswersText,
      isExplanationDisplayed: isExplanationDisplayed,
      isNavigatingToPrevious: false,
      selectionMessage: ''
    };
  }

  runHaveSameOptionOrder(_host: Host, left: Option[] = [], right: Option[] = []): boolean {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;

    return left.every((option, index) => {
      const other = right[index];
      if (!other) return false;
      const optionText = (option.text ?? '').toString();
      const otherText = (other.text ?? '').toString();
      return (
        option.optionId === other.optionId &&
        option.displayOrder === other.displayOrder &&
        optionText === otherText
      );
    });
  }

  runNormalizeKeySource(_host: Host, value: string | null | undefined): string {
    return (value ?? '')
      .toString()
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }
}