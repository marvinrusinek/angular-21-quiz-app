import { Injectable } from '@angular/core';
import { take } from 'rxjs/operators';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { Utils } from '../../../utils/utils';

type Host = any;

/**
 * Orchestrates QQC display state, option rendering, feedback, and misc wrappers.
 * Extracted from QqcComponentOrchestratorService.
 */
@Injectable({ providedIn: 'root' })
export class QqcOrchDisplayService {

  runUpdateOptionsSafely(host: Host, newOptions: Option[]): void {
    const result = host.displayStateManager.prepareOptionSwap({
      newOptions,
      currentOptionsJson: JSON.stringify(host.optionsToDisplay())
    });

    if (result.needsSwap) {
      host.renderReady.set(false);
      host.finalRenderReady.set(false);
      host.questionForm = result.formGroup;
      if (result.serialized !== host.lastSerializedOptions) {
        host.lastSerializedOptions = result.serialized;
      }
      host.optionsToDisplay.set(result.cleanedOptions);
      if (host.sharedOptionComponent) {
        host.sharedOptionComponent.initializeOptionBindings();
      }
      setTimeout(() => {
        if (host.displayStateManager.computeRenderReadiness(host.optionsToDisplay())) {
          host.markRenderReady();
        }
      }, 0);
    } else if (
      host.displayStateManager.computeRenderReadiness(host.optionsToDisplay()) &&
      !host.finalRenderReady
    ) {
      host.markRenderReady();
    }
  }

  runHydrateFromPayload(host: Host, payload: any): void {
    const result = host.displayStateManager.hydrateFromPayload({
      payload,
      currentQuestionText: host.currentQuestion()?.questionText?.trim(),
      isAlreadyRendered: host.finalRenderReady
    });
    if (!result) return;

    // renderReady / finalRenderReady were converted from Subjects to signals
    // in commit 2e084f59; the matching .next calls and plain assignments need
    // signal API (.set) to keep the host fields valid signals.
    host.renderReady.set(false);
    host.finalRenderReady.set(false);
    host.cdRef.detectChanges();

    host.currentQuestion.set(result.currentQuestion);
    host.optionsToDisplay.set(result.optionsToDisplay);
    host.updateShouldRenderOptions(host.optionsToDisplay());
    host.explanationToDisplay.set(result.explanationToDisplay);

    if (!host.containerInitialized && host.dynamicAnswerContainer) {
      host.loadDynamicComponent(host.currentQuestion(), host.optionsToDisplay());
      host.containerInitialized = true;
    }
    host.sharedOptionComponent?.initializeOptionBindings();

    setTimeout(() => {
      const bindingsReady =
        Array.isArray(host.sharedOptionComponent?.optionBindings) &&
        host.sharedOptionComponent.optionBindings.length > 0 &&
        host.sharedOptionComponent.optionBindings.every((b: any) => !!b.option);
      if (
        host.displayStateManager.computeRenderReadiness(host.optionsToDisplay()) &&
        bindingsReady
      ) {
        host.sharedOptionComponent?.markRenderReady('Hydrated from new payload');
      }
    }, 0);
  }

  runHandleQuestionAndOptionsChange(host: Host, currentQuestionChange: any, optionsChange: any): void {
    const { nextQuestion, effectiveQuestion, incomingOptions } =
      host.displayStateManager.handleQuestionAndOptionsChange({
        currentQuestionChange,
        optionsChange,
        currentQuestion: host.currentQuestion(),
      });
    if (nextQuestion) host.currentQuestion.set(nextQuestion);
    const normalizedOptions = host.refreshOptionsForQuestion(effectiveQuestion, incomingOptions);
    const selectedOptionValues = host.displayStateManager.extractSelectedOptionValues(effectiveQuestion);
    if (effectiveQuestion) {
      host.quizService.handleQuestionChange(effectiveQuestion, selectedOptionValues, normalizedOptions);
    } else if (optionsChange) {
      host.quizService.handleQuestionChange(null, selectedOptionValues, normalizedOptions);
    }
  }

  runRefreshOptionsForQuestion(
    host: Host,
    question: QuizQuestion | null,
    providedOptions?: Option[] | null
  ): Option[] {
    const result = host.displayStateManager.refreshOptionsForQuestion({
      question,
      providedOptions,
      currentQuestionIndex: host.currentQuestionIndex()
    });
    host.options.set(result.options);
    host.optionsToDisplay.set(result.optionsToDisplay);
    host.cdRef.markForCheck();
    return result.normalizedOptions;
  }

  runSetQuestionOptions(host: Host): void {
    host.quizService.getQuestionByIndex(host.currentQuestionIndex()).pipe(take(1)).subscribe((currentQuestion: QuizQuestion | null) => {
      if (!currentQuestion) return;
      host.currentQuestion.set(currentQuestion);
      host.currentOptions = host.displayStateManager.buildOptionsWithCorrectness(currentQuestion);
      if (host.currentOptions.length === 0) return;
      if (host.shuffleOptions) Utils.shuffleArray(host.currentOptions);
      host.currentOptions = host.displayStateManager.applyDisplayOrder(host.currentOptions);
      host.optionsToDisplay.set(host.currentOptions.map((o: any) => ({ ...o })));
      host.updateShouldRenderOptions(host.optionsToDisplay());
      host.quizService.nextOptionsSig.set(host.optionsToDisplay().map((o: any) => ({ ...o })));
      host.cdRef.markForCheck();
    });
  }

  runUpdateOptionHighlighting(host: Host, selectedKeys: Set<string | number>): void {
    host.optionsToDisplay.set(host.feedbackManager.updateOptionHighlighting(host.optionsToDisplay(), selectedKeys, host.currentQuestionIndex(), host.question()?.type));
    host.cdRef.markForCheck();
    host.cdRef.detectChanges();
  }

  runRefreshFeedbackFor(host: Host, opt: Option): void {
    if (!host.sharedOptionComponent) return;
    if (opt.optionId !== undefined) host.sharedOptionComponent.lastFeedbackOptionId = opt.optionId;
    const cfg = host.feedbackManager.buildFeedbackConfigForOption(opt, host.optionBindings(), host.currentQuestion()!, host.sharedOptionComponent.feedbackConfigs);
    host.sharedOptionComponent.feedbackConfigs = { ...host.sharedOptionComponent.feedbackConfigs, [opt.optionId!]: cfg };
    host.cdRef.markForCheck();
  }

  runPopulateOptionsToDisplay(host: Host): Option[] {
    const result = host.questionLoader.populateOptionsToDisplay(host.currentQuestion(), host.optionsToDisplay(), host.lastOptionsQuestionSignature);
    host.optionsToDisplay.set(result.options);
    host.lastOptionsQuestionSignature = result.signature;
    return host.optionsToDisplay();
  }

  runInitializeForm(host: Host): void {
    const form = host.initializer.buildFormFromOptions(host.currentQuestion(), host.fb);
    if (form) {
      host.questionForm = form;
    }
  }

  async runResolveFormatted(host: Host, index: number, opts: { useCache?: boolean; setCache?: boolean; timeoutMs?: number } = {}): Promise<string> {
    return host.timerEffect.resolveFormatted({
      index,
      normalizeIndex: (idx: number) => host.normalizeIndex(idx),
      formattedByIndex: host._formattedByIndex,
      useCache: opts.useCache,
      setCache: opts.setCache,
      timeoutMs: opts.timeoutMs,
      updateExplanationText: (idx: number) => host.updateExplanationText(idx)
    });
  }

  runDisableAllBindingsAndOptions(host: Host): { optionBindings: any[]; optionsToDisplay: Option[] } {
    const result = host.displayStateManager.disableAllBindingsAndOptions(host.optionBindings(), host.optionsToDisplay());
    host.optionBindings.set(result.optionBindings);
    host.optionsToDisplay.set(result.optionsToDisplay);
    return result;
  }

  runRevealFeedbackForAllOptions(host: Host, canonicalOpts: Option[]): void {
    const result = host.feedbackManager.revealFeedbackForAllOptions(canonicalOpts, host.feedbackConfigs, host.showFeedbackForOption);
    host.feedbackConfigs = result.feedbackConfigs;
    host.showFeedbackForOption = result.showFeedbackForOption;

    const soc = host.sharedOptionComponent;
    if (soc) {
      soc.feedbackConfigs = result.feedbackConfigs;
      soc.showFeedbackForOption = result.showFeedbackForOption;
      soc.cdRef.markForCheck();
    }

    host.cdRef.markForCheck();
  }

  runUpdateShouldRenderOptions(host: Host, options: Option[] | null | undefined): void {
    const v = host.displayStateManager.computeRenderReadiness(options);
    if (host.shouldRenderOptions() !== v) {
      host.shouldRenderOptions.set(v);
      host.cdRef.markForCheck();
    }
  }

  runSafeSetDisplayState(host: Host, state: { mode: 'question' | 'explanation'; answered: boolean }): void {
    if (host.displayStateManager.shouldSuppressDisplayState({
      visibilityRestoreInProgress: host._visibilityRestoreInProgress,
      suppressDisplayStateUntil: host._suppressDisplayStateUntil
    })) {
      return;
    }
    host.displayStateSubject?.next(state);
  }
}