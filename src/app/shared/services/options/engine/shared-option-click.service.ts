import { Injectable } from '@angular/core';

import { OptionBindings } from '../../../models/OptionBindings.model';
import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { SelectedOption } from '../../../models/SelectedOption.model';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { TimerService } from '../../features/timer/timer.service';
import { OptionInteractionService } from './option-interaction.service';
import { OptionClickHandlerService } from './option-click-handler.service';
import { OptionUiSyncService } from './option-ui-sync.service';
import { NextButtonStateService } from '../../state/next-button-state.service';
import { SocAnswerProcessingService } from './soc-answer-processing.service';
import { SocOptionUiService } from './soc-option-ui.service';

/**
 * Handles option click events for shared option components.
 * Delegates to 2 extracted sub-services; retains onOptionUI, runOptionContentClick preamble/postamble,
 * and updateOptionAndUI inline.
 */
@Injectable({ providedIn: 'root' })
export class SharedOptionClickService {
  constructor(
    private quizService: QuizService,
    private quizStateService: QuizStateService,
    private selectedOptionService: SelectedOptionService,
    private timerService: TimerService,
    private optionInteractionService: OptionInteractionService,
    private optionUiSyncService: OptionUiSyncService,
    private clickHandler: OptionClickHandlerService,
    private nextButtonStateService: NextButtonStateService,
    private answerProcessing: SocAnswerProcessingService,
    private optionUi: SocOptionUiService
  ) {}

  onOptionUI(comp: any, ev: any): void {
    if (ev == null || ev.optionId == null) return;

    const index = ev.displayIndex ?? comp.findBindingByOptionId(ev.optionId)?.i;
    if (index === undefined || index < 0) return;
    const binding = comp.optionBindings[index];
    if (!binding) return;

    comp.cdRef.markForCheck();
    let pristineCorrect = binding.option?.correct === true;
    try {
      const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
      const optText = nrm(binding.option?.text);
      const qIdx = comp.getActiveQuestionIndex?.() ?? comp.currentQuestionIndex ?? 0;
      const bundle: any[] = (this.quizService as any)?.quizInitialState ?? [];
      const quizId = this.quizService?.quizId;
      if (optText && bundle.length > 0 && quizId) {
        const qText = nrm(comp.currentQuestion?.questionText);
        let matched = false;
        if (qText) {
          for (const quiz of bundle) {
            for (const pq of (quiz?.questions ?? [])) {
              if (nrm(pq?.questionText) !== qText) continue;
              const matchedOpt = (pq?.options ?? []).find((o: any) => nrm(o?.text) === optText);
              if (matchedOpt !== undefined) {
                pristineCorrect = matchedOpt?.correct === true || String(matchedOpt?.correct) === 'true';
                matched = true;
              }
              break;
            }
            if (matched) break;
          }
        }
        if (!matched) {
          const pristineQuiz = bundle.find((qz: any) => qz?.quizId === quizId);
          const pristineQ = pristineQuiz?.questions?.[qIdx];
          if (pristineQ) {
            const matchedOpt = (pristineQ.options ?? []).find((o: any) => nrm(o?.text) === optText);
            if (matchedOpt !== undefined) {
              pristineCorrect = matchedOpt?.correct === true || String(matchedOpt?.correct) === 'true';
            }
          }
        }
      }
    } catch { }
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
        const isCorrectOpt = binding?.option?.correct === true || String(binding?.option?.correct) === 'true';
        const isSingleMode = comp.type === 'single' && !comp.isMultiMode;
        if (!(isSingleMode && isCorrectOpt && binding.disabled)) return;
      }

      if (isRapidDuplicate) return;

      if (comp.type === 'single' && !comp.isMultiMode && binding.option.selected && comp.showFeedback) {
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
      freezeOptionBindings: comp.freezeOptionBindings,
      disableRenderTrigger: comp.disableRenderTrigger,
      currentQuestion: comp.currentQuestion,
      currentQuestionIndex: baseCtx.getActiveQuestionIndex(),
      showExplanationChange: comp.showExplanationChange,
      explanationToDisplayChange: comp.explanationToDisplayChange
    };

    comp.freezeOptionBindings = true;
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
          state.showFeedback = comp.showFeedback;
          state.showFeedbackForOption = comp.showFeedbackForOption;
          state.feedbackConfigs = comp.feedbackConfigs;
          state.lastFeedbackOptionId = comp.lastFeedbackOptionId;
          state.disableRenderTrigger = comp.disableRenderTrigger;
        }
      );
    } finally {
      comp.freezeOptionBindings = false;
      state.freezeOptionBindings = false;
    }

    comp.disableRenderTrigger = state.disableRenderTrigger;
    comp.lastClickedOptionId = state.lastClickedOptionId;
    comp.lastClickTimestamp = state.lastClickTimestamp;
    comp.hasUserClicked = state.hasUserClicked;
    comp.freezeOptionBindings = state.freezeOptionBindings;
    comp.showFeedback = state.showFeedback;
    comp.showFeedbackForOption = state.showFeedbackForOption;
    comp.feedbackConfigs = state.feedbackConfigs;
    comp.lastFeedbackOptionId = state.lastFeedbackOptionId;

    for (const b of state.optionBindings) {
      if (b) b.showFeedbackForOption = { ...comp.showFeedbackForOption };
    }
    comp.optionBindings = state.optionBindings;

    let qIdx = comp.getActiveQuestionIndex();
    // Self-heal: getActiveQuestionIndex falls back to quizService's signal,
    // which can be stuck at 0 while the user is actually on Q2/Q3 (observed
    // via diagnostics). When qIdx and comp.currentQuestion's text don't
    // match quizService.questions[qIdx], correct qIdx by text fingerprint.
    // Without this fix, scoring writes to the wrong question's slot and
    // increments are skipped because that slot is already 'correct'.
    try {
      const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
      const liveQText = nrm(comp.currentQuestion?.questionText);
      const allQs: any[] = (this.quizService as any)?.questions ?? [];
      if (liveQText && allQs.length) {
        const atQIdx = nrm(allQs[qIdx]?.questionText);
        if (liveQText !== atQIdx) {
          const fixed = allQs.findIndex((q: any) => nrm(q?.questionText) === liveQText);
          if (fixed >= 0) qIdx = fixed;
        }
      }
    } catch { /* ignore */ }
    if (!comp._multiSelectByQuestion.has(qIdx)) {
      comp._multiSelectByQuestion.set(qIdx, new Set<number>());
    }
    const durableSet = comp._multiSelectByQuestion.get(qIdx)!;
    durableSet.add(index);

    this.nextButtonStateService.forceEnable(2000);
    this.selectedOptionService.setAnswered(true, true);

    if (!comp._correctIndicesByQuestion.has(qIdx)) {
      const question = comp.currentQuestion ?? comp.getQuestionAtDisplayIndex(qIdx);
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
      const nrmP = (t: any) => String(t ?? '').trim().toLowerCase();
      let qTextCandidates: string[];
      if (isShuffled) {
        qTextCandidates = [
          nrmP((this.quizService as any)?.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText),
          nrmP((this.quizService as any)?.shuffledQuestions?.[qIdx]?.questionText),
          nrmP(comp.getQuestionAtDisplayIndex?.(qIdx)?.questionText)
        ].filter((t: string) => !!t);
      } else {
        qTextCandidates = [
          nrmP(comp.currentQuestion?.questionText),
          nrmP((this.quizService as any)?.questions?.[qIdx]?.questionText),
          nrmP(comp.getQuestionAtDisplayIndex?.(qIdx)?.questionText)
        ].filter((t: string) => !!t);
      }
      const bundleP: any[] = (this.quizService as any)?.quizInitialState ?? [];

      let matched = false;
      for (const qText of qTextCandidates) {
        for (const quiz of bundleP) {
          const quizQuestions = quiz?.questions ?? [];
          for (const pq of quizQuestions) {
            const pqText = nrmP(pq?.questionText);
            if (pqText !== qText) continue;
            matched = true;
            const pristineOpts = pq?.options ?? [];
            const pristineCorrectTexts = new Set<string>(
              pristineOpts
                .filter((o: any) => o?.correct === true || String(o?.correct) === 'true')
                .map((o: any) => nrmP(o?.text))
            );
            pristineCorrectCount = pristineCorrectTexts.size;
            const rebuilt: number[] = [];
            const bindings: any[] = Array.isArray(comp.optionBindings) ? comp.optionBindings : [];
            const bindingTexts: string[] = [];
            for (let i = 0; i < bindings.length; i++) {
              const bt = nrmP(bindings[i]?.option?.text);
              bindingTexts.push(bt);
              if (pristineCorrectTexts.has(bt)) rebuilt.push(i);
            }
            if (rebuilt.length > 0) {
              effectiveCorrectIndices = rebuilt;
              comp._correctIndicesByQuestion.set(qIdx, rebuilt);
            }
            break;
          }
          if (matched) break;
        }
        if (matched) break;
      }
    } catch {
      // Pristine rebuild failed
    }
    const effectiveCorrectCount = effectiveCorrectIndices.length;
    const isMultiFromQ = comp.isMultiMode || comp.type === 'multiple' || effectiveCorrectCount > 1 || pristineCorrectCount > 1;

    // Universal "all correct selected" timer stop
    try {
      let allCorrectIdxs: number[] = [];
      const allQs: any[] = (this.quizService as any)?.questions ?? [];
      const passedText = (comp.currentQuestion?.questionText || '').trim().toLowerCase();
      let canonicalQ: any = null;
      if (passedText && allQs.length) {
        const cIdx = allQs.findIndex((q: any) => (q?.questionText || '').trim().toLowerCase() === passedText);
        if (cIdx >= 0) canonicalQ = allQs[cIdx];
      }
      if (!canonicalQ) canonicalQ = allQs[qIdx] ?? comp.currentQuestion;
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
      // Use fresh binding from comp.optionBindings[index] â€” the local
      // `binding` variable was captured before updateOptionAndUI's
      // `comp.optionBindings = state.optionBindings` reassign at line 238,
      // so its option may have a stale `correct` flag relative to the
      // bindings now driving the UI. Without this fix, _feedbackDisplay
      // captures the stale option and the 2nd correct click on a
      // multi-answer question shows a sad face instead of smiley.
      const freshBinding = comp.optionBindings?.[index] ?? binding;
      this.answerProcessing.processMultiAnswerClick({
        comp, index, binding: freshBinding, qIdx, durableSet,
        effectiveCorrectIndices, effectiveCorrectCount, isShuffled
      });
      return;
    }

    if (!isMultiFromQ) {
      this.answerProcessing.processSingleAnswerClick({
        comp, index, qIdx, durableSet,
        effectiveCorrectIndices, isShuffled
      });
    }

    // â”€â”€â”€ Post-click feedback display â”€â”€â”€
    comp._feedbackDisplay = null;
    if (comp.showFeedback) {
      const clickedBinding = comp.optionBindings[index];
      if (clickedBinding) {
        const key = comp.keyOf(clickedBinding.option, index);
        const byKey = comp.feedbackConfigs[key];
        const byIdx = (Object.values(comp.feedbackConfigs) as FeedbackProps[]).find(
          (c: any) => c?.idx === index && c.showFeedback
        );
        let cfg: FeedbackProps | undefined =
          (byKey?.showFeedback ? byKey : undefined) ??
          byIdx ??
          (comp.activeFeedbackConfig?.showFeedback ? comp.activeFeedbackConfig : undefined);

        if (cfg?.showFeedback) {
          cfg = this.clickHandler.overrideMultiAnswerFeedback(
            cfg, clickedBinding, comp.optionBindings
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
      comp.optionBindings = (comp.optionBindings ?? []).map((b: any, bi: number) => {
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
      });
    } else {
      comp.optionBindings = (comp.optionBindings ?? []).map((b: any) => ({
        ...b,
        option: b.option ? { ...b.option } : b.option
      }));
    }

    comp.cdRef.detectChanges();
  }

  // ï¿½ï¿½â”€â”€ Option UI (delegated) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    comp.showFeedback = ctx.showFeedback;
    comp.lastFeedbackOptionId = Number(ctx.lastFeedbackOptionId);
    comp.lastFeedbackQuestionIndex = ctx.lastFeedbackQuestionIndex;
    const isChecked = 'checked' in event ? event.checked : true;
    comp.lastSelectedOptionIndex = isChecked ? index : -1;
    comp.lastSelectedOptionId = ctx.lastFeedbackOptionId;

    const feedbackKey = comp.keyOf(optionBinding.option, index);
    const syncedConfig = comp.feedbackConfigs[feedbackKey] as FeedbackProps | undefined;
    if (syncedConfig?.showFeedback) {
      comp.activeFeedbackConfig = syncedConfig;
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
      comp.optionBindings = [...ctx.optionBindings];
    } else {
      comp.optionBindings = comp.optionBindings.map((b: any) => ({
        ...b,
        showFeedbackForOption: { ...comp.showFeedbackForOption },
        showFeedback: comp.showFeedback,
        disabled: comp.computeDisabledState(b.option, b.index)
      }));
    }

    // SINGLE-ANSWER GUARD
    const isCheckedForGuard = 'checked' in event ? event.checked : true;
    if (isCheckedForGuard && ctx.type === 'single') {
      const correctCount = (ctx.optionBindings ?? []).filter((b: any) => {
        const c = b?.option?.correct ?? b?.option?.isCorrect;
        return c === true || String(c) === 'true' || c === 1 || c === '1';
      }).length;
      if (correctCount <= 1) {
        for (let bi = 0; bi < (comp.optionBindings ?? []).length; bi++) {
          const ob = comp.optionBindings[bi];
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