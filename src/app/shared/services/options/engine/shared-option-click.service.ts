import { Injectable, inject } from '@angular/core';

import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import { NextButtonStateService } from '../../state/next-button-state.service';
import { OptionClickHandlerService } from './option-click-handler.service';
import { OptionInteractionService } from './option-interaction.service';
import { OptionUiSyncService } from './option-ui-sync.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { SocAnswerProcessingService } from './soc-answer-processing.service';
import { SocOptionUiService } from './soc-option-ui.service';
import { TimerService } from '../../features/timer/timer.service';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

/**
 * Handles option click events for shared option components.
 * Delegates to 2 extracted sub-services; retains onOptionUI, runOptionContentClick preamble/postamble,
 * and updateOptionAndUI inline.
 */
@Injectable({ providedIn: 'root' })
export class SharedOptionClickService {
  // ── injects ─────────────────────────────────────────────────────
  private answerProcessing = inject(SocAnswerProcessingService);
  private clickHandler = inject(OptionClickHandlerService);
  private nextButtonStateService = inject(NextButtonStateService);
  private optionInteractionService = inject(OptionInteractionService);
  private optionUi = inject(SocOptionUiService);
  private optionUiSyncService = inject(OptionUiSyncService);
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);
  private timerService = inject(TimerService);

  // ── public methods ──────────────────────────────────────────────

  onOptionUI(comp: any, ev: any): void {
    if (ev == null || ev.optionId == null) return;

    const index = ev.displayIndex ?? comp.findBindingByOptionId(ev.optionId)?.i;
    if (index === undefined || index < 0) return;
    const binding = comp.optionBindings()[index];
    if (!binding) return;

    comp.cdRef.markForCheck();
    let pristineCorrect = isOptionCorrect(binding.option);
    try {
      const optText = norm(binding.option?.text);
      if (optText) {
        const qText = comp.currentQuestion()?.questionText;
        const pristineTexts = this.quizService.getPristineCorrectTextsForQuestion(qText);
        if (pristineTexts.size > 0) {
          pristineCorrect = pristineTexts.has(optText);
        }
      }
    } catch (e) {
      console.error('SharedOptionClickService.onOptionUI pristine-correct lookup failed:', e);
    }
    comp.soundService.playOnceForOption({
      ...binding.option,
      correct: pristineCorrect,
      selected: true,
      questionIndex: comp.currentQuestionIndex
    });

    const now = Date.now();
    const isRapidDuplicate = comp._lastHandledIndex === index &&
      comp._lastHandledTime &&
      (now - comp._lastHandledTime < 100);

    if (ev.kind === 'change') {
      const native = ev.nativeEvent;

      if (isRapidDuplicate) return;

      comp._lastHandledIndex = index;
      comp._lastHandledTime = now;

      this.quizStateService.markUserInteracted(comp.getActiveQuestionIndex());

      this.runOptionContentClick(comp, binding, index, native as any);
      return;
    }

    if (ev.kind === 'interaction' || ev.kind === 'contentClick') {
      const event = ev.nativeEvent as MouseEvent;

      if (comp.isDisabled(binding, index)) {
        if (event) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      const target = event?.target as HTMLElement;
      const isInsideMaterialControl =
        target?.tagName === 'INPUT' ||
        target?.closest('.mat-mdc-radio-button') ||
        target?.closest('.mat-mdc-checkbox');

      if (isInsideMaterialControl) {
        const isCorrectOpt = isOptionCorrect(binding?.option);
        const isSingleMode = comp.type === 'single' && !comp.isMultiMode;
        if (!(isSingleMode && isCorrectOpt && binding.disabled)) return;
      }

      if (isRapidDuplicate) return;

      if (comp.type === 'single' && !comp.isMultiMode && binding.option.selected && comp.showFeedback()) {
        return;
      }

      comp._lastHandledIndex = index;
      comp._lastHandledTime = now;

      if (comp.type === 'single') {
        if (comp.form.get('selectedOptionId')?.value !== index) {
          comp.form.get('selectedOptionId')?.setValue(index, { emitEvent: false });
        }
      } else {
        const ctrl = comp.form.get(String(index));
        if (ctrl) {
          ctrl.setValue(!binding.option.selected, { emitEvent: false });
        }
      }

      this.runOptionContentClick(comp, binding, index, event);
      return;
    }
  }

  runOptionContentClick(comp: any, binding: any, index: number, event: any): void {
    const now = Date.now();
    if (comp._lastRunClickIndex === index && comp._lastRunClickTime && (now - comp._lastRunClickTime) < 200) {
      return;
    }
    comp._lastRunClickIndex = index;
    comp._lastRunClickTime = now;

    this.quizStateService.markUserInteracted(comp.getActiveQuestionIndex());

    const baseCtx = comp.buildOptionUiSyncContext();
    const state: any = {
      ...baseCtx,
      disabledOptionsPerQuestion: comp.disabledOptionsPerQuestion,
      correctClicksPerQuestion: comp.correctClicksPerQuestion,
      freezeOptionBindings: comp.freezeOptionBindings(),
      disableRenderTrigger: comp.disableRenderTrigger,
      currentQuestion: comp.currentQuestion(),
      currentQuestionIndex: baseCtx.getActiveQuestionIndex(),
      showExplanationChange: comp.showExplanationChange,
      explanationToDisplayChange: comp.explanationToDisplayChange
    };

    comp.freezeOptionBindings.set(true);
    state.freezeOptionBindings = true;

    const _isShuffledForFET = (this.quizService as any)?.isShuffleEnabled?.()
      && Array.isArray((this.quizService as any)?.shuffledQuestions)
      && (this.quizService as any)?.shuffledQuestions?.length > 0;
    const emitExplanationFn = _isShuffledForFET
      ? (_idx: number, _skip?: boolean) => { /* no-op in shuffled mode */ }
      : (idx: number, skipGuard?: boolean) => comp.emitExplanation(idx, skipGuard);

    try {
      this.optionInteractionService.handleOptionClick(
        binding,
        index,
        event,
        state,
        (idx: number) => comp.getQuestionAtDisplayIndex(idx),
        emitExplanationFn,
        (b: any, i: number, ev: any, existingCtx: any) => {
          this.updateOptionAndUI(comp, b, i, ev, existingCtx || state);
          state.showFeedback = comp.showFeedback();
          state.showFeedbackForOption = comp.showFeedbackForOption;
          state.feedbackConfigs = comp.feedbackConfigs;
          state.lastFeedbackOptionId = comp.lastFeedbackOptionId;
          state.disableRenderTrigger = comp.disableRenderTrigger;
        }
      );
    } finally {
      comp.freezeOptionBindings.set(false);
      state.freezeOptionBindings = false;
    }

    comp.disableRenderTrigger = state.disableRenderTrigger;
    comp.lastClickedOptionId = state.lastClickedOptionId;
    comp.lastClickTimestamp = state.lastClickTimestamp;
    comp.hasUserClicked.set(state.hasUserClicked);
    console.log('[CLICK-DIAG-2] click.service state pushed, hasUserClicked:', state.hasUserClicked, 'lastClickedOptionId:', state.lastClickedOptionId, 'bindings[clicked].isSelected:', state.optionBindings?.[state.lastClickedOptionId]?.isSelected);
    comp.freezeOptionBindings.set(state.freezeOptionBindings);
    comp.showFeedback.set(state.showFeedback);
    comp.showFeedbackForOption = state.showFeedbackForOption;
    comp.feedbackConfigs = state.feedbackConfigs;
    comp.lastFeedbackOptionId = state.lastFeedbackOptionId;

    for (const b of state.optionBindings) {
      if (b) b.showFeedbackForOption = { ...comp.showFeedbackForOption };
    }
    let qIdx = comp.getActiveQuestionIndex();
    const displayIdx = qIdx; // Preserve display index before self-heal corrects to original
    // Self-heal: getActiveQuestionIndex falls back to quizService's signal,
    // which can be stuck at 0 while the user is actually on Q2/Q3 (observed
    // via diagnostics). When qIdx and comp.currentQuestion's text don't
    // match quizService.questions[qIdx], correct qIdx by text fingerprint.
    // Without this fix, scoring writes to the wrong question's slot and
    // increments are skipped because that slot is already 'correct'.
    try {
      const liveQText = norm(comp.currentQuestion()?.questionText);
      const allQs: any[] = (this.quizService as any)?.questions ?? [];
      if (liveQText && allQs.length) {
        const atQIdx = norm(allQs[qIdx]?.questionText);
        if (liveQText !== atQIdx) {
          const fixed = allQs.findIndex((q: any) => norm(q?.questionText) === liveQText);
          if (fixed >= 0) qIdx = fixed;
        }
      }
    } catch { /* ignore */ }
    if (!comp._multiSelectByQuestion.has(qIdx)) {
      comp._multiSelectByQuestion.set(qIdx, new Set<number>());
    }
    const durableSet = comp._multiSelectByQuestion.get(qIdx)!;
    durableSet.add(index);

    // If auto-reveal already stamped the live bindings with
    // _autoRevealedCorrect (all-incorrects-exhausted scenario), use
    // the live bindings — state.optionBindings is a stale snapshot
    // captured before auto-reveal ran and would wipe the green
    // highlight, disabled state, and correct-option CSS class.
    const liveBindings = comp.optionBindings();
    const autoRevealed = liveBindings?.some((b: any) => b?._autoRevealedCorrect);
    comp.optionBindings.set(autoRevealed ? liveBindings : state.optionBindings);

    this.nextButtonStateService.forceEnable(2000);
    this.selectedOptionService.setAnswered(true, true);

    if (!comp._correctIndicesByQuestion.has(qIdx)) {
      const question = comp.currentQuestion() ?? comp.getQuestionAtDisplayIndex(qIdx);
      const result = this.clickHandler.resolveCorrectIndices(
        question, qIdx, comp.isMultiMode, comp.type
      );
      comp._correctIndicesByQuestion.set(qIdx, result.correctIndices);
    }
    const correctIndicesFromQ = comp._correctIndicesByQuestion.get(qIdx)!;
    const correctCountFromQ = correctIndicesFromQ.length;

    // Resolve correct indices from pristine quizInitialState
    let effectiveCorrectIndices = correctIndicesFromQ;
    const isShuffled = (this.quizService as any)?.isShuffleEnabled?.()
      && Array.isArray((this.quizService as any)?.shuffledQuestions)
      && (this.quizService as any)?.shuffledQuestions?.length > 0;

    let pristineCorrectCount = correctCountFromQ;
    try {
      const qTextForLookup = isShuffled
        ? ((this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText
          ?? (this.quizService as any)?.shuffledQuestions?.[qIdx]?.questionText
          ?? comp.getQuestionAtDisplayIndex?.(qIdx)?.questionText)
        : (comp.currentQuestion()?.questionText
          ?? (this.quizService as any)?.questions?.[qIdx]?.questionText
          ?? comp.getQuestionAtDisplayIndex?.(qIdx)?.questionText);
      const pristineCorrectTexts =
        this.quizService.getPristineCorrectTextsForQuestion(qTextForLookup);
      if (pristineCorrectTexts.size > 0) {
        pristineCorrectCount = pristineCorrectTexts.size;
        const rebuilt: number[] = [];
        const bindings: any[] = Array.isArray(comp.optionBindings()) ? comp.optionBindings() : [];
        for (let i = 0; i < bindings.length; i++) {
          if (pristineCorrectTexts.has(norm(bindings[i]?.option?.text))) rebuilt.push(i);
        }
        if (rebuilt.length > 0) {
          effectiveCorrectIndices = rebuilt;
          comp._correctIndicesByQuestion.set(qIdx, rebuilt);
        }
      }
    } catch (e) {
      console.error('SharedOptionClickService.runOptionContentClick pristine-rebuild failed:', e);
    }
    const effectiveCorrectCount = effectiveCorrectIndices.length;
    const isMultiFromQ = comp.isMultiMode || comp.type === 'multiple' || effectiveCorrectCount > 1 || pristineCorrectCount > 1;

    // Universal "all correct selected" timer stop
    try {
      let allCorrectIdxs: number[] = [];
      const allQs: any[] = (this.quizService as any)?.questions ?? [];
      const passedText = norm(comp.currentQuestion()?.questionText);
      let canonicalQ: any = null;
      if (passedText && allQs.length) {
        const cIdx = allQs.findIndex((q: any) => norm(q?.questionText) === passedText);
        if (cIdx >= 0) canonicalQ = allQs[cIdx];
      }
      if (!canonicalQ) canonicalQ = allQs[qIdx] ?? comp.currentQuestion();
      const rawOpts = canonicalQ?.options ?? [];
      allCorrectIdxs = rawOpts
        .map((o: any, i: number) => {
          const c = o?.correct ?? o?.isCorrect;
          return (c === true || c === 'true' || c === 1 || c === '1') ? i : -1;
        })
        .filter((n: number) => n >= 0);
      if (allCorrectIdxs.length === 0 && effectiveCorrectIndices?.length) {
        allCorrectIdxs = effectiveCorrectIndices;
      }
      if (allCorrectIdxs.length > 0) {
        const allSelected = allCorrectIdxs.every(ci => durableSet.has(ci));
        if (allSelected) {
          this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true });
        }
      }
    } catch {}

    // â”€â”€â”€ Delegate to answer processing sub-services â”€â”€â”€

    if (isMultiFromQ && effectiveCorrectCount > 0) {
      // Use fresh binding from comp.optionBindings()[index] â€” the local
      // `binding` variable was captured before updateOptionAndUI's
      // `comp.optionBindings() = state.optionBindings` reassign at line 238,
      // so its option may have a stale `correct` flag relative to the
      // bindings now driving the UI. Without this fix, _feedbackDisplay
      // captures the stale option and the 2nd correct click on a
      // multi-answer question shows a sad face instead of smiley.
      const freshBinding = comp.optionBindings()?.[index] ?? binding;
      this.answerProcessing.processMultiAnswerClick({
        comp, index, binding: freshBinding, qIdx, displayIdx, durableSet,
        effectiveCorrectIndices, effectiveCorrectCount, isShuffled
      });
      return;
    }

    if (!isMultiFromQ) {
      this.answerProcessing.processSingleAnswerClick({
        comp, index, qIdx, displayIdx, durableSet,
        effectiveCorrectIndices, isShuffled
      });
    }

    // â”€â”€â”€ Post-click feedback display â”€â”€â”€
    comp._feedbackDisplay = null;
    if (comp.showFeedback()) {
      const clickedBinding = comp.optionBindings()[index];
      if (clickedBinding) {
        const key = comp.keyOf(clickedBinding.option, index);
        const byKey = comp.feedbackConfigs[key];
        const byIdx = (Object.values(comp.feedbackConfigs) as FeedbackProps[]).find(
          (c: any) => c?.idx === index && c.showFeedback
        );
        const activeCfg = comp.activeFeedbackConfig();
        let cfg: FeedbackProps | undefined =
          (byKey?.showFeedback ? byKey : undefined) ??
          byIdx ??
          (activeCfg?.showFeedback ? activeCfg : undefined);

        if (cfg?.showFeedback) {
          cfg = this.clickHandler.overrideMultiAnswerFeedback(
            cfg, clickedBinding, comp.optionBindings()
          );
        }

        if (cfg?.showFeedback) {
          comp._feedbackDisplay = { idx: index, config: cfg };
        }
      }
    }

    // Create NEW binding object references so OnPush option-item children
    // detect the input change and re-render.
    if (!isMultiFromQ) {
      const histSet = new Set<number>(durableSet ?? []);
      comp.optionBindings.set((comp.optionBindings() ?? []).map((b: any, bi: number) => {
        const isClicked = bi === index;
        const inHistory = histSet.has(bi);
        return {
          ...b,
          isSelected: isClicked,
          option: b.option ? {
            ...b.option,
            selected: isClicked,
            highlight: isClicked || inHistory,
            showIcon: isClicked || inHistory
          } : b.option
        };
      }));
    } else {
      comp.optionBindings.set((comp.optionBindings() ?? []).map((b: any) => ({
        ...b,
        option: b.option ? { ...b.option } : b.option
      })));
    }

    comp.cdRef.detectChanges();
  }

  // ── Option UI (delegated) ──────────────────────────────────────

  handleSelection(comp: any, option: SelectedOption, index: number, optionId: number): void {
    this.optionUi.handleSelection(comp, option, index, optionId);
  }

  handleBackwardNavigationOptionClick(comp: any, option: any, index: number): void {
    this.optionUi.handleBackwardNavigationOptionClick(comp, option, index);
  }

  applySelectionsUI(comp: any, selectedOptions: any[]): void {
    this.optionUi.applySelectionsUI(comp, selectedOptions);
  }

  updateBindingSnapshots(comp: any): void {
    this.optionUi.updateBindingSnapshots(comp);
  }

  preserveOptionHighlighting(comp: any): void {
    this.optionUi.preserveOptionHighlighting(comp);
  }

  ensureOptionsToDisplay(comp: any): void {
    this.optionUi.ensureOptionsToDisplay(comp);
  }

  enforceSingleSelection(comp: any, selectedBinding: OptionBindings): void {
    this.optionUi.enforceSingleSelection(comp, selectedBinding);
  }

  // â”€â”€â”€ Remaining inline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  updateOptionAndUI(comp: any, optionBinding: any, index: number, event: any, 
    existingCtx?: any): void {
    const ctx = existingCtx ?? comp.buildOptionUiSyncContext();

    this.optionUiSyncService.updateOptionAndUI(optionBinding, index, event, ctx);

    comp.feedbackConfigs = { ...ctx.feedbackConfigs };
    comp.showFeedbackForOption = { ...ctx.showFeedbackForOption };
    comp.showFeedback.set(ctx.showFeedback);
    comp.lastFeedbackOptionId = Number(ctx.lastFeedbackOptionId);
    comp.lastFeedbackQuestionIndex = ctx.lastFeedbackQuestionIndex;
    const isChecked = 'checked' in event ? event.checked : true;
    comp.lastSelectedOptionIndex = isChecked ? index : -1;
    comp.lastSelectedOptionId = ctx.lastFeedbackOptionId;

    const feedbackKey = comp.keyOf(optionBinding.option, index);
    const syncedConfig = comp.feedbackConfigs[feedbackKey] as FeedbackProps | undefined;
    if (syncedConfig?.showFeedback) {
      comp.activeFeedbackConfig.set(syncedConfig);
      comp.currentFeedbackConfig = syncedConfig;
      comp._lastClickFeedback = {
        index,
        config: syncedConfig,
        questionIdx: comp.resolveCurrentQuestionIndex()
      };
    }

    comp.selectedOptions.clear();
    for (const id of ctx.selectedOptionMap.keys()) {
      comp.selectedOptions.add(Number(id));
    }

    if (ctx.optionBindings) {
      comp.optionBindings.set([...ctx.optionBindings]);
    } else {
      comp.optionBindings.set(comp.optionBindings().map((b: any) => ({
        ...b,
        showFeedbackForOption: { ...comp.showFeedbackForOption },
        showFeedback: comp.showFeedback(),
        disabled: comp.computeDisabledState(b.option, b.index)
      })));
    }

    // SINGLE-ANSWER GUARD
    const isCheckedForGuard = 'checked' in event ? event.checked : true;
    if (isCheckedForGuard && ctx.type === 'single') {
      const correctCount = (ctx.optionBindings ?? []).filter((b: any) => {
        const c = b?.option?.correct ?? b?.option?.isCorrect;
        return c === true || String(c) === 'true' || c === 1 || c === '1';
      }).length;
      if (correctCount <= 1) {
        for (let bi = 0; bi < (comp.optionBindings() ?? []).length; bi++) {
          const ob = comp.optionBindings()[bi];
          if (!ob) continue;
          ob.isSelected = (bi === index);
          if (ob.option) {
            ob.option.selected = (bi === index);
          }
        }
      }
    }

    this.updateBindingSnapshots(comp);
    comp.cdRef.detectChanges();
  }
}