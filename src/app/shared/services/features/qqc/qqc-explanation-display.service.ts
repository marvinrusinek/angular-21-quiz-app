import { inject, Injectable } from '@angular/core';
import { firstValueFrom, Observable, of } from 'rxjs';
import { catchError, filter, map, take, timeout } from 'rxjs/operators';

import { PROMISE_RACE_TIMEOUT_MS } from '../../../constants/timing';

import { FormattedExplanation } from '../../../models/FormattedExplanation.model';
import { Option } from '../../../models/Option.model';
import { QuestionState } from '../../../models/QuestionState.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { QqcExplanationManagerService } from './qqc-explanation-manager.service';
import { QuizDataService } from '../../data/quizdata.service';
import { QuizQuestionManagerService } from '../../flow/quizquestionmgr.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { delay } from '../../../utils/delay';
import { norm } from '../../../utils/text-norm';

/**
 * Manages explanation display, formatted explanation text (FET) resolution,
 * and explanation UI state for QQC.
 * Extracted from QuizQuestionComponent to reduce its size.
 */
@Injectable({ providedIn: 'root' })
export class QqcExplanationDisplayService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationManager = inject(QqcExplanationManagerService);
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizQuestionManagerService = inject(QuizQuestionManagerService);
  private readonly quizService = inject(QuizService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);

  /**
   * Resolves and formats the explanation text for a given question index.
   * Returns the formatted explanation text string.
   */
  async updateExplanationText(params: {
    index: number;
    normalizeIndex: (idx: number) => number;
    questionsArray: QuizQuestion[];
    currentQuestionIndex: number;
    currentQuestion: QuizQuestion | null;
    optionsToDisplay: Option[];
    options: Option[];
  }): Promise<string> {
    const svc = this.explanationTextService;
    const quizSvc = this.quizService;
    const i0 = params.normalizeIndex(params.index);

    // Step 1: Resolve the question object and raw text
    let q: QuizQuestion | null = null;
    try {
      if (params.questionsArray && params.questionsArray.length > i0) {
        q = params.questionsArray[i0];
      }

      if (!q && params.currentQuestionIndex === i0 && params.currentQuestion) {
        q = { ...params.currentQuestion } as QuizQuestion;
      }

      if (!q) {
        const svcQuestions = quizSvc.shuffledQuestions || quizSvc.questions || [];
        q = svcQuestions[i0];
      }
    } catch (err) {
      console.error('QqcExplanationDisplayService.resolveFormatted question lookup failed:', err);
    }

    if (!q) return ''; // Question object could not be resolved for this index

    const baseRaw = (q?.explanation ?? '').toString().trim();

    try {
      svc.purgeAndDefer(i0);
    } catch (e) {
      console.error('QqcExplanationDisplayService.resolveFormatted purgeAndDefer failed:', e);
    }

    await new Promise(res => requestAnimationFrame(res));

    // Step 2: Format explanation safely using authoritative indices
    let formatted = '';
    try {
      let visualOpts: Option[] = [];

      if (i0 === params.currentQuestionIndex && params.optionsToDisplay?.length) {
        visualOpts = params.optionsToDisplay;
      } else {
        try {
          const questions = quizSvc.shuffledQuestions?.length
            ? quizSvc.shuffledQuestions
            : quizSvc.questions || [];
          const targetQ = questions[i0];
          if (targetQ?.options?.length) {
            visualOpts = targetQ.options;
          }
        } catch (e) {
          console.error('QqcExplanationDisplayService.resolveFormatted visual options lookup failed:', e);
        }
      }

      if (!visualOpts?.length && params.options?.length) visualOpts = params.options;
      if (!visualOpts?.length && q.options?.length) visualOpts = q.options;

      if (!visualOpts?.length && quizSvc) {
        try {
          const fetchedOpts = await firstValueFrom(quizSvc.getOptions(i0));
          if (fetchedOpts?.length) visualOpts = fetchedOpts;
        } catch (e) {
          console.error('QqcExplanationDisplayService.resolveFormatted getOptions fetch failed:', e);
        }
      }

      const correctIndices = svc.getCorrectOptionIndices(q, visualOpts, i0);

      if (correctIndices.length > 0) {
        formatted = typeof svc.formatExplanation === 'function'
          ? svc.formatExplanation(q, correctIndices, baseRaw, i0)
          : (baseRaw.includes('correct because') ? baseRaw : `Option ${correctIndices[0]} is correct because ${baseRaw}`);
      } else {
        const findCorrect = visualOpts
          .map((opt, idx) => (isOptionCorrect(opt) ? idx + 1 : null))
          .filter((n): n is number => n !== null);

        if (findCorrect.length > 0) {
          formatted = svc.formatExplanation(q, findCorrect, baseRaw, i0);
        } else {
          formatted = baseRaw;
        }
      }
    } catch (e) {
      formatted = baseRaw;
    }

    const clean = (formatted ?? '').trim();

    // Step 3: Cache
    try {
      svc.formattedExplanations[i0] = {
        questionIndex: i0,
        explanation: clean || baseRaw,
      };
      if (typeof svc.fetByIndex?.set === 'function') {
        svc.fetByIndex.set(i0, clean || baseRaw);
      }
    } catch (e) {
      console.error('QqcExplanationDisplayService.resolveFormatted FET cache write failed:', e);
    }

    // Step 4: Emit only if we're still on this index
    const nextText = (clean || baseRaw).trim();
    if (!nextText) return clean || baseRaw;

    const stillActive = i0 === params.currentQuestionIndex;
    if (stillActive) {
      // Multi-answer guard: only emit FET text and set shouldDisplayExplanation
      // when ALL correct answers are selected. Previously, setExplanationText
      // was called unconditionally BEFORE this guard, leaking FET into the
      // reactive pipeline for partially-answered multi-answer questions.
      const rawQ: any = this.quizService?.questions?.[i0] ?? q;
      const rawOpts: any[] = rawQ?.options ?? [];
      const correctCount = rawOpts.filter(
        (o: any) => isOptionCorrect(o)
      ).length;
      const isMultiAnswer = correctCount > 1;

      if (isMultiAnswer) {
        const correctTexts = rawOpts
          .filter((o: any) => isOptionCorrect(o))
          .map((o: any) => norm(o?.text))
          .filter((t: string) => !!t);
        const selections = this.selectedOptionService.getSelectedOptionsForQuestion(i0) ?? [];
        const selTexts = new Set(
          selections
            .filter((s: any) => s?.selected !== false)
            .map((s: any) => norm(s?.text))
            .filter((t: string) => !!t)
        );
        const allCorrectSelected = correctTexts.length > 0
          && correctTexts.every((t: string) => selTexts.has(t));
        if (allCorrectSelected) {
          svc.setExplanationText(nextText, { index: i0 });
          svc.setShouldDisplayExplanation(true);
        }
      } else {
        svc.setExplanationText(nextText, { index: i0 });
        svc.setShouldDisplayExplanation(true);
      }

      svc.latestExplanation = nextText;
    }

    return nextText;
  }

  /**
   * Displays explanation text in the service and quiz state.
   */
  displayExplanationText(
    explanationText: string,
    lastAllCorrect: boolean
  ): void {
    this.explanationTextService.setExplanationText(explanationText);
    this.explanationTextService.setShouldDisplayExplanation(true);

    this.quizStateService.setDisplayState({
      mode: lastAllCorrect ? 'explanation' : 'question',
      answered: true
    });
  }

  /**
   * Validates and emits explanation text if the question index matches.
   */
  emitExplanationIfValid(
    explanationText: string,
    questionIndex: number,
    currentIndex: number
  ): boolean {
    if (currentIndex !== questionIndex) return false;

    this.explanationTextService.setExplanationText(explanationText);
    this.explanationTextService.setShouldDisplayExplanation(true);

    this.quizStateService.setDisplayState({
      mode: 'explanation',
      answered: true
    });

    return true;
  }

  /**
   * Handles the formatted explanation result.
   */
  handleFormattedExplanation(
    formattedExplanation: FormattedExplanation,
    isAnswered: boolean,
    shouldDisplayExplanation: boolean
  ): { explanationToDisplay: string; shouldEmit: boolean } {
    if (!formattedExplanation) {
      // formatExplanationText returned void
      return { explanationToDisplay: '', shouldEmit: false };
    }

    const explanationText =
      typeof formattedExplanation === 'string'
        ? formattedExplanation
        : formattedExplanation.explanation || 'No explanation available';

    return {
      explanationToDisplay: explanationText,
      shouldEmit: isAnswered && shouldDisplayExplanation
    };
  }

  /**
   * Updates explanation UI after question rendering.
   */
  async updateExplanationUI(params: {
    questionIndex: number;
    explanationText: string;
    questionsArray: QuizQuestion[];
    shouldDisplayExplanation: boolean;
    isAnyOptionSelected: (idx: number) => Promise<boolean>;
    updateCombinedQuestionData: (q: QuizQuestion, text: string) => void;
  }): Promise<{
    explanationToDisplay: string;
    shouldEmit: boolean;
  } | null> {
    if (!params.questionsArray || params.questionsArray.length === 0) return null;

    const adjustedIndex = Math.max(
      0,
      Math.min(params.questionIndex, params.questionsArray.length - 1)
    );
    const currentQuestion = params.questionsArray[adjustedIndex];

    if (!currentQuestion) return null;  // Question not found at adjusted index

    this.quizService.setCurrentQuestion(currentQuestion);

    // Wait for rendering
    await delay(100);

    if (
      params.shouldDisplayExplanation &&
      await params.isAnyOptionSelected(adjustedIndex)
    ) {
      params.updateCombinedQuestionData(currentQuestion, params.explanationText);
      return {
        explanationToDisplay: params.explanationText,
        shouldEmit: true
      };
    }

    return null;
  }

  /**
   * Handles explanation display update based on shouldDisplay flag.
   * Returns the state changes for the component to apply.
   */
  async handleExplanationDisplayUpdate(
    shouldDisplay: boolean,
    currentQuestionIndex: number
  ): Promise<{
    explanationToDisplay?: string;
    displayExplanation: boolean;
  }> {
    if (shouldDisplay) {
      this.explanationTextService.setResetComplete(true);
      this.explanationTextService.setShouldDisplayExplanation(true);
      this.explanationTextService.lockExplanation();

      try {
        let explanationText = 'No explanation available';

        if (this.explanationTextService.explanationsInitialized) {
          const fetched = await firstValueFrom(
            this.explanationTextService.getFormattedExplanationTextForQuestion(
              currentQuestionIndex
            )
          );
          explanationText = fetched?.trim() || explanationText;
        }

        this.explanationTextService.setExplanationText(explanationText);

        return {
          explanationToDisplay: explanationText,
          displayExplanation: true
        };
      } catch (error) {
        // Error fetching explanation in updateExplanationDisplay
        return {
          explanationToDisplay: 'Error loading explanation.',
          displayExplanation: true
        };
      }
    } else {
      if (!this.explanationTextService.isExplanationLocked()) {
        this.explanationTextService.setExplanationText('');
        this.explanationTextService.setResetComplete(false);
        this.explanationTextService.setShouldDisplayExplanation(false);
        return {
          explanationToDisplay: '',
          displayExplanation: false
        };
      }
      return { displayExplanation: false };
    }
  }

  /**
   * Computes the display-state flags for transitioning to explanation mode.
   * Returns null if the transition should be skipped.
   */
  computeExplanationModeTransition(
    shouldDisplayExplanation: boolean,
    currentDisplayMode: 'question' | 'explanation'
  ): {
    displayState: { mode: 'question' | 'explanation'; answered: boolean };
    displayMode: 'explanation';
    explanationFlags: {
      shouldDisplayExplanation: true;
      explanationVisible: true;
      isExplanationTextDisplayed: true;
      forceQuestionDisplay: false;
      readyForExplanationDisplay: true;
      isExplanationReady: true;
      isExplanationLocked: false;
    };
  } | null {
    const isAnswered = this.selectedOptionService.isAnsweredSig();

    if (!isAnswered || !shouldDisplayExplanation) return null;
    if (currentDisplayMode === 'explanation') return null;

    return {
      displayState: { mode: 'explanation', answered: isAnswered },
      displayMode: 'explanation',
      explanationFlags: {
        shouldDisplayExplanation: true,
        explanationVisible: true,
        isExplanationTextDisplayed: true,
        forceQuestionDisplay: false,
        readyForExplanationDisplay: true,
        isExplanationReady: true,
        isExplanationLocked: false
      }
    };
  }

  /**
   * Resets explanation state (service-level).
   * Returns whether the reset was blocked by a lock.
   */
  resetExplanation(
    force: boolean,
    _fixedQuestionIndex: number,
    _currentQuestionIndex: number
  ): boolean {
    this.explanationTextService.resetExplanationText();

    const locked = this.explanationTextService.isExplanationLocked?.();
    if (!force && locked) return true;  // blocked

    this.explanationTextService.setShouldDisplayExplanation(false);

    this.quizStateService.setDisplayState({
      mode: 'question',
      answered: false
    });
    this.quizStateService.setAnswerSelected(false);

    this.explanationTextService.setResetComplete?.(true);

    return false; // not blocked
  }

  /**
   * Marks explanation as answered/displayed in quiz state.
   */
  markExplanationDisplayed(
    _quizId: string,
    _questionIndex: number,
    lastAllCorrect: boolean
  ): void {
    this.quizStateService.setDisplayState({
      mode: lastAllCorrect ? 'explanation' : 'question',
      answered: true
    });
  }

  /**
   * Handles error state for explanation fetching.
   */
  handleExplanationError(): string {
    return 'Error fetching explanation. Please try again.';
  }

  /**
   * Manages the full explanation display lifecycle for a question.
   * Fetches question data, processes explanation, updates state, returns values for component.
   */
  async manageExplanationDisplay(params: {
    currentQuestionIndex: number;
    quizId: string;
    lastAllCorrect: boolean;
  }): Promise<{
    explanationToDisplay: string;
    displayExplanation: boolean;
    explanationText?: string;
    questionState?: QuestionState;
  }> {
    const { currentQuestionIndex, quizId, lastAllCorrect } = params;

    try {
      if (currentQuestionIndex === null || currentQuestionIndex === undefined) {
        throw new Error('Current question index is not set');
      }

      const questionData: any = await firstValueFrom(
        this.quizService.getQuestionByIndex(currentQuestionIndex)
      );

      if (!this.quizQuestionManagerService.isValidQuestionData(questionData!)) {
        throw new Error('Invalid question data');
      }

      let explanationText =
        questionData?.explanation ?? 'No explanation available';

      const processedExplanation = await this.explanationManager.processExplanationText(
        questionData!,
        currentQuestionIndex
      );

      if (processedExplanation && processedExplanation.explanation) {
        explanationText = processedExplanation.explanation;
      }

      // Update service state
      this.explanationTextService.updateFormattedExplanation(explanationText);
      this.explanationTextService.setResetComplete(true);
      this.explanationTextService.setShouldDisplayExplanation(lastAllCorrect);
      if (lastAllCorrect) {
        this.explanationTextService.lockExplanation();
      }

      // Update quiz state
      const questionState = this.quizStateService.getQuestionState(
        quizId,
        currentQuestionIndex
      );
      if (questionState) {
        questionState.explanationText = explanationText;
        questionState.explanationDisplayed = true;
        this.quizStateService.setQuestionState(
          quizId,
          currentQuestionIndex,
          questionState
        );
      }

      return {
        explanationToDisplay: explanationText,
        displayExplanation: true,
        explanationText,
        questionState
      };
    } catch (error) {
      // Error managing explanation display

      // Ensure flags are always set
      if (!this.explanationTextService.isExplanationLocked()) {
        this.explanationTextService.setResetComplete(true);
        this.explanationTextService.setShouldDisplayExplanation(true);
        this.explanationTextService.lockExplanation();
      }

      return {
        explanationToDisplay: 'Error loading explanation. Please try again.',
        displayExplanation: true
      };
    }
  }

  /**
   * Handles question data to determine if explanation should be shown.
   * Returns the explanation text and display flags.
   */
  async handleQuestionData(params: {
    questionsArray: QuizQuestion[];
    questionIndex: number;
    quizId: string;
    shouldDisplayExplanation: boolean;
    getExplanationText: (idx: number) => Promise<string>;
  }): Promise<{
    explanationText: string;
    shouldShowExplanation: boolean;
  }> {
    const { questionsArray, questionIndex, quizId, shouldDisplayExplanation, getExplanationText } = params;

    if (!questionsArray || questionsArray.length === 0) {
      return { explanationText: '', shouldShowExplanation: false };
    }

    if (questionIndex < 0 || questionIndex >= questionsArray.length) {
      // Invalid questionIndex
      return { explanationText: '', shouldShowExplanation: false };
    }

    const questionState = this.quizStateService.getQuestionState(quizId, questionIndex);
    const isAnswered = questionState?.isAnswered;
    const shouldShow = isAnswered && shouldDisplayExplanation;

    if (shouldShow) {
      try {
        const explanationText = await getExplanationText(questionIndex);

        this.explanationTextService.setResetComplete(true);
        this.explanationTextService.setExplanationText(explanationText);
        this.explanationTextService.setShouldDisplayExplanation(true);
        this.explanationTextService.lockExplanation();

        return { explanationText, shouldShowExplanation: true };
      } catch (error) {
        // Error fetching explanation text
        return { explanationText: 'Error loading explanation.', shouldShowExplanation: true };
      }
    } else {
      if (!this.explanationTextService.isExplanationLocked()) {
        this.explanationTextService.setExplanationText('');
        this.explanationTextService.setShouldDisplayExplanation(false);
        this.explanationTextService.setResetComplete(false);
      }
      return { explanationText: '', shouldShowExplanation: false };
    }
  }

  /**
   * Restores explanation state after a navigation reset.
   * Handles service-level state and quiz state updates, returns display flags for component.
   */
  restoreExplanationAfterReset(params: {
    questionIndex: number;
    explanationText: string;
    questionState?: QuestionState;
    quizId: string | null;
  }): {
    explanationToDisplay: string;
    displayMode: 'explanation';
    displayState: { mode: 'explanation'; answered: true };
    forceQuestionDisplay: false;
    readyForExplanationDisplay: true;
    isExplanationReady: true;
    isExplanationLocked: false;
    explanationLocked: true;
    explanationVisible: true;
    displayExplanation: true;
    shouldDisplayExplanation: true;
    isExplanationTextDisplayed: true;
  } | null {
    const normalized = (params.explanationText ?? '').trim();
    if (!normalized) return null;

    // Service-level state
    this.explanationTextService.setExplanationText(normalized);
    this.explanationTextService.setShouldDisplayExplanation(true);
    this.explanationTextService.setIsExplanationTextDisplayed(true);
    this.explanationTextService.setResetComplete(true);
    this.explanationTextService.lockExplanation();

    // Quiz state update
    if (params.quizId && params.questionState) {
      params.questionState.isAnswered = true;
      params.questionState.explanationDisplayed = true;
      this.quizStateService.setQuestionState(
        params.quizId, params.questionIndex, params.questionState
      );
    }

    return {
      explanationToDisplay: normalized,
      displayMode: 'explanation',
      displayState: { mode: 'explanation', answered: true },
      forceQuestionDisplay: false,
      readyForExplanationDisplay: true,
      isExplanationReady: true,
      isExplanationLocked: false,
      explanationLocked: true,
      explanationVisible: true,
      displayExplanation: true,
      shouldDisplayExplanation: true,
      isExplanationTextDisplayed: true
    };
  }

  /**
   * Handles explanation display update with shouldDisplay flag.
   * Manages lock/unlock, fetches explanation text, returns state for component.
   */
  async performUpdateExplanationDisplay(params: {
    shouldDisplay: boolean;
    currentQuestionIndex: number;
  }): Promise<{
    explanationToDisplay: string;
    displayExplanation: boolean;
    shouldEmitExplanation: boolean;
    shouldResetQuestionState: boolean;
  }> {
    const { shouldDisplay, currentQuestionIndex } = params;

    if (shouldDisplay) {
      this.explanationTextService.setResetComplete(true);
      this.explanationTextService.setShouldDisplayExplanation(true);
      this.explanationTextService.lockExplanation();

      try {
        let explanationText = 'No explanation available';

        if (this.explanationTextService.explanationsInitialized) {
          const fetched = await firstValueFrom(
            this.explanationTextService.getFormattedExplanationTextForQuestion(
              currentQuestionIndex
            )
          );
          explanationText = fetched?.trim() || explanationText;
        }

        this.explanationTextService.setExplanationText(explanationText);

        return {
          explanationToDisplay: explanationText,
          displayExplanation: true,
          shouldEmitExplanation: true,
          shouldResetQuestionState: false
        };
      } catch (error) {
        // Error fetching explanation in updateExplanationDisplay
        return {
          explanationToDisplay: 'Error loading explanation.',
          displayExplanation: true,
          shouldEmitExplanation: true,
          shouldResetQuestionState: false
        };
      }
    } else {
      if (!this.explanationTextService.isExplanationLocked()) {
        this.explanationTextService.setExplanationText('');
        this.explanationTextService.setResetComplete(false);
        this.explanationTextService.setShouldDisplayExplanation(false);

        return {
          explanationToDisplay: '',
          displayExplanation: false,
          shouldEmitExplanation: true,
          shouldResetQuestionState: true
        };
      } else {
        return {
          explanationToDisplay: '',
          displayExplanation: false,
          shouldEmitExplanation: true,
          shouldResetQuestionState: false
        };
      }
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // FORMATTED EXPLANATION RESOLUTION
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Resolves and returns a formatted explanation text for a given question index.
   * Uses cache when available and falls back to the observable stream.
   * Preserves all original logic and comments from QQC.
   */
  async resolveFormatted(
    index: number,
    opts: { useCache?: boolean; setCache?: boolean; timeoutMs?: number } = {},
    context: {
      normalizeIndex: (idx: number) => number;
      formattedByIndex: Map<number, string>;
      questionsArray: QuizQuestion[];
      currentQuestionIndex: number;
      currentQuestion: QuizQuestion | null;
      optionsToDisplay: Option[];
      options: Option[];
    }
  ): Promise<string> {
    const i0 = context.normalizeIndex(index);
    const { useCache = true, setCache = true, timeoutMs = 1200 } = opts;

    if (useCache) {
      const hit = context.formattedByIndex.get(i0);
      if (hit) return hit;
    }

    let text = '';

    try {
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Resolve the FET using the specific index i0
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

      // Try direct return first
      const out = await this.updateExplanationText({
        index: i0,
        normalizeIndex: context.normalizeIndex,
        questionsArray: context.questionsArray,
        currentQuestionIndex: context.currentQuestionIndex,
        currentQuestion: context.currentQuestion,
        optionsToDisplay: context.optionsToDisplay,
        options: context.options,
      });
      text = (out ?? '').toString().trim();

      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Fallback: formatter writes to a stream
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if ((!text || text === 'No explanation available for this question.') &&
        this.explanationTextService.formattedExplanation$) {

        const src$ = this.explanationTextService.formattedExplanation$ as Observable<string | null | undefined>;

        const formatted$: Observable<string> = src$.pipe(
          filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0),
          map(s => s.trim()),
          timeout(timeoutMs),
          take(1)
        );

        try {
          text = await firstValueFrom(formatted$);
        } catch {
          text = '';
        }
      }

      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Final check â€” only emit real explanation text
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (!text || text === 'No explanation available for this question.') {
        return '';
      }

      if (text && setCache) context.formattedByIndex.set(i0, text);
      return text;
    } catch (err) {
      return '';
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // PREPARE AND SET EXPLANATION TEXT
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Prepares and sets explanation text for a given question index.
   * Returns the explanation text string.
   * Preserves all original logic and comments from QQC.
   */
  async prepareAndSetExplanationText(
    questionIndex: number,
    context: {
      processExplanationText: (q: QuizQuestion, idx: number) => Promise<FormattedExplanation | null>;
    }
  ): Promise<string> {
    if (typeof document !== 'undefined' && document.hidden) {
      return 'Explanation text not available when document is hidden.';
    }

    try {
      const questionData = await firstValueFrom(
        this.quizService.getQuestionByIndex(questionIndex)
      );

      if (this.quizQuestionManagerService.isValidQuestionData(questionData!)) {
        const formattedExplanationObservable =
          this.explanationTextService.getFormattedExplanation(questionIndex);

        try {
          const formattedExplanation = await Promise.race([
            firstValueFrom(formattedExplanationObservable),
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error('Timeout')), PROMISE_RACE_TIMEOUT_MS)
            )
          ]);

          if (formattedExplanation) {
            return formattedExplanation as string;
          } else {
            const processedExplanation = await context.processExplanationText(
              questionData!,
              questionIndex
            );

            if (processedExplanation) {
              this.explanationTextService.updateFormattedExplanation(
                processedExplanation.explanation
              );
              return processedExplanation.explanation;
            } else {
              return 'No explanation available...';
            }
          }
        } catch (timeoutError) {
          // Timeout while fetching formatted explanation
          return 'Explanation text unavailable at the moment.';
        }
      } else {
        // questionData is invalid
        return 'No explanation available.';
      }
    } catch (error) {
      // Error in fetching explanation text
      return 'Error fetching explanation.';
    }
  }

  /**
   * Fetches questions for a quiz and delegates to handleQuestionData.
   * Returns an observable subscription for cleanup.
   * Extracted from conditionallyShowExplanation().
   */
  conditionallyShowExplanation(params: {
    questionIndex: number;
    quizId: string;
    shouldDisplayExplanation: boolean;
    getExplanationText: (index: number) => Promise<string>;
  }): Promise<{
    questionsArray: QuizQuestion[];
    explanationText: string;
    shouldShowExplanation: boolean;
  }> {
    return new Promise((resolve) => {
      this.quizDataService
        .getQuestionsForQuiz(params.quizId)
        .pipe(
          catchError(() => {
            // Error loading questions
            return of([]);
          })
        )
        .subscribe(async (data: QuizQuestion[]) => {
          const result = await this.handleQuestionData({
            questionsArray: data,
            questionIndex: params.questionIndex,
            quizId: params.quizId,
            shouldDisplayExplanation: params.shouldDisplayExplanation,
            getExplanationText: params.getExplanationText
          });

          resolve({
            questionsArray: data,
            explanationText: result.explanationText,
            shouldShowExplanation: result.shouldShowExplanation
          });
        });
    });
  }

  /**
   * Resets explanation state at the start of a click.
   * Extracted from onOptionClicked() explanation clearing block.
   */
  resetExplanationStateForClick(questionIndex: number): void {
    this.explanationTextService._activeIndex = questionIndex;
    this.explanationTextService.updateFormattedExplanation('');
    this.explanationTextService.latestExplanation = '';
    this.explanationTextService.setShouldDisplayExplanation(false);
    this.explanationTextService.setIsExplanationTextDisplayed(false);
  }
}