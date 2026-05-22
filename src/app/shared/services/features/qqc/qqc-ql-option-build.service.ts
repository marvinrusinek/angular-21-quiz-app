import { inject, Injectable } from '@angular/core';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SharedOptionConfig } from '../../../models/SharedOptionConfig.model';

import { QuizService } from '../../data/quiz.service';

/**
 * Handles option building, enrichment, bindings, and dynamic component configuration for QQC.
 * Extracted from QqcQuestionLoaderService.
 */
@Injectable({ providedIn: 'root' })
export class QqcQlOptionBuildService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly quizService = inject(QuizService);

  /**
   * Builds fresh options from a question's raw options.
   * Returns deep-cloned, enriched options with unique IDs.
   */
  buildFreshOptions(
    question: QuizQuestion,
    currentQuestionIndex: number
  ): Option[] {
    const rawOpts = Array.isArray(question.options)
      ? JSON.parse(JSON.stringify(question.options)) : [];

    return rawOpts.map((opt: Option, i: number) => ({
      ...opt,
      optionId: (currentQuestionIndex + 1) * 100 + (i + 1),
      selected: false,
      highlight: false,
      showIcon: false,
      active: true,
      disabled: false,
      feedback: opt.feedback ?? `Default feedback for Q${currentQuestionIndex} Opt${i}`
    }));
  }

  /**
   * Enriches options for display from a question's raw options.
   * Returns the enriched options array.
   */
  enrichOptionsForDisplay(question: QuizQuestion): Option[] {
    if (!question || !question.options?.length) return [];

    return [...question.options].map(option => ({
      ...option,
      feedback: option.feedback ?? 'No feedback available.',
      showIcon: option.showIcon ?? false,
      active: option.active ?? true,
      selected: option.selected ?? false,
      correct: option.correct ?? false
    }));
  }

  /**
   * Computes a question signature for deduplication.
   */
  computeQuestionSignature(question: QuizQuestion): string {
    const baseText = (question.questionText ?? '').trim();
    const optionKeys = (question.options ?? []).map((opt, idx) => {
      const optionId = opt.optionId ?? idx;
      const text = (opt.text ?? '').trim();
      const correctness = opt.correct === true ? '1' : '0';
      return `${optionId}|${text}|${correctness}`;
    });

    return `${baseText}::${optionKeys.join('||')}`;
  }

  /**
   * Populates optionsToDisplay from currentQuestion's options with deduplication.
   */
  populateOptionsToDisplay(
    currentQuestion: QuizQuestion | null,
    currentOptionsToDisplay: Option[],
    lastSignature: string | null
  ): { options: Option[]; signature: string | null } {
    if (!currentQuestion) return { options: [], signature: lastSignature };

    if (!Array.isArray(currentQuestion.options) || 
      currentQuestion.options.length === 0
    ) {
      return { options: [], signature: lastSignature };
    }

    const signature = this.computeQuestionSignature(currentQuestion);

    const hasValidOptions =
      Array.isArray(currentOptionsToDisplay) &&
      currentOptionsToDisplay.length === currentQuestion.options.length &&
      lastSignature === signature;

    if (hasValidOptions) return { options: currentOptionsToDisplay, signature };

    const populated = currentQuestion.options.map((option, index) => ({
      ...option,
      optionId: option.optionId ?? index,
      correct: option.correct ?? false
    }));

    return { options: populated, signature };
  }

  /**
   * Builds option bindings array for a dynamic component instance.
   */
  buildOptionBindings(
    clonedOptions: Option[],
    isMultipleAnswer: boolean
  ): OptionBindings[] {
    return clonedOptions.map((opt, idx) => ({
      appHighlightOption: false,
      option: opt,
      isCorrect: opt.correct ?? false,
      feedback: opt.feedback ?? '',
      showFeedback: false,
      showFeedbackForOption: {},
      highlightCorrectAfterIncorrect: false,
      allOptions: clonedOptions,
      type: isMultipleAnswer ? 'multiple' : 'single',
      appHighlightInputType: isMultipleAnswer ? 'checkbox' : 'radio',
      appHighlightReset: false,
      appResetBackground: false,
      optionsToDisplay: clonedOptions,
      isSelected: opt.selected ?? false,
      active: opt.active ?? true,
      checked: false,
      change: (_: any) => { },
      index: idx,
      highlightIncorrect: false,
      highlightCorrect: false,
      disabled: false,
      ariaLabel: opt.text ?? `Option ${idx + 1}`
    })) as OptionBindings[];
  }

  /**
   * Builds SharedOptionConfig for a dynamic component instance.
   */
  buildSharedOptionConfig(params: {
    question: QuizQuestion;
    clonedOptions: Option[];
    isMultipleAnswer: boolean;
    currentQuestionIndex: number;
    defaultConfig?: SharedOptionConfig | null;
  }): SharedOptionConfig {
    return {
      ...(params.defaultConfig ?? {}),
      type: params.isMultipleAnswer ? 'multiple' : 'single',
      currentQuestion: { ...params.question },
      optionsToDisplay: params.clonedOptions,
      selectedOption: null,
      selectedOptionIndex: -1,
      showFeedback: false,
      isAnswerCorrect: false,
      showCorrectMessage: false,
      showExplanation: false,
      explanationText: '',
      highlightCorrectAfterIncorrect: false,
      shouldResetBackground: false,
      showFeedbackForOption: {},
      isOptionSelected: false,
      correctMessage: '',
      feedback: '',
      idx: params.currentQuestionIndex
    } as SharedOptionConfig;
  }

  /**
   * Prepares enriched options for a question and determines if the option list
   * needs clearing due to length mismatch.
   */
  prepareOptionsForQuestion(params: {
    question: QuizQuestion;
    currentOptionsLength: number;
  }): {
    enrichedOptions: Option[];
    shouldClearFirst: boolean;
  } {
    const enrichedOptions = this.enrichOptionsForDisplay(params.question);
  
    // If incoming list length differs, caller can clear current list to avoid stale bleed-through
    const shouldClearFirst =
      enrichedOptions.length > 0 &&
      params.currentOptionsLength !== params.question.options.length;
  
    return { enrichedOptions, shouldClearFirst };
  }

  /**
   * Configures a dynamically loaded AnswerComponent instance with
   * cloned options, bindings, shared config, and event handlers.
   */
  configureDynamicInstance(params: {
    instance: any;
    componentRef?: any;
    question: any;
    options: Option[];
    isMultipleAnswer: boolean;
    currentQuestionIndex: number;
    navigatingBackwards: boolean;
    defaultConfig: any;
    onOptionClicked: (...args: any[]) => any;
  }): {
    clonedOptions: Option[];
    questionData: any;
    sharedOptionConfig: SharedOptionConfig | null;
  } {
    const { instance, componentRef, question, options, isMultipleAnswer, currentQuestionIndex } = params;

    // Configure instance with cloned options and bindings
    const clonedOptions =
      structuredClone?.(options) ?? JSON.parse(JSON.stringify(options));

    const builtBindings = this.buildOptionBindings(clonedOptions, isMultipleAnswer);

    try {
      if (componentRef?.setInput) {
        try { componentRef.setInput('question', { ...question }); } catch {}
        try { componentRef.setInput('optionsToDisplay', clonedOptions); } catch {}
        try { componentRef.setInput('questionData', { ...question, options: clonedOptions }); } catch {}
        try { componentRef.setInput('optionBindings', builtBindings); } catch {}
      }
      // Also set directly via signal API as a guaranteed write path.
      try { instance.question.set({ ...question }); } catch {}
      try { instance.optionsToDisplay.set(clonedOptions); } catch {}
      try { instance.optionBindings.set(builtBindings); } catch {}
      try { if (instance.questionData?.set) instance.questionData.set({ ...question, options: clonedOptions }); } catch {}
      try { componentRef?.changeDetectorRef?.markForCheck(); } catch {}
    } catch (error) {
      try {
        instance.question.set({ ...question });
        instance.optionsToDisplay.set(clonedOptions);
        instance.optionBindings.set(builtBindings);
      } catch {}
    }

    instance.sharedOptionConfig = this.buildSharedOptionConfig({
      question,
      clonedOptions,
      isMultipleAnswer,
      currentQuestionIndex,
      defaultConfig: params.defaultConfig
    });

    const questionData = { ...(instance as any).question(), options: clonedOptions };
    const sharedOptionConfig = instance.sharedOptionConfig;

    return { clonedOptions, questionData, sharedOptionConfig };
  }

  /**
   * Builds the initial data object for the component from a question and options.
   */
  buildInitialData(
    question: QuizQuestion,
    options: Option[]
  ): {
    questionText: string;
    explanationText: string;
    correctAnswersText: string;
    options: Option[];
  } {
    return {
      questionText: question.questionText,
      explanationText: question.explanation || 'No explanation available',
      correctAnswersText: this.quizService.getCorrectAnswersAsString() || '',
      options: options || []
    };
  }
}