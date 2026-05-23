import { Injectable, inject } from '@angular/core';

import { SK_DOT_CONFIRMED } from '../../constants/session-keys';

import { QuestionType } from '../../models/question-type.enum';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { SelectedOption } from '../../models/SelectedOption.model';

import { QuizPersistenceService } from '../state/quiz-persistence.service';
import { QuizService } from '../data/quiz.service';
import { QuizShuffleService } from './quiz-shuffle.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';

/**
 * Manages dot status computation, selection evaluation, and question
 * status determination for the quiz pagination dots.
 * Extracted from QuizComponent to reduce its size.
 */
@Injectable({ providedIn: 'root' })
export class QuizDotStatusService {

  // ── injects ─────────────────────────────────────────────────────
  private persistence = inject(QuizPersistenceService);
  private quizService = inject(QuizService);
  private quizShuffleService = inject(QuizShuffleService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);

  // ── properties ──────────────────────────────────────────────────
  dotStatusCache = new Map<number, 'correct' | 'wrong' | 'pending'>();
  pendingDotStatusOverrides = new Map<number, 'correct' | 'wrong'>();
  activeDotClickStatus = new Map<number, 'correct' | 'wrong'>();
  timerExpiredUnanswered = new Set<number>();

  // ═══════════════════════════════════════════════════════════════
  // STATE MAP HELPERS
  // ═══════════════════════════════════════════════════════════════

  clearAllMaps(): void {
    this.dotStatusCache.clear();
    this.pendingDotStatusOverrides.clear();
    this.activeDotClickStatus.clear();
    this.timerExpiredUnanswered.clear();
  }

  clearForIndex(index: number): void {
    this.activeDotClickStatus.delete(index);
    this.pendingDotStatusOverrides.delete(index);
    this.dotStatusCache.delete(index);
  }

  // ═══════════════════════════════════════════════════════════════
  // SCORING KEY HELPERS
  // ═══════════════════════════════════════════════════════════════

  getScoringKey(quizId: string, index: number): number {
    const effectiveQuizId = quizId
      || this.quizService.quizId
      || localStorage.getItem('lastQuizId')
      || '';
    if (this.quizService.isShuffleEnabled() && effectiveQuizId) {
      const originalIndex = this.quizShuffleService.toOriginalIndex(effectiveQuizId, index);
      if (typeof originalIndex === 'number' && originalIndex >= 0) {
        return originalIndex;
      }
    }
    return index;
  }

  getCandidateQuestionIndices(quizId: string, index: number): number[] {
    const scoringKey = this.getScoringKey(quizId, index);
    return Array.from(new Set([index, scoringKey]));
  }

  // ═══════════════════════════════════════════════════════════════
  // QUESTION LOOKUP
  // ═══════════════════════════════════════════════════════════════

  getQuestionForIndex(index: number, questionsArray: QuizQuestion[]): QuizQuestion | null {
    return this.quizService.questions?.[index] ||
      questionsArray?.[index] ||
      this.quizService.activeQuiz?.questions?.[index] ||
      null;
  }

  // ═══════════════════════════════════════════════════════════════
  // SELECTION MATCHING
  // ═══════════════════════════════════════════════════════════════

  selectionMatchesOption(
    selection: Partial<SelectedOption> | null | undefined,
    option: Partial<Option> | null | undefined,
    optionIndex?: number
  ): boolean {
    if (!selection || !option) return false;

    const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();
    const selectionId = String(selection.optionId ?? '').trim();
    const optionId = String(option.optionId ?? '').trim();

    if (selectionId !== '' && optionId !== '' && selectionId === optionId) {
      return true;
    }

    const selectionText = normalize(selection.text);
    const optionText = normalize(option.text);
    if (selectionText !== '' && optionText !== '' && selectionText === optionText) {
      return true;
    }

    const selectionDisplayIndex = Number(
      (selection as any)?.displayIndex ?? (selection as any)?.index ?? -1
    );
    return Number.isInteger(optionIndex) && selectionDisplayIndex === optionIndex;
  }

  // ═══════════════════════════════════════════════════════════════
  // CORRECT OPTION RESOLUTION
  // ═══════════════════════════════════════════════════════════════

  getResolvedCorrectOptionEntries(
    question: QuizQuestion | null | undefined,
    fallbackOptions: Option[] = []
  ): Array<{ option: Option; index: number }> {
    const options = Array.isArray(question?.options) && question!.options.length > 0
      ? question!.options : fallbackOptions;

    if (!Array.isArray(options) || options.length === 0) return [];

    const correctIds = new Set<number>();
    const correctTexts = new Set<string>();

    if (Array.isArray((question as any)?.answer)) {
      for (const answer of (question as any).answer) {
        if (!answer) continue;

        const id = Number(answer.optionId);
        if (!Number.isNaN(id)) correctIds.add(id);

        const text = String(answer.text ?? '').trim().toLowerCase();
        if (text) correctTexts.add(text);
      }
    }

    const resolvedFromAnswers = options
      .map((opt: Option, index: number) => ({ option: opt, index }))
      .filter(({ option }) => {
        const id = Number(option?.optionId);
        const text = String(option?.text ?? '').trim().toLowerCase();

        return (!Number.isNaN(id) && correctIds.has(id)) || (!!text && correctTexts.has(text));
      });

    if (resolvedFromAnswers.length > 0) return resolvedFromAnswers;

    return options
      .map((opt: Option, index: number) => ({ option: opt, index }))
      .filter(({ option }) => option?.correct === true || String(option?.correct) === 'true');
  }

  getResolvedCorrectOptions(
    question: QuizQuestion | null | undefined,
    fallbackOptions: Option[] = []
  ): Option[] {
    return this.getResolvedCorrectOptionEntries(question, fallbackOptions)
      .map(({ option }) => option);
  }

  matchesAnyCorrectOption(
    selection: Partial<SelectedOption> | null | undefined,
    question: QuizQuestion | null | undefined,
    fallbackOptions: Option[] = []
  ): boolean {
    return this.getResolvedCorrectOptionEntries(question, fallbackOptions)
      .some(({ option, index }) => this.selectionMatchesOption(selection, option, index));
  }

  // ═══════════════════════════════════════════════════════════════
  // OPTIMISTIC CORRECT SELECTION
  // ═══════════════════════════════════════════════════════════════

  hasOptimisticCorrectSelection(params: {
    index: number;
    selections: SelectedOption[];
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestion: QuizQuestion | null;
    questionsArray: QuizQuestion[];
  }): boolean {
    const { index, selections, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray } = params;
    const question = this.getQuestionForIndex(index, questionsArray);
    const fallbackOptions = this.getFallbackOptions(index, currentQuestionIndex, optionsToDisplay, currentQuestion);

    if (selections.length === 0) return false;

    const correctOptionEntries = this.getResolvedCorrectOptionEntries(question, fallbackOptions);

    if (correctOptionEntries.length <= 1) return false;

    const hasIncorrectSelection = selections.some((selection) =>
      !this.matchesAnyCorrectOption(selection, question, fallbackOptions)
    );

    if (hasIncorrectSelection) return false;

    const matchedCorrectSelections = selections.filter((selection) =>
      this.matchesAnyCorrectOption(selection, question, fallbackOptions)
    );

    return matchedCorrectSelections.length === correctOptionEntries.length;
  }

  // ═══════════════════════════════════════════════════════════════
  // SELECTION CORRECTNESS EVALUATION
  // ═══════════════════════════════════════════════════════════════

  evaluateSelectionCorrectness(params: {
    index: number;
    selections: SelectedOption[];
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestion: QuizQuestion | null;
    questionsArray: QuizQuestion[];
  }): boolean | null {
    const { index, selections, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray } = params;
    const question = this.getQuestionForIndex(index, questionsArray);
    const fallbackOptions = this.getFallbackOptions(index, currentQuestionIndex, optionsToDisplay, currentQuestion);

    if (
      (!question || !Array.isArray(question.options) || question.options.length === 0)
      && fallbackOptions.length === 0
    ) return null;

    const correctOptionEntries = this.getResolvedCorrectOptionEntries(question, fallbackOptions);
    const correctOptions = correctOptionEntries.map(({ option }) => option);
    const isMultipleAnswerQuestion =
      question?.type === QuestionType.MultipleAnswer || correctOptions.length > 1;

    if (correctOptions.length === 0 || selections.length === 0) return null;

    const matchedCorrectSelections = selections.filter((selection) =>
      correctOptionEntries.some(({ option, index: optionIndex }) =>
        this.selectionMatchesOption(selection, option, optionIndex)
      )
    );

    const incorrectSelections = selections.filter((selection) =>
      !correctOptionEntries.some(({ option, index: optionIndex }) =>
        this.selectionMatchesOption(selection, option, optionIndex)
      )
    );

    if (matchedCorrectSelections.length === 0 && incorrectSelections.length === 0) {
      return null;
    }

    if (isMultipleAnswerQuestion) {
      if (incorrectSelections.length > 0) return false;

      return matchedCorrectSelections.length === correctOptionEntries.length;
    }

    if (incorrectSelections.length > 0) return false;

    return matchedCorrectSelections.length > 0 ? true : null;
  }

  // ═══════════════════════════════════════════════════════════════
  // SELECTION RETRIEVAL
  // ═══════════════════════════════════════════════════════════════

  getSelectionsForQuestion(params: {
    index: number;
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestion: QuizQuestion | null;
    questionsArray: QuizQuestion[];
  }): SelectedOption[] {
    const { index, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray } = params;
    const question = this.quizService.questions?.[index] ||
      questionsArray?.[index] ||
      this.quizService.activeQuiz?.questions?.[index];
    const currentQuestionOptions = index === currentQuestionIndex
      ? ((Array.isArray(optionsToDisplay) && optionsToDisplay.length > 0)
          ? optionsToDisplay
          : (Array.isArray(currentQuestion?.options) ? currentQuestion!.options as Option[] : []))
      : [];
    const referenceOptions = Array.isArray(question?.options) && question!.options.length > 0
      ? question!.options
      : currentQuestionOptions;

    const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();
    const optionIdSet = new Set(
      referenceOptions
        .map((opt: Option, optIndex: number) => {
          const rawId = opt?.optionId;
          if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
            return String(rawId).trim();
          }
          return String(optIndex);
        })
    );
    const optionTextSet = new Set(
      referenceOptions.map((opt: Option) => normalize(opt?.text)).filter(Boolean)
    );
    const optionIndexSet = new Set(
      referenceOptions.map((_opt: Option, optIndex: number) => optIndex)
    );

    const isSelectionActive = (selection: SelectedOption): boolean => {
      if (!selection) return false;

      return selection.selected !== false &&
        (selection as any)?.checked !== false &&
        (selection as any)?.isSelected !== false &&
        (selection as any)?.active !== false;
    };

    const pickRelevantSelections = (selections: SelectedOption[]): SelectedOption[] => {
      if (!Array.isArray(selections) || selections.length === 0) return [];

      const activeSelections = selections.filter(isSelectionActive);
      if (activeSelections.length === 0) return [];

      const exactQuestionSelections = activeSelections.filter(
        (selection: SelectedOption) => selection?.questionIndex === index
      );
      if (exactQuestionSelections.length > 0) return exactQuestionSelections;

      const matchedSelections = activeSelections.filter((selection: SelectedOption) => {
        const selectionId = String(selection?.optionId ?? '').trim();
        const selectionText = normalize(selection?.text);
        const selectionDisplayIndex = Number(
          (selection as any)?.displayIndex ?? (selection as any)?.index ?? -1
        );

        return (
          (selectionId !== '' && optionIdSet.has(selectionId)) ||
          (selectionText !== '' && optionTextSet.has(selectionText)) ||
          optionIndexSet.has(selectionDisplayIndex)
        );
      });

      return matchedSelections.length > 0 ? matchedSelections : activeSelections;
    };

    if (index === currentQuestionIndex && currentQuestionOptions.length > 0) {
      const displayedSelections = currentQuestionOptions
        .map((option: Option, optionIndex: number) => ({ option, optionIndex }))
        .filter(({ option }) => isSelectionActive(option as SelectedOption))
        .map(({ option, optionIndex }) => ({
          ...(option as SelectedOption),
          optionId: option?.optionId ?? optionIndex,
          questionIndex: index,
          displayIndex: Number(
            (option as any)?.displayIndex ?? (option as any)?.index ?? optionIndex
          ),
          selected: true
        } as SelectedOption));

      if (displayedSelections.length > 0) {
        return pickRelevantSelections(displayedSelections);
      }
    }

    const serviceSelection = this.selectedOptionService?.selectedOptionsMap?.get(index);
    if (Array.isArray(serviceSelection) && serviceSelection.length > 0) {
      return pickRelevantSelections(serviceSelection);
    }

    const quizSelection = this.quizService?.selectedOptionsMap?.get(index);
    if (Array.isArray(quizSelection) && quizSelection.length > 0) {
      return pickRelevantSelections(quizSelection as SelectedOption[]);
    }

    if (index !== currentQuestionIndex) {
      const storedAnswerIds = Array.isArray(this.quizService?.userAnswers?.[index])
        ? (this.quizService.userAnswers[index] as number[]) : [];
      if (storedAnswerIds.length > 0 && Array.isArray(question?.options) && question!.options.length > 0) {
        const reconstructedSelections = storedAnswerIds
          .map((answerId: number) => {
            const directMatch = question!.options.find(
              (opt: Option) => String(opt?.optionId ?? '') === String(answerId)
            );
            if (directMatch) {
              return {
                ...directMatch,
                optionId: directMatch.optionId ?? answerId,
                questionIndex: index,
                selected: true
              } as SelectedOption;
            }

            if (Number.isInteger(answerId) && answerId >= 0 && answerId < question!.options.length) {
              return {
                ...question!.options[answerId],
                optionId: question!.options[answerId]?.optionId ?? answerId,
                questionIndex: index,
                displayIndex: answerId,
                selected: true
              } as SelectedOption;
            }

            return null;
          })
          .filter((selection): selection is SelectedOption => !!selection);

        if (reconstructedSelections.length > 0) {
          return reconstructedSelections;
        }
      }
    }

    return [];
  }

  // ═══════════════════════════════════════════════════════════════
  // LIVE SESSION STATE CHECK
  // ═══════════════════════════════════════════════════════════════

  hasLiveSessionStateForQuestion(quizId: string, index: number): boolean {
    const selectedViaService = this.selectedOptionService?.selectedOptionsMap?.get(index);
    if (Array.isArray(selectedViaService) && selectedViaService.length > 0) {
      return true;
    }

    const selectedViaQuiz = this.quizService?.selectedOptionsMap?.get(index);
    if (Array.isArray(selectedViaQuiz) && selectedViaQuiz.length > 0) {
      return true;
    }

    const scoringKey = this.getScoringKey(quizId, index);
    const score = this.quizService?.questionCorrectness?.get(scoringKey);
    if (score === true || score === false) return true;

    const answers = this.quizService?.userAnswers?.[index];
    return Array.isArray(answers) && answers.length > 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // QUIZ FRESH CHECK
  // ═══════════════════════════════════════════════════════════════

  isQuizFreshAtQuestionOne(currentQuestionIndex: number): boolean {
    if (currentQuestionIndex !== 0) return false;

    const hasSelectionsInSelectedOptionService =
      (this.selectedOptionService?.selectedOptionsMap?.size ?? 0) > 0
      || this.selectedOptionService?.hasRefreshBackup
      || (this.selectedOptionService?.clickConfirmedDotStatus?.size ?? 0) > 0;
    const hasSelectionsInQuizService =
      (this.quizService?.selectedOptionsMap?.size ?? 0) > 0;
    const hasScoredQuestions =
      (this.quizService?.questionCorrectness?.size ?? 0) > 0;
    const hasStoredUserAnswers =
      Array.isArray(this.quizService?.userAnswers) &&
      this.quizService.userAnswers.some((answers: unknown) =>
        Array.isArray(answers) && answers.length > 0
      );
    const hasStateServiceActivity =
      (this.quizStateService?._answeredQuestionIndices?.size ?? 0) > 0 ||
      (this.quizStateService?._hasUserInteracted?.size ?? 0) > 0;

    return !hasSelectionsInSelectedOptionService &&
      !hasSelectionsInQuizService &&
      !hasScoredQuestions &&
      !hasStoredUserAnswers &&
      !hasStateServiceActivity;
  }

  // ═══════════════════════════════════════════════════════════════
  // GET QUESTION STATUS (core dot status computation)
  // ═══════════════════════════════════════════════════════════════

  getQuestionStatusSimple(params: {
    index: number;
    quizId: string;
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestion: QuizQuestion | null;
    questionsArray: QuizQuestion[];
    options?: { forceRecompute?: boolean };
  }): 'correct' | 'wrong' | 'pending' {
    return this.getQuestionStatus({
      ...params,
      dotStatusCache: this.dotStatusCache,
      pendingDotStatusOverrides: this.pendingDotStatusOverrides,
      activeDotClickStatus: this.activeDotClickStatus
    });
  }

  getDotClassSimple(params: {
    index: number;
    quizId: string;
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestion: QuizQuestion | null;
    questionsArray: QuizQuestion[];
  }): string {
    return this.getDotClass({
      ...params,
      dotStatusCache: this.dotStatusCache,
      pendingDotStatusOverrides: this.pendingDotStatusOverrides,
      activeDotClickStatus: this.activeDotClickStatus,
      timerExpiredUnanswered: this.timerExpiredUnanswered
    });
  }

  getQuestionStatus(params: {
    index: number;
    quizId: string;
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestion: QuizQuestion | null;
    questionsArray: QuizQuestion[];
    dotStatusCache: Map<number, 'correct' | 'wrong' | 'pending'>;
    pendingDotStatusOverrides: Map<number, 'correct' | 'wrong'>;
    activeDotClickStatus: Map<number, 'correct' | 'wrong'>;
    options?: { forceRecompute?: boolean };
  }): 'correct' | 'wrong' | 'pending' {
    const {
      index, quizId, currentQuestionIndex, optionsToDisplay, currentQuestion,
      questionsArray, dotStatusCache, pendingDotStatusOverrides, activeDotClickStatus,
    } = params;

    // On refresh, restore dot color from clickConfirmedDotStatus (backed by sessionStorage)
    const confirmedForIndex = this.selectedOptionService.clickConfirmedDotStatus.get(index);
    if (
      (confirmedForIndex === 'correct' || confirmedForIndex === 'wrong') &&
      !pendingDotStatusOverrides.has(index) &&
      !activeDotClickStatus.has(index)
    ) {
      dotStatusCache.set(index, confirmedForIndex);
      return confirmedForIndex;
    }

    if (this.isQuizFreshAtQuestionOne(currentQuestionIndex)) {
      dotStatusCache.set(index, 'pending');
      return 'pending';
    }

    const pendingOverrideStatus = pendingDotStatusOverrides.get(index);
    const previousCached = dotStatusCache.get(index);
    const hasCachedStatus = dotStatusCache.has(index);

    const selectionParams = { index, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray };
    const selections = this.getSelectionsForQuestion(selectionParams);
    const questionHasLiveSessionState = this.hasLiveSessionStateForQuestion(quizId, index);

    if (hasCachedStatus) {
      const cached = dotStatusCache.get(index)!;
      const isCurrentQuestion = index === currentQuestionIndex;

      if (!params.options?.forceRecompute && !isCurrentQuestion && cached === 'correct') {
        return cached;
      }

      if (
        !params.options?.forceRecompute &&
        !isCurrentQuestion &&
        cached === 'pending' &&
        !questionHasLiveSessionState &&
        selections.length === 0
      ) {
        return cached;
      }
      if (!params.options?.forceRecompute && isCurrentQuestion && cached === 'pending') {
        return cached;
      }
    }

    // Early authoritative check for NON-CURRENT questions.
    if (index !== currentQuestionIndex) {
      const earlyScoringKey = this.getScoringKey(quizId, index);
      const earlyScored = this.quizService.questionCorrectness.get(earlyScoringKey);
      if (earlyScored === true) {
        dotStatusCache.set(index, 'correct');
        return 'correct';
      }
    }

    if (
      index === currentQuestionIndex &&
      !questionHasLiveSessionState &&
      selections.length === 0
    ) {
      if (previousCached === 'correct' || previousCached === 'wrong') {
        dotStatusCache.set(index, previousCached);
        return previousCached;
      }

      const localStatus = this.persistence.getPersistedDotStatus(quizId, index);
      if (localStatus === 'correct' || localStatus === 'wrong') {
        dotStatusCache.set(index, localStatus);
        return localStatus;
      }

      // Fallback: check clickConfirmedDotStatus (restored from sessionStorage on refresh)
      const confirmedStatus = this.selectedOptionService.clickConfirmedDotStatus.get(index);
      if (confirmedStatus === 'correct' || confirmedStatus === 'wrong') {
        dotStatusCache.set(index, confirmedStatus);
        this.persistence.setPersistedDotStatus(quizId, index, confirmedStatus);
        return confirmedStatus;
      }

      // Last resort: check sessionStorage directly
      try {
        const sessionVal = sessionStorage.getItem(SK_DOT_CONFIRMED + index);
        if (sessionVal === 'correct' || sessionVal === 'wrong') {
          dotStatusCache.set(index, sessionVal);
          this.persistence.setPersistedDotStatus(quizId, index, sessionVal);
          return sessionVal;
        }
      } catch { }

      dotStatusCache.set(index, 'pending');
      return 'pending';
    }

    const scoringKey = this.getScoringKey(quizId, index);
    const persistedScoredValues = [this.quizService.questionCorrectness.get(scoringKey)]
      .filter((value): value is boolean => value === true || value === false);
    const hasScoredState = persistedScoredValues.length > 0;
    const hasAuthoritativeCorrectState = persistedScoredValues.includes(true);

    const evalParams = { index, selections, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray };
    const evaluatedStatus = selections.length > 0
      ? this.evaluateSelectionCorrectness(evalParams)
      : null;
    const hasOptimisticCorrectSelection = selections.length > 0 &&
      this.hasOptimisticCorrectSelection({ ...evalParams, selections });

    const localStatus = this.persistence.getPersistedDotStatus(quizId, index);
    const question = this.getQuestionForIndex(index, questionsArray);
    const fallbackOptions = this.getFallbackOptions(index, currentQuestionIndex, optionsToDisplay, currentQuestion);
    const resolvedCorrectOptionCount = this.getResolvedCorrectOptionEntries(question, fallbackOptions).length;
    const isLiveMultiAnswerQuestion =
      index === currentQuestionIndex &&
      (questionHasLiveSessionState || selections.length > 0) &&
      (
        question?.type === QuestionType.MultipleAnswer ||
        resolvedCorrectOptionCount > 1
      );

    const activeClickStatus = activeDotClickStatus.get(index);

    if (isLiveMultiAnswerQuestion && activeClickStatus) {
      this.persistence.setPersistedDotStatus(quizId, index, activeClickStatus);
      pendingDotStatusOverrides.set(index, activeClickStatus);
      dotStatusCache.set(index, activeClickStatus);
      return activeClickStatus;
    }

    if (isLiveMultiAnswerQuestion && pendingOverrideStatus) {
      this.persistence.setPersistedDotStatus(quizId, index, pendingOverrideStatus);
      dotStatusCache.set(index, pendingOverrideStatus);
      return pendingOverrideStatus;
    }

    if (
      pendingOverrideStatus &&
      index === currentQuestionIndex
    ) {
      this.persistence.setPersistedDotStatus(quizId, index, pendingOverrideStatus);
      dotStatusCache.set(index, pendingOverrideStatus);
      return pendingOverrideStatus;
    }

    if (hasOptimisticCorrectSelection) {
      this.persistence.setPersistedDotStatus(quizId, index, 'correct');
      dotStatusCache.set(index, 'correct');
      return 'correct';
    }

    if (
      localStatus === 'wrong' &&
      evaluatedStatus !== true &&
      !hasAuthoritativeCorrectState
    ) {
      // Don't return 'wrong' if the most recent click was correct
      const clickConfirmedHere = this.selectedOptionService.clickConfirmedDotStatus.get(index);
      if (clickConfirmedHere === 'correct') {
        this.persistence.setPersistedDotStatus(quizId, index, 'correct');
        dotStatusCache.set(index, 'correct');
        return 'correct';
      }
      dotStatusCache.set(index, 'wrong');
      return 'wrong';
    }

    if (
      index === currentQuestionIndex &&
      isLiveMultiAnswerQuestion &&
      localStatus === 'correct'
    ) {
      dotStatusCache.set(index, 'correct');
      return 'correct';
    }

    if (
      index !== currentQuestionIndex &&
      localStatus === 'correct' &&
      (questionHasLiveSessionState || selections.length > 0)
    ) {
      dotStatusCache.set(index, 'correct');
      return 'correct';
    }

    if (
      index === currentQuestionIndex &&
      evaluatedStatus === false &&
      (questionHasLiveSessionState || selections.length > 0)
    ) {
      // The most recent click may be correct even though evaluateSelectionCorrectness
      // returns false (stale wrong selections still in the array).
      // Trust the per-click confirmed status over the aggregate evaluation.
      const clickConfirmed = this.selectedOptionService.clickConfirmedDotStatus.get(index);
      if (clickConfirmed === 'correct') {
        this.persistence.setPersistedDotStatus(quizId, index, 'correct');
        dotStatusCache.set(index, 'correct');
        return 'correct';
      }
      const lastClickedCorrect = this.selectedOptionService.lastClickedCorrectByQuestion.get(index);
      if (lastClickedCorrect === true) {
        this.persistence.setPersistedDotStatus(quizId, index, 'correct');
        dotStatusCache.set(index, 'correct');
        return 'correct';
      }
      this.persistence.setPersistedDotStatus(quizId, index, 'wrong');
      dotStatusCache.set(index, 'wrong');
      return 'wrong';
    }

    if (hasAuthoritativeCorrectState) {
      this.persistence.setPersistedDotStatus(quizId, index, 'correct');
      dotStatusCache.set(index, 'correct');
      return 'correct';
    }

    if (evaluatedStatus === true || evaluatedStatus === false) {
      const status: 'correct' | 'wrong' = evaluatedStatus ? 'correct' : 'wrong';
      this.persistence.setPersistedDotStatus(quizId, index, status);
      dotStatusCache.set(index, status);
      return status;
    }

    if (index !== currentQuestionIndex && localStatus === 'correct') {
      dotStatusCache.set(index, localStatus);
      return localStatus;
    }

    if (index !== currentQuestionIndex) {
      const persisted = this.quizService.questionCorrectness.get(scoringKey);
      if (persisted === true || persisted === false) {
        const status: 'correct' | 'wrong' = persisted ? 'correct' : 'wrong';
        this.persistence.setPersistedDotStatus(quizId, index, status);
        dotStatusCache.set(index, status);
        return status;
      }
    }

    if (!hasScoredState && evaluatedStatus === null) {
      if (previousCached === 'correct' || previousCached === 'wrong') {
        dotStatusCache.set(index, previousCached);
        return previousCached;
      }
      if (localStatus === 'correct' || localStatus === 'wrong') {
        dotStatusCache.set(index, localStatus);
        return localStatus;
      }
      const confirmed2 = this.selectedOptionService.clickConfirmedDotStatus.get(index);
      if (confirmed2 === 'correct' || confirmed2 === 'wrong') {
        dotStatusCache.set(index, confirmed2);
        return confirmed2;
      }
      dotStatusCache.set(index, 'pending');
      return 'pending';
    }

    if (localStatus === 'correct' && index !== currentQuestionIndex) {
      dotStatusCache.set(index, localStatus);
      return localStatus;
    }

    if (evaluatedStatus === true || evaluatedStatus === false) {
      const status: 'correct' | 'wrong' = evaluatedStatus ? 'correct' : 'wrong';
      this.persistence.setPersistedDotStatus(quizId, index, status);
      dotStatusCache.set(index, status);
      return status;
    }

    // Final fallback: check clickConfirmedDotStatus / sessionStorage
    const finalConfirmed = this.selectedOptionService.clickConfirmedDotStatus.get(index);
    if (finalConfirmed === 'correct' || finalConfirmed === 'wrong') {
      dotStatusCache.set(index, finalConfirmed);
      return finalConfirmed;
    }
    try {
      const sessionVal = sessionStorage.getItem(SK_DOT_CONFIRMED + index);
      if (sessionVal === 'correct' || sessionVal === 'wrong') {
        dotStatusCache.set(index, sessionVal);
        return sessionVal;
      }
    } catch {}

    return 'pending';
  }

  // ═══════════════════════════════════════════════════════════════
  // GET DOT CLASS
  // ═══════════════════════════════════════════════════════════════

  getDotClass(params: {
    index: number;
    quizId: string;
    currentQuestionIndex: number;
    optionsToDisplay: Option[];
    currentQuestion: QuizQuestion | null;
    questionsArray: QuizQuestion[];
    dotStatusCache: Map<number, 'correct' | 'wrong' | 'pending'>;
    pendingDotStatusOverrides: Map<number, 'correct' | 'wrong'>;
    activeDotClickStatus: Map<number, 'correct' | 'wrong'>;
    timerExpiredUnanswered: Set<number>;
  }): string {
    const {
      index, quizId, currentQuestionIndex, dotStatusCache,
      pendingDotStatusOverrides, activeDotClickStatus, timerExpiredUnanswered,
    } = params;

    if (index === currentQuestionIndex) {
      const lastClickedCorrect = this.selectedOptionService.lastClickedCorrectByQuestion.get(index);
      if (lastClickedCorrect !== undefined) {
        return `${lastClickedCorrect ? 'correct' : 'wrong'} current`;
      }

      const activeClickStatus = activeDotClickStatus.get(index);
      if (activeClickStatus) return `${activeClickStatus} current`;

      const pendingOverrideStatus = pendingDotStatusOverrides.get(index);
      if (pendingOverrideStatus) return `${pendingOverrideStatus} current`;

      if (!this.quizStateService.hasUserInteracted(index)) {
        // On refresh, interaction state is lost — check clickConfirmedDotStatus (from sessionStorage)
        const confirmedStatus = this.selectedOptionService.clickConfirmedDotStatus.get(index);
        if (confirmedStatus === 'correct' || confirmedStatus === 'wrong') {
          return `${confirmedStatus} current`;
        }
        if (timerExpiredUnanswered.has(index)) return 'pending';
        
        return 'current';
      }

      const cachedStatus = dotStatusCache.get(index);
      if (cachedStatus && cachedStatus !== 'pending') {
        return `${cachedStatus} current`;
      }

      const persistedStatus = this.persistence.getPersistedDotStatus(quizId, index);
      if (persistedStatus === 'correct' || persistedStatus === 'wrong') {
        return `${persistedStatus} current`;
      }

      if (timerExpiredUnanswered.has(index)) return 'pending';

      return 'current';
    }

    // Non-current question
    if (timerExpiredUnanswered.has(index)) return 'pending';

    const scoringKey = this.getScoringKey(quizId, index);
    const scoredCorrect = this.quizService.questionCorrectness.get(scoringKey);
    const persisted = this.persistence.getPersistedDotStatus(quizId, index);
    const confirmed = this.selectedOptionService.clickConfirmedDotStatus.get(index);
    const ssStored = (() => {
      try {
        return sessionStorage.getItem(SK_DOT_CONFIRMED + index);
      } catch {
        return null;
      }
    })();

    // 1. Ground truth: questionCorrectness
    if (scoredCorrect === true) return 'correct';

    // 2. Persisted dot status (localStorage)
    if (persisted === 'correct') return 'correct';

    // 3. clickConfirmedDotStatus (in-memory or sessionStorage fallback)
    if (confirmed) return confirmed;
    if (ssStored === 'correct' || ssStored === 'wrong') {
      this.selectedOptionService.clickConfirmedDotStatus.set(index, ssStored);
      return ssStored;
    }

    // 4. Explicit wrong from scoring
    if (scoredCorrect === false) return 'wrong';
    if (persisted === 'wrong') return 'wrong';

    // 5. Fallback
    const status = this.getQuestionStatus({ ...params, options: undefined });
    return status;
  }

  // ═══════════════════════════════════════════════════════════════
  // PROGRESS COMPUTATION
  // ═══════════════════════════════════════════════════════════════

  computeTotalCount(
    totalQuestions: number,
    serviceQuestionsLength: number,
    quizQuestionsLength: number
  ): number {
    if (totalQuestions > 0) return totalQuestions;
    if (serviceQuestionsLength > 0) return serviceQuestionsLength;
    return quizQuestionsLength;
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════

  private getFallbackOptions(
    index: number,
    currentQuestionIndex: number,
    optionsToDisplay: Option[],
    currentQuestion: QuizQuestion | null
  ): Option[] {
    return index === currentQuestionIndex
      ? ((Array.isArray(optionsToDisplay) && optionsToDisplay.length > 0)
          ? optionsToDisplay
          : (Array.isArray(currentQuestion?.options) ? currentQuestion!.options as Option[] : []))
      : [];
  }
}
