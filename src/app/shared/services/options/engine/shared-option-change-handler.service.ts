import { Injectable } from '@angular/core';
import { SimpleChanges } from '@angular/core';
import { FormGroup } from '@angular/forms';
import { BehaviorSubject } from 'rxjs';

import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { SharedOptionConfig } from '../../../models/SharedOptionConfig.model';
import { ExplanationTextService } from '../../features/explanation/explanation-text.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

/**
 * All the component state and methods that ngOnChanges reads or calls.
 */
export interface ChangeHandlerContext {
  // --- @Input fields ---
  currentQuestionIndex: number;
  questionIndex: number | null;
  optionsToDisplay: Option[];
  config: SharedOptionConfig;
  type: 'single' | 'multiple';
  optionBindings: OptionBindings[];
  selectedOption: Option | null;
  showFeedbackForOption: { [key: string | number]: boolean };
  showFeedback: boolean;
  questionVersion: number;

  // --- Internal state ---
  lastProcessedQuestionIndex: number;
  resolvedQuestionIndex: number | null;
  isMultiMode: boolean;
  form: FormGroup;
  optionsToDisplay$: BehaviorSubject<Option[]>;

  // --- Component methods (called during change handling) ---
  resolveCurrentQuestionIndex: () => number;
  updateResolvedQuestionIndex: (index: number) => void;
  computeDisabledState: (option: Option, index: number) => boolean;
  hydrateOptionsFromSelectionState: () => void;
  generateOptionBindings: () => void;
  resetStateForNewQuestion: () => void;
  clearForceDisableAllOptions: () => void;
  fullyResetRows: () => void;
  processOptionBindings: () => void;
  updateHighlighting: () => void;
}

/**
 * All mutations that ngOnChanges needs to apply back to the component.
 * Fields that are undefined were not mutated.
 */
export interface ChangeResult {
  // --- Fields to assign directly ---
  selectedOptions?: 'clear';
  clickedOptionIds?: 'clear';
  selectedOptionMap?: 'clear';
  selectedOptionHistory?: (number | string)[];
  isMultiModeCache?: null;
  lastHandledIndex?: null;
  lastHandledTime?: null;
  forceDisableAll?: boolean;
  lockedIncorrectOptionIds?: 'clear';
  showFeedbackForOption?: { [key: string | number]: boolean };
  feedbackConfigs?: { [key: string]: FeedbackProps };
  lastFeedbackOptionId?: number | string;
  lastFeedbackQuestionIndex?: number;
  showFeedback?: boolean;
  lastProcessedQuestionIndex?: number;
  lastClickFeedback?: null;
  feedbackDisplay?: null;
  resolvedQuestionIndex?: number | null;
  currentQuestionIndex?: number;
  disabledOptionsPerQuestion?: 'clear';
  activeFeedbackConfig?: null;
  disableRenderTrigger?: 'increment';
  optionsToDisplay?: Option[];
  highlightedOptionIds?: 'clear';
  selectedOption?: null;
  type?: 'single' | 'multiple';
  questionVersion?: number;
  flashDisabledSet?: 'clear';
  correctClicksPerQuestion?: 'clear';

  // --- CDR calls ---
  markForCheck?: boolean;
  detectChanges?: boolean;

  // --- Form calls ---
  resetFormSelectedOptionId?: boolean;

  // --- Method calls to invoke after applying state ---
  callResetStateForNewQuestion?: boolean;
  callClearForceDisableAllOptions?: boolean;
  callFullyResetRows?: boolean;
  callProcessOptionBindings?: boolean;
  callUpdateHighlighting?: boolean;
  callHydrateAndGenerate?: boolean;
  callGenerateOnly?: boolean;

  // --- Service calls already handled inside handleChanges ---
  // (unlockAllOptionsForQuestion, setDisplayState, explanation resets)
}

@Injectable({ providedIn: 'root' })
export class SharedOptionChangeHandlerService {
  constructor(
    private quizService: QuizService,
    private selectedOptionService: SelectedOptionService,
    private quizStateService: QuizStateService,
    private explanationTextService: ExplanationTextService
  ) {}

  handleChanges(changes: SimpleChanges, ctx: ChangeHandlerContext): ChangeResult {
    // Alias new signal-input keys (post-SOC refactor) back to the legacy
    // names so existing change-handler logic keeps working unchanged.
    const aliasMap: Record<string, string> = {
      currentQuestionIndexInput: 'currentQuestionIndex',
      optionsToDisplayInput: 'optionsToDisplay',
      optionBindingsInput: 'optionBindings',
      typeInput: 'type',
      currentQuestionInput: 'currentQuestion',
      isNavigatingBackwardsInput: 'isNavigatingBackwards',
      renderReadyInput: 'renderReady'
    };
    for (const newKey of Object.keys(aliasMap)) {
      if (changes[newKey] && !changes[aliasMap[newKey]]) {
        changes[aliasMap[newKey]] = changes[newKey];
      }
    }

    const result: ChangeResult = {};

    const currentIdx = ctx.resolveCurrentQuestionIndex();
    const hasIndexChanged =
      changes['currentQuestionIndex'] ||
      ctx.lastProcessedQuestionIndex !== currentIdx;
    const hasQuestionChanged = changes['question'] || changes['options'];

    // ---------------------------------------------------------------
    // BLOCK 1: Full state reset when question index or question changes
    // ---------------------------------------------------------------
    if (hasIndexChanged || hasQuestionChanged) {
      result.selectedOptions = 'clear';
      result.clickedOptionIds = 'clear';
      result.selectedOptionMap = 'clear';
      result.selectedOptionHistory = [];
      result.isMultiModeCache = null;
      result.lastHandledIndex = null;
      result.lastHandledTime = null;
      result.forceDisableAll = false;
      result.lockedIncorrectOptionIds = 'clear';
      result.showFeedbackForOption = {};
      result.feedbackConfigs = {};
      result.lastFeedbackOptionId = -1;
      result.lastFeedbackQuestionIndex = currentIdx;
      result.showFeedback = false;
      result.lastProcessedQuestionIndex = currentIdx;
      result.lastClickFeedback = null;
      result.feedbackDisplay = null;
    }

    // ---------------------------------------------------------------
    // BLOCK 2: Always resolve a valid index
    // ---------------------------------------------------------------
    const fallbackIndex =
      changes['questionIndex']?.currentValue ??
      changes['currentQuestionIndex']?.currentValue ??
      ctx.currentQuestionIndex ??
      ctx.questionIndex ??
      -1;

    result.resolvedQuestionIndex = fallbackIndex;
    result.currentQuestionIndex = fallbackIndex;

    // ---------------------------------------------------------------
    // BLOCK 3: Force re-render when question index actually changes
    // ---------------------------------------------------------------
    const qIdxChanged =
      (changes['questionIndex'] &&
        !changes['questionIndex'].firstChange &&
        changes['questionIndex'].previousValue !==
          changes['questionIndex'].currentValue) ||
      (changes['currentQuestionIndex'] &&
        !changes['currentQuestionIndex'].firstChange &&
        changes['currentQuestionIndex'].previousValue !==
          changes['currentQuestionIndex'].currentValue);

    if (qIdxChanged) {
      result.disabledOptionsPerQuestion = 'clear';
      result.activeFeedbackConfig = null;
      result.feedbackDisplay = null;
      result.feedbackConfigs = {};
      result.lastFeedbackOptionId = -1;
      result.showFeedback = false;

      // Clear service-level option locks for the new question
      try {
        this.selectedOptionService.unlockAllOptionsForQuestion(fallbackIndex);
      } catch {}

      result.disableRenderTrigger = 'increment';
    }

    // ---------------------------------------------------------------
    // BLOCK 4: Hard reset when optionsToDisplay changes
    // ---------------------------------------------------------------
    if (changes['optionsToDisplay'] && Array.isArray(ctx.optionsToDisplay)) {
      try {
        // Hard clone and purge any reference identity leaks
        let clonedOptions: Option[] = JSON.parse(
          JSON.stringify(ctx.optionsToDisplay)
        );

        // Publish the latest options snapshot for SOC reactive logic
        // (done via result so the component pushes to its BehaviorSubject)

        // Clear visual state on existing bindings ONLY if question changed
        if (qIdxChanged) {
          const updatedBindings = (ctx.optionBindings ?? []).map((b) => ({
            ...b,
            isSelected: false,
            showFeedback: false,
            highlightCorrect: false,
            highlightIncorrect: false,
            highlightCorrectAfterIncorrect: false,
            disabled: ctx.computeDisabledState(b.option, b.index),
            option: {
              ...b.option,
              selected: false,
              showIcon: false
            }
          }));
          // The component will need to apply these updated bindings;
          // we signal this via the optionsToDisplay field and the component
          // handles binding updates in applyChangeResult.
          // NOTE: We don't set optionBindings on result because the component
          // manages its own optionBindings array via generateOptionBindings.
          // The binding reset is handled via qIdxChanged block below.
          void updatedBindings; // bindings are regenerated by generateOptionBindings
        }

        result.highlightedOptionIds = 'clear';
        result.selectedOption = null;
        result.optionsToDisplay = clonedOptions;

        result.markForCheck = true;
      } catch (error: any) {
        result.markForCheck = true;
      }
    }

    // Hard clone barrier: break all option object references between questions
    const currentOptions = result.optionsToDisplay ?? ctx.optionsToDisplay;
    if (Array.isArray(currentOptions)) {
      try {
        result.optionsToDisplay =
          typeof structuredClone === 'function'
            ? structuredClone(currentOptions)
            : JSON.parse(JSON.stringify(currentOptions));
      } catch (error: any) {
      }
    }

    // ---------------------------------------------------------------
    // BLOCK 5: Update resolved question index from specific changes
    // ---------------------------------------------------------------
    if (changes['questionIndex']) {
      result.resolvedQuestionIndex = null;
      ctx.updateResolvedQuestionIndex(changes['questionIndex'].currentValue);
    }

    if (changes['currentQuestionIndex']) {
      result.resolvedQuestionIndex = null;
      ctx.updateResolvedQuestionIndex(
        changes['currentQuestionIndex'].currentValue
      );
    }

    if (changes['config']?.currentValue?.idx !== undefined) {
      ctx.updateResolvedQuestionIndex(changes['config'].currentValue.idx);
    }

    // ---------------------------------------------------------------
    // BLOCK 6: Determine whether to regenerate option bindings
    // ---------------------------------------------------------------
    const shouldRegenerate =
      (changes['optionsToDisplay'] &&
        Array.isArray(ctx.optionsToDisplay) &&
        ctx.optionsToDisplay.length > 0) ||
      (changes['config'] && ctx.config != null) ||
      (changes['currentQuestionIndex'] &&
        typeof changes['currentQuestionIndex'].currentValue === 'number') ||
      (changes['questionIndex'] &&
        typeof changes['questionIndex'].currentValue === 'number');

    if (changes['currentQuestionIndex']) {
      const newIndex = changes['currentQuestionIndex'].currentValue;
      if (typeof newIndex === 'number') {
        result.lastProcessedQuestionIndex = newIndex;
        result.callResetStateForNewQuestion = true;
        result.highlightedOptionIds = 'clear';
        result.showFeedback = false;
        result.showFeedbackForOption = {};
      }

      if (!changes['currentQuestionIndex'].firstChange) {
        result.flashDisabledSet = 'clear';
        result.markForCheck = true;
      }
    }

    if (shouldRegenerate) {
      result.callHydrateAndGenerate = true;

      // Synchronize type from data-detected multi-mode
      if (ctx.isMultiMode) result.type = 'multiple';
    } else if (
      changes['optionBindings'] &&
      Array.isArray(changes['optionBindings'].currentValue) &&
      changes['optionBindings'].currentValue.length
    ) {
      result.callHydrateAndGenerate = true;
    }

    // ---------------------------------------------------------------
    // BLOCK 7: Handle question changed / options changed
    // ---------------------------------------------------------------
    const questionChanged =
      (changes['questionIndex'] && !changes['questionIndex'].firstChange) ||
      (changes['currentQuestionIndex'] &&
        !changes['currentQuestionIndex'].firstChange);
    const optionsChanged =
      changes['optionsToDisplay'] &&
      changes['optionsToDisplay'].previousValue !==
        changes['optionsToDisplay'].currentValue;

    // Only reset display mode when question changes
    if (questionChanged) {
      result.resolvedQuestionIndex = null;

      this.quizStateService.setDisplayState({
        mode: 'question',
        answered: false
      });

      // Clear the explanation text service to prevent old FET from showing
      this.explanationTextService.unlockExplanation();
      this.explanationTextService.setExplanationText('', { force: true });
      this.explanationTextService.setShouldDisplayExplanation(false, {
        force: true
      });
      this.explanationTextService.setIsExplanationTextDisplayed(false, {
        force: true
      });
    }

    // Handle TYPE changes explicitly
    if (changes['type']) result.type = changes['type'].currentValue;

    // UI cleanup ONLY when question index changes
    if (questionChanged && ctx.optionsToDisplay?.length) {
      result.questionVersion = (ctx.questionVersion ?? 0) + 1;

      result.callClearForceDisableAllOptions = true;
      result.callFullyResetRows = true;

      result.selectedOptionHistory = [];
      result.lastFeedbackOptionId = -1;
      result.showFeedbackForOption = {};
      result.feedbackConfigs = {};

      result.resetFormSelectedOptionId = true;

      result.callProcessOptionBindings = true;
      result.detectChanges = true;

      result.callUpdateHighlighting = true;
    }

    // Full local visual reset when question changes
    if (questionChanged) {
      result.highlightedOptionIds = 'clear';
      result.flashDisabledSet = 'clear';
      result.correctClicksPerQuestion = 'clear';
      result.showFeedbackForOption = {};
      result.feedbackConfigs = {};
      result.selectedOptionHistory = [];
      result.lastFeedbackOptionId = -1;

      // Force every option to lose highlight/showIcon state
      const opts = result.optionsToDisplay ?? ctx.optionsToDisplay;
      if (Array.isArray(opts)) {
        result.optionsToDisplay = opts.map((opt) => ({
          ...opt,
          selected: false,
          highlight: false,
          showIcon: false
        }));
      }

      result.resetFormSelectedOptionId = true;
      result.detectChanges = true;
    }

    return result;
  }
}