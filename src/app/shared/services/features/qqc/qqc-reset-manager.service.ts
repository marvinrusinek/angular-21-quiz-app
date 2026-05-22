import { inject, Injectable } from '@angular/core';

import { FeedbackConfig } from '../../../models/FeedbackConfig.model';
import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { ExplanationTextService } from '../explanation/explanation-text.service';
import { TimerService } from '../timer/timer.service';

/**
 * Manages per-question reset, state clearing, and click guard resets for QQC.
 * Extracted from QuizQuestionComponent to reduce its size.
 */
@Injectable({ providedIn: 'root' })
export class QqcResetManagerService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly timerService = inject(TimerService);

  /**
   * Resets all per-question state for a given index.
   * Returns the state values the component should apply.
   */
  resetPerQuestionState(params: {
    index: number;
    normalizeIndex: (idx: number) => number;
    formattedByIndex: Map<number, string>;
    clearSharedOptionForceDisable: () => void;
    resolveFormatted: (idx: number, opts: any) => void;
  }): {
    hasSelections: boolean;
    i0: number;
    feedbackConfigs: Record<number | string, FeedbackConfig>;
    lastFeedbackOptionId: number;
    showFeedbackForOption: { [optionId: number]: boolean };
    questionFresh: boolean;
    timedOut: boolean;
    timerStoppedForQuestion: boolean;
    lastAllCorrect: boolean;
    lastLoggedIndex: number;
    lastLoggedQuestionIndex: number;
    displayMode: 'question' | 'explanation';
    displayExplanation: boolean;
    explanationToDisplay: string;
    explanationOwnerIdx: number;
  } {
    const i0 = params.normalizeIndex(params.index);
    const existingSelections =
      this.selectedOptionService.getSelectedOptionsForQuestion(i0) ?? [];
    const hasSelections = existingSelections.length > 0;

    // Clear stale FET cache
    params.formattedByIndex.delete(i0);

    // Unlock & clear per-question selection/locks
    this.selectedOptionService.resetLocksForQuestion(i0);
    if (!hasSelections) {
      this.selectedOptionService.clearSelectionsForQuestion(i0);
    } else {
      this.selectedOptionService.republishFeedbackForQuestion(i0);
    }
    params.clearSharedOptionForceDisable();

    // Clear expiry guards. Skip when this question already has selections
    // (i.e., it was just answered) so the stoppedForQuestion bookkeeping
    // survives — otherwise restartForQuestion below would re-arm the timer.
    if (!hasSelections) {
      this.timerService.resetTimerFlagsFor?.(i0);
    }

    // Explanation & display mode
    if (hasSelections) {
      this.explanationTextService.setShouldDisplayExplanation(true);
      this.quizStateService.setDisplayState({ mode: 'explanation', answered: true });
      this.quizStateService.setAnswered(true);
      this.quizStateService.setAnswerSelected(true);
    } else {
      this.explanationTextService.unlockExplanation?.();
      this.explanationTextService.resetExplanationText();
      this.explanationTextService.setShouldDisplayExplanation(false);
      this.quizStateService.setDisplayState({ mode: 'question', answered: false });
      this.quizStateService.setAnswered(false);
      this.quizStateService.setAnswerSelected(false);
    }

    // Prewarm explanation cache
    params.resolveFormatted(i0, { useCache: true, setCache: true });

    // Timer reset/restart — must use restartForQuestion so that
    // hasExpiredForRun is cleared before resetTimer/startTimer.
    // Without this, the anti-thrash guards in resetTimer/startTimer
    // suppress the restart after Q1's timer has expired.
    // Skip for already-answered questions so the timer stays frozen
    // at the click-moment value instead of restarting to the full
    // start value.
    if (!hasSelections) {
      this.timerService.restartForQuestion(i0);
    }

    // Build showFeedbackForOption from existing selections
    let showFeedbackForOption: { [optionId: number]: boolean } = {};
    if (hasSelections) {
      const feedbackMap = this.selectedOptionService.getFeedbackForQuestion(i0);
      showFeedbackForOption = { ...feedbackMap };
    }

    return {
      hasSelections,
      i0,
      feedbackConfigs: {},
      lastFeedbackOptionId: -1,
      showFeedbackForOption,
      questionFresh: true,
      timedOut: false,
      timerStoppedForQuestion: false,
      lastAllCorrect: false,
      lastLoggedIndex: -1,
      lastLoggedQuestionIndex: -1,
      displayMode: hasSelections ? 'explanation' : 'question',
      displayExplanation: hasSelections,
      explanationToDisplay: hasSelections ? '' : '',  // component keeps or clears
      explanationOwnerIdx: hasSelections ? -1 : -1
    };
  }

  /**
   * Resets feedback-related component state.
   */
  resetFeedback(): {
    correctMessage: string;
    showFeedback: boolean;
    selectedOption: null;
    showFeedbackForOption: { [optionId: number]: boolean };
  } {
    return {
      correctMessage: '',
      showFeedback: false,
      selectedOption: null,
      showFeedbackForOption: {}
    };
  }

  /**
   * Resets full component state including options and feedback.
   */
  resetState(): {
    selectedOption: null;
    options: Option[];
    areOptionsReadyToRender: boolean;
  } {
    this.selectedOptionService.clearOptions();

    return {
      selectedOption: null,
      options: [],
      areOptionsReadyToRender: false
    };
  }

  /**
   * Clears selection state for all options in a question.
   */
  clearSelection(
    correctAnswers: number[] | undefined,
    currentQuestion: QuizQuestion | null
  ): void {
    if (correctAnswers && correctAnswers.length === 1) {
      if (currentQuestion && currentQuestion.options) {
        for (const option of currentQuestion.options) {
          option.selected = false;
          option.styleClass = '';
        }
      }
    }
  }

  /**
   * Restores selections and icons for a question from the service state.
   */
  restoreSelectionsAndIcons(
    index: number,
    optionsToDisplay: Option[]
  ): Option[] {
    const selectedOptions =
      this.selectedOptionService.getSelectedOptionsForQuestion(index);

    return optionsToDisplay?.map(opt => {
      const match = selectedOptions.find(
        (sel) => sel.optionId === opt.optionId
      );
      return {
        ...opt,
        selected: !!match,
        showIcon: !!match?.showIcon,
        highlight: false
      };
    }) ?? [];
  }

  /**
   * Returns reset values for click guard state.
   */
  hardResetClickGuards(): {
    clickGate: boolean;
    waitingForReady: boolean;
    deferredClick: undefined;
    lastLoggedQuestionIndex: number;
    lastLoggedIndex: number;
  } {
    return {
      clickGate: false,
      waitingForReady: false,
      deferredClick: undefined,
      lastLoggedQuestionIndex: -1,
      lastLoggedIndex: -1
    };
  }

  /**
   * Computes the reset state before navigation to a new question.
   * Returns an object describing what the component should apply.
   */
  computeResetQuestionStateBeforeNavigation(options?: {
    preserveVisualState?: boolean;
    preserveExplanation?: boolean;
  }): {
    preserveVisualState: boolean;
    preserveExplanation: boolean;
    displayState: { mode: 'question' | 'explanation'; answered: boolean };
    displayMode: 'question' | 'explanation';
    forceQuestionDisplay: boolean;
    readyForExplanationDisplay: boolean;
    isExplanationReady: boolean;
    isExplanationLocked: boolean;
    explanationLocked: boolean;
    explanationVisible: boolean;
    displayExplanation: boolean;
    shouldDisplayExplanation: boolean;
    isExplanationTextDisplayed: boolean;
    explanationToDisplay: string;
    questionToDisplay: string;
    shouldRenderOptions: boolean;
    feedbackText: string;
    currentQuestion: null;
    selectedOption: null;
    resetOptions: Option[];
  } {
    const preserveVisualState = options?.preserveVisualState ?? false;
    const preserveExplanation = options?.preserveExplanation ?? false;

    // Perform service-level resets when not preserving explanation
    if (!preserveExplanation) {
      this.explanationTextService.resetExplanationState();
      this.explanationTextService.setExplanationText('');
      this.explanationTextService.updateFormattedExplanation('');
      this.explanationTextService.setResetComplete(false);
      this.explanationTextService.unlockExplanation();
      this.explanationTextService.setShouldDisplayExplanation(false);
      this.explanationTextService.setIsExplanationTextDisplayed(false);
    }

    return {
      preserveVisualState,
      preserveExplanation,
      displayState: preserveExplanation
        ? { mode: 'explanation' as const, answered: true }
        : { mode: 'question' as const, answered: false },
      displayMode: preserveExplanation ? 'explanation' : 'question',
      forceQuestionDisplay: !preserveExplanation,
      readyForExplanationDisplay: preserveExplanation,
      isExplanationReady: preserveExplanation,
      isExplanationLocked: !preserveExplanation,
      explanationLocked: !preserveExplanation,
      explanationVisible: preserveExplanation,
      displayExplanation: preserveExplanation,
      shouldDisplayExplanation: preserveExplanation,
      isExplanationTextDisplayed: preserveExplanation,
      explanationToDisplay: preserveExplanation ? '' : '',
      questionToDisplay: preserveVisualState ? '' : '',
      shouldRenderOptions: preserveVisualState,
      feedbackText: preserveExplanation ? '' : '',
      currentQuestion: null,
      selectedOption: null,
      resetOptions: []
    };
  }

  /**
   * Handles the full post-reset shared option component cleanup.
   * Schedules the freezeOptionBindings and showFeedbackForOption reset.
   * Extracted from resetQuestionStateBeforeNavigation() in QuizQuestionComponent.
   */
  computeResetDelay(preserveVisualState?: boolean): number {
    return preserveVisualState ? 0 : 50;
  }
}
