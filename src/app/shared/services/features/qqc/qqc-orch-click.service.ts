import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { QuestionType } from '../../../models/question-type.enum';
import type { QuizQuestionComponent } from '../../../../components/question/quiz-question/quiz-question.component';

type Host = QuizQuestionComponent;

/**
 * Orchestrates QQC option click handling.
 * Extracted from QqcComponentOrchestratorService.
 */
@Injectable({ providedIn: 'root' })
export class QqcOrchClickService {

  async runOnOptionClicked(
    host: Host,
    event: { option: any; index: number; checked: boolean; wasReselected?: boolean }
  ): Promise<void> {
    host._skipNextAsyncUpdates = false;

    if (host._pendingRAF != null) {
      cancelAnimationFrame(host._pendingRAF);
      host._pendingRAF = null;
    }

    if (!host.quizStateService.isInteractionReady()) {
      await firstValueFrom(
        host.quizStateService.interactionReady$.pipe(filter(Boolean), take(1))
      );
    }

    if (!host.currentQuestion() || !host.currentOptions) return;

    const idx = host.quizService.getCurrentQuestionIndex() ?? 0;
    const q = host.quizService.getQuestionsInDisplayOrder?.()?.[idx]
      ?? host.questions()?.[idx];
    const evtIdx = event.index;
    const evtOpt = event.option;

    host.explanationDisplay.resetExplanationStateForClick(idx);

    if (evtOpt == null) return;

    try {
      const lockIdNum = Number(evtOpt?.optionId);
      if (Number.isFinite(lockIdNum) && host.selectedOptionService.isOptionLocked(idx, lockIdNum)) {
        return;
      }
    } catch {}

    if (host._clickGate) return;
    host._clickGate = true;
    host.questionFresh = false;

    try {
      const clickResult = host.clickOrchestrator.performSynchronousClickFlow({
        question: q!,
        questionIndex: idx,
        evtIdx,
        evtOpt,
        checked: event.checked,
        optionsToDisplay: host.optionsToDisplay(),
        currentQuestionOptions: host.currentQuestion()?.options,
        totalQuestions: host.totalQuestions(),
        msgTok: host._msgTok
      });

      const { selectedKeysSet: selOptsSetImmediate,
        isMultiForSelection, allCorrect } = clickResult;
      host._msgTok = clickResult.msgTok;
      host._lastAllCorrect = allCorrect;

      host.updateOptionHighlighting(selOptsSetImmediate);
      host.refreshFeedbackFor(evtOpt ?? undefined);

      const applySingleAnswerDisable = () => {
      try {
        const rawQuestion: any = host.quizService.getQuestionsInDisplayOrder?.()?.[idx]
          ?? (host.quizService as any)?.questions?.[idx]
          ?? q;
        const rawOpts: any[] = rawQuestion?.options ?? [];
        const rawCorrectCount = rawOpts.filter((o: any) =>
          o?.correct === true || String(o?.correct) === 'true'
        ).length;

        // Pristine fallback: if rawCorrectCount looks like single-answer
        // (0 or 1) but quizInitialState shows >1 correct for the same
        // question text, the binding/raw flags are stale and this is
        // actually a multi-answer question. Skip the single-answer
        // disable-all-incorrects path; the multi-answer pipeline
        // (option-click-handler.updateDisabledSet) will lock incorrects
        // only after ALL correct are selected.
        let pristineMultiDetected = false;
        try {
          const nrmM = (t: any) => String(t ?? '').trim().toLowerCase();
          const liveQText = nrmM(rawQuestion?.questionText);
          if (liveQText) {
            const bundleM: any[] = (host.quizService as any)?.quizInitialState ?? [];
            for (const quizM of bundleM) {
              for (const pqM of (quizM?.questions ?? [])) {
                if (nrmM(pqM?.questionText) !== liveQText) continue;
                const pristineCorrect = (pqM?.options ?? []).filter(
                  (o: any) =>
                    o?.correct === true || String(o?.correct) === 'true' ||
                    o?.correct === 1 || o?.correct === '1'
                ).length;
                if (pristineCorrect > 1) pristineMultiDetected = true;
                break;
              }
              if (pristineMultiDetected) break;
            }
          }
        } catch { /* ignore */ }

        const isSingleAnswer = !pristineMultiDetected && rawCorrectCount <= 1;
        const correctIdSet = new Set<number>(
          rawOpts
            .map((o: any, i: number) => {
              const c = o?.correct === true || String(o?.correct) === 'true';
              if (!c) return -1;
              const id = Number(o?.optionId);
              return Number.isFinite(id) && id !== -1 ? id : i;
            })
            .filter((n: number) => n >= 0)
        );
        const clickedId = Number(evtOpt?.optionId);
        const clickedKey = Number.isFinite(clickedId) && clickedId !== -1 ? clickedId : evtIdx;
        const clickedIsCorrect = correctIdSet.has(clickedKey)
          || evtOpt?.correct === true
          || String(evtOpt?.correct) === 'true';

        if (correctIdSet.size === 0 && clickedIsCorrect) {
          correctIdSet.add(clickedKey);
        }

        if (isSingleAnswer && clickedIsCorrect) {
          const targets: any[][] = [];
          const soc: any = host.sharedOptionComponent?.();
          if (soc?.optionBindings?.length) targets.push(soc.optionBindings);
          const sigBindings: any[] = host.optionBindings?.() ?? [];
          if (sigBindings?.length) targets.push(sigBindings);
          for (const arr of targets) {
            for (let bi = 0; bi < arr.length; bi++) {
              const b = arr[bi];
              if (!b) continue;
              const bId = Number(b.option?.optionId);
              const effId = Number.isFinite(bId) && bId !== -1 ? bId : bi;
              const isCorrect = correctIdSet.has(effId);
              b.disabled = !isCorrect;
              if (b.option) b.option.active = isCorrect;
              if (!isCorrect && (b.isSelected || b.option?.selected)) {
                b.highlight = true;
                b.showFeedback = true;
                if (b.option) {
                  b.option.highlight = true;
                  b.option.showIcon = true;
                  b.option.feedback = b.option.feedback || 'incorrect';
                }
              }
            }
          }
          soc?.cdRef?.markForCheck?.();
          soc?.cdRef?.detectChanges?.();
        }
      } catch {}
      };

      applySingleAnswerDisable();

      host.cdRef.markForCheck();
      host.cdRef.detectChanges();

      const lockedIndex = host.currentQuestionIndex() ?? idx;

      let fetGatePassed = allCorrect && isMultiForSelection;
      if (fetGatePassed) {
        try {
          const displayQ: any = host.quizService.getQuestionsInDisplayOrder?.()?.[idx]
            ?? (host.quizService as any)?.questions?.[idx]
            ?? q;
          const norm = (t: any) => String(t ?? '').trim().toLowerCase();
          let rawCorrectTexts = new Set<string>();
          try {
            const qTextNorm = norm(displayQ?.questionText);
            for (const quiz of ((host.quizService as any)?.quizInitialState ?? []) as any[]) {
              for (const pq of (quiz?.questions ?? [])) {
                if (norm(pq?.questionText) !== qTextNorm) continue;
                rawCorrectTexts = new Set(
                  (pq?.options ?? [])
                    .filter((o: any) => o?.correct === true || String(o?.correct) === 'true')
                    .map((o: any) => norm(o?.text))
                    .filter((t: string) => !!t)
                );
                break;
              }
              if (rawCorrectTexts.size > 0) break;
            }
          } catch { /* ignore */ }
          if (rawCorrectTexts.size === 0) {
            const rawOpts: any[] = displayQ?.options ?? [];
            rawCorrectTexts = new Set(
              rawOpts.filter((o: any) => o?.correct === true || String(o?.correct) === 'true')
                .map((o: any) => norm(o?.text))
                .filter((t: string) => !!t)
            );
          }
          const svcSel = host.selectedOptionService.getSelectedOptionsForQuestion(idx) ?? [];
          const selTexts = new Set(svcSel.map((s: any) => norm(s?.text)).filter((t: string) => !!t));
          const allCorrectSel = rawCorrectTexts.size > 0 && [...rawCorrectTexts].every(t => selTexts.has(t));
          if (!allCorrectSel) {
            fetGatePassed = false;
          }
        } catch { /* trust upstream */ }
      }

      if (fetGatePassed && !host._fetEarlyShown.has(lockedIndex)) {
        if (host.timerEffect.safeStopTimer('completed', host._timerStoppedForQuestion, host._lastAllCorrect)) {
          host._timerStoppedForQuestion = true;
        }
        host._fetEarlyShown.add(lockedIndex);
        const displayQForFet = host.quizService.getQuestionsInDisplayOrder?.()?.[lockedIndex] ?? q;
        host.explanationFlow.triggerMultiAnswerFet({ lockedIndex, question: displayQForFet }).then((fetResult: any) => {
          if (host.currentQuestionIndex() !== lockedIndex || !fetResult) return;
          host.displayExplanation = true;
          host.displayMode.set('explanation');
          host.isAnswered.set(true);
          host.showExplanationChange.emit(true);
          host.explanationToDisplay.set(fetResult.formatted);
          host.explanationToDisplayChange?.emit(fetResult.formatted);
        }).catch(() => {});
      }

      queueMicrotask(() => {
        if (host._skipNextAsyncUpdates) return;
        host.updateOptionHighlighting(selOptsSetImmediate);
        host.refreshFeedbackFor(evtOpt ?? undefined);
        applySingleAnswerDisable();
        host.cdRef.markForCheck();
        host.cdRef.detectChanges();
      });

      requestAnimationFrame(() => {
        if (host._skipNextAsyncUpdates || idx !== host.currentQuestionIndex()) return;
        const resolvedQuizId =
          host.quizService.quizId ||
          host.activatedRoute.snapshot.paramMap.get('quizId') ||
          'dependency-injection';
        host.clickOrchestrator.performPostClickRafTasks({
          idx,
          evtOpt: evtOpt ?? undefined,
          evtIdx,
          question: q!,
          event,
          quizId: resolvedQuizId,
          generateFeedbackText: (question: QuizQuestion) => host.generateFeedbackText(question),
          postClickTasks: (opt: any, i: number, checked: boolean, wasPrev: boolean, qIdx: number) =>
            host.postClickTasks(opt, i, checked, wasPrev, qIdx),
          handleCoreSelection: (ev: any, i: number) => {
            host.performInitialSelectionFlow(ev, ev.option);
            const coreResult = host.optionSelection.handleCoreSelectionState({
              option: ev.option,
              questionIndex: i,
              currentQuestionIndex: host.currentQuestionIndex(),
              questionType: host.question()?.type,
              forceQuestionDisplay: host.forceQuestionDisplay,
              lastAllCorrect: host._lastAllCorrect,
            });
            if (coreResult.isAnswered) host.isAnswered.set(true);
            host.forceQuestionDisplay = coreResult.forceQuestionDisplay;
            if (coreResult.displayStateAnswered) {
              host.isAnswered.set(coreResult.displayStateAnswered);
              host.displayMode.set(coreResult.displayStateMode);
            }
            host.cdRef.detectChanges();
          },
          markBindingSelected: (opt: any) => {
            const b = host.feedbackManager.markBindingSelected(opt, host.currentQuestionIndex(), host.optionBindings());
            if (!b) return;
            host.optionBindings.set(host.optionBindings().map((ob: any) =>
              ob.option.optionId === b.option.optionId ? b : ob
            ));
            b.directiveInstance?.updateHighlight();
          },
          refreshFeedbackFor: (opt: Option) => host.refreshFeedbackFor(opt),
        }).catch(() => {}).finally(() => {
          applySingleAnswerDisable();
          host.cdRef?.markForCheck?.();
          host.cdRef?.detectChanges?.();
        });
      });

      setTimeout(() => {
        applySingleAnswerDisable();
        host.sharedOptionComponent?.()?.cdRef?.markForCheck?.();
        host.sharedOptionComponent?.()?.cdRef?.detectChanges?.();
        host.cdRef?.markForCheck?.();
        host.cdRef?.detectChanges?.();
      }, 0);

    } finally {
      queueMicrotask(() => {
        host._clickGate = false;
        host.selectionMessageService.releaseBaseline(host.currentQuestionIndex());
        const selectionComplete =
          q?.type === QuestionType.SingleAnswer ? !!evtOpt?.correct : host._lastAllCorrect;
        host.selectionMessageService.setSelectionMessage(selectionComplete);
      });
    }
  }
}