import { Injectable, inject } from '@angular/core';

import { QuestionType } from '../../../models/question-type.enum';

import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

/**
 * Result of resolving correct indices for a question.
 */
export interface CorrectIndicesResult {
  /** 0-based indices of correct options in display order */
  correctIndices: number[];
  /** Total correct count */
  correctCount: number;
  /** Whether multi-answer mode should be used */
  isMultiMode: boolean;
}

/**
 * State snapshot for multi-answer click processing.
 */
export interface MultiAnswerClickState {
  /** The clicked option's display index */
  clickedIndex: number;
  /** Whether the clicked option is correct */
  isClickedCorrect: boolean;
  /** Number of correct options selected so far */
  correctSelected: number;
  /** Number of incorrect options selected so far */
  incorrectSelected: number;
  /** Remaining correct answers to find */
  remaining: number;
  /** 1-based correct option indices for display */
  correctIndices1Based: number[];
}

/**
 * Computed binding state for multi-answer after a click.
 */
export interface MultiAnswerBindingUpdate {
  isSelected: boolean;
  isCorrect: boolean;
  disabled: boolean;
  optionOverrides: {
    correct: boolean;
    selected: boolean;
    highlight: boolean;
    showIcon: boolean;
  };
}

/**
 * Input context for disabled-state computation, supplied by the component.
 */
export interface DisabledStateContext {
  currentQuestionIndex: number;
  isMultiMode: boolean;
  forceDisableAll: boolean;
  disabledOptionsPerQuestion: Map<number, Set<number>>;
  lockedIncorrectOptionIds: Set<number>;
  flashDisabledSet: Set<number>;
}

@Injectable({ providedIn: 'root' })
export class OptionClickHandlerService {
  // ── injects ─────────────────────────────────────────────────────
  private quizService = inject(QuizService);
  private selectedOptionService = inject(SelectedOptionService);

  // ── public methods ──────────────────────────────────────────────

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Correct Indices Resolution
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Resolves the correct option indices for a question, cross-referencing
   * multiple data sources for accuracy.
   */
  resolveCorrectIndices(
    question: QuizQuestion | null,
    _questionIndex: number,
    isMultiModeFromComponent: boolean,
    typeFromComponent: string
  ): CorrectIndicesResult {
    const isCorrectFlag = isOptionCorrect;

    const questionOpts = question?.options ?? [];

    // SOURCE 1: Current question options
    const fromCurrentQ = questionOpts
      .map((o: any, idx: number) => isCorrectFlag(o) ? idx : -1)
      .filter((idx: number) => idx >= 0);

    // SOURCE 2: Raw _questions data for cross-reference
    const rawQs: any[] = (this.quizService as any)._questions ?? [];
    const qText = norm(question?.questionText);
    let fromRaw: number[] = [];
    for (const rq of rawQs) {
      if (norm(rq.questionText) === qText) {
        const rawCorrectTexts = new Set<string>(
          (rq.options ?? []).filter((o: any) => isOptionCorrect(o)).map((o: any) => norm(o.text))
        );
        fromRaw = questionOpts
          .map((o: any, idx: number) => rawCorrectTexts.has(norm(o.text)) ? idx : -1)
          .filter((idx: number) => idx >= 0);
        break;
      }
    }

    // SOURCE 3: Pristine quizInitialState â€” most reliable, never mutated
    let fromPristine: number[] = [];
    if (qText) {
      try {
        const bundle = this.quizService?.quizInitialState ?? [];
        for (const quiz of bundle) {
          for (const pq of (quiz?.questions ?? [])) {
            if (norm(pq?.questionText) !== qText) continue;
            const pristineCorrectTexts = new Set<string>(
              (pq?.options ?? [])
                .filter((o: any) => isOptionCorrect(o))
                .map((o: any) => norm(o?.text))
            );
            fromPristine = questionOpts
              .map((o: any, idx: number) => pristineCorrectTexts.has(norm(o?.text)) ? idx : -1)
              .filter((idx: number) => idx >= 0);
            break;
          }
          if (fromPristine.length > 0) break;
        }
      } catch { /* ignore */ }
    }

    const correctIndices = fromPristine.length > 0 ? fromPristine : (fromRaw.length > 0 ? fromRaw : fromCurrentQ);
    const correctCount = correctIndices.length;
    const isMultiMode = isMultiModeFromComponent || typeFromComponent === 'multiple' || correctCount > 1;

    return { correctIndices, correctCount, isMultiMode };
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Multi-Answer Click State
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Computes the multi-answer state after a click, given the durable
   * selection set and correct indices.
   */
  computeMultiAnswerClickState(
    clickedIndex: number,
    durableSet: Set<number>,
    correctIndices: number[]
  ): MultiAnswerClickState {
    const correctSet = new Set(correctIndices);
    const isClickedCorrect = correctSet.has(clickedIndex);

    let correctSelected = 0;
    let incorrectSelected = 0;
    for (const selIdx of durableSet) {
      if (correctSet.has(selIdx)) correctSelected++;
      else incorrectSelected++;
    }

    const remaining = Math.max(correctIndices.length - correctSelected, 0);
    const correctIndices1Based = correctIndices.map(i => i + 1);

    return {
      clickedIndex,
      isClickedCorrect,
      correctSelected,
      incorrectSelected,
      remaining,
      correctIndices1Based
    };
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Multi-Answer Feedback Text
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Generates the feedback text for a multi-answer click.
   */
  generateMultiAnswerFeedbackText(state: MultiAnswerClickState): string {
    if (state.isClickedCorrect) {
      if (state.remaining === 0) {
        const optsList = state.correctIndices1Based.length > 1
          ? `Options ${state.correctIndices1Based.slice(0, -1).join(', ')} and ${state.correctIndices1Based[state.correctIndices1Based.length - 1]}`
          : `Option ${state.correctIndices1Based[0]}`;
        return state.correctIndices1Based.length > 1
          ? `You're right! The correct answers are ${optsList}.`
          : `You're right! The correct answer is ${optsList}.`;
      } else {
        const remTxt = state.remaining === 1 ? '1 more correct answer' : `${state.remaining} more correct answers`;
        return `That's correct! Please select ${remTxt}.`;
      }
    } else {
      return 'Not this one, try again!';
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Multi-Answer Binding Updates
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Computes what each binding should look like after a multi-answer click.
   */
  computeMultiAnswerBindingUpdates(
    bindingsCount: number,
    durableSet: Set<number>,
    correctIndices: number[],
    disabledSet: Set<number>
  ): MultiAnswerBindingUpdate[] {
    const correctSet = new Set(correctIndices);
    const updates: MultiAnswerBindingUpdate[] = [];

    for (let bi = 0; bi < bindingsCount; bi++) {
      const isInDurable = durableSet.has(bi);
      const isCorrect = correctSet.has(bi);
      updates.push({
        isSelected: isInDurable,
        isCorrect,
        disabled: disabledSet.has(bi),
        optionOverrides: {
          correct: isCorrect,
          selected: isInDurable,
          highlight: isInDurable,
          showIcon: isInDurable
        }
      });
    }

    return updates;
  }

  /**
   * Updates the disabled set for a multi-answer click.
   * Disables incorrect clicks and all incorrect options when all correct are found.
   */
  updateDisabledSet(
    disabledSet: Set<number>,
    clickedIndex: number,
    isClickedCorrect: boolean,
    remaining: number,
    bindingsCount: number,
    correctIndices: number[]
  ): void {
    const correctSet = new Set(correctIndices);

    if (!isClickedCorrect) disabledSet.add(clickedIndex);
    // When all correct answers selected, disable ALL incorrect options.
    // PRISTINE GUARD: before triggering the disable-all branch, sanity-
    // check correctIndices.length against quizInitialState. If pristine
    // shows more correct options than we have here, the upstream count
    // was undercounted (stale binding flags) and remaining=0 fired
    // prematurely. Abort to prevent locking the OTHER unselected correct
    // option(s).
    if (remaining === 0) {
      try {
        const isShuffled = this.quizService?.isShuffleEnabled?.() &&
          this.quizService?.shuffledQuestions?.length > 0;
        const liveIdx = this.quizService?.getCurrentQuestionIndex?.() ?? 0;
        const liveQ: any = isShuffled
          ? this.quizService?.getQuestionsInDisplayOrder?.()?.[liveIdx]
            ?? this.quizService?.shuffledQuestions?.[liveIdx]
          : this.quizService?.questions?.[liveIdx];
        const liveQText = norm(liveQ?.questionText);
        if (liveQText) {
          const bundle = this.quizService?.quizInitialState ?? [];
          for (const quiz of bundle) {
            for (const pq of (quiz?.questions ?? [])) {
              if (norm(pq?.questionText) !== liveQText) continue;
              const pristineCorrectCount = (pq?.options ?? []).filter(
                (o: any) => isOptionCorrect(o)
              ).length;
              if (pristineCorrectCount > correctIndices.length) {
                // Pristine has more correct than passed-in correctIndices.
                // This is the undercounted case â€” bail without locking.
                return;
              }
              break;
            }
          }
        }
      } catch { /* fall through to original disable-all */ }

      for (let bi = 0; bi < bindingsCount; bi++) {
        if (!correctSet.has(bi)) disabledSet.add(bi);
      }
    }
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Single-Answer Feedback Override
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * For single-answer mode, verifies and potentially overrides the feedback
   * config for multi-answer edge cases detected from binding state.
   */
  overrideMultiAnswerFeedback(
    cfg: FeedbackProps,
    clickedBinding: OptionBindings,
    optionBindings: OptionBindings[]
  ): FeedbackProps {
    const isCorrectFlag = isOptionCorrect;

    // RESOLVE: optionBindings may be a signal (-clean) or plain array (-main)
    const _rawOb = optionBindings as any;
    const _ob: any[] = typeof _rawOb === 'function' ? (_rawOb() ?? []) : (_rawOb ?? []);
    const correctCountFromBindings = _ob.filter((b: any) => isCorrectFlag(b.option)).length;
    if (correctCountFromBindings <= 1) return cfg;

    const isClickedCorrect = isCorrectFlag(clickedBinding.option);
    const correctIdxs: number[] = [];
    let correctSelected = 0;
    let incorrectSelected = 0;

    for (let bi = 0; bi < _ob.length; bi++) {
      const b = _ob[bi];
      const bCorrect = isCorrectFlag(b.option);
      if (bCorrect) correctIdxs.push(bi + 1);
      if (b.isSelected || b.option?.selected) {
        if (bCorrect) correctSelected++;
        else incorrectSelected++;
      }
    }

    const totalCorrect = correctIdxs.length;
    const remaining = Math.max(totalCorrect - correctSelected, 0);

    if (isClickedCorrect) {
      if (remaining === 0 && incorrectSelected === 0) {
        const optionsList = correctIdxs.length > 1
          ? `Options ${correctIdxs.slice(0, -1).join(', ')} and ${correctIdxs[correctIdxs.length - 1]}`
          : `Option ${correctIdxs[0]}`;
        return {
          ...cfg,
          feedback: correctIdxs.length > 1
            ? `You're right! The correct answers are ${optionsList}.`
            : `You're right! The correct answer is ${optionsList}.`
        };
      } else if (remaining > 0) {
        const remText = remaining === 1 ? '1 more correct answer' : `${remaining} more correct answers`;
        return { ...cfg, feedback: `That's correct! Please select ${remText}.` };
      }
    } else {
      return { ...cfg, feedback: 'Not this one, try again!' };
    }

    return cfg;
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Disabled State Computation
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Computes whether an option should be disabled, given the component's
   * current state context. Pure decision logic â€” no side effects.
   */
  computeDisabledState(
    option: Option,
    index: number,
    ctx: DisabledStateContext
  ): boolean {
    const { currentQuestionIndex: qIndex, isMultiMode, forceDisableAll,
            disabledOptionsPerQuestion, lockedIncorrectOptionIds, flashDisabledSet } = ctx;
    const lockId = (option?.optionId != null && Number(option.optionId) !== -1)
      ? option.optionId : index;

    // Detect multi-answer from data as well as the context flag â€” isMultiMode
    // can be stale/false during initialization before runIsMultiMode computes.
    let effectiveMulti = isMultiMode;
    if (!effectiveMulti) {
      try {
        const isShuffledChk = this.quizService?.isShuffleEnabled?.() &&
          this.quizService?.shuffledQuestions?.length > 0;
        const qSrc = isShuffledChk
          ? this.quizService?.getQuestionsInDisplayOrder?.() ?? this.quizService.shuffledQuestions
          : this.quizService?.questions;
        const chkQ = qSrc?.[qIndex] ?? null;
        const chkCorrectCount = (chkQ?.options ?? []).filter(
          (o: any) => isOptionCorrect(o)
        ).length;
        if (chkCorrectCount > 1) effectiveMulti = true;
      } catch { /* ignore */ }
    }

    // Multi-answer: only use the explicit disabledOptionsPerQuestion set
    // and forceDisableAll. Lock services can cross-contaminate.
    if (effectiveMulti) {
      if (forceDisableAll) return true;
      const disabledSet = disabledOptionsPerQuestion.get(qIndex);
      return !!(disabledSet && disabledSet.has(index));
    }

    // Correct options should NOT be disabled while the user is still selecting.
    const isCorrectOpt = isOptionCorrect(option);
    if (isCorrectOpt && !forceDisableAll) {
      const isShuffled = this.quizService?.isShuffleEnabled?.() &&
        this.quizService?.shuffledQuestions?.length > 0;
      const questionSource = isShuffled
        ? this.quizService.shuffledQuestions
        : this.quizService?.questions;
      const currentQ = questionSource?.[qIndex] ?? null;
      const questionCorrectCount = (currentQ?.options ?? []).filter(
        (o: any) => isOptionCorrect(o)
      ).length;
      const isMultiFromData = questionCorrectCount > 1;

      if (isMultiFromData) {
        const isFullyResolved = this.quizService._multiAnswerPerfect.get(qIndex) === true;
        if (!isFullyResolved) return false;
      } else {
        return false;
      }
    }

    // SINGLE-ANSWER GUARD: while no correct option has been selected for this
    // question, every option must remain clickable so the user can recover
    // from a wrong pick. The downstream lock signals (disabledBySet,
    // optionLocked, lockedIncorrectOptionIds, flashDisabled) occasionally
    // leak true on incorrect-only single-answer clicks; bypass them here
    // until the user actually picks the correct answer.
    //
    // PRISTINE-FIRST: read correct flags from quizInitialState (the
    // immutable structuredClone of QUIZ_DATA) since live quizService
    // .questions[].options[].correct can get mutated during gameplay,
    // making the size===1 gate fail on Q3/Q5+ even though pristine
    // clearly shows one correct option.
    if (!forceDisableAll) {
      try {
        const saSelections =
          this.selectedOptionService.getSelectedOptionsForQuestion(qIndex) ?? [];
        const isShuffledSA = this.quizService?.isShuffleEnabled?.() &&
          this.quizService?.shuffledQuestions?.length > 0;
        const liveSAQ = isShuffledSA
          ? this.quizService?.getQuestionsInDisplayOrder?.()?.[qIndex]
            ?? this.quizService?.shuffledQuestions?.[qIndex]
          : this.quizService?.questions?.[qIndex];
        const correctTextsSA =
          this.quizService.getPristineCorrectTextsForQuestion(liveSAQ?.questionText);
        // anyCorrectSelected: trust the selection's own `correct` flag
        // (spread from the canonical binding option) as a fallback when
        // the cache misses â€” stale questionText on Q3+ would otherwise
        // wrongly leave siblings clickable after a real correct pick.
        const anyCorrectSelected = saSelections.some((s: any) => {
          if (isOptionCorrect(s)) {
            return true;
          }
          return correctTextsSA.has(norm(s?.text));
        });
        if (!anyCorrectSelected && correctTextsSA.size <= 1) return false;
      } catch { /* ignore — fall through to legacy lock checks */ }
    }

    const disabledSet = disabledOptionsPerQuestion.get(qIndex);
    const disabledBySet = disabledSet && (disabledSet.has(index) || disabledSet.has(lockId));
    const forceDisabled = forceDisableAll;

    let questionLocked = false;
    try {
      questionLocked = this.selectedOptionService.isQuestionLocked(qIndex);
    } catch (e) {
      console.error('OptionClickHandlerService.computeDisabledState questionLocked check failed:', e);
    }

    let optionLocked = false;
    try {
      optionLocked = this.selectedOptionService.isOptionLocked(qIndex, index) ||
        this.selectedOptionService.isOptionLocked(qIndex, lockId);
    } catch (e) {
      console.error('OptionClickHandlerService.computeDisabledState optionLocked check failed:', e);
    }

    const lockedIncorrect = lockedIncorrectOptionIds.has(index) || lockedIncorrectOptionIds.has(lockId);
    const flashDisabled = flashDisabledSet.has(index) || flashDisabledSet.has(lockId);

    const result = !!(disabledBySet || forceDisabled || questionLocked || optionLocked || lockedIncorrect || flashDisabled);
    return result;
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // Question Type Detection
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * Determines if a question is single or multiple answer.
   */
  determineQuestionType(input: QuizQuestion): 'single' | 'multiple' {
    if (input && Array.isArray(input.options)) {
      const correctOptionsCount = input.options.filter(o => isOptionCorrect(o)).length;
      if (correctOptionsCount > 1 || input.type === QuestionType.MultipleAnswer || (input as any).multipleAnswer === true) {
        return 'multiple';
      }
    }
    return 'single';
  }

  /**
   * Detects multi-answer mode from question data, text keywords, and fallback type.
   * Returns the cached result if provided (for CD-cycle performance).
   */
  detectMultiMode(
    question: QuizQuestion | null,
    typeInput: string,
    configType?: string
  ): boolean {
    let result = false;

    const qText = (question?.questionText || '').toLowerCase();
    if (qText.includes('select all') || qText.includes('all that apply') || qText.includes('multiple')) {
      result = true;
    }

    let correctCount = 0;
    if (question?.options && !result) {
      correctCount = question.options.filter((o: Option) => isOptionCorrect(o)).length;
      if (correctCount > 1) result = true;
    }

    // Only trust the type/config input when data is unavailable (correctCount === 0).
    if (correctCount === 0 && (typeInput === 'multiple' || configType === 'multiple')) {
      result = true;
    }

    return result;
  }

}