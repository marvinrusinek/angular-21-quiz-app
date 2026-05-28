import { Injectable, inject } from '@angular/core';

import { QuestionType } from '../../../models/question-type.enum';

import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';

import { SK_MULTI_PERFECT, SK_SEL_Q } from '../../../constants/session-keys';

import { ExplanationTextService } from '../../features/explanation/explanation-text.service';
import { FeedbackService } from '../../features/feedback/feedback.service';
import { NextButtonStateService } from '../../state/next-button-state.service';
import { OptionClickHandlerService } from './option-click-handler.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { SelectionMessageService } from '../../features/selection-message/selection-message.service';
import { SharedOptionExplanationService } from '../../features/shared-option/shared-option-explanation.service';
import { TimerService } from '../../features/timer/timer.service';
import { norm } from '../../../utils/text-norm';

/** Delay before backup explanation emission after all correct answers are selected in multi-answer mode. */
const MULTI_ANSWER_BACKUP_FET_DELAY_MS = 50;

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
    displayIdx: number;
    durableSet: Set<number>;
    effectiveCorrectIndices: number[];
    effectiveCorrectCount: number;
    isShuffled: boolean;
  }): void {
    const { comp, index, binding, qIdx, displayIdx, durableSet, isShuffled } = params;
    let { effectiveCorrectIndices } = params;

    // PRISTINE-AUTHORITATIVE: always recompute correctIndices from
    // quizInitialState. Upstream bindings can have mutated/missing
    // correct flags so passed-in values aren't reliable. Pristine is
    // the immutable source of truth and the ONLY way to guarantee
    // correctIndices.length matches what the user actually expects
    // for multi-answer questions.
    try {
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
            if (pristineCorrectTexts.has(norm(bindings[i]?.option?.text))) {
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
    } catch (e) { console.error('processMultiAnswerClick pristine-recompute failed:', e); }

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
      this.quizService._multiAnswerPerfect.set(displayIdx, true);
      try { sessionStorage.setItem(SK_MULTI_PERFECT + displayIdx, 'true'); } catch {}
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
      const liveQS: any = comp.currentQuestion()
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[displayIdx]
        ?? (this.quizService as any)?.questions?.[qIdx];
      const pristineCorrectTextsS =
        this.quizService.getPristineCorrectTextsForQuestion(liveQS?.questionText);
      if (pristineCorrectTextsS.size > 1) {
        const bindingsS: any[] = comp.optionBindings() ?? [];
        let selectedCorrectS = 0;
        for (const sIdx of durableSet) {
          if (pristineCorrectTextsS.has(norm(bindingsS[sIdx]?.option?.text))) {
            selectedCorrectS++;
          }
        }
        if (selectedCorrectS < pristineCorrectTextsS.size) {
          suppressDisableForUnselected = true;
        }
      }
    } catch (e) { console.error('processMultiAnswerClick suppressDisable-guard failed:', e); }

    comp.optionBindings.set(comp.optionBindings().map((ob: OptionBindings, bi: number) => {
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
      (comp.optionsToDisplay ?? []).filter((o: Option) => o && typeof o === 'object'),
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

    const optsForMsg: Option[] = comp.optionBindings().map((ob: OptionBindings, bi: number) => ({
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

    // CHECK: all correct options selected?
    // PRISTINE-AUTHORITATIVE: count how many selected options' texts
    // match a pristine correct option text. allCorrectInDurable only
    // when count === pristine correct count. This bypasses any index-
    // mismatch issues between effectiveCorrectIndices and the actual
    // multi-answer count from quizInitialState.
    let allCorrectInDurable = effectiveCorrectIndices.length > 0 &&
      effectiveCorrectIndices.every((ci: number) => durableSet.has(ci));
    try {
      const liveQAC: any = comp.currentQuestion()
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[displayIdx]
        ?? (this.quizService as any)?.questions?.[qIdx];
      const bindingsAC: any[] = comp.optionBindings() ?? [];
      if (bindingsAC.length) {
        const pristineCorrectTextsAC =
          this.quizService.getPristineCorrectTextsForQuestion(liveQAC?.questionText);
        if (pristineCorrectTextsAC.size > 0) {
          let selectedCorrectCount = 0;
          for (const selIdx of durableSet) {
            const txt = norm(bindingsAC[selIdx]?.option?.text);
            if (pristineCorrectTextsAC.has(txt)) selectedCorrectCount++;
          }
          allCorrectInDurable = selectedCorrectCount >= pristineCorrectTextsAC.size;
        }
      }
    } catch (e) { console.error('processMultiAnswerClick allCorrectInDurable check failed:', e); }

    const _ts = Date.now() % 100000;
    console.log('[SOC-MA]', _ts, 'allCorrectInDurable:', allCorrectInDurable, 'qIdx:', qIdx, 'displayIdx:', displayIdx, 'durableSet:', [...durableSet], 'effectiveCorrectIndices:', effectiveCorrectIndices, 'isShuffled:', isShuffled);
    if (allCorrectInDurable) {
      try { this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true }); } catch {}
      this.nextButtonStateService.setNextButtonState(true);

      // Set FET bypass BEFORE scoring so all downstream gates are open.
      // Use displayIdx for all display-pipeline keys (FET, multiPerfect,
      // sessionStorage) because CQC/navigation read by display index.
      // Keep qIdx (original/canonical) for scoreDirectly — scoring
      // handles shuffle mapping internally.
      this.explanationTextService.fetBypassForQuestion.set(displayIdx, true);

      this.quizService.scoreDirectly(qIdx, true, true);

      this.quizService._multiAnswerPerfect.set(displayIdx, true);
      try { sessionStorage.setItem(SK_MULTI_PERFECT + displayIdx, 'true'); } catch {}

      (this.explanationTextService as any)._fetLocked = false;
      this.explanationTextService.unlockExplanation();

      comp.showExplanationChange.emit(true);

      // Resolve explanation text from pristine data and write directly
      let fetText = '';
      try {
        const fetQText = isShuffled
          ? ((this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[displayIdx]?.questionText
            ?? (this.quizService as any)?.shuffledQuestions?.[displayIdx]?.questionText)
          : (comp.currentQuestion()?.questionText
            ?? (this.quizService as any)?.questions?.[qIdx]?.questionText);
        const pristineFETQ = this.quizService.getPristineQuestionByText(fetQText);
        fetText = ((pristineFETQ as any)?.explanation ?? '').trim();
        // Also try live question objects
        if (!fetText) {
          const liveQ = comp.currentQuestion()
            ?? comp.getQuestionAtDisplayIndex?.(displayIdx)
            ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[displayIdx];
          fetText = (liveQ?.explanation ?? '').trim();
        }
      } catch (e) { console.error('processMultiAnswerClick FET-text resolution failed:', e); }

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
            ?? comp.getQuestionAtDisplayIndex?.(displayIdx)
            ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[displayIdx]
            ?? (this.quizService as any)?.questions?.[qIdx];
          if (qForFormat && oneBasedIndices.length > 0) {
            formattedFET = this.explanationTextService.formatExplanation(
              qForFormat,
              oneBasedIndices,
              fetText
            );
          }
        } catch (e) { console.error('processMultiAnswerClick FET formatting failed:', e); }

        // Write directly via explanationTextService — use displayIdx
        // so the CQC display pipeline (which reads by display index) finds it.
        this.explanationTextService._activeIndex = displayIdx;
        (this.explanationTextService as any).latestExplanation = formattedFET;
        (this.explanationTextService as any).latestExplanationIndex = displayIdx;
        const qForStore = comp.currentQuestion()
          ?? comp.getQuestionAtDisplayIndex?.(displayIdx)
          ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[displayIdx];
        this.explanationTextService.storeFormattedExplanation(
          displayIdx, formattedFET, qForStore, qForStore?.options ?? [], true
        );
        this.explanationTextService.setExplanationText(formattedFET, {
          force: true,
          context: `question:${displayIdx}`,
          index: displayIdx
        });
        this.explanationTextService.emitFormatted(displayIdx, formattedFET, { bypassGuard: true });
        this.explanationTextService.setShouldDisplayExplanation(true, {
          context: `question:${displayIdx}`,
          force: true
        } as any);
        this.explanationTextService.setIsExplanationTextDisplayed(true, {
          context: `question:${displayIdx}`,
          force: true
        } as any);
        this.explanationTextService.lockExplanation();
        this.quizStateService.setDisplayState({ mode: 'explanation', answered: true });

        // DIRECT DOM WRITE: ensure FET appears in the H3 heading even if the
        // displayText$ pipeline's emission gets filtered by distinctUntilChanged
        // or a signal-timing race. Without this, the FET would only appear on
        // navigate-away-and-back (when the orchestrator's computeIntendedQText
        // rebuilds it from cache).
        try {
          // codelab-quiz-content's H3 — the only h3 inside that component
          const qTextEl =
            (typeof document !== 'undefined'
              && document.querySelector('codelab-quiz-content h3')) as HTMLElement | null;
          if (qTextEl && formattedFET) {
            qTextEl.innerHTML = formattedFET;
          }
        } catch { /* ignore */ }
      }

      // Also try the component path as backup
      setTimeout(() => {
        try {
          comp.emitExplanation(displayIdx, true);
        } catch { /* ignore */ }
      }, MULTI_ANSWER_BACKUP_FET_DELAY_MS);
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
        comp.optionBindings.set((comp.optionBindings() ?? []).map((b: OptionBindings, bi: number) => {
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

    }

    // INCORRECT CLICK + ALL-INCORRECT-EXHAUSTED auto-reveal for multi-answer.
    // Mirrors the single-answer block in processSingleAnswerClick (~line 642).
    // Fires only when every incorrect option has been clicked — disables
    // remaining incorrects and auto-highlights any unclicked correct options.
    this.triggerAllIncorrectsExhaustedAutoReveal(comp, index, qIdx, displayIdx);
  }

  /**
   * Processes a single-answer option click: pristine correctness check,
   * FET emission, timer stop, option disable/highlight, session persistence.
   */
  processSingleAnswerClick(params: {
    comp: any;
    index: number;
    qIdx: number;
    displayIdx: number;
    durableSet: Set<number>;
    effectiveCorrectIndices: number[];
    isShuffled: boolean;
  }): void {
    const { comp, index, qIdx, displayIdx, durableSet, effectiveCorrectIndices, isShuffled } = params;

    const _ts = Date.now() % 100000;
    console.log('[SOC-SA-ENTRY]', _ts, 'index:', index, 'qIdx:', qIdx, 'displayIdx:', displayIdx, 'effectiveCorrectIndices:', effectiveCorrectIndices, 'isShuffled:', isShuffled);
    // GUARD: If pristine data says this is actually a multi-answer
    // question, abort the single-answer path. Otherwise selecting one
    // correct option (or one incorrect + one correct) would lock the
    // remaining options before the user has answered the second correct.
    // Routes back through processMultiAnswerClick which only locks
    // incorrects after all correct answers are selected.
    try {
      const liveQText = comp.currentQuestion()?.questionText
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[displayIdx]?.questionText
        ?? (this.quizService as any)?.questions?.[qIdx]?.questionText;
      const pristineCorrectTexts =
        this.quizService.getPristineCorrectTextsForQuestion(liveQText);
      const pristineCorrectCount = pristineCorrectTexts.size;
      if (pristineCorrectCount > 1) {
        const correctIndicesByText: number[] = [];
        const bindings: any[] = comp.optionBindings() ?? [];
        for (let i = 0; i < bindings.length; i++) {
          if (pristineCorrectTexts.has(norm(bindings[i]?.option?.text))) {
            correctIndicesByText.push(i);
          }
        }
        this.processMultiAnswerClick({
          comp,
          index,
          binding: comp.optionBindings()?.[index],
          qIdx,
          displayIdx,
          durableSet,
          effectiveCorrectIndices: correctIndicesByText.length
            ? correctIndicesByText
            : effectiveCorrectIndices,
          effectiveCorrectCount: correctIndicesByText.length || pristineCorrectCount,
          isShuffled
        });
        return;
      }
    } catch (e) { console.error('processSingleAnswerClick multi-answer guard failed:', e); }

    // CANONICAL resolution: match comp.currentQuestion text against
    // quizService.questions[] to get authoritative correct flags.
    let correctIdxs: number[] = [];
    try {
      const allQs: any[] = (this.quizService as any)?.questions ?? [];
      const passedText = norm(comp.currentQuestion()?.questionText);
      let canonicalQ: any = null;
      if (passedText && allQs.length) {
        const idx = allQs.findIndex((q: any) => norm(q?.questionText) === passedText);
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
    } catch (e) { console.error('processSingleAnswerClick canonical-resolution failed:', e); }
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
      const clickedBinding = comp.optionBindings()?.[index];
      const clickedText = norm(clickedBinding?.option?.text);
      const clickedFlag = clickedBinding?.option?.correct;
      if (
        clickedFlag === true || String(clickedFlag) === 'true' ||
        clickedFlag === 1 || clickedFlag === '1'
      ) {
        pristineSingleCorrect = true;
      } else if (clickedText) {
        const candidates = isShuffled
          ? [
              comp.currentQuestion()?.questionText,
              (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[displayIdx]?.questionText,
              (this.quizService as any)?.shuffledQuestions?.[displayIdx]?.questionText,
              (this.quizService as any)?.questions?.[qIdx]?.questionText,
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
    } catch (e) { console.error('processSingleAnswerClick pristine-correct check failed:', e); }

    if (pristineSingleCorrect) {
      try { this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true }); } catch {}

      // Score and emit FET for single-answer correct click.
      // Use displayIdx for all display-pipeline keys (FET bypass,
      // multiPerfect, sessionStorage, latestExplanationIndex) because
      // CQC/navigation read by display index. Keep qIdx for
      // scoreDirectly — scoring handles shuffle mapping internally.
      this.explanationTextService.fetBypassForQuestion.set(displayIdx, true);
      this.quizService.scoreDirectly(qIdx, true, false);
      this.nextButtonStateService.setNextButtonState(true);
      this.quizService._multiAnswerPerfect.set(displayIdx, true);
      try { sessionStorage.setItem(SK_MULTI_PERFECT + displayIdx, 'true'); } catch {}

      (this.explanationTextService as any)._fetLocked = false;
      this.explanationTextService.unlockExplanation();
      comp.showExplanationChange.emit(true);
      const singleFetQuestion = comp.currentQuestion()
        ?? comp.getQuestionAtDisplayIndex?.(displayIdx)
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[displayIdx];

      // Synchronous FET write
      try {
        const singleFetCtxSync = {
          resolvedIndex: displayIdx,
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
          this.explanationTextService._activeIndex = displayIdx;
          (this.explanationTextService as any).latestExplanation = fetText;
          (this.explanationTextService as any).latestExplanationIndex = displayIdx;
          // Populate per-index cache so resolveDisplayText finds the FET
          // even if the reactive stream doesn't deliver it in time.
          this.explanationTextService.storeFormattedExplanation(
            displayIdx, fetText, singleFetQuestion, singleFetQuestion?.options ?? [], true
          );
          this.explanationTextService.setExplanationText(fetText, {
            force: true,
            context: `question:${displayIdx}`,
            index: displayIdx
          });
          this.explanationTextService.emitFormatted(displayIdx, fetText, { bypassGuard: true });
          this.explanationTextService.setShouldDisplayExplanation(true, {
            context: `question:${displayIdx}`,
            force: true
          } as any);
          this.explanationTextService.setIsExplanationTextDisplayed(true, {
            context: `question:${displayIdx}`,
            force: true
          } as any);
          this.explanationTextService.lockExplanation();
          this.quizStateService.setDisplayState({ mode: 'explanation', answered: true });
        }
      } catch (e) { console.error('processSingleAnswerClick FET-sync write failed:', e); }

      const singleFetCtx = {
        resolvedIndex: displayIdx,
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
        } catch (e) {
          console.error('SocAnswerProcessingService.processSingleAnswerClick FET-backup emission failed:', e);
          comp.emitExplanation(displayIdx, true);
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
          sessionStorage.setItem(SK_SEL_Q + qIdx, JSON.stringify(toSave));
          this.selectedOptionService.addToSelectionHistory(qIdx, toSave as any[]);
        }
      } catch (e) { console.error('processSingleAnswerClick selection-persist failed:', e); }

      comp.cdRef?.detectChanges?.();
      return;
    }

    // INCORRECT CLICK + ALL-INCORRECT-EXHAUSTED auto-reveal:
    // When every incorrect option has been clicked, auto-highlight canonical
    // correct option(s) and emit FET. Delegates to the shared helper that
    // processMultiAnswerClick also uses.
    this.triggerAllIncorrectsExhaustedAutoReveal(comp, index, qIdx, displayIdx);
  }

  /**
   * AUTO-REVEAL helper: when the user has selected every incorrect option
   * for the given question, auto-highlight every canonical correct option,
   * emit FET, and stop the timer. Works for both single- and multi-answer
   * questions — the size of pristineCorrectTextsAR can be 1 (single) or N
   * (multi). Score is NOT incremented (user didn't fully pick correctly).
   *
   * Called from both processSingleAnswerClick (incorrect-click tail) and
   * processMultiAnswerClick to share a single auto-reveal implementation.
   */
  private triggerAllIncorrectsExhaustedAutoReveal(comp: any, index: number, qIdx: number, displayIdx: number): void {
    try {
      const liveQAR: any = comp.currentQuestion()
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]
        ?? (this.quizService as any)?.questions?.[qIdx];
      const bindingsAR: any[] = Array.isArray(comp.optionBindings())
        ? comp.optionBindings()
        : (typeof comp.optionBindings() === 'function' ? comp.optionBindings() : []);
      if (!bindingsAR.length) return;

      // Pre-compute normalized texts for all bindings (avoids repeated
      // norm() calls in the multiple loops below).
      const bindingNormsAR: string[] = bindingsAR.map(
        (b: any) => norm(b?.option?.text)
      );

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
          const tx = bindingNormsAR[ci];
          if (tx) selectedTextsAR.add(tx);
        }
      }
      // Belt-and-suspenders: also include the just-clicked option in case
      // the durable set hasn't been populated yet on this CD cycle.
      const clickedTextAR = bindingNormsAR[index] ?? norm(comp.optionBindings()?.[index]?.option?.text);
      if (clickedTextAR) selectedTextsAR.add(clickedTextAR);
      // And merge any in-memory map entries.
      const selectionsAR =
        this.selectedOptionService.getSelectedOptionsForQuestion(qIdx) ?? [];
      for (const s of selectionsAR) {
        const tx = norm(s?.text);
        if (tx) selectedTextsAR.add(tx);
      }

      // Build the set of incorrect bindings by text — option whose text is
      // not in the pristine correct set.
      const incorrectTextsAR = new Set<string>();
      for (let i = 0; i < bindingsAR.length; i++) {
        const tx = bindingNormsAR[i];
        if (tx && !pristineCorrectTextsAR.has(tx)) incorrectTextsAR.add(tx);
      }
      if (incorrectTextsAR.size === 0) return;
      const allIncorrectSelected =
        [...incorrectTextsAR].every(t => selectedTextsAR.has(t));
      if (!allIncorrectSelected) return;

      // All incorrects exhausted — auto-reveal the correct answer(s).
      try { this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true }); } catch {}
      this.nextButtonStateService.setNextButtonState(true);
      this.selectionMessageService.forceNextButtonMessage(qIdx);
      this.explanationTextService.fetBypassForQuestion.set(displayIdx, true);
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
      for (let bi = 0; bi < bindingsAR.length; bi++) {
        const tx = bindingNormsAR[bi];
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

      // Resolve and emit the FET text FIRST while bindings are still
      // stable. The binding rebuild below must be synchronous (not
      // deferred via queueMicrotask) because detectChanges() triggers
      // effects that can overwrite the bindings before the microtask
      // runs — wiping _autoRevealedCorrect and the green highlight.
      const fetQuestionAR = comp.currentQuestion()
        ?? comp.getQuestionAtDisplayIndex?.(displayIdx)
        ?? (this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[displayIdx];
      const fetCtxAR = {
        resolvedIndex: displayIdx,
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
        } catch (e) { console.error('triggerAllIncorrectsExhausted FET formatting failed:', e); }
      }
      if (fetTextAR) {
        this.explanationTextService._activeIndex = displayIdx;
        (this.explanationTextService as any).latestExplanation = fetTextAR;
        (this.explanationTextService as any).latestExplanationIndex = displayIdx;
        this.explanationTextService.storeFormattedExplanation(
          displayIdx, fetTextAR, fetQuestionAR, fetQuestionAR?.options ?? [], true
        );
        this.explanationTextService.setExplanationText(fetTextAR, {
          force: true,
          context: `question:${displayIdx}`,
          index: displayIdx
        });
        this.explanationTextService.emitFormatted(displayIdx, fetTextAR, { bypassGuard: true });
        this.explanationTextService.setShouldDisplayExplanation(true, {
          context: `question:${displayIdx}`,
          force: true
        } as any);
        this.explanationTextService.setIsExplanationTextDisplayed(true, {
          context: `question:${displayIdx}`,
          force: true
        } as any);
        this.explanationTextService.lockExplanation();
        this.quizStateService.setDisplayState({ mode: 'explanation', answered: true });
      }

      // Synchronous binding rebuild — MUST happen after FET emission
      // and MUST NOT be deferred to queueMicrotask. Effects triggered
      // by detectChanges() would overwrite deferred bindings before the
      // microtask runs, wiping _autoRevealedCorrect.
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

      setTimeout(() => {
        try { comp.emitExplanation?.(qIdx, true); } catch { /* ignore */ }
      }, 0);

      comp.cdRef?.detectChanges?.();
    } catch (e) { console.error('auto-reveal failed:', e); }
  }

}