import { Injectable, Optional } from '@angular/core';
import { SelectionMessageService } from '../selection-message/selection-message.service';
import { ParamMap } from '@angular/router';
import {
  BehaviorSubject, combineLatest, firstValueFrom, forkJoin, Observable, of, Subject
} from 'rxjs';
import {
  catchError, distinctUntilChanged, filter, map, shareReplay, startWith, 
  switchMap, take, takeUntil, tap, withLatestFrom
} from 'rxjs/operators';

import { CombinedQuestionDataType } from '../../../models/CombinedQuestionDataType.model';
import { Option } from '../../../models/Option.model';
import { QuestionType } from '../../../models/question-type.enum';
import { QuestionPayload } from '../../../models/QuestionPayload.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { CqcFetGuardService } from './cqc-fet-guard.service';
import { CqcDisplayTextService } from './cqc-display-text.service';
import { CqcQuestionNavService } from './cqc-question-nav.service';

type Host = any;

/**
 * Orchestrates CodelabQuizContentComponent logic, extracted via host: any pattern.
 */
@Injectable({ providedIn: 'root' })
export class CqcOrchestratorService {
  constructor(
    private fetGuard: CqcFetGuardService,
    private displayText: CqcDisplayTextService,
    private questionNav: CqcQuestionNavService,
    @Optional() private selectionMessageService?: SelectionMessageService
  ) {}

  async runOnInit(host: Host): Promise<void> {
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
    host.setupCorrectAnswersTextDisplay();

    host.quizService.questions$
      .pipe(
        takeUntil(host.destroy$),
        filter((qs: any) => Array.isArray(qs) && qs.length > 0)
      )
      .subscribe(() => {});

    // Build the intended qText HTML for the current index. Centralised so
    // the visibility handler, replay retries, and the MutationObserver
    // safety net all derive the same value.
    const computeIntendedQText = (): string => {
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
      let intended = '';
      const hasInteracted = this.fetGuard.hasInteractionEvidence(host, idx);
      if (hasInteracted) {
        // Check FET caches first — but only if the question is resolved.
        // For multi-answer questions, the cache may have been populated by
        // an upstream path before all correct answers were selected.
        const isResolvedForCache = this.fetGuard.isQuestionResolvedFromStorage(host, idx);
        const cachedFet = isResolvedForCache
          ? ((host.explanationTextService.formattedExplanations?.[idx]?.explanation ?? '').trim()
            || ((host.explanationTextService as any).fetByIndex?.get(idx) ?? '').trim())
          : '';
        if (cachedFet) intended = cachedFet;
        
        // No cached FET — try on-the-fly if quiz data is available
        if (!intended) {
          try {
            const questions = host.quizService.getQuestionsInDisplayOrder?.()
              ?? host.quizService.questions;
            const q = questions?.[idx];
            if (q?.explanation && q?.options?.length > 0) {
              // Check resolution to decide FET vs question text
              const isResolved = this.fetGuard.isQuestionResolvedFromStorage(host, idx);
              if (isResolved) {
                const correctIndices = host.explanationTextService.getCorrectOptionIndices(q, q.options, idx);
                if (correctIndices.length > 0) {
                  intended = host.explanationTextService.formatExplanation(q, correctIndices, q.explanation);
                }
              } else {
                // Unresolved (partial multi-answer) — show question text
                intended = this.fetGuard.buildQuestionDisplayHTML(host, idx);
              }
            }
          } catch { /* ignore */ }
          // If no FET was resolved, fall through to question text below
          // instead of returning '' — that would leave the heading blank.
        }
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
    };
    host._cqcComputeIntendedQText = computeIntendedQText;

    const forceStampIfBlank = (reason: string): void => {
      const el = host.qText?.()?.nativeElement;
      if (!el) return;
      const current = (el.innerHTML ?? '').trim();
      const intended = computeIntendedQText();
      if (!intended) return;
      if (!current || current !== intended) {
        this.fetGuard.writeQText(host, intended);
      }
    };

    // Persistent MutationObserver safety net. The SCSS rule
    // `h3:empty { display: none }` means any transient blank collapses
    // the heading, and some restore paths (tab visibility, async
    // emissions) clear qText without routing through a path we control.
    // Watch qText forever and debounced-restore when it goes empty:
    //   - 80ms debounce lets intentional navigation blanks (runQuestionIndexSet)
    //     be overwritten by stampQuestionTextNow's own retry array before
    //     we try to intervene.
    //   - If it's STILL empty after the debounce, restore `_lastDisplayedText`
    //     (or recompute via the builder) so the user never sees a collapsed heading.
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

    host._cqcVisibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      // Replay at several points to win races with the QQC visibility-restore
      // flow (which runs async with ~350ms + 400ms setTimeouts and may
      // overwrite or clear the qText DOM).
      forceStampIfBlank('visibility:0');
      setTimeout(() => forceStampIfBlank('visibility:100'), 100);
      setTimeout(() => forceStampIfBlank('visibility:500'), 500);
      setTimeout(() => forceStampIfBlank('visibility:900'), 900);
      setTimeout(() => forceStampIfBlank('visibility:1200'), 1200);
      setTimeout(() => forceStampIfBlank('visibility:2000'), 2000);
    };
    document.addEventListener('visibilitychange', host._cqcVisibilityHandler);

    host.timerService.expired$
      .pipe(takeUntil(host.destroy$))
      .subscribe(() => {
        const idx = host.currentIndex >= 0 ? host.currentIndex : (host.quizService.getCurrentQuestionIndex?.() ?? host.currentQuestionIndexValue ?? 0);

        host.timedOutIdxSig.set(idx);
        host.timedOutIdxSubject.next(idx);
        (window as any).__quizTimerExpired = true;

        const isShuffled = host.quizService.isShuffleEnabled?.() && Array.isArray(host.quizService.shuffledQuestions) && host.quizService.shuffledQuestions.length > 0;
        let q = isShuffled
          ? host.quizService.shuffledQuestions[idx]
          : host.quizService.questions?.[idx];

        q = q ?? (host.quizService?.currentQuestion?.value ?? null);
        console.warn('[FET-TIMER] expired$ FIRED idx=' + idx, 'hasExplanation=' + !!q?.explanation, 'hasQText=' + !!host.qText?.()?.nativeElement);

        if (q?.explanation) {
          const visualOpts = host.quizQuestionComponent?.()?.optionsToDisplay ?? q.options;
          host.explanationTextService.storeFormattedExplanation(idx, q.explanation, q, visualOpts);
        }

        // DIRECT DOM FET WRITE on timer expiry — bypasses all service/guard layers
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
                (host as any)._fetLockedForIndex = idx;
              };
              write();
              setTimeout(write, 50);
              setTimeout(write, 200);
              setTimeout(write, 500);
            }
          }
        } catch { /* ignore */ }

        host.cdRef.markForCheck();
      });
  }

  runOnDestroy(host: Host): void {
    if (host._cqcVisibilityHandler) {
      document.removeEventListener('visibilitychange', host._cqcVisibilityHandler);
      host._cqcVisibilityHandler = null;
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
    try { host.destroy$?.next(); } catch {}
    try { host.destroy$?.complete(); } catch {}
    try { host.correctAnswersDisplaySubject?.complete(); } catch {}
    host.combinedSub?.unsubscribe();
  }

  runInstallFetWatchdog(host: Host): void {
    this.fetGuard.installFetWatchdog(host);
  }

  private stampQuestionTextNow(host: Host, idx: number): boolean {
    return this.questionNav.stampQuestionTextNow(host, idx);
  }

  private cleanupStaleStateForIndex(host: Host, idx: number): void {
    this.questionNav.cleanupStaleStateForIndex(host, idx);
  }

  runQuestionIndexSet(host: Host, idx: number): void {
    this.questionNav.runQuestionIndexSet(host, idx);
  }

  runSetupQuestionResetSubscription(host: Host): void {
    if (!host.questionToDisplay$()) return;
    combineLatest([
      host.questionToDisplay$().pipe(startWith(''), distinctUntilChanged()),
      host.quizService.currentQuestionIndex$.pipe(
        startWith(host.quizService?.currentQuestionIndex ?? 0)
      )
    ])
      .pipe(takeUntil(host.destroy$))
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
      catchError((error: Error) => {
        return of(false);
      }),
      startWith(false)
    );

    host.isContentAvailable$
      .pipe(distinctUntilChanged())
      .subscribe(() => {});
  }

  runEmitContentAvailableState(host: Host): void {
    host.isContentAvailable$.pipe(takeUntil(host.destroy$)).subscribe({
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
          takeUntil(host.destroy$)
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
    } catch (error: any) {
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
        catchError((error: Error) => {
          return of([] as QuizQuestion[]);
        })
      ),
      host.quizDataService.getAllExplanationTextsForQuiz(qid).pipe(
        catchError((error: Error) => {
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

          const shouldDisplayCorrectAnswers = isMultipleAnswer && !explanationDisplayed;
          if (host.shouldDisplayCorrectAnswersSubject.getValue() !== shouldDisplayCorrectAnswers) {
            host.shouldDisplayCorrectAnswersSubject.next(shouldDisplayCorrectAnswers);
          }
        }),
        map(() => void 0)
      );
  }

  runInitializeCombinedQuestionData(host: Host): void {
    const currentQuizAndOptions$ = host.combineCurrentQuestionAndOptions();

    currentQuizAndOptions$.pipe(takeUntil(host.destroy$)).subscribe({
      next: (data: any) => {},
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
      map(
        (arr: any): CombinedQuestionDataType => {
          const quiz: { currentQuestion: QuizQuestion | null; currentOptions: Option[]; explanation: string; currentIndex: number; } | null = arr[0];
          const numberOfCorrectAnswers: number | string = arr[1];
          const isExplanationDisplayed: boolean = arr[2];
          const formattedExplanation: string = arr[3];
          const safeQuizData = quiz?.currentQuestion
            ? quiz
            : { currentQuestion: null, currentOptions: [], explanation: '', currentIndex: 0 };

          const selectionMessage =
            'selectionMessage' in safeQuizData
              ? (safeQuizData as any).selectionMessage || ''
              : '';

          const currentQuizData: CombinedQuestionDataType = {
            currentQuestion: safeQuizData.currentQuestion,
            currentOptions: safeQuizData.currentOptions ?? [],
            options: safeQuizData.currentOptions ?? [],
            questionText: safeQuizData.currentQuestion?.questionText || 'No question available',
            explanation: safeQuizData.explanation ?? '',
            correctAnswersText: '',
            isExplanationDisplayed: !!isExplanationDisplayed,
            isNavigatingToPrevious: false,
            selectionMessage
          };

          return host.calculateCombinedQuestionData(
            currentQuizData,
            +(numberOfCorrectAnswers ?? 0),
            !!isExplanationDisplayed,
            formattedExplanation ?? ''
          );
        }
      ),
      filter((data: CombinedQuestionDataType | null): data is CombinedQuestionDataType => data !== null),
      catchError((error: Error) => {
        const fallback: CombinedQuestionDataType = {
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

        return of<CombinedQuestionDataType>(fallback);
      }),
    ));
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
      filter(({ payload, index }: { payload: QuestionPayload; index: number }) => {
        const expected =
          Array.isArray(host.questions()) && index >= 0
            ? (host.questions()[index] ?? null) : null;

        if (!expected) return true;

        return true;
      }),
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
      catchError((error: Error) => {
        return of({
          currentQuestion: null,
          currentOptions: [],
          explanation: '',
          currentIndex: -1
        });
      })
    );
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

  runSetupCorrectAnswersTextDisplay(host: Host): void {
    host.shouldDisplayCorrectAnswers$ = combineLatest([
      host.shouldDisplayCorrectAnswers$.pipe(
        startWith(false),
        map((value: boolean) => value ?? false),
        distinctUntilChanged()
      ),
      host.isExplanationDisplayed$.pipe(
        startWith(false),
        map((value: boolean) => value ?? false),
        distinctUntilChanged()
      )
    ]).pipe(
      map((arr: any) => !!arr[0] && !arr[1]),
      distinctUntilChanged(),
      catchError((error: Error) => {
        return of(false);
      })
    );

    host.displayCorrectAnswersText$ = host.shouldDisplayCorrectAnswers$.pipe(
      switchMap((shouldDisplay: boolean) => {
        return shouldDisplay ? host.correctAnswersText$ : of(null);
      }),
      distinctUntilChanged(),
      catchError((error: Error) => {
        return of(null);
      })
    );
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
