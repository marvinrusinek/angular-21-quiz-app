import { Injectable, inject } from '@angular/core';

import { QuestionType } from '../../../models/question-type.enum';

import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { Option } from '../../../models/Option.model';

import { QuizService } from '../../data/quiz.service';
import { ExplanationTextService } from '../../features/explanation/explanation-text.service';
import { FeedbackService } from '../../features/feedback/feedback.service';
import { SelectionMessageService } from '../../features/selection-message/selection-message.service';
import { SharedOptionExplanationService } from '../../features/shared-option/shared-option-explanation.service';
import { TimerService } from '../../features/timer/timer.service';
import { NextButtonStateService } from '../../state/next-button-state.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { OptionClickHandlerService } from './option-click-handler.service';

/**
 * Handles multi-answer and single-answer click processing logic.
 * Extracted from SharedOptionClickService.runOptionContentClick.
 */
@Injectable({ providedIn: 'root' })
export class SocAnswerProcessingService {
  // ── injects ─────────────────────────────────────────────────────
  private clickHandler = inject(OptionClickHandlerService);
  private explanationTextService = inject(ExplanationTextService);
  private feedbackService = inject(FeedbackService);
  private nextButtonStateService = inject(NextButtonStateService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);
  private selectionMessageService = inject(SelectionMessageService);
  private sharedOptionExplanationService = inject(SharedOptionExplanationService);
  private timerService = inject(TimerService);

  // ── public methods ──────────────────────────────────────────────

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
    let { effectiveCorrectIndices } = params;

    // PRISTINE-AUTHORITATIVE: always recompute correctIndices from
    // quizInitialState. Upstream bindings can have mutated/missing
    // correct flags so passed-in values aren't reliable. Pristine is
    // the immutable source of truth and the ONLY way to guarantee
    // correctIndices.length matches what the user actually expects
    // for multi-answer questions.
    try {
      const nrmR = (t: any) => String(t ?? '').trim().toLowerCase();
      const liveQ: any = comp.currentQuestion()
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]
        ?? (this.quizService as any)?.questions?.[qIdx];
      const bindings: any[] = comp.optionBindings() ?? [];
      if (bindings.length) {
        const pristineCorrectTexts =
          this.quizService.getPristineCorrectTextsForQuestion(liveQ?.questionText);
        if (pristineCorrectTexts.size > 0) {
          const rebuilt: number[] = [];
          for (let i = 0; i < bindings.length; i++) {
            if (pristineCorrectTexts.has(nrmR(bindings[i]?.option?.text))) {
              rebuilt.push(i);
            }
          }
          // Authoritative override (pristine wins) — but only when the
          // rebuild identifies AT LEAST as many correct bindings as we
          // already had, to avoid pathological cases where text matching
          // fails completely.
          if (rebuilt.length >= effectiveCorrectIndices.length && rebuilt.length > 0) {
            effectiveCorrectIndices = rebuilt;
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
      clickState.remaining, comp.optionBindings().length, effectiveCorrectIndices
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
      comp.optionBindings().length, durableSet, effectiveCorrectIndices, disabledSetRef
    );

    // Q2/Q4 GUARD: when pristine has more correct than we've selected,
    // suppress disabled=true on every binding except the previously-
    // clicked incorrect option(s). This blocks both the binding flag
    // AND the .disabled-option CSS class that getOptionClasses derives
    // from !!binding.disabled.
    let suppressDisableForUnselected = false;
    try {
      const nrmS = (t: any) => String(t ?? '').trim().toLowerCase();
      const liveQS: any = comp.currentQuestion()
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]
        ?? (this.quizService as any)?.questions?.[qIdx];
      const pristineCorrectTextsS =
        this.quizService.getPristineCorrectTextsForQuestion(liveQS?.questionText);
      if (pristineCorrectTextsS.size > 1) {
        const bindingsS: any[] = comp.optionBindings() ?? [];
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
    } catch { /* ignore */ }

    comp.optionBindings.set(comp.optionBindings().map((ob: any, bi: number) => {
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
    }));

    const feedbackText = this.clickHandler.generateMultiAnswerFeedbackText(clickState);

    const correctMessage = this.feedbackService.setCorrectMessage(
      (comp.optionsToDisplay ?? []).filter((o: any) => o && typeof o === 'object'),
      comp.currentQuestion()!
    );
    // Build selectedOption.correct from effectiveCorrectIndices (which is
    // recomputed from pristine quizInitialState above). The `binding.option`
    // and even comp.optionBindings()[index].option can be stale relative to
    // the latest pristine rebuild on multi-answer questions, leading to
    // sad-face feedback on the 2nd correct click while the option visuals
    // correctly show green. Pristine indices are the immutable source of truth.
    const freshOption = comp.optionBindings()?.[index]?.option ?? binding.option;
    const isClickedCorrect = new Set(effectiveCorrectIndices).has(index);
    comp._feedbackDisplay = {
      idx: index,
      config: {
        feedback: feedbackText,
        showFeedback: true,
        correctMessage,
        selectedOption: { ...freshOption, correct: isClickedCorrect },
        options: comp.optionsToDisplay ?? [],
        question: comp.currentQuestion() ?? null,
        idx: index
      } as FeedbackProps
    };

    const optsForMsg: Option[] = comp.optionBindings().map((ob: any, bi: number) => ({
      ...ob.option,
      correct: new Set(effectiveCorrectIndices).has(bi),
      selected: durableSet.has(bi),
    })) as Option[];
    const selMsg = this.selectionMessageService.computeFinalMessage({
      index: qIdx,
      total: this.quizService?.totalQuestions() ?? 0,
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
      const liveQAC: any = comp.currentQuestion()
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]
        ?? (this.quizService as any)?.questions?.[qIdx];
      const bindingsAC: any[] = comp.optionBindings() ?? [];
      if (bindingsAC.length) {
        const pristineCorrectTextsAC =
          this.quizService.getPristineCorrectTextsForQuestion(liveQAC?.questionText);
        if (pristineCorrectTextsAC.size > 0) {
          let selectedCorrectCount = 0;
          for (const selIdx of durableSet) {
            const txt = nrmAC(bindingsAC[selIdx]?.option?.text);
            if (pristineCorrectTextsAC.has(txt)) selectedCorrectCount++;
          }
          allCorrectInDurable = selectedCorrectCount >= pristineCorrectTextsAC.size;
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
        const fetQText = isShuffled
          ? ((this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText
            ?? (this.quizService as any)?.shuffledQuestions?.[qIdx]?.questionText)
          : (comp.currentQuestion()?.questionText
            ?? (this.quizService as any)?.questions?.[qIdx]?.questionText);
        const pristineFETQ = this.quizService.getPristineQuestionByText(fetQText);
        fetText = ((pristineFETQ as any)?.explanation ?? '').trim();
        // Also try live question objects
        if (!fetText) {
          const liveQ = comp.currentQuestion()
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
          const qForFormat = comp.currentQuestion()
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

    comp.showFeedback.set(true);
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
        comp.optionBindings.set((comp.optionBindings() ?? []).map((b: any, bi: number) => {
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
        }));
        comp.cdRef.detectChanges();
      });

      // DOM fallback — guarantees the visual lock regardless of CD timing.
      const stamp = () => {
        try {
          const correctSet = new Set(effectiveCorrectIndices);
          const items = document.querySelectorAll('app-option-item');
          for (const [idx, el] of Array.from(items).entries()) {
            if (correctSet.has(idx)) continue;
            const row = el.querySelector('.option-row') as HTMLElement | null;
            if (row) {
              row.style.pointerEvents = 'none';
              row.style.backgroundColor = '#a0a0a0';
              row.style.opacity = '0.7';
            }
            const input = el.querySelector('input') as HTMLInputElement | null;
            if (input) input.disabled = true;
          }
        } catch { /* DOM not ready */ }
      };
      stamp();
      setTimeout(stamp, 0);
      setTimeout(stamp, 50);
    }

    // INCORRECT CLICK + ALL-INCORRECT-EXHAUSTED auto-reveal for multi-answer.
    // Mirrors the single-answer block in processSingleAnswerClick (~line 642).
    // Fires only when every incorrect option has been clicked — disables
    // remaining incorrects and auto-highlights any unclicked correct options.
    this.triggerAllIncorrectsExhaustedAutoReveal(comp, index, qIdx);
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
      const liveQText = comp.currentQuestion()?.questionText
        ?? (this.quizService as any)?.questions?.[qIdx]?.questionText
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText;
      const pristineCorrectTexts =
        this.quizService.getPristineCorrectTextsForQuestion(liveQText);
      const pristineCorrectCount = pristineCorrectTexts.size;
      if (pristineCorrectCount > 1) {
        const correctIndicesByText: number[] = [];
        const bindings: any[] = comp.optionBindings() ?? [];
        for (let i = 0; i < bindings.length; i++) {
          if (pristineCorrectTexts.has(nrmGuard(bindings[i]?.option?.text))) {
            correctIndicesByText.push(i);
          }
        }
        this.processMultiAnswerClick({
          comp,
          index,
          binding: comp.optionBindings()?.[index],
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
    } catch { /* fall through to single-answer path */ }

    // CANONICAL resolution: match comp.currentQuestion text against
    // quizService.questions[] to get authoritative correct flags.
    let correctIdxs: number[] = [];
    try {
      const allQs: any[] = (this.quizService as any)?.questions ?? [];
      const passedText = (comp.currentQuestion()?.questionText || '').trim().toLowerCase();
      let canonicalQ: any = null;
      if (passedText && allQs.length) {
        const idx = allQs.findIndex((q: any) => (q?.questionText || '').trim().toLowerCase() === passedText);
        if (idx >= 0) canonicalQ = allQs[idx];
      }
      if (!canonicalQ) canonicalQ = allQs[qIdx] ?? comp.currentQuestion();
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

    // Pristine cross-check for single-answer. Tries several sources in
    // order of reliability so a stale `comp.currentQuestion` (which can
    // still point to Q1's text right after navigating to Q3+) doesn't
    // miss a real correct click and skip the post-correct disable block:
    //   1. The clicked binding's own `option.correct` flag (set at
    //      binding generation from the pristine JSON, so it's authoritative
    //      unless something downstream mutates it).
    //   2. Cache lookup by quizService.questions[qIdx].questionText.
    //   3. Cache lookup by getQuestionsInDisplayOrder()[qIdx] (shuffled).
    //   4. Cache lookup by comp.currentQuestion.questionText (last
    //      resort because of the staleness risk).
    let pristineSingleCorrect = false;
    try {
      const nrmSA = (t: any) => String(t ?? '').trim().toLowerCase();
      const clickedBinding = comp.optionBindings()?.[index];
      const clickedText = nrmSA(clickedBinding?.option?.text);
      const clickedFlag = clickedBinding?.option?.correct;
      if (
        clickedFlag === true || String(clickedFlag) === 'true' ||
        clickedFlag === 1 || clickedFlag === '1'
      ) {
        pristineSingleCorrect = true;
      } else if (clickedText) {
        const candidates = isShuffled
          ? [
              (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText,
              (this.quizService as any)?.shuffledQuestions?.[qIdx]?.questionText,
              (this.quizService as any)?.questions?.[qIdx]?.questionText,
              comp.currentQuestion()?.questionText
            ]
          : [
              (this.quizService as any)?.questions?.[qIdx]?.questionText,
              (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText,
              comp.currentQuestion()?.questionText
            ];
        for (const qText of candidates) {
          if (!qText) continue;
          const pristineCorrectTextsSA =
            this.quizService.getPristineCorrectTextsForQuestion(qText);
          if (pristineCorrectTextsSA.has(clickedText)) {
            pristineSingleCorrect = true;
            break;
          }
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
      const singleFetQuestion = comp.currentQuestion()
        ?? comp.getQuestionAtDisplayIndex?.(qIdx)
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx];

      // Synchronous FET write
      try {
        const singleFetCtxSync = {
          resolvedIndex: qIdx,
          question: singleFetQuestion,
          currentQuestion: comp.currentQuestion(),
          quizId: comp.quizId?.() ?? comp.quizId ?? '',
          optionBindings: comp.optionBindings() ?? [],
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
        currentQuestion: comp.currentQuestion(),
        quizId: comp.quizId?.() ?? comp.quizId ?? '',
        optionBindings: comp.optionBindings() ?? [],
        optionsToDisplay: comp.optionsToDisplay ?? [],
        isMultiMode: false
      };
      setTimeout(() => {
        try {
          this.sharedOptionExplanationService.emitExplanation(singleFetCtx as any, true);
        } catch {
          comp.emitExplanation(qIdx, true);
        }
      }, 0);


      if (!comp.disabledOptionsPerQuestion.has(qIdx)) {
        comp.disabledOptionsPerQuestion.set(qIdx, new Set<number>());
      }
      const disabledSetRef = comp.disabledOptionsPerQuestion.get(qIdx)!;
      disabledSetRef.clear();
      const currentBindings: any[] = Array.isArray(comp.optionBindings())
        ? comp.optionBindings()
        : (typeof comp.optionBindings() === 'function' ? comp.optionBindings() : []);
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
      comp.optionBindings.set(newBindings);

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
      return;
    }

    // INCORRECT CLICK + ALL-INCORRECT-EXHAUSTED auto-reveal:
    // After the user has selected every incorrect option for this question,
    // auto-highlight every canonical correct option and emit FET so the
    // question reaches a resolved visual state. Works for both single-
    // and multi-answer questions: the size of `pristineCorrectTextsAR`
    // can be 1 (single) or N (multi). Score is NOT incremented — the
    // user didn't fully pick the correct answer(s).
    try {
      const nrmAR = (t: any) => String(t ?? '').trim().toLowerCase();
      const liveQAR: any = comp.currentQuestion()
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]
        ?? (this.quizService as any)?.questions?.[qIdx];
      const bindingsAR: any[] = Array.isArray(comp.optionBindings())
        ? comp.optionBindings()
        : (typeof comp.optionBindings() === 'function' ? comp.optionBindings() : []);
      if (!bindingsAR.length) return;

      // Pristine correct text(s) from cache. Must have at least one
      // canonical correct option to reveal.
      const pristineCorrectTextsAR =
        this.quizService.getPristineCorrectTextsForQuestion(liveQAR?.questionText);
      if (pristineCorrectTextsAR.size < 1) return;
      const isMultiModeAR = pristineCorrectTextsAR.size > 1;

      // Collect every selected text for this question. For single-answer,
      // selectedOptionsMap holds only the latest click (each click replaces
      // the previous), so we MUST read from comp._multiSelectByQuestion —
      // a Set<number> of every clicked binding index for this qIdx, set by
      // shared-option-click.runOptionContentClick line 263. Without this,
      // we'd never see all 3 incorrects-selected for a 4-option SA question.
      const selectedTextsAR = new Set<string>();
      const durableClicksAR0: Set<number> | undefined =
        comp._multiSelectByQuestion?.get(qIdx);
      if (durableClicksAR0) {
        for (const ci of durableClicksAR0) {
          const tx = nrmAR(bindingsAR[ci]?.option?.text);
          if (tx) selectedTextsAR.add(tx);
        }
      }
      // Belt-and-suspenders: also include the just-clicked option in case
      // the durable set hasn't been populated yet on this CD cycle.
      const clickedTextAR = nrmAR(comp.optionBindings()?.[index]?.option?.text);
      if (clickedTextAR) selectedTextsAR.add(clickedTextAR);
      // And merge any in-memory map entries (no-op for single-answer but
      // safe for any path that did populate it).
      const selectionsAR =
        this.selectedOptionService.getSelectedOptionsForQuestion(qIdx) ?? [];
      for (const s of selectionsAR) {
        const tx = nrmAR(s?.text);
        if (tx) selectedTextsAR.add(tx);
      }

      // Build the set of incorrect bindings by text — option whose text is
      // not in the pristine correct set.
      const incorrectTextsAR = new Set<string>();
      for (const b of bindingsAR) {
        const tx = nrmAR(b?.option?.text);
        if (tx && !pristineCorrectTextsAR.has(tx)) incorrectTextsAR.add(tx);
      }
      if (incorrectTextsAR.size === 0) return;
      const allIncorrectSelected =
        [...incorrectTextsAR].every(t => selectedTextsAR.has(t));
      if (!allIncorrectSelected) return;

      // All incorrects exhausted — auto-reveal the correct answer.
      try { this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true }); } catch {}
      this.nextButtonStateService.setNextButtonState(true);
      this.explanationTextService.fetBypassForQuestion.set(qIdx, true);
      // INTENTIONALLY do NOT set _multiAnswerPerfect — that flag is used as
      // the navigation-clear gate ("preserve state on revisit"), so setting
      // it on autoreveal-fired (user picked wrong) made Q2 retain its green
      // correct-option highlight on 2nd visit. The autoreveal already sets
      // cssClasses['correct-option']=true on bindings below, which is what
      // shouldHighlightOption uses to paint green during this session.

      // Highlight the canonical correct option + disable everything else.
      const correctIdxsAR: number[] = [];
      for (const [bi, b] of bindingsAR.entries()) {
        const tx = nrmAR(b?.option?.text);
        if (tx && pristineCorrectTextsAR.has(tx)) correctIdxsAR.push(bi);
      }

      if (!comp.disabledOptionsPerQuestion.has(qIdx)) {
        comp.disabledOptionsPerQuestion.set(qIdx, new Set<number>());
      }
      const disabledSetAR = comp.disabledOptionsPerQuestion.get(qIdx)!;
      const correctSetAR = new Set(correctIdxsAR);
      disabledSetAR.clear();
      for (let i = 0; i < bindingsAR.length; i++) {
        if (!correctSetAR.has(i)) disabledSetAR.add(i);
      }

      const durableClicksAR = comp._multiSelectByQuestion?.get(qIdx);
      const historySetAR = new Set<number>(durableClicksAR ?? []);
      historySetAR.add(index);

      comp.optionBindings.set(bindingsAR.map((ob: any, bi: number) => {
        const isCorrectBinding = correctSetAR.has(bi);
        const isClicked = bi === index;
        const wasPreviouslyClicked = historySetAR.has(bi) && !isClicked && !isCorrectBinding;
        return {
          ...ob,
          disabled: !isCorrectBinding && !isClicked,
          isSelected: isClicked,
          isCorrect: isCorrectBinding,
          // Persistent auto-reveal marker — checked by option-item to keep
          // the correct option painted green even after post-click pipelines
          // (runOptionContentClick spread, updateBindingSnapshots) reassign
          // cssClasses and wipe option.highlight back to false.
          _autoRevealedCorrect: isCorrectBinding,
          option: ob?.option ? {
            ...ob.option,
            selected: isClicked,
            highlight: isClicked || wasPreviouslyClicked || isCorrectBinding,
            showIcon: isClicked || wasPreviouslyClicked || isCorrectBinding,
            active: isCorrectBinding,
            _autoRevealedCorrect: isCorrectBinding
          } : ob?.option,
          cssClasses: {
            ...(ob?.cssClasses || {}),
            'correct-option': isCorrectBinding,
            'incorrect-option': !isCorrectBinding && (isClicked || wasPreviouslyClicked)
          }
        };
      }));

      // Resolve and emit the FET text.
      const fetQuestionAR = comp.currentQuestion()
        ?? comp.getQuestionAtDisplayIndex?.(qIdx)
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx];
      const fetCtxAR = {
        resolvedIndex: qIdx,
        question: fetQuestionAR,
        currentQuestion: comp.currentQuestion(),
        quizId: comp.quizId?.() ?? comp.quizId ?? '',
        optionBindings: comp.optionBindings() ?? [],
        optionsToDisplay: comp.optionsToDisplay ?? [],
        isMultiMode: isMultiModeAR
      };
      let fetTextAR = '';
      try {
        fetTextAR = this.sharedOptionExplanationService.resolveExplanationText(fetCtxAR as any)?.trim()
          || fetQuestionAR?.explanation || '';
      } catch { /* ignore */ }

      if (fetTextAR) {
        this.explanationTextService._activeIndex = qIdx;
        (this.explanationTextService as any).latestExplanation = fetTextAR;
        (this.explanationTextService as any).latestExplanationIndex = qIdx;
        this.explanationTextService.setExplanationText(fetTextAR, {
          force: true,
          context: `question:${qIdx}`,
          index: qIdx
        });
        this.explanationTextService.emitFormatted(qIdx, fetTextAR);
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
        comp.showExplanationChange.emit(true);
      }

      setTimeout(() => {
        try { comp.emitExplanation?.(qIdx, true); } catch { /* ignore */ }
      }, 0);

      comp.cdRef?.markForCheck?.();
      comp.cdRef?.detectChanges?.();
    } catch { /* never throw from auto-reveal */ }
  }

  /**
   * AUTO-REVEAL helper: when the user has selected every incorrect option
   * for the given question, auto-highlight every canonical correct option,
   * emit FET, and stop the timer. Works for both single- and multi-answer
   * questions — the size of pristineCorrectTextsAR can be 1 (single) or N
   * (multi). Score is NOT incremented (user didn't fully pick correctly).
   *
   * NOTE: processSingleAnswerClick has an inline copy of identical logic
   * around line 642 for historical reasons. Future cleanup: consolidate
   * once this multi-answer call site is verified stable.
   */
  private triggerAllIncorrectsExhaustedAutoReveal(comp: any, index: number, qIdx: number): void {
    try {
      const nrmAR = (t: any) => String(t ?? '').trim().toLowerCase();
      const liveQAR: any = comp.currentQuestion()
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]
        ?? (this.quizService as any)?.questions?.[qIdx];
      const bindingsAR: any[] = Array.isArray(comp.optionBindings())
        ? comp.optionBindings()
        : (typeof comp.optionBindings() === 'function' ? comp.optionBindings() : []);
      if (!bindingsAR.length) return;

      // Pristine correct text(s) from cache. Must have at least one
      // canonical correct option to reveal.
      const pristineCorrectTextsAR =
        this.quizService.getPristineCorrectTextsForQuestion(liveQAR?.questionText);
      if (pristineCorrectTextsAR.size < 1) return;
      const isMultiModeAR = pristineCorrectTextsAR.size > 1;

      // Collect every selected text for this question. For single-answer,
      // selectedOptionsMap holds only the latest click (each click replaces
      // the previous), so we MUST read from comp._multiSelectByQuestion —
      // a Set<number> of every clicked binding index for this qIdx.
      const selectedTextsAR = new Set<string>();
      const durableClicksAR0: Set<number> | undefined =
        comp._multiSelectByQuestion?.get(qIdx);
      if (durableClicksAR0) {
        for (const ci of durableClicksAR0) {
          const tx = nrmAR(bindingsAR[ci]?.option?.text);
          if (tx) selectedTextsAR.add(tx);
        }
      }
      // Belt-and-suspenders: also include the just-clicked option in case
      // the durable set hasn't been populated yet on this CD cycle.
      const clickedTextAR = nrmAR(comp.optionBindings()?.[index]?.option?.text);
      if (clickedTextAR) selectedTextsAR.add(clickedTextAR);
      // And merge any in-memory map entries.
      const selectionsAR =
        this.selectedOptionService.getSelectedOptionsForQuestion(qIdx) ?? [];
      for (const s of selectionsAR) {
        const tx = nrmAR(s?.text);
        if (tx) selectedTextsAR.add(tx);
      }

      // Build the set of incorrect bindings by text — option whose text is
      // not in the pristine correct set.
      const incorrectTextsAR = new Set<string>();
      for (const b of bindingsAR) {
        const tx = nrmAR(b?.option?.text);
        if (tx && !pristineCorrectTextsAR.has(tx)) incorrectTextsAR.add(tx);
      }
      if (incorrectTextsAR.size === 0) return;
      const allIncorrectSelected =
        [...incorrectTextsAR].every(t => selectedTextsAR.has(t));
      if (!allIncorrectSelected) return;

      // All incorrects exhausted — auto-reveal the correct answer(s).
      try { this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true }); } catch {}
      this.nextButtonStateService.setNextButtonState(true);
      this.explanationTextService.fetBypassForQuestion.set(qIdx, true);
      // INTENTIONALLY do NOT set _multiAnswerPerfect — see comment in
      // sibling autoreveal block (~line 711). Used as the navigation-clear
      // gate, so setting it on autoreveal-fired (user picked wrong) made
      // Q2 retain green correct-option highlight on 2nd visit.

      // Unlock the explanation BEFORE setting new FET — without this,
      // a previous question's lockExplanation() would silently swallow
      // setExplanationText() calls and the FET would never display.
      (this.explanationTextService as any)._fetLocked = false;
      this.explanationTextService.unlockExplanation();
      // Emit early so the explanation panel becomes visible before we
      // resolve and write the text (mirrors processMultiAnswerClick's
      // all-correct-selected path at line 246).
      comp.showExplanationChange.emit(true);

      // Highlight the canonical correct option(s) + disable everything else.
      const correctIdxsAR: number[] = [];
      for (const [bi, b] of bindingsAR.entries()) {
        const tx = nrmAR(b?.option?.text);
        if (tx && pristineCorrectTextsAR.has(tx)) correctIdxsAR.push(bi);
      }

      if (!comp.disabledOptionsPerQuestion.has(qIdx)) {
        comp.disabledOptionsPerQuestion.set(qIdx, new Set<number>());
      }
      const disabledSetAR = comp.disabledOptionsPerQuestion.get(qIdx)!;
      const correctSetAR = new Set(correctIdxsAR);
      disabledSetAR.clear();
      for (let i = 0; i < bindingsAR.length; i++) {
        if (!correctSetAR.has(i)) disabledSetAR.add(i);
      }

      const durableClicksAR = comp._multiSelectByQuestion?.get(qIdx);
      const historySetAR = new Set<number>(durableClicksAR ?? []);
      historySetAR.add(index);

      // Defer the optionBindings rebuild to a microtask so the FET emission
      // below happens FIRST while bindings are still stable. Mirrors the
      // all-correct-selected path which rebuilds bindings via queueMicrotask
      // (~line 337) AFTER its synchronous FET write.
      queueMicrotask(() => {
        comp.optionBindings.set(bindingsAR.map((ob: any, bi: number) => {
          const isCorrectBinding = correctSetAR.has(bi);
          const isClicked = bi === index;
          const wasPreviouslyClicked = historySetAR.has(bi) && !isClicked && !isCorrectBinding;
          return {
            ...ob,
            disabled: !isCorrectBinding && !isClicked,
            isSelected: isClicked,
            isCorrect: isCorrectBinding,
            _autoRevealedCorrect: isCorrectBinding,
            option: ob?.option ? {
              ...ob.option,
              selected: isClicked,
              highlight: isClicked || wasPreviouslyClicked || isCorrectBinding,
              showIcon: isClicked || wasPreviouslyClicked || isCorrectBinding,
              active: isCorrectBinding,
              _autoRevealedCorrect: isCorrectBinding
            } : ob?.option,
            cssClasses: {
              ...(ob?.cssClasses || {}),
              'correct-option': isCorrectBinding,
              'incorrect-option': !isCorrectBinding && (isClicked || wasPreviouslyClicked)
            }
          };
        }));
        comp.cdRef?.detectChanges?.();
      });

      // Resolve and emit the FET text.
      const fetQuestionAR = comp.currentQuestion()
        ?? comp.getQuestionAtDisplayIndex?.(qIdx)
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx];
      const fetCtxAR = {
        resolvedIndex: qIdx,
        question: fetQuestionAR,
        currentQuestion: comp.currentQuestion(),
        quizId: comp.quizId?.() ?? comp.quizId ?? '',
        optionBindings: comp.optionBindings() ?? [],
        optionsToDisplay: comp.optionsToDisplay ?? [],
        isMultiMode: isMultiModeAR
      };
      let fetTextAR = '';
      try {
        fetTextAR = this.sharedOptionExplanationService.resolveExplanationText(fetCtxAR as any)?.trim()
          || fetQuestionAR?.explanation || '';
      } catch { /* ignore */ }

      // For multi-answer, format like "Options X and Y are correct because ..."
      // to match the all-correct-selected path's formatting (~line 281).
      if (isMultiModeAR && fetTextAR) {
        try {
          const oneBasedIndices = correctIdxsAR
            .map((ci: number) => ci + 1)
            .filter((n: number) => Number.isFinite(n) && n > 0);
          if (fetQuestionAR && oneBasedIndices.length > 0) {
            fetTextAR = this.explanationTextService.formatExplanation(
              fetQuestionAR,
              oneBasedIndices,
              fetTextAR
            );
          }
        } catch { /* ignore */ }
      }
      if (fetTextAR) {
        this.explanationTextService._activeIndex = qIdx;
        (this.explanationTextService as any).latestExplanation = fetTextAR;
        (this.explanationTextService as any).latestExplanationIndex = qIdx;
        this.explanationTextService.setExplanationText(fetTextAR, {
          force: true,
          context: `question:${qIdx}`,
          index: qIdx
        });
        this.explanationTextService.emitFormatted(qIdx, fetTextAR);
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

      setTimeout(() => {
        try { comp.emitExplanation?.(qIdx, true); } catch { /* ignore */ }
      }, 0);

      comp.cdRef?.markForCheck?.();
      comp.cdRef?.detectChanges?.();
    } catch { /* never throw from auto-reveal */ }
  }

}