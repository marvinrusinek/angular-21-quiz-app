import { Injectable, inject } from '@angular/core';

import { QuestionType } from '../../../models/question-type.enum';

import { FeedbackProps } from '../../../models/FeedbackProps.model';
import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOption } from '../../../models/SelectedOption.model';

import { SK_DOT_CONFIRMED, SK_MULTI_PERFECT } from '../../../constants/session-keys';
import { writeSessionString } from '../../../utils/session-storage';

import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { SelectionMessageService } from '../../features/selection-message/selection-message.service';
import { TimerService } from '../../features/timer/timer.service';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

export interface OptionInteractionState {
  optionBindings: OptionBindings[];
  optionsToDisplay: Option[];
  currentQuestionIndex: number;
  selectedOptionHistory: (number | string)[];
  selectedOptionMap: Map<number | string, boolean>;
  disabledOptionsPerQuestion: Map<number, Set<number>>;
  correctClicksPerQuestion: Map<number, Set<number>>;
  feedbackConfigs: { [key: string]: FeedbackProps };
  showFeedbackForOption: { [key: string]: boolean };
  lastFeedbackOptionId: number | string;
  lastFeedbackQuestionIndex: number;
  lastClickedOptionId: number | string | null;
  lastClickTimestamp: number | null;
  hasUserClicked: boolean;
  freezeOptionBindings: boolean;
  showFeedback: boolean;
  disableRenderTrigger: number;
  type: 'single' | 'multiple';
  currentQuestion: QuizQuestion | null;
  showExplanationChange: any;
  explanationToDisplayChange: any;
}

@Injectable({
  providedIn: 'root'
})
export class OptionInteractionService {
  // ── injects ─────────────────────────────────────────────────────
  private quizService = inject(QuizService);
  private quizStateService = inject(QuizStateService);
  private selectedOptionService = inject(SelectedOptionService);
  private selectionMessageService = inject(SelectionMessageService);
  private timerService = inject(TimerService);

  // ── public methods ──────────────────────────────────────────────

  /**
   * Main handler for option content clicks
   */
  handleOptionClick(
    binding: OptionBindings,
    index: number,
    event: any,
    state: OptionInteractionState,
    getQuestionAtDisplayIndex: (idx: number) => QuizQuestion | null,
    emitExplanation: (idx: number, skipGuard?: boolean) => void,
    updateOptionAndUI: (b: OptionBindings, i: number, ev: any, ctx?: any) => void
  ): void {
    // RESOLVE: state.optionBindings may arrive as a signal function (-clean)
    // or plain array (-main). Normalize to array on the state object so ALL
    // downstream code (.entries, .findIndex, .map, .filter, .[idx]) works.
    // Extracted to normalizeStateOptionBindings; body unchanged.
    this.normalizeStateOptionBindings(state);
    // INDEX-MODEL REWRITE (Phase 1): resolve the active DISPLAY index from the
    // caller-seeded, URL-authoritative state.currentQuestionIndex (extracted to
    // resolveActiveDisplayIndex). `let` because the isPristineCorrect delegate
    // below captures it by reference; it is no longer reassigned (the old
    // self-heal that did so was removed).
    let qIdx = this.resolveActiveDisplayIndex(state);

    // PRISTINE CORRECTNESS RESOLVER: Resolve whether the clicked option is
    // truly correct from quizInitialState, not from potentially-mutated binding data.
    // Uses question TEXT matching (not index) to handle shuffled mode correctly.
    // Thin delegate: forwards to isPristineCorrectFor, capturing `qIdx` and
    // `state` by reference so late reassignments of `qIdx` are still honored
    // at call-time (identical to the original inline closure semantics).
    const isPristineCorrect = (o: any): boolean =>
      this.isPristineCorrectFor(o, qIdx, state);

    // Mark interaction immediately
    this.quizStateService.markUserInteracted(qIdx);

    // Prevent propagation
    if (event && event.stopPropagation) event.stopPropagation();

    const getEffectiveId = (o: any, i: number) => (o?.optionId != null && o.optionId !== -1) ? o.optionId : i;
    const targetKey = getEffectiveId(binding.option, index);
    // Composite identity: optionId alone can collide when loader fallbacks
    // produce duplicate ids (e.g. `optionId ?? i+1` gives position 0 an id
    // that already exists at position 1). Use `id|displayIndex` for
    // deselection matching so each position is distinct.
    const targetCompositeKey = `${targetKey}|${index}`;

    // NOTE: binding.disabled guard REMOVED. The option-item's isDisabled()
    // already gates clicks at the template level. If a click reaches here,
    // the user was able to interact with the option. Processing it is correct.
    // The old guard caused false early-returns because binding.disabled was
    // set by computeDisabledState using stale isMultiMode during initialization.

    // SET DOT STATUS EARLY — before any subscription-triggering code runs,
    // so updateDotStatus sees the correct confirmed status immediately.
    const clickedIsCorrectEarly = isPristineCorrect(binding.option);
    const dotStatusEarly = clickedIsCorrectEarly ? 'correct' : 'wrong';

    this.recordEarlyDotStatus(qIdx, binding, clickedIsCorrectEarly, dotStatusEarly, isPristineCorrect);
    // NOTE: sessionStorage persist of dot_confirmed is deferred to AFTER we
    // know the question type. For multi-answer, a single correct click must
    // NOT persist 'correct' — only full resolution should. The in-memory
    // map is fine for live dot rendering; the sessionStorage value drives
    // the DOT-CONFIRMED FALLBACK LOCK on refresh.

    // Count the correct options in the live bindings (extracted to
    // resolveCorrectCountInBindings; handles signal-or-array bindings).
    const correctCountInBindings = this.resolveCorrectCountInBindings(state);

    // PRISTINE correct-count: bindings can have mutated correct flags (e.g.
    // only 1 of 2 shown as correct). Cross-check against quizInitialState
    // so multi-answer questions are never misidentified as single-answer.
    const pristineCorrectCount = this.resolvePristineCorrectCount(correctCountInBindings, qIdx, state);

    // Authoritative Type Resolution (extracted to resolveIsMultipleMode).
    const isMultipleMode = this.resolveIsMultipleMode(state, correctCountInBindings, pristineCorrectCount);

    // Guard: prevent deselection of correct answers in multiple
    if (isMultipleMode && binding.isSelected && isPristineCorrect(binding.option)) {
      if (event && event.preventDefault) event.preventDefault();
      return;
    }

    // STATE SETUP
    const question = getQuestionAtDisplayIndex(qIdx);
    const questionOptions = Array.isArray(question?.options) ? question.options : [];

    let simulatedSelection = this.resolveSimulatedSelection(qIdx, state);

    // Check if ALREADY selected using composite (id + displayIndex) matching.
    // See targetCompositeKey comment above — optionId alone can collide.
    const existingIdx = this.findExistingSelectionIndex(simulatedSelection, targetCompositeKey);
    const isCurrentlySelected = (existingIdx !== -1);

    let futureSelection = this.buildFutureSelection(
      isCurrentlySelected, simulatedSelection, existingIdx, binding, targetKey, qIdx, index, isMultipleMode
    );
    const futureKeys = this.buildFutureKeysAndSyncMap(futureSelection, state);

    // Normalize displayIndex on EVERY futureSelection entry (not just the
    // freshly-clicked one). Pre-existing entries in simulatedSelection can
    // come from persisted state with a missing displayIndex, and rehydrate
    // keys strictly on displayIndex — so entries without it silently fail
    // to restore on refresh. Resolve by matching optionId/text against the
    // current bindings or optionsToDisplay to stamp the correct position.
    futureSelection = this.normalizeSelectionDisplayIndices(futureSelection, state);

    // Re-sync simulatedSelection with the normalized futureSelection so the
    // subsequent syncSelectionState call below persists the corrected data.
    simulatedSelection = [...futureSelection];

    // UPDATE UI STATE BASICS
    const newState = !isCurrentlySelected;
    const mockEvent = this.buildMockEvent(isMultipleMode, newState, binding, index);

    this.updateSelectionHistory(state, newState, index);

    const correctIndicesSet = this.resolveCorrectIndicesSet(question, state, questionOptions);

    const allCorrectFound = correctIndicesSet.size > 0 && [...correctIndicesSet].every(i => futureKeys.has(i));

    // DEFERRED DOT PERSIST: For single-answer, persist immediately.
    // For multi-answer, only persist 'correct' when ALL correct answers
    // are selected. A partial 'correct' causes the DOT-CONFIRMED FALLBACK
    // LOCK to treat the question as fully resolved on refresh, which
    // auto-highlights the 2nd correct answer the user never selected.
    this.persistDotConfirmedStatus(isMultipleMode, allCorrectFound, clickedIsCorrectEarly, dotStatusEarly, qIdx);

    // COMMIT STATE (extracted to commitSelectionState; body unchanged).
    this.commitSelectionState(qIdx, futureSelection, futureKeys, state);

    // INDEX-MODEL REWRITE (Phase 2): record a DURABLE per-display-index answered
    // flag the moment the question is complete (single-answer = any click;
    // multi-answer = all correct selected). Navigation clears the selection
    // stores on revisit ("clean on revisit"), so they can't tell the Next
    // button a revisited question was already answered — leaving it to a racy
    // re-derivation stream. This durable flag (not cleared on plain bounce
    // navigation) is what the post-nav re-derivation reads to re-enable Next
    // deterministically.
    if (!isMultipleMode || allCorrectFound) {
      this.quizStateService.markQuestionAnswered(qIdx);
    }

    // UPDATE UI

    // AUTHORITATIVE HIGHLIGHT SYNC (single- vs multi-answer). Extracted to
    // applyHighlightSync; body is unchanged.
    this.applyHighlightSync(state, index, qIdx, targetKey, isMultipleMode, futureKeys);

    // Detect shuffle mode early — needed for timer and scoring gates
    const isShuffleActive = (this.quizService as any)?.isShuffleEnabled?.() &&
      (this.quizService as any)?.shuffledQuestions?.length > 0;

    // Stop timer when correct answer(s) selected.
    this.stopTimerIfAnswerCorrect(isShuffleActive, isMultipleMode, isPristineCorrect, binding.option, allCorrectFound);

    // FET & Explanation & Scoring
    // For MULTI-ANSWER, defer FET/scoring to runOptionContentClick which uses
    // the authoritative correctIndicesFromQ (resolved by resolveCorrectIndices).
    // correctIndicesSet here is built from questionOptions which may have
    // incomplete correct flags — causing allCorrectFound to fire prematurely
    // (e.g. 1 of 2 correct answers found). runOptionContentClick checks
    // clickState.remaining === 0 against the canonical correct count.
    // PRISTINE MULTI-ANSWER GUARD: correctCountInBindings can be wrong
    // (bindings may show only 1 correct due to mutation). Cross-check
    // against quizInitialState to detect true multi-answer questions.
    const pristineIsMultiAnswer = this.resolvePristineIsMultiAnswer(question, qIdx, state);

    // ─── SCORING ─── (extracted to scoreAndEmitIfUnshuffledPerfect; body
    // unchanged). In shuffled mode scoring/FET is handled by the SOC, so OIS
    // must not score or emit there.
    this.scoreAndEmitIfUnshuffledPerfect(
      isShuffleActive, allCorrectFound, isMultipleMode, pristineIsMultiAnswer,
      qIdx, state, emitExplanation
    );

    // UPDATE ANCHOR (extracted to updateFeedbackAnchor; body unchanged).
    this.updateFeedbackAnchor(state, isCurrentlySelected, index, futureKeys);

    // AUTHORITATIVE FEEDBACK ANCHORING (extracted to applyFeedbackAnchoring;
    // body unchanged). Retried in Phase 3 — previously worsened the shuffle
    // revisit Next-button race, which Phases 1+2 fixed deterministically.
    this.applyFeedbackAnchoring(state, targetKey, index, binding);

    state.lastClickedOptionId = index;
    state.hasUserClicked = true;
    state.disableRenderTrigger++;

    // CALL UPDATE with THE AUTHORITATIVE CONTEXT (state)
    (updateOptionAndUI as any)(binding, index, mockEvent, state);


    // MESSAGE UPDATE
    this.syncMessageAfterClick(state, qIdx, isMultipleMode, futureKeys);
  }

  /**
   * Compute the next selection list for a click. Deselecting an already-
   * selected option drops it; otherwise build the new selection entry. In
   * single-answer mode the result is just the new option (only one selected
   * at a time); in multi-answer mode it is appended to the existing
   * selections. Pure — no side effects. Extracted verbatim from
   * handleOptionClick.
   *
   * NOTE (single-answer): we do NOT clearSelectionsForQuestion here — that
   * would wipe _selectionHistory and sel_Q* in sessionStorage, erasing the
   * "previously clicked" record for prior wrong clicks. `[newOpt]` already
   * enforces single-answer "only one currently selected" semantics in the
   * live map; history accumulation is handled downstream.
   */
  private buildFutureSelection(
    isCurrentlySelected: boolean,
    simulatedSelection: SelectedOption[],
    existingIdx: number,
    binding: OptionBindings,
    targetKey: number | string,
    qIdx: number,
    index: number,
    isMultipleMode: boolean
  ): SelectedOption[] {
    if (isCurrentlySelected) {
      return simulatedSelection.filter((_, i) => i !== existingIdx);
    }
    const newOpt: SelectedOption = {
      ...binding.option,
      optionId: targetKey,
      selected: true,
      questionIndex: qIdx,
      index: index,
      displayIndex: index
    } as SelectedOption;
    if (!isMultipleMode) {
      return [newOpt];
    }
    return [...simulatedSelection, newOpt];
  }

  /**
   * Resolve the display-index set for the future selection and mirror it onto
   * state.selectedOptionMap. Each selection entry's display index is taken
   * directly when present, else recovered by matching optionId/text against
   * the current bindings (then optionsToDisplay). Returns the resolved index
   * set and clears+repopulates selectedOptionMap by effective id. Extracted
   * verbatim from handleOptionClick (capture-free getEffectiveId redefined).
   */
  private buildFutureKeysAndSyncMap(
    futureSelection: SelectedOption[],
    state: OptionInteractionState
  ): Set<number> {
    const getEffectiveId = (o: any, i: number) =>
      (o?.optionId != null && o.optionId !== -1) ? o.optionId : i;
    const futureKeys = new Set<number>();
    for (const s of futureSelection) {
      const sId = s.optionId;
      const sText = norm(s.text);
      let idx = s.displayIndex ?? s.index ?? s.idx;

      if (idx === undefined || idx === null || idx === -1 || isNaN(Number(idx))) {
        const foundIdx = state.optionBindings.findIndex(b => {
          if (b.option === s) return true;
          const bId = b.option?.optionId;
          if (sId != null && sId !== -1 && bId != null && bId !== -1 && String(sId) === String(bId)) return true;
          return !!sText && norm(b.option?.text) === sText;
        });
        if (foundIdx !== -1) idx = foundIdx;
        else {
          const oIdx = state.optionsToDisplay.findIndex(o => {
            if (o === s) return true;
            if (sId != null && sId !== -1 && o.optionId != null && o.optionId !== -1 && String(sId) === String(o.optionId)) return true;
            return !!sText && norm(o.text) === sText;
          });
          if (oIdx !== -1) idx = oIdx;
        }
      }
      if (idx !== undefined && idx !== null && idx !== -1 && !isNaN(Number(idx))) {
        futureKeys.add(Number(idx));
      }
    }

    state.selectedOptionMap.clear();
    for (const k of futureKeys) {
      const b = state.optionBindings[k];
      const eid = b ? getEffectiveId(b.option, k) : k;
      state.selectedOptionMap.set(eid, true);
    }
    return futureKeys;
  }

  /**
   * Unshuffled single-answer "perfect" scoring + FET emission. When the
   * clicked answer fully resolves the question correctly (and it's not a
   * multi-answer question), record the score and emit the explanation. In
   * shuffled mode this is a no-op — the SOC owns scoring/FET there, using
   * authoritative pristine logic. Terminal side-effect; extracted verbatim.
   */
  private scoreAndEmitIfUnshuffledPerfect(
    isShuffleActive: boolean,
    allCorrectFound: boolean,
    isMultipleMode: boolean,
    pristineIsMultiAnswer: boolean,
    qIdx: number,
    state: OptionInteractionState,
    emitExplanation: (idx: number, skipGuard?: boolean) => void
  ): void {
    if (isShuffleActive) return;
    let scoreFired = false;
    if (allCorrectFound && !isMultipleMode && !pristineIsMultiAnswer) {
      this.quizService._multiAnswerPerfect.set(qIdx, true);
      writeSessionString(SK_MULTI_PERFECT + qIdx, 'true');
      this.quizService.scoreDirectly(qIdx, true, isMultipleMode);
      scoreFired = true;
    }
    if (scoreFired) {
      if ((state as any).showExplanationChange) {
        (state as any).showExplanationChange.emit(true);
      }
      queueMicrotask(() => emitExplanation(qIdx, true));
    }
  }

  /**
   * Record the click's early dot status: register a correct click for the
   * scoring service's multi-answer gate, and set the in-memory confirmed
   * dot status + last-clicked-correct flag for this question. Terminal
   * side-effect; extracted verbatim from handleOptionClick. (The
   * sessionStorage persist of dot_confirmed is deliberately left inline and
   * deferred until the question type is known.)
   */
  private recordEarlyDotStatus(
    qIdx: number,
    binding: OptionBindings,
    clickedIsCorrectEarly: boolean,
    dotStatusEarly: 'correct' | 'wrong',
    isPristineCorrect: (o: any) => boolean
  ): void {
    // Record correct clicks for the scoring service's multi-answer gate.
    try {
      if (isPristineCorrect(binding.option)) {
        (this.quizService as any)?.scoringService?.recordCorrectClick?.(qIdx, binding.option.text);
      }
    } catch { /* ignore */ }
    this.selectedOptionService.clickConfirmedDotStatus.set(qIdx, dotStatusEarly);
    this.selectedOptionService.lastClickedCorrectByQuestion.set(qIdx, clickedIsCorrectEarly);
  }

  /**
   * Stop the countdown timer when the answer is resolved correctly. In
   * shuffled mode only isPristineCorrect is trusted (allCorrectFound uses
   * mutated binding flags that can be wrong when questions are reordered).
   * Terminal side-effect; extracted verbatim from handleOptionClick.
   */
  private stopTimerIfAnswerCorrect(
    isShuffleActive: boolean,
    isMultipleMode: boolean,
    isPristineCorrect: (o: any) => boolean,
    clickedOption: any,
    allCorrectFound: boolean
  ): void {
    const shouldStopTimer = isShuffleActive
      ? (!isMultipleMode && isPristineCorrect(clickedOption))
      : (allCorrectFound || (!isMultipleMode && isPristineCorrect(clickedOption)));
    if (shouldStopTimer) {
      try { this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true }); } catch (e) {
        console.error('OptionInteractionService.stopTimerIfAnswerCorrect timer stop failed:', e);
      }
    }
  }

  /**
   * Resolve the active DISPLAY index for the click. The caller
   * (shared-option-click.service) seeds state.currentQuestionIndex from the
   * URL-authoritative getActiveQuestionIndex() (the questionIndex() @Input) —
   * the single source of truth for the active display position — so trust it
   * first and fall back to the live service signal only when it's invalid.
   *
   * The previous logic preferred quizService.getCurrentQuestionIndex() (which
   * sticks at 0 during init/hydration) then ran a text-match "self-heal"
   * against ORIGINAL-order questions[]; in shuffle, state.currentQuestion is
   * itself wrong-order, so the self-heal collapsed every click onto the same
   * original slot (the index-0 mis-keying behind the revisit bug) AND produced
   * an original-order index while downstream consumers expect a DISPLAY index.
   * Removed — qIdx is the display index end to end now.
   */
  private resolveActiveDisplayIndex(state: OptionInteractionState): number {
    const stateIdx = state.currentQuestionIndex;
    const liveIdx = this.quizService?.getCurrentQuestionIndex?.();
    return (typeof stateIdx === 'number' && Number.isFinite(stateIdx) && stateIdx >= 0)
      ? stateIdx
      : ((typeof liveIdx === 'number' && Number.isFinite(liveIdx) && liveIdx >= 0) ? liveIdx : 0);
  }

  /**
   * Resolve the initial simulated selection for the clicked question from the
   * durable store. Detects stale pre-refresh selections (durable click tracker
   * empty but the service still has stored selections — remnants from before a
   * refresh) and discards them so the user starts fresh. Does NOT clear the
   * sessionStorage/_selectionHistory entries — those are legitimate prior clicks
   * that must rehydrate as prev-clicked. Extracted verbatim from handleOptionClick.
   */
  private resolveSimulatedSelection(
    qIdx: number,
    state: OptionInteractionState
  ): SelectedOption[] {
    const storedSelection = this.selectedOptionService.getSelectedOptionsForQuestion(qIdx) ?? [];
    const durableClicks = (state as any)._multiSelectByQuestion?.get(qIdx);
    const isStaleFromRefresh = storedSelection.length > 0
      && (!durableClicks || durableClicks.size === 0);
    return isStaleFromRefresh ? [] : [...storedSelection];
  }

  /**
   * Find whether the clicked option is already selected, by composite
   * (effectiveId|displayIndex) matching — optionId alone can collide when
   * loader fallbacks produce duplicate ids. Returns the index or -1.
   * The only closure (getEffectiveId) is capture-free and redefined inline.
   * Extracted verbatim from handleOptionClick.
   */
  private findExistingSelectionIndex(
    simulatedSelection: SelectedOption[],
    targetCompositeKey: string
  ): number {
    const getEffectiveId = (o: any, i: number) => (o?.optionId != null && o.optionId !== -1) ? o.optionId : i;
    return simulatedSelection.findIndex(o => {
      const sIdx = o.displayIndex ?? (o as any).index ?? (o as any).idx ?? -1;
      const sKey = `${getEffectiveId(o, sIdx)}|${sIdx}`;
      return sKey === targetCompositeKey;
    });
  }

  /**
   * Build the synthetic change event passed to updateOptionAndUI: a `checked`
   * shape for multi-answer (radio-group-free), a `value` shape for single.
   * Extracted verbatim from handleOptionClick.
   */
  private buildMockEvent(
    isMultipleMode: boolean,
    newState: boolean,
    binding: OptionBindings,
    index: number
  ): { source: null; checked: boolean } | { source: null; value: number } {
    return isMultipleMode
      ? { source: null, checked: newState }
      : { source: null, value: binding.option.optionId ?? index };
  }

  /**
   * Count the correct options in the live bindings. state.optionBindings may
   * arrive as a signal function (-clean) or a plain array (-main); normalize
   * then count via isOptionCorrect. Pure read; extracted verbatim from
   * handleOptionClick.
   */
  private resolveCorrectCountInBindings(state: OptionInteractionState): number {
    const _rawBindings = state.optionBindings as any;
    const bindingsForScore: any[] = typeof _rawBindings === 'function'
      ? (_rawBindings() ?? [])
      : (_rawBindings ?? []);
    return bindingsForScore.filter((b: any) => isOptionCorrect(b.option)).length;
  }

  /**
   * Authoritative Type Resolution: a question is multi-answer if the state
   * says so, the text says "select all"/"multiple"/"apply", or more than one
   * correct option is detected (in the live bindings OR the pristine quiz
   * data). Pure read; extracted verbatim from handleOptionClick.
   */
  private resolveIsMultipleMode(
    state: OptionInteractionState,
    correctCountInBindings: number,
    pristineCorrectCount: number
  ): boolean {
    const qText = state.currentQuestion?.questionText?.toLowerCase() || '';
    const isExplicitMulti = qText.includes('select all') || qText.includes('multiple') || qText.includes('apply');
    return state.type === 'multiple' || (state as any).isMultiMode === true ||
      isExplicitMulti || correctCountInBindings > 1 || pristineCorrectCount > 1;
  }

  /**
   * UPDATE UI STATE BASICS (history part): push the clicked index onto
   * selectedOptionHistory when newly selected, or remove it when deselected.
   * Terminal side-effect on state; extracted verbatim from handleOptionClick.
   */
  private updateSelectionHistory(
    state: OptionInteractionState,
    newState: boolean,
    index: number
  ): void {
    if (newState && !state.selectedOptionHistory.includes(index)) {
      state.selectedOptionHistory.push(index);
    } else if (!newState) {
      const hIdx = state.selectedOptionHistory.indexOf(index);
      if (hIdx !== -1)  state.selectedOptionHistory.splice(hIdx, 1);
    }
  }

  /**
   * DEFERRED DOT PERSIST: persist the dot-confirmed status to sessionStorage.
   * Single-answer persists immediately; multi-answer persists 'correct' only
   * when ALL correct are selected (a partial 'correct' makes the DOT-CONFIRMED
   * FALLBACK LOCK treat the question as fully resolved on refresh and
   * auto-highlight an unselected correct answer), and 'wrong' on an incorrect
   * click; multi-answer partial-correct is intentionally NOT persisted (the
   * in-memory map handles live rendering). Terminal side-effect; closure-free;
   * extracted verbatim from handleOptionClick.
   */
  private persistDotConfirmedStatus(
    isMultipleMode: boolean,
    allCorrectFound: boolean,
    clickedIsCorrectEarly: boolean,
    dotStatusEarly: string,
    qIdx: number
  ): void {
    try {
      if (!isMultipleMode) {
        sessionStorage.setItem(SK_DOT_CONFIRMED + qIdx, dotStatusEarly);
      } else if (allCorrectFound) {
        sessionStorage.setItem(SK_DOT_CONFIRMED + qIdx, 'correct');
      } else if (!clickedIsCorrectEarly) {
        sessionStorage.setItem(SK_DOT_CONFIRMED + qIdx, 'wrong');
      }
      // For multi-answer partial correct: don't persist to sessionStorage.
      // The in-memory map handles live rendering; refresh should NOT see
      // a 'correct' status for an incomplete multi-answer question.
    } catch (e) {
      console.error('OptionInteractionService.handleOptionClick dot-status persist failed:', e);
    }
  }

  /**
   * UPDATE ANCHOR: if we just selected something, that's the new anchor; if we
   * unselected, find the most recently selected option in history that is STILL
   * selected and anchor on it (else -1). Side-effect on state.lastFeedbackOptionId;
   * the only closure used (getEffectiveId) is capture-free and redefined inline.
   * Extracted verbatim from handleOptionClick.
   */
  private updateFeedbackAnchor(
    state: OptionInteractionState,
    isCurrentlySelected: boolean,
    index: number,
    futureKeys: Set<number>
  ): void {
    const getEffectiveId = (o: any, i: number) => (o?.optionId != null && o.optionId !== -1) ? o.optionId : i;
    if (!isCurrentlySelected) {
      state.lastFeedbackOptionId = index;
    } else {
      // Robustly find the most recent in history that is STILL selected
      const stillSelectedId = [...(state.selectedOptionHistory || [])]
        .reverse()
        .find(histId => {
          // Find the option in optionsToDisplay that corresponds to this history entry
          const oIdx = state.optionsToDisplay.findIndex((_, i) => i === histId || String(i) === String(histId));
          const opt = oIdx !== -1 ? state.optionsToDisplay[oIdx] : state.optionsToDisplay.find(o => o.optionId != null && o.optionId !== -1 && o.optionId == histId);
          return opt && futureKeys.has(getEffectiveId(opt, state.optionsToDisplay.indexOf(opt)));
        });

      if (stillSelectedId !== undefined) {
        // Find its reliable index to use as the lastFeedbackOptionId
        const finalIdx = state.optionsToDisplay.findIndex((_, i) => i === stillSelectedId || String(i) === String(stillSelectedId));
        state.lastFeedbackOptionId = finalIdx !== -1 ? finalIdx : stillSelectedId;
      } else {
        state.lastFeedbackOptionId = -1;
      }
    }
  }

  /**
   * AUTHORITATIVE FEEDBACK ANCHORING: reset showFeedbackForOption completely
   * (so feedback only shows under the LAST selection), then re-anchor it on the
   * clicked option's keys, and set lastFeedbackOptionId + showFeedback. Terminal
   * side-effect on state; closure-free; extracted verbatim from handleOptionClick.
   */
  private applyFeedbackAnchoring(
    state: OptionInteractionState,
    targetKey: number,
    index: number,
    binding: OptionBindings
  ): void {
    // Reset completely for both single and multi-answer questions so feedback only shows under the LAST selection.
    state.showFeedbackForOption = {};

    state.showFeedbackForOption = {
      [targetKey]: true,
      [index]: true,
      [`idx:${index}`]: true
    };
    if (binding.option.optionId != null) {
      state.showFeedbackForOption[binding.option.optionId] = true;
    }
    state.lastFeedbackOptionId = targetKey;
    state.showFeedback = true;
  }

  /**
   * Back-fill displayIndex on EVERY futureSelection entry, not just the freshly
   * clicked one. Pre-existing entries from persisted state can be missing
   * displayIndex, and rehydrate keys strictly on displayIndex — so entries
   * without it silently fail to restore on refresh. Resolve by matching
   * optionId/text against the current bindings or optionsToDisplay to stamp the
   * correct position. Pure transform; extracted verbatim from handleOptionClick.
   * (Previously broke the shuffle revisit Next-button as `normalizeSelectionDisplayIndices`;
   * retried now that Phases 1+2 made the index model reliable and a permanent
   * revisit regression guard exists.)
   */
  private normalizeSelectionDisplayIndices(
    futureSelection: SelectedOption[],
    state: OptionInteractionState
  ): SelectedOption[] {
    return futureSelection.map((s: SelectedOption) => {
      const hasIdx =
        s?.displayIndex != null && Number.isFinite(Number(s.displayIndex));
      if (hasIdx) return s;
      const sId = s?.optionId;
      const sText = norm(s?.text);
      let pos = state.optionBindings.findIndex((b: OptionBindings) => {
        const bId = b?.option?.optionId;
        if (sId != null && sId !== -1 && bId != null && bId !== -1 && String(sId) === String(bId)) return true;
        return !!sText && norm(b?.option?.text) === sText;
      });
      if (pos === -1) {
        pos = state.optionsToDisplay.findIndex((o: Option) => {
          if (sId != null && sId !== -1 && o?.optionId != null && o.optionId !== -1 && String(sId) === String(o.optionId)) return true;
          return !!sText && norm(o?.text) === sText;
        });
      }
      if (pos === -1) return s;
      return { ...s, displayIndex: pos, index: pos };
    });
  }

  /**
   * Normalize state.optionBindings to a plain array in place. It may arrive
   * as a signal function (-clean) or plain array (-main); all downstream code
   * iterates/indexes it, so coerce once up front. Mutating `state` is safe —
   * it's a per-call context object, not the SOC itself. Self-contained leaf
   * side-effect; extracted verbatim from handleOptionClick's head.
   */
  private normalizeStateOptionBindings(state: OptionInteractionState): void {
    const _rawOb = (state as any).optionBindings;
    if (typeof _rawOb === 'function') {
      (state as any).optionBindings = (_rawOb() ?? []);
    } else if (!Array.isArray(_rawOb)) {
      (state as any).optionBindings = [];
    }
  }

  /**
   * PRISTINE CORRECTNESS RESOLVER: resolve whether the clicked option is
   * truly correct from quizInitialState, not from potentially-mutated binding
   * data. Uses question TEXT matching (not index) to handle shuffled mode
   * correctly. Extracted verbatim from handleOptionClick's inline closure;
   * `qIdx`/`state` are passed by the thin delegate that captures them by
   * reference so late `qIdx` reassignments are honored at call-time.
   */
  private isPristineCorrectFor(
    o: any,
    qIdx: number,
    state: OptionInteractionState
  ): boolean {
    if (!o) return false;
    try {
      const optText = norm(o?.text);
      if (!optText) return false;
      // Resolve the current question text for matching.
      // CRITICAL: In shuffled mode, state.currentQuestion points to the
      // WRONG question (original order). ALWAYS prefer display-order
      // sources first in shuffled mode.
      const isShuffledPC = (this.quizService as any)?.isShuffleEnabled?.()
        && (this.quizService as any)?.shuffledQuestions?.length > 0;
      let question: any;
      if (isShuffledPC) {
        question = this.quizService.getQuestionsInDisplayOrder?.()?.[qIdx]
          ?? (this.quizService as any)?.shuffledQuestions?.[qIdx]
          ?? state.currentQuestion
          ?? (this.quizService as any)?.questions?.[qIdx];
      } else {
        question = state.currentQuestion
          ?? (this.quizService as any)?.questions?.[qIdx]
          ?? this.quizService.getQuestionsInDisplayOrder?.()?.[qIdx];
      }
      const pristineCorrectTexts =
        this.quizService.getPristineCorrectTextsForQuestion(question?.questionText);
      return pristineCorrectTexts.has(optText);
    } catch { /* ignore */ }
    return false;
  }

  /**
   * Commit the resolved selection to the durable stores: the per-question
   * selection map (via syncSelectionState) and the quiz-service user-answer
   * record (the option ids derived from futureKeys). Terminal side-effect;
   * extracted verbatim from handleOptionClick (passes a fresh copy of
   * futureSelection, matching the prior `simulatedSelection = [...]` spread).
   */
  private commitSelectionState(
    qIdx: number,
    futureSelection: SelectedOption[],
    futureKeys: Set<number>,
    state: OptionInteractionState
  ): void {
    const getEffectiveId = (o: any, i: number) =>
      (o?.optionId != null && o.optionId !== -1) ? o.optionId : i;
    this.selectedOptionService.syncSelectionState(qIdx, [...futureSelection]);
    this.quizService.updateUserAnswer(
      qIdx,
      Array.from(futureKeys).map(idx => {
        const o = state.optionsToDisplay[idx] || state.optionBindings[idx]?.option;
        const eid = getEffectiveId(o, idx);
        return typeof eid === 'number' ? eid : -1;
      }).filter(id => id !== -1)
    );
  }

  /**
   * Authoritative highlight/selection sync for the option bindings after a
   * click. Single-answer: only the current click is "selected", but the
   * current click plus all previously-clicked options stay highlighted
   * (history is seeded from durable storage so prior clicks survive a
   * refresh). Multi-answer: a two-pass update mirrors `futureKeys` onto both
   * bindings and optionsToDisplay. Void side-effect on `state`; body extracted
   * verbatim from handleOptionClick.
   */
  private applyHighlightSync(
    state: OptionInteractionState,
    index: number,
    qIdx: number,
    targetKey: number | string,
    isMultipleMode: boolean,
    futureKeys: Set<number>
  ): void {
    if (!isMultipleMode) {
      // Accumulate history (don't reset it)
      if (!state.selectedOptionHistory.includes(index)) {
        state.selectedOptionHistory.push(index);
      }
      // Seed history from durable sel_Q* on first post-refresh click.
      // state.selectedOptionHistory is component-local and empty after
      // refresh, but sel_Q* holds every prior click for this question. Without
      // seeding, the binding loop below unhighlights prev-clicked options
      // (wasPreviouslyClicked=false) and turns them white.
      const historySet = new Set<number | string>(state.selectedOptionHistory);
      try {
        const saved = this.selectedOptionService.getSelectedOptionsForQuestion(qIdx) ?? [];
        for (const s of saved) {
          const sText = norm(s?.text);
          const sId = s?.optionId;
          let pos = -1;
          if (sText) {
            pos = state.optionBindings.findIndex((b: OptionBindings) =>
              norm(b?.option?.text) === sText
            );
          }
          if (pos === -1 && sId != null && sId !== -1) {
            pos = state.optionBindings.findIndex((b: OptionBindings) =>
              b?.option?.optionId != null && String(b.option.optionId) === String(sId)
            );
          }
          if (pos === -1) {
            const sIdx = s?.displayIndex ?? s?.index;
            if (sIdx != null && Number.isFinite(Number(sIdx))) pos = Number(sIdx);
          }
          if (pos !== -1) {
            historySet.add(pos);
            if (!state.selectedOptionHistory.includes(pos)) {
              state.selectedOptionHistory.push(pos);
            }
          }
        }
      } catch { /* ignore */ }
      for (const [i, b] of state.optionBindings.entries()) {
        const isCurrent = (i === index);
        const wasPreviouslyClicked = historySet.has(i);
        // Radio state: only current
        b.isSelected = isCurrent;
        if (b.option) {
          b.option.selected = isCurrent;
          // Highlight: current + previously clicked
          b.option.highlight = isCurrent || wasPreviouslyClicked;
          b.option.showIcon = isCurrent || wasPreviouslyClicked;
        }
        b.highlightCorrect = false;
        b.highlightIncorrect = false;
        b.showFeedback = isCurrent;
      }
      state.selectedOptionMap.clear();
      state.selectedOptionMap.set(targetKey, true);
      state.feedbackConfigs = {};
    } else { // Multiple mode: two-pass update to ensure correct results regardless of binding order
      // Pass 1: Sync 'selected' state for all bindings AND optionsToDisplay based on futureKeys.
      // Binding options are structuredClone'd copies of optionsToDisplay, so both must be updated.
      for (const [i, b] of state.optionBindings.entries()) {
        const isCurrentlySelected = futureKeys.has(i);
        b.isSelected = isCurrentlySelected;
        if (b.option) {
          b.option.selected = isCurrentlySelected;
        }
        if (state.optionsToDisplay?.[i]) {
          state.optionsToDisplay[i].selected = isCurrentlySelected;
        }
      }

      // Pass 2: Calculate 'highlight' and 'showIcon' based on the updated state
      for (const [i, b] of state.optionBindings.entries()) {
        if (!b.option) continue;
        const isCurrentlySelected = b.isSelected;
        b.option.highlight = isCurrentlySelected;
        b.option.showIcon = isCurrentlySelected;
        if (state.optionsToDisplay?.[i]) {
          state.optionsToDisplay[i].highlight = isCurrentlySelected;
          state.optionsToDisplay[i].showIcon = isCurrentlySelected;
        }
      }
    }
  }

  /**
   * Resolve the canonical set of correct-option indices for the current
   * question via a 3-tier fallback:
   *   1. Pristine-first: text-match against quizInitialState (immune to
   *      stale/mutated correct flags after Restart Quiz)
   *   2. questionOptions's own `correct` flags
   *   3. state.optionBindings's `isCorrect` / `option.correct`
   *
   * Pure read — never mutates inputs. Returns an empty Set if all three
   * sources fail.
   */
  private resolveCorrectIndicesSet(
    question: QuizQuestion | null,
    state: OptionInteractionState,
    questionOptions: Option[]
  ): Set<number> {
    const correctIndicesSet = new Set<number>();

    // PRISTINE-FIRST: Resolve correct indices from quizInitialState to avoid
    // stale/mutated correct flags on questionOptions (e.g. after Restart Quiz).
    try {
      const qTextForLookup = question?.questionText ?? state.currentQuestion?.questionText;
      const pristineCorrectTexts =
        this.quizService.getPristineCorrectTextsForQuestion(qTextForLookup);
      if (pristineCorrectTexts.size > 0) {
        for (const [i, o] of questionOptions.entries()) {
          if (pristineCorrectTexts.has(norm(o?.text))) {
            correctIndicesSet.add(i);
          }
        }
      }
    } catch { /* ignore */ }

    // Fallback: use questionOptions directly (may have stale flags but better than nothing)
    if (correctIndicesSet.size === 0) {
      for (const [i, o] of questionOptions.entries()) {
        if (isOptionCorrect(o)) correctIndicesSet.add(i);
      }
    }

    // Also try bindings as a source of correct info
    if (correctIndicesSet.size === 0) {
      for (const [i, b] of state.optionBindings.entries()) {
        if (b.isCorrect || isOptionCorrect(b.option)) correctIndicesSet.add(i);
      }
    }

    return correctIndicesSet;
  }

  /**
   * Pristine correct-count probe: looks up the pristine quiz data for the
   * current question and returns the count of correct options. Bindings can
   * carry mutated correct flags (only 1 of 2 shown as correct), so this
   * cross-check ensures multi-answer questions aren't misidentified as
   * single-answer.
   *
   * Returns `seed` if the pristine lookup fails or yields nothing. Returns
   * the pristine count when available (which OVERWRITES seed — same as
   * the original inline behavior; may shrink seed in odd binding states).
   */
  private resolvePristineCorrectCount(seed: number, qIdx: number, state: OptionInteractionState): number {
    try {
      const qTextLookup = state.currentQuestion?.questionText
        || this.quizService.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText
        || (this.quizService as any)?.questions?.[qIdx]?.questionText;
      const pristineTexts = this.quizService.getPristineCorrectTextsForQuestion(qTextLookup);
      if (pristineTexts.size > 0) {
        return pristineTexts.size;
      }
    } catch { /* ignore */ }
    return seed;
  }

  /**
   * Pristine multi-answer probe: looks up the pristine quiz data by the
   * current question text (shuffle-aware) and returns true when there's
   * more than one correct answer. Bindings can carry stale/mutated correct
   * flags, so this is the authoritative single/multi classifier inside
   * handleOptionClick.
   */
  private resolvePristineIsMultiAnswer(
    question: QuizQuestion | null,
    qIdx: number,
    state: OptionInteractionState
  ): boolean {
    try {
      const isShuffledPM = (this.quizService as any)?.isShuffleEnabled?.()
        && (this.quizService as any)?.shuffledQuestions?.length > 0;
      const qTextForLookup = isShuffledPM
        ? (question?.questionText
          ?? this.quizService.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText
          ?? (this.quizService as any)?.shuffledQuestions?.[qIdx]?.questionText
          ?? state.currentQuestion?.questionText)
        : (question?.questionText ?? state.currentQuestion?.questionText);
      const pristineTexts = this.quizService.getPristineCorrectTextsForQuestion(qTextForLookup);
      return pristineTexts.size > 1;
    } catch {
      return false;
    }
  }

  /**
   * Tail-end of handleOptionClick: compute the post-click selection message
   * for the current question and push it. Reads the live optionBindings
   * (signal-or-array tolerant) and projects each option's "selected" state
   * from the just-computed futureKeys set so the message reflects the new
   * state, not the pre-click state.
   */
  private syncMessageAfterClick(
    state: OptionInteractionState,
    qIdx: number,
    isMultipleMode: boolean,
    futureKeys: Set<number>
  ): void {
    try {
      // RESOLVE: state.optionBindings may be a signal in -clean / array in -main
      const _rawSob = state.optionBindings as any;
      const _sob: any[] = typeof _rawSob === 'function' ? (_rawSob() ?? []) : (_rawSob ?? []);
      const message = this.selectionMessageService.computeFinalMessage({
        index: qIdx,
        total: this.quizService?.totalQuestions(),
        qType: isMultipleMode ? QuestionType.MultipleAnswer : QuestionType.SingleAnswer,
        opts: _sob.map((b: any, i: number) => ({
          ...b.option,
          selected: futureKeys.has(i)
        })) as Option[]
      });
      this.selectionMessageService.pushMessage(message, qIdx);
    } catch (e) {
      console.error('OptionInteractionService.handleOptionClick message sync failed:', e);
    }
  }
}