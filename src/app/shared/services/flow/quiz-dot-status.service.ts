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

import { isOptionCorrect } from '../../utils/is-option-correct';
import { norm } from '../../utils/text-norm';

type DotStatus = 'correct' | 'wrong' | 'pending';
type DotResolved = 'correct' | 'wrong';

/** Threaded context for the scored-status decision branches of getQuestionStatus. */
interface ScoredDotCtx {
  index: number;
  quizId: string;
  currentQuestionIndex: number;
  dotStatusCache: Map<number, DotStatus>;
  pendingDotStatusOverrides: Map<number, DotResolved>;
  pendingOverrideStatus: DotResolved | undefined;
  previousCached: DotStatus | undefined;
  selections: Array<SelectedOption | Option>;
  questionHasLiveSessionState: boolean;
  scoringKey: any;
  hasScoredState: boolean;
  hasAuthoritativeCorrectState: boolean;
  evaluatedStatus: boolean | null;
  hasOptimisticCorrectSelection: boolean;
  localStatus: DotResolved | null;
  isLiveMultiAnswerQuestion: boolean;
  activeClickStatus: DotResolved | undefined;
}

/** Public input shape for getQuestionStatus. */
interface GetQuestionStatusParams {
  index: number;
  quizId: string;
  currentQuestionIndex: number;
  optionsToDisplay: Option[];
  currentQuestion: QuizQuestion | null;
  questionsArray: QuizQuestion[];
  dotStatusCache: Map<number, DotStatus>;
  pendingDotStatusOverrides: Map<number, DotResolved>;
  activeDotClickStatus: Map<number, DotResolved>;
  options?: { forceRecompute?: boolean };
}

/** Inputs to the scored-status phase (after the early exits). */
interface ScoredDotParams {
  index: number;
  quizId: string;
  currentQuestionIndex: number;
  optionsToDisplay: Option[];
  currentQuestion: QuizQuestion | null;
  questionsArray: QuizQuestion[];
  selections: Array<SelectedOption | Option>;
  questionHasLiveSessionState: boolean;
  pendingOverrideStatus: DotResolved | undefined;
  previousCached: DotStatus | undefined;
  dotStatusCache: Map<number, DotStatus>;
  pendingDotStatusOverrides: Map<number, DotResolved>;
  activeDotClickStatus: Map<number, DotResolved>;
}

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

    const normalize = (value: unknown): string => norm(value);
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

        const text = norm(answer.text);
        if (text) correctTexts.add(text);
      }
    }

    const resolvedFromAnswers = options
      .map((opt: Option, index: number) => ({ option: opt, index }))
      .filter(({ option }) => {
        const id = Number(option?.optionId);
        const text = norm(option?.text);

        return (!Number.isNaN(id) && correctIds.has(id)) || (!!text && correctTexts.has(text));
      });

    if (resolvedFromAnswers.length > 0) return resolvedFromAnswers;

    return options
      .map((opt: Option, index: number) => ({ option: opt, index }))
      .filter(({ option }) => isOptionCorrect(option));
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

    const normalize = (value: unknown): string => norm(value);
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

  getQuestionStatus(params: GetQuestionStatusParams): DotStatus {
    const {
      index, quizId, currentQuestionIndex, optionsToDisplay, currentQuestion,
      questionsArray, dotStatusCache, pendingDotStatusOverrides, activeDotClickStatus,
    } = params;
    const forceRecompute = !!params.options?.forceRecompute;

    // On refresh, restore dot color from clickConfirmedDotStatus (sessionStorage-backed).
    const r1 = this.tryConfirmedOnRefresh(index, pendingDotStatusOverrides, activeDotClickStatus, dotStatusCache);
    if (r1) return r1;

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

    const r2 = this.tryCachedShortCircuit({
      index, currentQuestionIndex, forceRecompute, dotStatusCache,
      hasCachedStatus, questionHasLiveSessionState, selections,
    });
    if (r2) return r2;

    const r3 = this.tryEarlyAuthoritativeNonCurrent(index, quizId, currentQuestionIndex, dotStatusCache);
    if (r3) return r3;

    if (index === currentQuestionIndex && !questionHasLiveSessionState && selections.length === 0) {
      return this.resolveCurrentNoSelection(index, quizId, previousCached, dotStatusCache);
    }

    return this.resolveScoredDotStatus({
      index, quizId, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray,
      selections, questionHasLiveSessionState, pendingOverrideStatus, previousCached,
      dotStatusCache, pendingDotStatusOverrides, activeDotClickStatus,
    });
  }

  /** Refresh-restore: confirmed dot color when no pending/active override exists. Extracted verbatim. */
  private tryConfirmedOnRefresh(
    index: number,
    pendingDotStatusOverrides: Map<number, DotResolved>,
    activeDotClickStatus: Map<number, DotResolved>,
    dotStatusCache: Map<number, DotStatus>
  ): DotStatus | null {
    const confirmedForIndex = this.selectedOptionService.clickConfirmedDotStatus.get(index);
    if (
      (confirmedForIndex === 'correct' || confirmedForIndex === 'wrong') &&
      !pendingDotStatusOverrides.has(index) &&
      !activeDotClickStatus.has(index)
    ) {
      dotStatusCache.set(index, confirmedForIndex);
      return confirmedForIndex;
    }
    return null;
  }

  /** Short-circuit on a usable cached status (unless forceRecompute). Extracted verbatim. */
  private tryCachedShortCircuit(p: {
    index: number;
    currentQuestionIndex: number;
    forceRecompute: boolean;
    dotStatusCache: Map<number, DotStatus>;
    hasCachedStatus: boolean;
    questionHasLiveSessionState: boolean;
    selections: Array<SelectedOption | Option>;
  }): DotStatus | null {
    if (!p.hasCachedStatus) return null;
    const cached = p.dotStatusCache.get(p.index)!;
    const isCurrentQuestion = p.index === p.currentQuestionIndex;

    if (!p.forceRecompute && !isCurrentQuestion && cached === 'correct') {
      return cached;
    }
    if (
      !p.forceRecompute &&
      !isCurrentQuestion &&
      cached === 'pending' &&
      !p.questionHasLiveSessionState &&
      p.selections.length === 0
    ) {
      return cached;
    }
    if (!p.forceRecompute && isCurrentQuestion && cached === 'pending') {
      return cached;
    }
    return null;
  }

  /** Early authoritative-correct check for non-current questions. Extracted verbatim. */
  private tryEarlyAuthoritativeNonCurrent(
    index: number,
    quizId: string,
    currentQuestionIndex: number,
    dotStatusCache: Map<number, DotStatus>
  ): DotStatus | null {
    if (index !== currentQuestionIndex) {
      const earlyScoringKey = this.getScoringKey(quizId, index);
      const earlyScored = this.quizService.questionCorrectness.get(earlyScoringKey);
      if (earlyScored === true) {
        dotStatusCache.set(index, 'correct');
        return 'correct';
      }
    }
    return null;
  }

  /**
   * Current question with no live state and no selections: restore from cache,
   * persisted dot status, confirmed status, then sessionStorage; else pending.
   * Extracted verbatim.
   */
  private resolveCurrentNoSelection(
    index: number,
    quizId: string,
    previousCached: DotStatus | undefined,
    dotStatusCache: Map<number, DotStatus>
  ): DotStatus {
    if (previousCached === 'correct' || previousCached === 'wrong') {
      dotStatusCache.set(index, previousCached);
      return previousCached;
    }

    const localStatus = this.persistence.getPersistedDotStatus(quizId, index);
    if (localStatus === 'correct' || localStatus === 'wrong') {
      dotStatusCache.set(index, localStatus);
      return localStatus;
    }

    // Fallback: clickConfirmedDotStatus (restored from sessionStorage on refresh).
    const confirmedStatus = this.selectedOptionService.clickConfirmedDotStatus.get(index);
    if (confirmedStatus === 'correct' || confirmedStatus === 'wrong') {
      dotStatusCache.set(index, confirmedStatus);
      this.persistence.setPersistedDotStatus(quizId, index, confirmedStatus);
      return confirmedStatus;
    }

    // Last resort: sessionStorage directly.
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

  /**
   * Build the scoring/evaluation context, then run the decision branches in
   * order: overrides -> selection-based -> authoritative/eval fallbacks.
   * Extracted verbatim.
   */
  private resolveScoredDotStatus(p: ScoredDotParams): DotStatus {
    const ctx = this.buildScoredDotCtx(p);
    return this.resolveOverrideDotStatus(ctx)
      ?? this.resolveSelectionDotStatus(ctx)
      ?? this.resolveAuthoritativeDotStatus(ctx)
      ?? this.resolveUnscoredFallbackDotStatus(ctx);
  }

  /** Compute the scoring/evaluation context for the decision branches. Extracted verbatim. */
  private buildScoredDotCtx(p: ScoredDotParams): ScoredDotCtx {
    const {
      index, quizId, currentQuestionIndex, optionsToDisplay, currentQuestion, questionsArray,
      selections, questionHasLiveSessionState, pendingOverrideStatus, previousCached,
      dotStatusCache, pendingDotStatusOverrides, activeDotClickStatus,
    } = p;

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

    return {
      index, quizId, currentQuestionIndex, dotStatusCache, pendingDotStatusOverrides,
      pendingOverrideStatus, previousCached, selections, questionHasLiveSessionState,
      scoringKey, hasScoredState, hasAuthoritativeCorrectState, evaluatedStatus,
      hasOptimisticCorrectSelection, localStatus, isLiveMultiAnswerQuestion, activeClickStatus,
    };
  }

  /** setPersistedDotStatus + cache + return. Extracted (common to the scored branches). */
  private persistAndCache(c: ScoredDotCtx, status: DotResolved): DotResolved {
    this.persistence.setPersistedDotStatus(c.quizId, c.index, status);
    c.dotStatusCache.set(c.index, status);
    return status;
  }

  /** Cache + return (no persistence write). Extracted (common to the scored branches). */
  private cacheAndReturn(c: ScoredDotCtx, status: DotStatus): DotStatus {
    c.dotStatusCache.set(c.index, status);
    return status;
  }

  /** When the last click for this index was confirmed correct, persist+cache+return 'correct'. Extracted verbatim. */
  private tryClickConfirmedCorrect(c: ScoredDotCtx): DotResolved | null {
    const clickConfirmed = this.selectedOptionService.clickConfirmedDotStatus.get(c.index);
    if (clickConfirmed === 'correct') {
      return this.persistAndCache(c, 'correct');
    }
    return null;
  }

  /** Live-multi active/pending and current-question pending overrides. Extracted verbatim. */
  private resolveOverrideDotStatus(c: ScoredDotCtx): DotStatus | null {
    if (c.isLiveMultiAnswerQuestion && c.activeClickStatus) {
      this.persistence.setPersistedDotStatus(c.quizId, c.index, c.activeClickStatus);
      c.pendingDotStatusOverrides.set(c.index, c.activeClickStatus);
      c.dotStatusCache.set(c.index, c.activeClickStatus);
      return c.activeClickStatus;
    }
    if (c.isLiveMultiAnswerQuestion && c.pendingOverrideStatus) {
      return this.persistAndCache(c, c.pendingOverrideStatus);
    }
    if (c.pendingOverrideStatus && c.index === c.currentQuestionIndex) {
      return this.persistAndCache(c, c.pendingOverrideStatus);
    }
    return null;
  }

  /** Selection-driven branches: optimistic-correct, local-wrong, live-multi/non-current correct, eval-false. Extracted verbatim. */
  private resolveSelectionDotStatus(c: ScoredDotCtx): DotStatus | null {
    if (c.hasOptimisticCorrectSelection) {
      return this.persistAndCache(c, 'correct');
    }

    if (c.localStatus === 'wrong' && c.evaluatedStatus !== true && !c.hasAuthoritativeCorrectState) {
      // Don't return 'wrong' if the most recent click was correct.
      return this.tryClickConfirmedCorrect(c) ?? this.cacheAndReturn(c, 'wrong');
    }

    if (c.index === c.currentQuestionIndex && c.isLiveMultiAnswerQuestion && c.localStatus === 'correct') {
      return this.cacheAndReturn(c, 'correct');
    }

    if (
      c.index !== c.currentQuestionIndex &&
      c.localStatus === 'correct' &&
      (c.questionHasLiveSessionState || c.selections.length > 0)
    ) {
      return this.cacheAndReturn(c, 'correct');
    }

    if (
      c.index === c.currentQuestionIndex &&
      c.evaluatedStatus === false &&
      (c.questionHasLiveSessionState || c.selections.length > 0)
    ) {
      return this.resolveCurrentEvalFalse(c);
    }
    return null;
  }

  /**
   * Current question with eval-false: trust the per-click confirmed / last-clicked
   * correct over the aggregate evaluation; otherwise 'wrong'. Extracted verbatim.
   */
  private resolveCurrentEvalFalse(c: ScoredDotCtx): DotResolved {
    const confirmed = this.tryClickConfirmedCorrect(c);
    if (confirmed) return confirmed;
    const lastClickedCorrect = this.selectedOptionService.lastClickedCorrectByQuestion.get(c.index);
    if (lastClickedCorrect === true) {
      return this.persistAndCache(c, 'correct');
    }
    return this.persistAndCache(c, 'wrong');
  }

  /**
   * Authoritative-correct, evaluated, and non-current persisted branches; returns
   * null to fall through to the unscored fallbacks. Extracted verbatim.
   */
  private resolveAuthoritativeDotStatus(c: ScoredDotCtx): DotStatus | null {
    if (c.hasAuthoritativeCorrectState) {
      return this.persistAndCache(c, 'correct');
    }
    if (c.evaluatedStatus === true || c.evaluatedStatus === false) {
      return this.persistAndCache(c, c.evaluatedStatus ? 'correct' : 'wrong');
    }
    if (c.index !== c.currentQuestionIndex && c.localStatus === 'correct') {
      return this.cacheAndReturn(c, c.localStatus);
    }
    if (c.index !== c.currentQuestionIndex) {
      const persisted = this.quizService.questionCorrectness.get(c.scoringKey);
      if (persisted === true || persisted === false) {
        return this.persistAndCache(c, persisted ? 'correct' : 'wrong');
      }
    }
    return null;
  }

  /**
   * Unscored fallbacks: a no-eval restore, a non-current local-correct, a final
   * eval pass, then clickConfirmedDotStatus / sessionStorage, then 'pending'.
   * Always returns. Extracted verbatim.
   */
  private resolveUnscoredFallbackDotStatus(c: ScoredDotCtx): DotStatus {
    if (!c.hasScoredState && c.evaluatedStatus === null) {
      return this.resolveUnscoredNoEval(c);
    }
    if (c.localStatus === 'correct' && c.index !== c.currentQuestionIndex) {
      return this.cacheAndReturn(c, c.localStatus);
    }
    if (c.evaluatedStatus === true || c.evaluatedStatus === false) {
      return this.persistAndCache(c, c.evaluatedStatus ? 'correct' : 'wrong');
    }
    const finalConfirmed = this.selectedOptionService.clickConfirmedDotStatus.get(c.index);
    if (finalConfirmed === 'correct' || finalConfirmed === 'wrong') {
      return this.cacheAndReturn(c, finalConfirmed);
    }
    try {
      const sessionVal = sessionStorage.getItem(SK_DOT_CONFIRMED + c.index);
      if (sessionVal === 'correct' || sessionVal === 'wrong') {
        return this.cacheAndReturn(c, sessionVal);
      }
    } catch {}

    return 'pending';
  }

  /** No-scored-state, no-eval restore: previous cache, persisted, confirmed, else pending. Extracted verbatim. */
  private resolveUnscoredNoEval(c: ScoredDotCtx): DotStatus {
    if (c.previousCached === 'correct' || c.previousCached === 'wrong') {
      return this.cacheAndReturn(c, c.previousCached);
    }
    if (c.localStatus === 'correct' || c.localStatus === 'wrong') {
      return this.cacheAndReturn(c, c.localStatus);
    }
    const confirmed2 = this.selectedOptionService.clickConfirmedDotStatus.get(c.index);
    if (confirmed2 === 'correct' || confirmed2 === 'wrong') {
      return this.cacheAndReturn(c, confirmed2);
    }
    return this.cacheAndReturn(c, 'pending');
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
