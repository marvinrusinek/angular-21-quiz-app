import { Injectable } from '@angular/core';

import { Option } from '../../../models/Option.model';
import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { QuestionType } from '../../../models/question-type.enum';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { FeedbackService } from '../../features/feedback/feedback.service';
import { SelectionMessageService } from '../../features/selection-message/selection-message.service';
import { TimerService } from '../../features/timer/timer.service';
import { ExplanationTextService } from '../../features/explanation/explanation-text.service';
import { OptionClickHandlerService } from './option-click-handler.service';
import { NextButtonStateService } from '../../state/next-button-state.service';
import { SharedOptionExplanationService } from '../../features/shared-option/shared-option-explanation.service';

/**
 * Handles multi-answer and single-answer click processing logic.
 * Extracted from SharedOptionClickService.runOptionContentClick.
 */
@Injectable({ providedIn: 'root' })
export class SocAnswerProcessingService {
  constructor(
    private quizService: QuizService,
    private quizStateService: QuizStateService,
    private selectedOptionService: SelectedOptionService,
    private feedbackService: FeedbackService,
    private selectionMessageService: SelectionMessageService,
    private timerService: TimerService,
    private explanationTextService: ExplanationTextService,
    private clickHandler: OptionClickHandlerService,
    private nextButtonStateService: NextButtonStateService,
    private sharedOptionExplanationService: SharedOptionExplanationService
  ) {}

  /**
   * Processes a multi-answer option click: updates disabled set, bindings,
   * feedback, selection message, and triggers FET when all correct are selected.
   */
  processMultiAnswerClick(params: {
    comp: any;
    index: number;
    binding: any;
    qIdx: number;
    durableSet: Set<number>;
    effectiveCorrectIndices: number[];
    effectiveCorrectCount: number;
    isShuffled: boolean;
  }): void {
    const { comp, index, binding, qIdx, durableSet, isShuffled } = params;
    let { effectiveCorrectIndices, effectiveCorrectCount } = params;

    // PRISTINE-AUTHORITATIVE: always recompute correctIndices from
    // quizInitialState. Upstream bindings can have mutated/missing
    // correct flags so passed-in values aren't reliable. Pristine is
    // the immutable source of truth and the ONLY way to guarantee
    // correctIndices.length matches what the user actually expects
    // for multi-answer questions.
    try {
      const nrmR = (t: any) => String(t ?? '').trim().toLowerCase();
      const liveQ: any = comp.currentQuestion
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]
        ?? (this.quizService as any)?.questions?.[qIdx];
      const liveQText = nrmR(liveQ?.questionText);
      const bindings: any[] = comp.optionBindings ?? [];
      if (liveQText && bindings.length) {
        const bundleR: any[] = (this.quizService as any)?.quizInitialState ?? [];
        outer: for (const quizR of bundleR) {
          for (const pqR of (quizR?.questions ?? [])) {
            if (nrmR(pqR?.questionText) !== liveQText) continue;
            const pristineCorrectTexts = new Set(
              (pqR?.options ?? [])
                .filter((o: any) =>
                  o?.correct === true || String(o?.correct) === 'true' ||
                  o?.correct === 1 || o?.correct === '1'
                )
                .map((o: any) => nrmR(o?.text))
                .filter((t: string) => !!t)
            );
            if (pristineCorrectTexts.size > 0) {
              const rebuilt: number[] = [];
              for (let i = 0; i < bindings.length; i++) {
                if (pristineCorrectTexts.has(nrmR(bindings[i]?.option?.text))) {
                  rebuilt.push(i);
                }
              }
              // Authoritative override (pristine wins) — but only when
              // the rebuild actually identifies AT LEAST as many correct
              // bindings as we already had, to avoid pathological cases
              // where text matching fails completely.
              if (rebuilt.length >= effectiveCorrectIndices.length && rebuilt.length > 0) {
                effectiveCorrectIndices = rebuilt;
                effectiveCorrectCount = rebuilt.length;
              }
            }
            break outer;
          }
        }
      }
    } catch { /* ignore */ }

    const clickState = this.clickHandler.computeMultiAnswerClickState(
      index, durableSet, effectiveCorrectIndices
    );

    if (!comp.disabledOptionsPerQuestion.has(qIdx)) {
      comp.disabledOptionsPerQuestion.set(qIdx, new Set<number>());
    }
    const disabledSetRef = comp.disabledOptionsPerQuestion.get(qIdx)!;
    this.clickHandler.updateDisabledSet(
      disabledSetRef, index, clickState.isClickedCorrect,
      clickState.remaining, comp.optionBindings.length, effectiveCorrectIndices
    );

    // Set _multiAnswerPerfect BEFORE applying bindings so that
    // isDisabled() sees it when Angular re-renders the option items.
    if (clickState.remaining === 0) {
      if (!(this.quizService as any)._multiAnswerPerfect) {
        (this.quizService as any)._multiAnswerPerfect = new Map<number, boolean>();
      }
      (this.quizService as any)._multiAnswerPerfect.set(qIdx, true);
    }

    const bindingUpdates = this.clickHandler.computeMultiAnswerBindingUpdates(
      comp.optionBindings.length, durableSet, effectiveCorrectIndices, disabledSetRef
    );

    // Q2/Q4 GUARD: when pristine has more correct than we've selected,
    // suppress disabled=true on every binding except the previously-
    // clicked incorrect option(s). This blocks both the binding flag
    // AND the .disabled-option CSS class that getOptionClasses derives
    // from !!binding.disabled.
    let suppressDisableForUnselected = false;
    try {
      const nrmS = (t: any) => String(t ?? '').trim().toLowerCase();
      const liveQS: any = comp.currentQuestion
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]
        ?? (this.quizService as any)?.questions?.[qIdx];
      const liveQTextS = nrmS(liveQS?.questionText);
      if (liveQTextS) {
        const bundleS: any[] = (this.quizService as any)?.quizInitialState ?? [];
        outerS: for (const quizS of bundleS) {
          for (const pqS of (quizS?.questions ?? [])) {
            if (nrmS(pqS?.questionText) !== liveQTextS) continue;
            const pristineCorrectTextsS = new Set(
              (pqS?.options ?? [])
                .filter((o: any) =>
                  o?.correct === true || String(o?.correct) === 'true' ||
                  o?.correct === 1 || o?.correct === '1'
                )
                .map((o: any) => nrmS(o?.text))
                .filter((t: string) => !!t)
            );
            if (pristineCorrectTextsS.size > 1) {
              const bindingsS: any[] = comp.optionBindings ?? [];
              let selectedCorrectS = 0;
              for (const sIdx of durableSet) {
                if (pristineCorrectTextsS.has(nrmS(bindingsS[sIdx]?.option?.text))) {
                  selectedCorrectS++;
                }
              }
              if (selectedCorrectS < pristineCorrectTextsS.size) {
                suppressDisableForUnselected = true;
              }
            }
            break outerS;
          }
        }
      }
    } catch { /* ignore */ }

    comp.optionBindings = comp.optionBindings.map((ob: any, bi: number) => {
      let disabledFinal = bindingUpdates[bi].disabled;
      // Only allow `disabled` for clicked-incorrect options before the
      // question is fully answered. Everything else stays enabled so the
      // user can still pick the second correct answer.
      if (suppressDisableForUnselected && disabledFinal && !durableSet.has(bi)) {
        disabledFinal = false;
      }
      return {
        ...ob,
        isSelected: bindingUpdates[bi].isSelected,
        isCorrect: bindingUpdates[bi].isCorrect,
        disabled: disabledFinal,
        option: ob.option ? {
          ...ob.option,
          ...bindingUpdates[bi].optionOverrides
        } : ob.option
      };
    });

    const feedbackText = this.clickHandler.generateMultiAnswerFeedbackText(clickState);

    const correctMessage = this.feedbackService.setCorrectMessage(
      (comp.optionsToDisplay ?? []).filter((o: any) => o && typeof o === 'object'),
      comp.currentQuestion!
    );
    comp._feedbackDisplay = {
      idx: index,
      config: {
        feedback: feedbackText,
        showFeedback: true,
        correctMessage,
        selectedOption: binding.option,
        options: comp.optionsToDisplay ?? [],
        question: comp.currentQuestion ?? null,
        idx: index
      } as FeedbackProps
    };

    const optsForMsg: Option[] = comp.optionBindings.map((ob: any, bi: number) => ({
      ...ob.option,
      correct: new Set(effectiveCorrectIndices).has(bi),
      selected: durableSet.has(bi),
    })) as Option[];
    const selMsg = this.selectionMessageService.computeFinalMessage({
      index: qIdx,
      total: this.quizService?.totalQuestions ?? 0,
      qType: QuestionType.MultipleAnswer,
      opts: optsForMsg
    });
    this.selectionMessageService.pushMessage(selMsg, qIdx);
    queueMicrotask(() => this.selectionMessageService.pushMessage(selMsg, qIdx));
    setTimeout(() => this.selectionMessageService.pushMessage(selMsg, qIdx), 0);

    // CHECK: all correct options selected?
    // PRISTINE-AUTHORITATIVE: count how many selected options' texts
    // match a pristine correct option text. allCorrectInDurable only
    // when count === pristine correct count. This bypasses any index-
    // mismatch issues between effectiveCorrectIndices and the actual
    // multi-answer count from quizInitialState.
    let allCorrectInDurable = effectiveCorrectIndices.length > 0 &&
      effectiveCorrectIndices.every((ci: number) => durableSet.has(ci));
    try {
      const nrmAC = (t: any) => String(t ?? '').trim().toLowerCase();
      const liveQAC: any = comp.currentQuestion
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]
        ?? (this.quizService as any)?.questions?.[qIdx];
      const liveQTextAC = nrmAC(liveQAC?.questionText);
      const bindingsAC: any[] = comp.optionBindings ?? [];
      if (liveQTextAC && bindingsAC.length) {
        const bundleAC: any[] = (this.quizService as any)?.quizInitialState ?? [];
        outerAC: for (const quizAC of bundleAC) {
          for (const pqAC of (quizAC?.questions ?? [])) {
            if (nrmAC(pqAC?.questionText) !== liveQTextAC) continue;
            const pristineCorrectTextsAC = new Set(
              (pqAC?.options ?? [])
                .filter((o: any) =>
                  o?.correct === true || String(o?.correct) === 'true' ||
                  o?.correct === 1 || o?.correct === '1'
                )
                .map((o: any) => nrmAC(o?.text))
                .filter((t: string) => !!t)
            );
            if (pristineCorrectTextsAC.size > 0) {
              // Count selected bindings whose text matches a pristine correct
              let selectedCorrectCount = 0;
              for (const selIdx of durableSet) {
                const txt = nrmAC(bindingsAC[selIdx]?.option?.text);
                if (pristineCorrectTextsAC.has(txt)) selectedCorrectCount++;
              }
              allCorrectInDurable = selectedCorrectCount >= pristineCorrectTextsAC.size;
            }
            break outerAC;
          }
        }
      }
    } catch { /* keep upstream value */ }

    if (allCorrectInDurable) {
      try { this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true }); } catch {}
      this.nextButtonStateService.setNextButtonState(true);

      // Set FET bypass BEFORE scoring so all downstream gates are open
      this.explanationTextService.fetBypassForQuestion.set(qIdx, true);

      this.quizService.scoreDirectly(qIdx, true, true);

      if (!(this.quizService as any)._multiAnswerPerfect) {
        (this.quizService as any)._multiAnswerPerfect = new Map<number, boolean>();
      }
      (this.quizService as any)._multiAnswerPerfect.set(qIdx, true);

      (this.explanationTextService as any)._fetLocked = false;
      this.explanationTextService.unlockExplanation();

      comp.showExplanationChange.emit(true);

      // Resolve explanation text from pristine data and write directly
      let fetText = '';
      try {
        const nrmFET = (t: any) => String(t ?? '').trim().toLowerCase();
        const fetQText = isShuffled
          ? (nrmFET((this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText)
            || nrmFET((this.quizService as any)?.shuffledQuestions?.[qIdx]?.questionText))
          : (nrmFET(comp.currentQuestion?.questionText)
            || nrmFET((this.quizService as any)?.questions?.[qIdx]?.questionText));
        const bundleFET: any[] = (this.quizService as any)?.quizInitialState ?? [];
        for (const quiz of bundleFET) {
          for (const pq of (quiz?.questions ?? [])) {
            if (nrmFET(pq?.questionText) !== fetQText) continue;
            fetText = (pq?.explanation ?? '').trim();
            break;
          }
          if (fetText) break;
        }
        // Also try live question objects
        if (!fetText) {
          const liveQ = comp.currentQuestion
            ?? comp.getQuestionAtDisplayIndex?.(qIdx)
            ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx];
          fetText = (liveQ?.explanation ?? '').trim();
        }
      } catch { /* ignore */ }

      if (fetText) {
        // Format as "Options X and Y are correct because ..." using
        // 1-based option numbers (matches the formatter used everywhere
        // else for multi-answer FET).
        let formattedFET = fetText;
        try {
          const oneBasedIndices = effectiveCorrectIndices
            .map((ci: number) => ci + 1)
            .filter((n: number) => Number.isFinite(n) && n > 0);
          const qForFormat = comp.currentQuestion
            ?? comp.getQuestionAtDisplayIndex?.(qIdx)
            ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]
            ?? (this.quizService as any)?.questions?.[qIdx];
          if (qForFormat && oneBasedIndices.length > 0) {
            formattedFET = this.explanationTextService.formatExplanation(
              qForFormat,
              oneBasedIndices,
              fetText
            );
          }
        } catch { /* ignore */ }

        // Write directly via explanationTextService
        this.explanationTextService._activeIndex = qIdx;
        (this.explanationTextService as any).latestExplanation = formattedFET;
        (this.explanationTextService as any).latestExplanationIndex = qIdx;
        this.explanationTextService.setExplanationText(formattedFET, {
          force: true,
          context: `question:${qIdx}`,
          index: qIdx
        });
        this.explanationTextService.emitFormatted(qIdx, formattedFET);
        this.explanationTextService.setShouldDisplayExplanation(true, {
          context: `question:${qIdx}`,
          force: true
        } as any);
        this.explanationTextService.setIsExplanationTextDisplayed(true, {
          context: `question:${qIdx}`,
          force: true
        } as any);
        this.explanationTextService.lockExplanation();
        this.quizStateService.setDisplayState({ mode: 'explanation', answered: true });

        // DIRECT DOM FALLBACK — writes FET into the qText heading without
        // routing through the reactive pipeline or writeQText guards.
        // Mirrors the single-answer path; required for multi-answer because
        // the reactive pipeline can race with selectedOptionsMap updates and
        // the writeQText looksLikeFet gate can revert FET back to question
        // text before scoreDirectly's questionCorrectness flag is observed.
        const fetForDom = formattedFET;
        const stampQIdx = qIdx;
        const stampFet = () => {
          try {
            // Originating-question guard: if the user has navigated away,
            // the current question is no longer the one this FET belongs
            // to. Stamping Q(N)'s FET into Q(N+1)'s heading would leak
            // stale FET across questions ("Q1's FET shows for Q2").
            const liveIdx = (this.quizService as any)?.getCurrentQuestionIndex?.()
              ?? (this.quizService as any)?.currentQuestionIndex;
            if (typeof liveIdx === 'number' && liveIdx !== stampQIdx) return;
            this.writeFetToQuestionTextIfNeeded(fetForDom);
          } catch { /* ignore */ }
        };
        stampFet();
        setTimeout(stampFet, 50);
        setTimeout(stampFet, 150);
        setTimeout(stampFet, 350);
      }

      // Also try the component path as backup
      setTimeout(() => {
        try {
          comp.emitExplanation(qIdx, true);
        } catch { /* ignore */ }
      }, 50);
    } else if (!allCorrectInDurable) {
    }

    const savedFeedback = comp._feedbackDisplay;
    queueMicrotask(() => {
      comp._feedbackDisplay = savedFeedback;
      comp.cdRef.detectChanges();
    });

    comp.showFeedback = true;
    comp.cdRef.detectChanges();

    // Multi-answer: when all correct options are selected, also
    // re-spread bindings AND fall back to a DOM stamp. The Angular
    // binding rebuild SHOULD make the OnPush option-items re-render,
    // but the click-flow CD timing in this codebase doesn't always
    // propagate cleanly to siblings. The DOM stamp guarantees the
    // visual lock as a belt-and-suspenders fallback.
    if (allCorrectInDurable) {
      queueMicrotask(() => {
        const correctSet = new Set(effectiveCorrectIndices);
        comp.optionBindings = (comp.optionBindings ?? []).map((b: any, bi: number) => {
          const isCorrectIdx = correctSet.has(bi);
          return {
            ...b,
            disabled: !isCorrectIdx,
            isCorrect: isCorrectIdx,
            option: b.option ? {
              ...b.option,
              active: isCorrectIdx
            } : b.option
          };
        });
        comp.cdRef.detectChanges();
      });

      // DOM fallback — guarantees the visual lock regardless of CD timing.
      const stamp = () => {
        try {
          const correctSet = new Set(effectiveCorrectIndices);
          const items = document.querySelectorAll('app-option-item');
          items.forEach((el, idx) => {
            if (correctSet.has(idx)) return;
            const row = el.querySelector('.option-row') as HTMLElement | null;
            if (row) {
              row.style.pointerEvents = 'none';
              row.style.backgroundColor = '#a0a0a0';
              row.style.opacity = '0.7';
            }
            const input = el.querySelector('input') as HTMLInputElement | null;
            if (input) input.disabled = true;
          });
        } catch { /* DOM not ready */ }
      };
      stamp();
      setTimeout(stamp, 0);
      setTimeout(stamp, 50);
    }
  }

  /**
   * Processes a single-answer option click: pristine correctness check,
   * FET emission, timer stop, option disable/highlight, session persistence.
   */
  processSingleAnswerClick(params: {
    comp: any;
    index: number;
    qIdx: number;
    durableSet: Set<number>;
    effectiveCorrectIndices: number[];
    isShuffled: boolean;
  }): void {
    const { comp, index, qIdx, durableSet, effectiveCorrectIndices, isShuffled } = params;

    // GUARD: If pristine data says this is actually a multi-answer
    // question, abort the single-answer path. Otherwise selecting one
    // correct option (or one incorrect + one correct) would lock the
    // remaining options before the user has answered the second correct.
    // Routes back through processMultiAnswerClick which only locks
    // incorrects after all correct answers are selected.
    try {
      const nrmGuard = (t: any) => String(t ?? '').trim().toLowerCase();
      const liveQText = nrmGuard(comp.currentQuestion?.questionText)
        || nrmGuard((this.quizService as any)?.questions?.[qIdx]?.questionText)
        || nrmGuard((this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText);
      if (liveQText) {
        const bundleGuard: any[] = (this.quizService as any)?.quizInitialState ?? [];
        for (const quiz of bundleGuard) {
          for (const pq of (quiz?.questions ?? [])) {
            if (nrmGuard(pq?.questionText) !== liveQText) continue;
            const pristineCorrectCount = (pq?.options ?? []).filter(
              (o: any) =>
                o?.correct === true || String(o?.correct) === 'true' ||
                o?.correct === 1 || o?.correct === '1'
            ).length;
            if (pristineCorrectCount > 1) {
              const correctIndicesByText: number[] = [];
              const pristineCorrectTexts = new Set(
                (pq?.options ?? [])
                  .filter((o: any) =>
                    o?.correct === true || String(o?.correct) === 'true' ||
                    o?.correct === 1 || o?.correct === '1'
                  )
                  .map((o: any) => nrmGuard(o?.text))
              );
              const bindings: any[] = comp.optionBindings ?? [];
              for (let i = 0; i < bindings.length; i++) {
                if (pristineCorrectTexts.has(nrmGuard(bindings[i]?.option?.text))) {
                  correctIndicesByText.push(i);
                }
              }
              this.processMultiAnswerClick({
                comp,
                index,
                binding: comp.optionBindings?.[index],
                qIdx,
                durableSet,
                effectiveCorrectIndices: correctIndicesByText.length
                  ? correctIndicesByText
                  : effectiveCorrectIndices,
                effectiveCorrectCount: correctIndicesByText.length || pristineCorrectCount,
                isShuffled
              });
              return;
            }
            break;
          }
        }
      }
    } catch { /* fall through to single-answer path */ }

    // CANONICAL resolution: match comp.currentQuestion text against
    // quizService.questions[] to get authoritative correct flags.
    let correctIdxs: number[] = [];
    try {
      const allQs: any[] = (this.quizService as any)?.questions ?? [];
      const passedText = (comp.currentQuestion?.questionText || '').trim().toLowerCase();
      let canonicalQ: any = null;
      if (passedText && allQs.length) {
        const idx = allQs.findIndex((q: any) => (q?.questionText || '').trim().toLowerCase() === passedText);
        if (idx >= 0) canonicalQ = allQs[idx];
      }
      if (!canonicalQ) canonicalQ = allQs[qIdx] ?? comp.currentQuestion;
      const rawOpts = canonicalQ?.options ?? [];
      correctIdxs = rawOpts
        .map((o: any, i: number) => {
          const c = o?.correct ?? o?.isCorrect;
          return (c === true || c === 'true' || c === 1 || c === '1') ? i : -1;
        })
        .filter((n: number) => n >= 0);
    } catch {}
    if (correctIdxs.length === 0 && effectiveCorrectIndices?.length) {
      correctIdxs = effectiveCorrectIndices;
    }
    const correctSet = new Set(correctIdxs);

    // Pristine cross-check for single-answer
    let pristineSingleCorrect = false;
    try {
      const nrmSA = (t: any) => String(t ?? '').trim().toLowerCase();
      const clickedText = nrmSA(comp.optionBindings?.[index]?.option?.text);
      const qTextSA = isShuffled
        ? (nrmSA((this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText)
          || nrmSA((this.quizService as any)?.shuffledQuestions?.[qIdx]?.questionText))
        : (nrmSA(comp.currentQuestion?.questionText)
          || nrmSA((this.quizService as any)?.questions?.[qIdx]?.questionText));
      if (clickedText && qTextSA) {
        const bundleSA: any[] = (this.quizService as any)?.quizInitialState ?? [];
        let saMatched = false;
        for (const quiz of bundleSA) {
          for (const pq of (quiz?.questions ?? [])) {
            if (nrmSA(pq?.questionText) !== qTextSA) continue;
            saMatched = true;
            const matchedOpt = (pq?.options ?? []).find((o: any) => nrmSA(o?.text) === clickedText);
            if (matchedOpt !== undefined) {
              pristineSingleCorrect = matchedOpt?.correct === true || String(matchedOpt?.correct) === 'true';
            }
            break;
          }
          if (saMatched) break;
        }
      }
    } catch { /* ignore */ }

    if (pristineSingleCorrect) {
      try { this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true }); } catch {}

      // Score and emit FET for single-answer correct click
      this.explanationTextService.fetBypassForQuestion.set(qIdx, true);
      this.quizService.scoreDirectly(qIdx, true, false);
      this.nextButtonStateService.setNextButtonState(true);
      if (!(this.quizService as any)._multiAnswerPerfect) {
        (this.quizService as any)._multiAnswerPerfect = new Map<number, boolean>();
      }
      (this.quizService as any)._multiAnswerPerfect.set(qIdx, true);

      (this.explanationTextService as any)._fetLocked = false;
      this.explanationTextService.unlockExplanation();
      comp.showExplanationChange.emit(true);
      const singleFetQuestion = comp.currentQuestion
        ?? comp.getQuestionAtDisplayIndex?.(qIdx)
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx];

      // Synchronous FET write
      try {
        const singleFetCtxSync = {
          resolvedIndex: qIdx,
          question: singleFetQuestion,
          currentQuestion: comp.currentQuestion,
          quizId: comp.quizId?.() ?? comp.quizId ?? '',
          optionBindings: comp.optionBindings ?? [],
          optionsToDisplay: comp.optionsToDisplay ?? [],
          isMultiMode: false
        };
        const fetText = this.sharedOptionExplanationService.resolveExplanationText(singleFetCtxSync as any)?.trim()
          || singleFetQuestion?.explanation || '';
        if (fetText) {
          this.explanationTextService._activeIndex = qIdx;
          (this.explanationTextService as any).latestExplanation = fetText;
          (this.explanationTextService as any).latestExplanationIndex = qIdx;
          this.explanationTextService.setExplanationText(fetText, {
            force: true,
            context: `question:${qIdx}`,
            index: qIdx
          });
          this.explanationTextService.emitFormatted(qIdx, fetText);
          this.explanationTextService.setShouldDisplayExplanation(true, {
            context: `question:${qIdx}`,
            force: true
          } as any);
          this.explanationTextService.setIsExplanationTextDisplayed(true, {
            context: `question:${qIdx}`,
            force: true
          } as any);
          this.explanationTextService.lockExplanation();
          this.quizStateService.setDisplayState({ mode: 'explanation', answered: true });
        }
      } catch (syncErr) {}

      const singleFetCtx = {
        resolvedIndex: qIdx,
        question: singleFetQuestion,
        currentQuestion: comp.currentQuestion,
        quizId: comp.quizId?.() ?? comp.quizId ?? '',
        optionBindings: comp.optionBindings ?? [],
        optionsToDisplay: comp.optionsToDisplay ?? [],
        isMultiMode: false
      };
      let resolvedFetText = '';
      try {
        resolvedFetText = this.sharedOptionExplanationService.resolveExplanationText(singleFetCtx as any)?.trim()
          || singleFetQuestion?.explanation || '';
      } catch { /* ignore */ }
      setTimeout(() => {
        try {
          this.sharedOptionExplanationService.emitExplanation(singleFetCtx as any, true);
        } catch {
          comp.emitExplanation(qIdx, true);
        }
      }, 0);

      // DIRECT DOM FALLBACK
      if (resolvedFetText) {
        const fetForDom = resolvedFetText;
        const stampQIdx = qIdx;
        const stampFet = (label: string) => {
          try {
            // Originating-question guard: skip if user has navigated away,
            // otherwise this stamps Q(N)'s FET into Q(N+1)'s heading.
            const liveIdx = (this.quizService as any)?.getCurrentQuestionIndex?.()
              ?? (this.quizService as any)?.currentQuestionIndex;
            if (typeof liveIdx === 'number' && liveIdx !== stampQIdx) return;
            this.writeFetToQuestionTextIfNeeded(fetForDom);
          } catch { /* ignore */ }
        };
        setTimeout(() => stampFet('50ms'), 50);
        setTimeout(() => stampFet('150ms'), 150);
        setTimeout(() => stampFet('350ms'), 350);
      }

      if (!comp.disabledOptionsPerQuestion.has(qIdx)) {
        comp.disabledOptionsPerQuestion.set(qIdx, new Set<number>());
      }
      const disabledSetRef = comp.disabledOptionsPerQuestion.get(qIdx)!;
      disabledSetRef.clear();
      const currentBindings: any[] = Array.isArray(comp.optionBindings)
        ? comp.optionBindings
        : (typeof comp.optionBindings === 'function' ? comp.optionBindings() : []);
      for (let i = 0; i < currentBindings.length; i++) {
        if (!correctSet.has(i)) disabledSetRef.add(i);
      }

      const durableClicks = comp._multiSelectByQuestion?.get(qIdx);
      const historySet = new Set<number>(durableClicks ?? []);

      // Replace with NEW array of NEW binding objects so OnPush children re-render.
      const newBindings = currentBindings.map((ob: any, bi: number) => {
        const isCorrectBinding = correctSet.has(bi);
        const isClicked = bi === index;
        const wasPreviouslyClicked = historySet.has(bi) && !isClicked && !isCorrectBinding;
        return {
          ...ob,
          disabled: !isCorrectBinding,
          isSelected: isClicked,
          option: ob?.option ? {
            ...ob.option,
            selected: isClicked,
            highlight: isClicked || wasPreviouslyClicked,
            showIcon: isClicked || wasPreviouslyClicked
          } : ob?.option
        };
      });
      comp.optionBindings = newBindings;

      // Persist selections to session storage
      try {
        const toSave: any[] = [];
        for (let bi = 0; bi < newBindings.length; bi++) {
          const nb = newBindings[bi];
          if (!nb?.option) continue;
          const isCorrectBinding = correctSet.has(bi);
          const isClicked = bi === index;
          const wasPreviouslyClicked = historySet.has(bi) && !isClicked && !isCorrectBinding;
          if (isClicked || wasPreviouslyClicked) {
            toSave.push({
              optionId: nb.option.optionId,
              text: nb.option.text,
              displayIndex: bi,
              questionIndex: qIdx,
              selected: isClicked,
              highlight: true,
              showIcon: true,
              correct: isCorrectBinding
            });
          }
        }
        if (toSave.length > 0) {
          sessionStorage.setItem('sel_Q' + qIdx, JSON.stringify(toSave));
          this.selectedOptionService.addToSelectionHistory(qIdx, toSave as any[]);
        }
      } catch { /* ignore */ }

      comp.cdRef?.markForCheck?.();
      comp.cdRef?.detectChanges?.();
    }
  }

  private writeFetToQuestionTextIfNeeded(fetForDom: string): void {
    const h3 = this.qText?.nativeElement;
    if (!h3) return;
  
    const domNow = h3.innerHTML.toLowerCase();
    if (!domNow.includes('correct because')) {
      h3.innerHTML = fetForDom;
    }
  }
}