import { afterNextRender, inject, Injectable } from '@angular/core';

import { Option } from '../../../models/Option.model';

import { QuestionHeadingService } from '../quiz-content/question-heading.service';

import type { QuizQuestionComponent } from '../../../../components/question/quiz-question/quiz-question.component';

type Host = QuizQuestionComponent;

/**
 * Orchestrates QQC timer expiry and timeout handling.
 * Extracted from QqcComponentOrchestratorService.
 */
@Injectable({ providedIn: 'root' })
export class QqcOrchTimerService {
  private questionHeadingService = inject(QuestionHeadingService);

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

    // Write FET to the H3 via QuestionHeadingService. The codelab-quiz-content
    // component's effect() applies the signal to the DOM through Renderer2.
    try {
      (window as any).__quizTimerExpired = true;
      const i0 = host.normalizeIndex(targetIndex ?? host.currentQuestionIndex() ?? 0);
      const q = host.questions()?.[i0] ?? host.currentQuestion();
      if (q) {
        const opts = q.options ?? host.optionsToDisplay() ?? [];
        const correctIndices = host.explanationTextService.getCorrectOptionIndices(q, opts, i0);
        let fetHtml = '';
        if (correctIndices.length > 0) {
          fetHtml = host.explanationTextService.formatExplanation(q, correctIndices, q.explanation);
        }
        if (!fetHtml) fetHtml = q.explanation || '';

        if (fetHtml) {
          // Guard the delayed writes against the user navigating away
          // before they fire — without this, a stale Q's FET would land
          // in the heading after Q(N+1) has already rendered.
          const expectedIdx = i0;
          const write = () => {
            const sigIdx = host.questionIndex?.() ?? host.currentQuestionIndex?.() ?? 0;
            const liveIdx = host.normalizeIndex(sigIdx);
            if (liveIdx !== expectedIdx) return;
            this.questionHeadingService.setHtml(fetHtml);
          };
          write();
          afterNextRender(() => {
            write();
          });
        }
      }
    } catch { /* ignore */ }

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
    if (host.handledOnExpiry.has(i0)) return;
    host.handledOnExpiry.add(i0);
    host.onQuestionTimedOut(i0);

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

    if (formattedText) host.applyExplanationTextInZone(formattedText);
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
          if (repaired) host.applyExplanationTextInZone(repaired);
        })
        .catch(() => {});
    }
  }
}