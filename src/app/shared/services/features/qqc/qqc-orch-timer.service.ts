import { inject, Service } from '@angular/core';

import { Option } from '../../../models/Option.model';

import { NextButtonStateService } from '../../state/next-button-state.service';
import { QuizDotStatusService } from '../../flow/quiz-dot-status.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { TimerService } from '../timer/timer.service';

import { swallow } from '../../../utils/error-logging';

import type { QuizQuestionComponent } from '../../../../components/question/quiz-question/quiz-question.component';

type Host = QuizQuestionComponent;

/**
 * Orchestrates QQC timer expiry and timeout handling.
 * Extracted from QqcComponentOrchestratorService.
 */
@Service()
export class QqcOrchTimerService {
  private dotStatusService = inject(QuizDotStatusService);
  private nextButtonStateService = inject(NextButtonStateService);
  private selectedOptionService = inject(SelectedOptionService);
  private timerService = inject(TimerService);

  runOnQuestionTimedOut(host: Host, targetIndex?: number): void {
    if (host.timedOut()) return;
    host.timedOut.set(true);

    const soc = host.sharedOptionComponent?.();
    if (soc) {
      soc.timerExpiredForQuestion.set(true);

      const displayOpts = soc.optionsToDisplay?.length
        ? soc.optionsToDisplay
        : host.optionsToDisplay() ?? [];
      const keys = new Set<string>();
      for (const [i, opt] of displayOpts.entries()) {
        if (opt?.correct) keys.add(soc.keyOf(opt, i));
      }
      soc.timeoutCorrectOptionKeys = keys;
    }

    const result = host.timerEffect.onQuestionTimedOut({
      targetIndex,
      currentQuestionIndex: host.currentQuestionIndex(),
      questions: host.questions(),
      currentQuestion: host.currentQuestion(),
      optionsToDisplay: host.optionsToDisplay(),
      sharedOptionBindings: soc?.optionBindings(),
      totalQuestions: host.totalQuestions(),
      formattedByIndex: host._formattedByIndex,
      lastAllCorrect: host._lastAllCorrect,
      normalizeIndex: (idx: number) => host.normalizeIndex(idx),
      setExplanationFor: (_idx: number, html: string) => {
        host.explanationTextService.setExplanationText(html, { force: true });
        host.cdRef.markForCheck();
      },
      resolveFormatted: (idx: number) => host.resolveFormatted(idx),
      revealFeedbackForAllOptions: (opts: Option[]) => host.revealFeedbackForAllOptions(opts),
      forceDisableSharedOption: () => host.forceDisableSharedOption(),
      updateBindingsAndOptions: () => host.disableAllBindingsAndOptions(),
      markForCheck: () => host.cdRef.markForCheck()
    });
    host.displayExplanation.set(true);
    host.showExplanationChange.emit(true);
    host.explanationToDisplay.set(result.explanationToDisplay);
    host.explanationToDisplayChange?.emit(result.explanationToDisplay);
    host._timerStoppedForQuestion = result.timerStoppedForQuestion;

    // Persist the resolved FET AT the timed-out index so the single-source heading's
    // fetHtml (formattedExplanations[idx] / fetByIndex.get(idx)) is populated. The
    // fast-path (Q2+) resolved the text but never stored it by index, so the heading
    // fell back to the question even once isTimedOut became true.
    const timedOutIdx = (typeof targetIndex === 'number' && targetIndex >= 0)
      ? targetIndex
      : host.currentQuestionIndex();
    if (timedOutIdx >= 0 && result.explanationToDisplay && host.explanationTextService?.timeoutFetByIndex?.set) {
      host.explanationTextService.timeoutFetByIndex.set(timedOutIdx, result.explanationToDisplay);
    }

    // Timer expiry no longer writes the heading directly — the single-source
    // headingHtml computed reacts to the timer-expiry signal and renders the FET
    // itself. __quizTimerExpired is still set: other flows read it as a
    // timeout marker.
    try {
      (window as any).__quizTimerExpired = true;
    } catch (err: unknown) { swallow('qqc-orch-timer.service.ts set __quizTimerExpired', err); }

    if (soc) {
      soc.cdRef.markForCheck();
    }
  }

  runHandleTimerStoppedForActiveQuestion(host: Host, reason: 'timeout' | 'stopped'): void {
    const stopped = host.timerEffect.handleTimerStoppedForActiveQuestion({
      reason,
      timerStoppedForQuestion: host._timerStoppedForQuestion,
      currentQuestionIndex: host.currentQuestionIndex(),
      questions: host.questions(),
      questionFresh: host.questionFresh(),
      optionsToDisplay: host.optionsToDisplay(),
      sharedOptionBindings: host.sharedOptionComponent?.()?.optionBindings(),
      currentQuestion: host.currentQuestion(),
      normalizeIndex: (idx: number) => host.normalizeIndex(idx),
      revealFeedbackForAllOptions: (opts: Option[]) => host.revealFeedbackForAllOptions(opts),
      forceDisableSharedOption: () => host.forceDisableSharedOption(),
      updateBindingsAndOptions: () => host.disableAllBindingsAndOptions(),
      markForCheck: () => host.cdRef.markForCheck()
    });
    if (stopped) host._timerStoppedForQuestion = true;
  }

  async runOnTimerExpiredFor(host: Host, index: number): Promise<void> {
    const i0 = host.normalizeIndex(index);

    // Record the timeout durably and enable Next on EVERY expiry call — before
    // the handledOnExpiry guard. A background-tab expiry reaches here via the
    // fast-path (the real timer is throttled, so the cqc expired$ stream that
    // normally stamps the durable flag never fires) and tab-return re-entry
    // hits the early-return below. Both must still keep Next enabled so the
    // user can advance, even when the question was never answered.
    this.dotStatusService.timedOutFetForced.add(i0);
    this.selectedOptionService.setAnswered(true, true);
    this.nextButtonStateService.setNextButtonState(true);

    if (host.handledOnExpiry.has(i0)) return;
    host.handledOnExpiry.add(i0);
    host.onQuestionTimedOut(i0);
    // Q2+ time out via this fast-path, which (unlike the normal timer expiry)
    // never recorded the expired index — so the single-source heading's
    // `expiredForQuestionIndexSig === idx` gate stayed false and the FET never
    // showed. Record it here for every expired question.
    this.timerService.expiredForQuestionIndexSig.set(i0);

    const expiryState = host.timerEffect.applyTimerExpiryState({
      i0,
      questions: host.questions(),
      currentQuestionType: host.currentQuestion()?.type
    });
    host.feedbackText.set(expiryState.feedbackText);
    host.displayExplanation.set(expiryState.displayExplanation);
    host.showExplanationChange?.emit(true);
    host.cdRef.markForCheck();

    const { formattedText, needsAsyncRepair } = await host.timerEffect.performTimerExpiredForAsync({
      i0,
      normalizeIndex: (idx: number) => host.normalizeIndex(idx),
      questions: host.questions(),
      currentQuestionIndex: host.currentQuestionIndex(),
      currentQuestion: host.currentQuestion(),
      formattedByIndex: host._formattedByIndex,
      fixedQuestionIndex: host.fixedQuestionIndex(),
      updateExplanationText: (idx: number) => host.updateExplanationText(idx)
    });

    if (formattedText) {
      host.applyExplanationTextInZone(formattedText);
      // Durable FET store (survives the purge that races the heading render).
      host.explanationTextService?.timeoutFetByIndex?.set(i0, formattedText);
    }
    if (needsAsyncRepair) {
      host.timerEffect
        .repairExplanationAsync({
          index: i0,
          normalizeIndex: (idx: number) => host.normalizeIndex(idx),
          formattedByIndex: host._formattedByIndex,
          fixedQuestionIndex: host.fixedQuestionIndex(),
          currentQuestionIndex: host.currentQuestionIndex(),
          updateExplanationText: (idx: number) => host.updateExplanationText(idx)
        })
        .then((repaired: string | null) => {
          if (repaired) {
            host.applyExplanationTextInZone(repaired);
            host.explanationTextService?.timeoutFetByIndex?.set(i0, repaired);
          }
        })
        .catch(() => {});
    }
  }
}