import { Injectable } from '@angular/core';

import { Option } from '../../../models/Option.model';

type Host = any;

/**
 * Orchestrates QQC reset, per-question state clearing, and selection restore.
 * Extracted from QqcComponentOrchestratorService.
 */
@Injectable({ providedIn: 'root' })
export class QqcOrchResetService {

  async runResetQuestionStateBeforeNavigation(
    host: Host,
    options?: { preserveVisualState?: boolean; preserveExplanation?: boolean }
  ): Promise<void> {
    const result = host.resetManager.computeResetQuestionStateBeforeNavigation(options);
    host.currentQuestion.set(result.currentQuestion);
    host.selectedOption = result.selectedOption;
    host.options.set(result.resetOptions);

    if (!result.preserveExplanation) {
      host.feedbackText = result.feedbackText;
      host.applyDisplayState(result.displayState);
      host.quizStateService.setDisplayState(host.displayState);
      host.updateDisplayMode(result.displayMode);
      host.applyExplanationFlags(result);
      host.explanationToDisplay.set(result.explanationToDisplay);
      host.emitExplanationChange('', false);
    }
    if (!result.preserveVisualState) {
      host.questionToDisplay = '';
      host.updateShouldRenderOptions([]);
      host.shouldRenderOptions.set(false);
    }

    host.finalRenderReady.set(false);
    host.renderReady.set(false);
    setTimeout(() => {
      if (host.sharedOptionComponent) {
        host.sharedOptionComponent.freezeOptionBindings = false;
        host.sharedOptionComponent.showFeedbackForOption = {};
      }
    }, 0);

    const resetDelay = host.resetManager.computeResetDelay(result.preserveVisualState);
    if (resetDelay > 0) await new Promise((resolve) => setTimeout(resolve, resetDelay));
  }

  runResetPerQuestionState(host: Host, index: number): void {
    if (host._pendingRAF != null) {
      cancelAnimationFrame(host._pendingRAF);
      host._pendingRAF = null;
    }
    host._skipNextAsyncUpdates = false;

    const result = host.resetManager.resetPerQuestionState({
      index,
      normalizeIndex: (idx: number) => host.normalizeIndex(idx),
      formattedByIndex: host._formattedByIndex,
      clearSharedOptionForceDisable: () => host.sharedOptionComponent?.clearForceDisableAllOptions?.(),
      resolveFormatted: (idx: number, opts: any) => host.resolveFormatted(idx, opts)
    });

    host.handledOnExpiry.delete(result.i0);
    host.feedbackConfigs = result.feedbackConfigs;
    host.lastFeedbackOptionId = result.lastFeedbackOptionId;
    host.showFeedbackForOption = result.showFeedbackForOption;

    if (result.hasSelections) {
      host.optionsToDisplay.set(
        host.resetManager.restoreSelectionsAndIcons(
          result.i0, host.optionsToDisplay()
        )
      );
      host.cdRef.detectChanges();
    }

    host.displayExplanation = result.displayExplanation;
    host.updateDisplayMode(result.displayMode);
    if (result.hasSelections) {
      host.showExplanationChange?.emit(true);
    } else {
      host.explanationToDisplay.set('');
      host.emitExplanationChange('', false);
    }

    host.questionFresh = result.questionFresh;
    host.timedOut = result.timedOut;
    host._timerStoppedForQuestion = result.timerStoppedForQuestion;
    host._lastAllCorrect = result.lastAllCorrect;
    host.lastLoggedIndex = result.lastLoggedIndex;
    host.lastLoggedQuestionIndex = result.lastLoggedQuestionIndex;

    try {
      host.questionForm?.enable({ emitEvent: false });
    } catch { }
    queueMicrotask(() => host.emitPassiveNow(index));
    host.cdRef.markForCheck();
    host.cdRef.detectChanges();
  }

  runResetState(host: Host): void {
    const result = host.resetManager.resetState();
    host.selectedOption = result.selectedOption;
    host.options.set(result.options);
    host.resetFeedback();
  }

  runResetFeedback(host: Host): void {
    const result = host.resetManager.resetFeedback();
    host.correctMessage.set(result.correctMessage);
    host.showFeedback.set(result.showFeedback);
    host.selectedOption = result.selectedOption;
    host.showFeedbackForOption = result.showFeedbackForOption;
  }

  runRestoreSelectionsAndIconsForQuestion(host: Host, index: number): void {
    host.optionsToDisplay.set(
      host.resetManager.restoreSelectionsAndIcons(index, host.optionsToDisplay())
    );
    host.cdRef.detectChanges();
  }

  runResetForQuestion(host: Host, index: number): void {
    const guards = host.resetManager.hardResetClickGuards();
    host._clickGate = guards.clickGate;
    host.waitingForReady = guards.waitingForReady;
    host.deferredClick = guards.deferredClick;
    host.lastLoggedQuestionIndex = guards.lastLoggedQuestionIndex;
    host.lastLoggedIndex = guards.lastLoggedIndex;
    host.resetExplanation(true);
    host.resetPerQuestionState(index);
  }
}