import { Injectable } from '@angular/core';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOption } from '../../../models/SelectedOption.model';
import { ChangeResult } from '../../options/engine/shared-option-change-handler.service';
import { FeedbackContext } from './shared-option-feedback.service';

type Host = any;

@Injectable({ providedIn: 'root' })
export class SharedOptionOrchestratorService {

  // ===== Lifecycle =====
  runOnInit(host: Host): void {
    host.initializeQuestionIndex();
    host.resetStateForNewQuestion();
    host.subscribeToTimerExpiration();
    host.setupFallbackRendering();
    host.initializeConfiguration();
    host.initializeOptionDisplayWithFeedback();
    host.setupSubscriptions();
    host.subscribeToSelectionChanges();
  }

  runAfterViewInit(host: Host): void {
    host.viewReady = true;
    host.setupRehydrateTriggers();

    if (!host.optionBindings?.length && host.optionsToDisplay?.length) {
      host.generateOptionBindings();
    }
  }

  runOnDestroy(host: Host): void {
    try { host.destroy$?.next(); } catch {}
    try { host.destroy$?.complete(); } catch {}
    host.selectionSub?.unsubscribe();
    host.finalRenderReadySub?.unsubscribe();
  }

  // ===== ngOnChanges =====
  async runOnChanges(host: Host, changes: any): Promise<void> {
    const result = host.changeHandler.handleChanges(changes, {
      currentQuestionIndex: host.currentQuestionIndex,
      questionIndex: host.questionIndex(),
      optionsToDisplay: host.optionsToDisplay,
      config: host.config(),
      type: host.type,
      optionBindings: host.optionBindings,
      selectedOption: host.selectedOption,
      showFeedbackForOption: host.showFeedbackForOption,
      showFeedback: host.showFeedback,
      questionVersion: host.questionVersion(),
      lastProcessedQuestionIndex: host.lastProcessedQuestionIndex,
      resolvedQuestionIndex: host.resolvedQuestionIndex,
      isMultiMode: host.isMultiMode,
      form: host.form,
      optionsToDisplay$: host.optionsToDisplay$,
      resolveCurrentQuestionIndex: () => host.resolveCurrentQuestionIndex(),
      updateResolvedQuestionIndex: (idx: number) => host.updateResolvedQuestionIndex(idx),
      computeDisabledState: (opt: Option, idx: number) => host.computeDisabledState(opt, idx),
      hydrateOptionsFromSelectionState: () => host.hydrateOptionsFromSelectionState(),
      generateOptionBindings: () => host.generateOptionBindings(),
      resetStateForNewQuestion: () => host.resetStateForNewQuestion(),
      clearForceDisableAllOptions: () => host.clearForceDisableAllOptions(),
      fullyResetRows: () => host.fullyResetRows(),
      processOptionBindings: () => host.processOptionBindings(),
      updateHighlighting: () => host.updateHighlighting()
    });
    this.runApplyChangeResult(host, result);
  }

  runApplyChangeResult(host: Host, r: ChangeResult): void {
    if (r.selectedOptions === 'clear') host.selectedOptions.clear();
    if (r.clickedOptionIds === 'clear') host.clickedOptionIds.clear();
    if (r.selectedOptionMap === 'clear') host.selectedOptionMap.clear();
    if (r.selectedOptionHistory !== undefined) host.selectedOptionHistory = r.selectedOptionHistory;
    if (r.isMultiModeCache === null) host._isMultiModeCache = null;
    if (r.lastHandledIndex === null) host._lastHandledIndex = null;
    if (r.lastHandledTime === null) host._lastHandledTime = null;
    if (r.forceDisableAll !== undefined) host.forceDisableAll = r.forceDisableAll;
    if (r.lockedIncorrectOptionIds === 'clear') host.lockedIncorrectOptionIds.clear();
    if (r.showFeedbackForOption !== undefined) host.showFeedbackForOption = r.showFeedbackForOption;
    if (r.feedbackConfigs !== undefined) host.feedbackConfigs = r.feedbackConfigs;
    if (r.lastFeedbackOptionId !== undefined) host.lastFeedbackOptionId = r.lastFeedbackOptionId as number;
    if (r.lastFeedbackQuestionIndex !== undefined) host.lastFeedbackQuestionIndex = r.lastFeedbackQuestionIndex;
    if (r.showFeedback !== undefined) host.showFeedback = r.showFeedback;
    if (r.lastProcessedQuestionIndex !== undefined) host.lastProcessedQuestionIndex = r.lastProcessedQuestionIndex;
    if (r.lastClickFeedback === null) host._lastClickFeedback = null;
    if (r.feedbackDisplay === null) host._feedbackDisplay = null;
    if (r.resolvedQuestionIndex !== undefined) host.resolvedQuestionIndex = r.resolvedQuestionIndex;
    if (r.currentQuestionIndex !== undefined) host.currentQuestionIndex = r.currentQuestionIndex;
    if (r.disabledOptionsPerQuestion === 'clear') host.disabledOptionsPerQuestion.clear();
    if (r.activeFeedbackConfig === null) host.activeFeedbackConfig = null;
    if (r.disableRenderTrigger === 'increment') host.disableRenderTrigger++;
    if (r.optionsToDisplay !== undefined) host.optionsToDisplay = r.optionsToDisplay;
    if (r.highlightedOptionIds === 'clear') host.highlightedOptionIds.clear();
    if (r.selectedOption === null) host.selectedOption = null;
    if (r.type !== undefined) host.type = r.type;
    // questionVersion is now a signal input — write removed.
    if (r.flashDisabledSet === 'clear') host.flashDisabledSet.clear();
    if (r.correctClicksPerQuestion === 'clear') host.correctClicksPerQuestion.clear();

    if (r.optionsToDisplay !== undefined) {
      // optional-chain `next` so this is a no-op when the host doesn't
      // expose optionsToDisplay$ (the subject was removed in commit
      // a9164c67 along with its only subscriber). Without the guard,
      // calling `.next` on undefined throws and aborts runApplyChangeResult,
      // which leaves the host in a partially-applied state and triggers
      // NG0953 emits on a now-destroyed output.
      host.optionsToDisplay$?.next?.(
        Array.isArray(host.optionsToDisplay) ? [...host.optionsToDisplay] : []
      );
    }

    if (r.callResetStateForNewQuestion) host.resetStateForNewQuestion();
    if (r.callClearForceDisableAllOptions) host.clearForceDisableAllOptions();
    if (r.callFullyResetRows) host.fullyResetRows();
    if (r.resetFormSelectedOptionId) {
      host.form.get('selectedOptionId')?.setValue(null, { emitEvent: false });
    }
    if (r.callProcessOptionBindings) host.processOptionBindings();
    if (r.callHydrateAndGenerate) {
      host.hydrateOptionsFromSelectionState();
      host.generateOptionBindings();
    } else if (r.callGenerateOnly) {
      host.generateOptionBindings();
    }
    if (r.callUpdateHighlighting) host.updateHighlighting();

    if (r.detectChanges) host.cdRef.detectChanges();
    else if (r.markForCheck) host.cdRef.markForCheck();
  }

  // ===== Index helpers =====
  runInitializeQuestionIndex(host: Host): void {
    const qIndex = host.questionIndex() ??
        host.currentQuestionIndex ??
        host.config()?.idx ??
        host.quizService?.currentQuestionIndex ?? 0;
    host.lastProcessedQuestionIndex = qIndex;
    host.updateResolvedQuestionIndex(qIndex);
  }

  runResolveCurrentQuestionIndex(host: Host): number {
    const active = host.getActiveQuestionIndex();
    return Number.isFinite(active) ? Math.max(0, Math.floor(active)) : 0;
  }

  runGetActiveQuestionIndex(host: Host): number {
    const qi = host.questionIndex();
    if (typeof qi === 'number' && Number.isFinite(qi)) return qi;

    if (typeof host.currentQuestionIndex === 'number' && 
      Number.isFinite(host.currentQuestionIndex)
    ) {
      return host.currentQuestionIndex;
    }
    if (Number.isFinite(host.resolvedQuestionIndex)) {
      return host.resolvedQuestionIndex!;
    }
    const svcIndex = host.quizService?.getCurrentQuestionIndex?.() ?? host.quizService?.currentQuestionIndex;
    if (typeof svcIndex === 'number' && Number.isFinite(svcIndex)) return svcIndex;

    return 0;
  }

  runNormalizeQuestionIndex(host: Host, candidate: unknown): number | null {
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
      return null;
    }
    if (candidate < 0) return 0;
    return Math.floor(candidate);
  }

  runUpdateResolvedQuestionIndex(host: Host, candidate: unknown): void {
    if (typeof candidate !== 'number' && candidate !== null) return;

    const normalized = host.normalizeQuestionIndex(candidate);
    if (normalized !== null) host.resolvedQuestionIndex = normalized;
  }

  runGetQuestionAtDisplayIndex(host: Host, displayIndex: number): QuizQuestion | null {
    const isShuffled = host.quizService?.isShuffleEnabled?.() &&
      host.quizService?.shuffledQuestions?.length > 0;
    const questionSource = isShuffled
      ? host.quizService.shuffledQuestions
      : host.quizService?.questions;
    return questionSource?.[displayIndex] ?? null;
  }

  // ===== Multi-mode =====
  runIsMultiMode(host: Host): boolean {
    const idx = host.getActiveQuestionIndex();

    // Always resolve the display-order question for this index
    const currentQ = host.getQuestionAtDisplayIndex(idx) ?? host.currentQuestion;

    // PRISTINE-FIRST via OPTION-TEXT FINGERPRINT.
    // Question-text matching can fail (currentQuestion may be null/stale at
    // initial render). Match by the option-text fingerprint instead — it
    // uniquely identifies a question across the entire QUIZ_DATA.
    let result = false;
    try {
      const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
      const qs: any = host.quizService;

      // Collect candidate option texts from anywhere we can find them.
      const collectTexts = (arr: any[] | undefined | null): string[] => {
        if (!Array.isArray(arr)) return [];
        return arr.map((o: any) => nrm(o?.text)).filter((t: string) => !!t);
      };
      let candidateTexts: string[] = collectTexts(host.optionBindings?.map((b: any) => b?.option));
      if (!candidateTexts.length) candidateTexts = collectTexts(host.optionsToDisplay);
      if (!candidateTexts.length) candidateTexts = collectTexts(currentQ?.options);

      if (candidateTexts.length > 0) {
        const candidateSet = new Set(candidateTexts);
        const bundle: any[] = qs?.quizInitialState ?? [];
        outer: for (const quiz of bundle) {
          for (const pq of (quiz?.questions ?? [])) {
            const pqOpts = pq?.options ?? [];
            if (pqOpts.length !== candidateTexts.length) continue;
            const pqTexts = pqOpts.map((o: any) => nrm(o?.text));
            // Every pristine option text must appear in candidate set.
            if (!pqTexts.every((t: string) => candidateSet.has(t))) continue;
            const correctCount = pqOpts.filter(
              (o: any) =>
                o?.correct === true || String(o?.correct) === 'true' ||
                o?.correct === 1 || o?.correct === '1'
            ).length;
            if (correctCount > 1) result = true;
            break outer;
          }
        }
      }

      // ALSO try question-text match in case option fingerprint missed.
      if (!result) {
        const isShuffled = qs?.isShuffleEnabled?.()
          && Array.isArray(qs?.shuffledQuestions)
          && qs.shuffledQuestions.length > 0;
        const displayQ = isShuffled
          ? (qs?.getQuestionsInDisplayOrder?.()?.[idx] ?? qs?.shuffledQuestions?.[idx])
          : currentQ;
        const qText = nrm(displayQ?.questionText ?? currentQ?.questionText);
        if (qText) {
          const bundle: any[] = qs?.quizInitialState ?? [];
          outerQ: for (const quiz of bundle) {
            for (const pq of (quiz?.questions ?? [])) {
              if (nrm(pq?.questionText) !== qText) continue;
              const correctCount = (pq?.options ?? []).filter(
                (o: any) =>
                  o?.correct === true || String(o?.correct) === 'true' ||
                  o?.correct === 1 || o?.correct === '1'
              ).length;
              if (correctCount > 1) result = true;
              break outerQ;
            }
          }
        }
      }
    } catch { /* ignore */ }

    // Fall back to detectMultiMode if pristine didn't decide.
    if (!result) {
      result = host.clickHandler.detectMultiMode(
        currentQ, 
        host.type, 
        host.config()?.type
      );
    }

    // Update cache for other code that reads it
    host._isMultiModeCache = result;
    return result;
  }

  // ===== Feedback =====
  runBuildFeedbackContext(host: Host): FeedbackContext {
    return {
      optionsToDisplay: host.optionsToDisplay,
      currentQuestion: host.currentQuestion,
      type: host.type as 'single' | 'multiple',
      selectedOptions: host.selectedOptions,
      optionBindings: host.optionBindings,
      timerExpiredForQuestion: host.timerExpiredForQuestion,
      activeQuestionIndex: host.getActiveQuestionIndex(),
      showFeedbackForOption: host.showFeedbackForOption,
      feedbackConfigs: host.feedbackConfigs,
      lastFeedbackOptionId: host.lastFeedbackOptionId as number,
      lastFeedbackQuestionIndex: host.lastFeedbackQuestionIndex,
      selectedOptionId: host.selectedOptionId(),
      isMultiMode: host.isMultiMode,
      _feedbackDisplay: host._feedbackDisplay,
      _multiSelectByQuestion: host._multiSelectByQuestion,
      _correctIndicesByQuestion: host._correctIndicesByQuestion
    };
  }

  runDisplayFeedbackForOption(host: Host, option: SelectedOption, index: number, optionId: number): void {
    if (!option) return;
    const ctx = host.buildFeedbackContext();
    const result = host.feedbackManager.displayFeedbackForOption(option, index, optionId, ctx);
    if (!result) return;
    host.showFeedback = result.showFeedback;
    host.showFeedbackForOption = result.showFeedbackForOption;
    host.feedbackConfigs = result.feedbackConfigs;
    host.currentFeedbackConfig = result.currentFeedbackConfig;
    host.activeFeedbackConfig = result.activeFeedbackConfig;
    host.lastFeedbackOptionId = result.lastFeedbackOptionId;
    host.lastFeedbackQuestionIndex = result.lastFeedbackQuestionIndex;
    host.cdRef.markForCheck();
  }

  runRebuildShowFeedbackMapFromBindings(host: Host): void {
    const result = host.feedbackManager.rebuildShowFeedbackMapFromBindings(
      host.optionBindings, host.lastFeedbackOptionId, host.selectedOptionHistory
    );
    host.showFeedback = result.showFeedback;
    host.showFeedbackForOption = result.showFeedbackForOption;
    for (const b of host.optionBindings ?? []) {
      b.showFeedbackForOption = host.showFeedbackForOption;
      if (host.showFeedback) b.showFeedback = true;
    }
    host.cdRef.detectChanges();
  }

  runRegenerateFeedback(host: Host, idx: number): void {
    const result = host.feedbackManager.regenerateFeedback(idx, host.optionsToDisplay, host.optionBindings);
    if (result) {
      host.feedbackConfigs = result.feedbackConfigs;
      host.cdRef.markForCheck();
    }
  }

  // ===== Selection / visibility =====
  runUpdateSelections(host: Host, rawSelectedId: number | string): void {
    host.optionSelectionUiService.applySingleSelectClick(
        host.optionBindings,
        rawSelectedId,
        host.selectedOptionHistory
    );
    if (host.showFeedback) {
      host.rebuildShowFeedbackMapFromBindings();
    }
    host.cdRef.markForCheck();
  }

  runOnVisibilityChange(host: Host): void {
    if (document.visibilityState !== 'visible') {
      return;
    }
    try {
      host.ensureOptionsToDisplay();
      host.preserveOptionHighlighting();
      host.cdRef.markForCheck();
    } catch {
      // visibility change handling failed
    }
  }

  // ===== Disabled / classes =====
  runComputeDisabledState(host: Host, option: Option, index: number): boolean {
    return host.clickHandler.computeDisabledState(option, index, {
      currentQuestionIndex: host.currentQuestionIndex,
      isMultiMode: host.isMultiMode,
      forceDisableAll: host.forceDisableAll,
      disabledOptionsPerQuestion: host.disabledOptionsPerQuestion,
      lockedIncorrectOptionIds: host.lockedIncorrectOptionIds,
      flashDisabledSet: host.flashDisabledSet
    });
  }

  runShouldDisableOption(host: Host, binding: OptionBindings): boolean {
    if (!binding || !binding.option) return false;
    if (host.isMultiMode) return host.forceDisableAll;
    return true;
  }

  runGetOptionClasses(host: Host, binding: OptionBindings): { [key: string]: boolean } {
    return host.optionService.getOptionClasses(
      binding,
      binding.index,
      host.highlightedOptionIds,
      host.flashDisabledSet,
      host.isLocked(binding, binding.index),
      host.timerExpiredForQuestion
    );
  }

  runOnOptionInteraction(host: Host, binding: OptionBindings, index: number, event: MouseEvent): void {
    if (host.isDisabled(binding, index)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT') return;
    host.runOptionContentClick(binding, index, event);
  }

  // ===== Rendering / explanation =====
  runMarkRenderReady(host: Host, reason: string): void {
    const bindingsReady =
      Array.isArray(host.optionBindings) && host.optionBindings.length > 0;
    const optionsReady =
      Array.isArray(host.optionsToDisplay) && host.optionsToDisplay.length > 0;

    if (bindingsReady && optionsReady) {
      host.renderReady.set(true);
      host.renderReadyChange.emit(true);
    }
  }

  runEmitExplanation(host: Host, questionIndex: number, skipGuard: boolean): void {
    host.explanationHandler.resolveAndEmitExplanation({
      questionIndex,
      activeQuestionIndex: host.getActiveQuestionIndex(),
      currentQuestion: host.currentQuestion,
      quizId: host.quizId(),
      optionBindings: host.optionBindings,
      optionsToDisplay: host.optionsToDisplay,
      isMultiMode: host.isMultiMode,
      getQuestionAtDisplayIndex: (idx: number) => host.getQuestionAtDisplayIndex(idx)
    }, skipGuard);
  }

  runDeferHighlightUpdate(host: Host, callback: () => void): void {
    if (host._pendingHighlightRAF !== null) {
      cancelAnimationFrame(host._pendingHighlightRAF);
    }
    host._pendingHighlightRAF = requestAnimationFrame(() => {
      host._pendingHighlightRAF = null;
      callback();
    });
  }

  runFinalizeOptionPopulation(host: Host): void {
    if (!host.optionsToDisplay?.length) return;

    if (host.type !== 'multiple') {
      // In shuffled mode, use display-order question (currentQuestion may be wrong)
      const qs: any = host.quizService;
      const isShuf = qs?.isShuffleEnabled?.()
        && Array.isArray(qs?.shuffledQuestions)
        && qs.shuffledQuestions.length > 0;
      const displayIdx = host.getActiveQuestionIndex();
      const questionForType = isShuf
        ? (qs?.getQuestionsInDisplayOrder?.()?.[displayIdx] ?? qs?.shuffledQuestions?.[displayIdx] ?? host.currentQuestion)
        : host.currentQuestion;
      host.type = questionForType
          ? host.determineQuestionType(questionForType) : 'single';
    }
  }

  runResetUIForNewQuestion(host: Host): void {
    host.hasUserClicked = false;
    host.highlightedOptionIds.clear();
    host.selectedOptionMap.clear();
    host.showFeedbackForOption = {};
    host.lastFeedbackOptionId = -1;
    host.lastSelectedOptionId = -1;
    host.selectedOptionHistory = [];
    host.feedbackConfigs = {};
    host.lockedIncorrectOptionIds.clear();
    host.timerExpiredForQuestion = false;
    host._timerExpiryHandled = false;
    host.forceDisableAll = false;
    host.timeoutCorrectOptionKeys?.clear?.();
    host.flashDisabledSet?.clear?.();
  }

  runInitializeOptionBindings(host: Host): void {
    if (host.optionBindingsInitialized) return;

    host.optionBindingsInitialized = true;
    if (!host.optionsToDisplay?.length) {
      host.optionBindingsInitialized = false;
      return;
    }
    host.generateOptionBindings();
  }

  runEnsureOptionIds(host: Host): void {
    for (const [index, option] of (host.optionsToDisplay ?? []).entries()) {
      const id = Number(option.optionId);
      if (option.optionId == null || isNaN(id) || id < 0) {
        option.optionId = index;
      }
    }
  }

  runFindBindingByOptionId(host: Host, optionId: number): { b: OptionBindings; i: number } | null {
    const opts = host.optionBindings ?? [];
    const i = opts.findIndex((x: OptionBindings, idx: number) => {
      const explicitId = x?.option?.optionId;
      const effectiveId = (explicitId != null && Number(explicitId) > -1)
        ? Number(explicitId) : idx;
      return effectiveId === Number(optionId);
    });
    if (i < 0) return null;
    return { b: opts[i], i };
  }

  runCanShowOptions(host: Host): boolean {
    const hasBindings = (host.optionBindings?.length ?? 0) > 0;
    if (!hasBindings) return false;
    return host.canDisplayOptions() && host.renderReady;
  }

  runCanDisplayOptions(host: Host): boolean {
    return (
      !!host.form &&
      host.renderReady &&
      host.showOptions &&
      Array.isArray(host.optionBindings) &&
      host.optionBindings.length > 0 &&
      host.optionBindings.every((b: OptionBindings) => !!b.option)
    );
  }

  runShouldShowIcon(host: Host, option: Option, i: number): boolean {
    const k = host.keyOf(option, i);
    const showFromCfg = !!host.feedbackConfigs[k]?.showFeedback;
    const showLegacy = !!(option as any).showIcon;
    return showFromCfg || showLegacy;
  }
}
