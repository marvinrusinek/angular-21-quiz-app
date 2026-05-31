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
    // Mutating state.optionBindings here is safe because `state` is a
    // per-call context object, not the SOC itself.
    const _rawOb = (state as any).optionBindings;
    if (typeof _rawOb === 'function') {
      (state as any).optionBindings = (_rawOb() ?? []);
    } else if (!Array.isArray(_rawOb)) {
      (state as any).optionBindings = [];
    }
    // Always prefer the live quiz service index over the state snapshot.
    // On the first click after navigating Q1→Q2, state.currentQuestionIndex
    // can still be 0 (stale) while the user is physically on Q2, causing
    // the click to be attributed to the wrong question and dropped.
    const liveIdx = this.quizService?.getCurrentQuestionIndex?.();
    let qIdx = (typeof liveIdx === 'number' && Number.isFinite(liveIdx) && liveIdx >= 0)
      ? liveIdx : state.currentQuestionIndex;
    // Self-heal: quizService.getCurrentQuestionIndex() can be stuck at 0
    // even when the user is on Q2/Q3. Correct qIdx by matching the live
    // currentQuestion text against quizService.questions, so confirmed
    // clicks get recorded under the right question slot.
    try {
      const liveQText = norm(state.currentQuestion?.questionText);
      const allQs: any[] = (this.quizService as any)?.questions ?? [];
      if (liveQText && allQs.length) {
        const atQIdx = norm(allQs[qIdx]?.questionText);
        if (liveQText !== atQIdx) {
          const fixed = allQs.findIndex((q: any) => norm(q?.questionText) === liveQText);
          if (fixed >= 0) qIdx = fixed;
        }
      }
    } catch { /* ignore */ }
    const isCorrectHelper = isOptionCorrect;

    // PRISTINE CORRECTNESS RESOLVER: Resolve whether the clicked option is
    // truly correct from quizInitialState, not from potentially-mutated binding data.
    // Uses question TEXT matching (not index) to handle shuffled mode correctly.
    const isPristineCorrect = (o: any): boolean => {
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
    };

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

    // Record correct clicks for the scoring service's multi-answer gate.
    try {
      if (isPristineCorrect(binding.option)) {
        (this.quizService as any)?.scoringService?.recordCorrectClick?.(qIdx, binding.option.text);
      }
    } catch { /* ignore */ }
    this.selectedOptionService.clickConfirmedDotStatus.set(qIdx, dotStatusEarly);
    this.selectedOptionService.lastClickedCorrectByQuestion.set(qIdx, clickedIsCorrectEarly);
    // NOTE: sessionStorage persist of dot_confirmed is deferred to AFTER we
    // know the question type. For multi-answer, a single correct click must
    // NOT persist 'correct' — only full resolution should. The in-memory
    // map is fine for live dot rendering; the sessionStorage value drives
    // the DOT-CONFIRMED FALLBACK LOCK on refresh.

    // RESOLVE: state.optionBindings may be a signal (-clean) or plain array (-main).
    // Call as function if it's a signal, otherwise use directly.
    const _rawBindings = state.optionBindings as any;
    const bindingsForScore: any[] = typeof _rawBindings === 'function'
      ? (_rawBindings() ?? [])
      : (_rawBindings ?? []);
    const correctCountInBindings = bindingsForScore.filter((b: any) => isCorrectHelper(b.option)).length;

    // PRISTINE correct-count: bindings can have mutated correct flags (e.g.
    // only 1 of 2 shown as correct). Cross-check against quizInitialState
    // so multi-answer questions are never misidentified as single-answer.
    const pristineCorrectCount = this.resolvePristineCorrectCount(correctCountInBindings, qIdx, state);

    // Authoritative Type Resolution
    const qText = state.currentQuestion?.questionText?.toLowerCase() || '';
    const isExplicitMulti = qText.includes('select all') || qText.includes('multiple') || qText.includes('apply');
    const isMultipleMode = state.type === 'multiple' || (state as any).isMultiMode === true ||
                          isExplicitMulti || correctCountInBindings > 1 || pristineCorrectCount > 1;

    // Guard: prevent deselection of correct answers in multiple
    if (isMultipleMode && binding.isSelected && isPristineCorrect(binding.option)) {
      if (event && event.preventDefault) event.preventDefault();
      return;
    }

    // STATE SETUP
    const question = getQuestionAtDisplayIndex(qIdx);
    const questionOptions = Array.isArray(question?.options) ? question.options : [];

    const storedSelection = this.selectedOptionService.getSelectedOptionsForQuestion(qIdx) ?? [];
    // Detect stale pre-refresh selections: if the durable click tracker
    // for this question is empty but the service has stored selections,
    // those are remnants from before refresh. Discard them so the user
    // starts fresh after page reload.
    const durableClicks = (state as any)._multiSelectByQuestion?.get(qIdx);
    const isStaleFromRefresh = storedSelection.length > 0
      && (!durableClicks || durableClicks.size === 0);
    // Even if the in-memory multi-select tracker is empty post-refresh, the
    // durable sel_Q* / _selectionHistory entries are legitimate prior clicks
    // that must be preserved so they rehydrate as prev-clicked (dark gray /
    // red+X) on the next refresh. Only use isStaleFromRefresh to scope the
    // LOCAL simulatedSelection shape; do NOT call clearSelectionsForQuestion
    // here — it wipes _selectionHistory and sel_Q* in sessionStorage.
    let simulatedSelection = isStaleFromRefresh ? [] : [...storedSelection];

    // Check if ALREADY selected using composite (id + displayIndex) matching.
    // See targetCompositeKey comment above — optionId alone can collide.
    const existingIdx = simulatedSelection.findIndex(o => {
      const sIdx = o.displayIndex ?? o.index ?? o.idx ?? -1;
      const sKey = `${getEffectiveId(o, sIdx)}|${sIdx}`;
      return sKey === targetCompositeKey;
    });
    const isCurrentlySelected = (existingIdx !== -1);

    let futureSelection: SelectedOption[] = [];
    if (isCurrentlySelected) {
      futureSelection = simulatedSelection.filter((_, i) => i !== existingIdx);
    } else {
      const newOpt: SelectedOption = {
        ...binding.option,
        optionId: targetKey,
        selected: true,
        questionIndex: qIdx,
        index: index,
        displayIndex: index
      } as SelectedOption;
      
      if (!isMultipleMode) {
        // Do NOT call clearSelectionsForQuestion here: it wipes
        // _selectionHistory and sel_Q* in sessionStorage, which erases the
        // "previously clicked" record for prior wrong clicks. We still
        // want A to rehydrate on refresh (as previously-clicked, even if
        // not currently selected). futureSelection = [newOpt] below
        // already enforces single-answer "only one currently selected"
        // semantics in the live map; history accumulation is handled by
        // setSelectedOptionsForQuestion downstream.
        futureSelection = [newOpt];
      } else {
        futureSelection = [...simulatedSelection, newOpt];
      }
    }
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

    // Normalize displayIndex on EVERY futureSelection entry (not just the
    // freshly-clicked one). Pre-existing entries in simulatedSelection can
    // come from persisted state with a missing displayIndex, and rehydrate
    // keys strictly on displayIndex — so entries without it silently fail
    // to restore on refresh. Resolve by matching optionId/text against the
    // current bindings or optionsToDisplay to stamp the correct position.
    futureSelection = futureSelection.map((s: SelectedOption) => {
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

    // Re-sync simulatedSelection with the normalized futureSelection so the
    // subsequent syncSelectionState call below persists the corrected data.
    simulatedSelection = [...futureSelection];

    // UPDATE UI STATE BASICS
    const newState = !isCurrentlySelected;
    const mockEvent = isMultipleMode ? { source: null, checked: newState } : { source: null, value: binding.option.optionId ?? index };

    if (newState && !state.selectedOptionHistory.includes(index)) {
      state.selectedOptionHistory.push(index);
    } else if (!newState) {
      const hIdx = state.selectedOptionHistory.indexOf(index);
      if (hIdx !== -1)  state.selectedOptionHistory.splice(hIdx, 1);
    }

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
        if (isCorrectHelper(o)) correctIndicesSet.add(i);
      }
    }

    // Also try bindings as a source of correct info
    if (correctIndicesSet.size === 0) {
      for (const [i, b] of state.optionBindings.entries()) {
        if (b.isCorrect || isCorrectHelper(b.option)) correctIndicesSet.add(i);
      }
    }

    const allCorrectFound = correctIndicesSet.size > 0 && [...correctIndicesSet].every(i => futureKeys.has(i));

    // DEFERRED DOT PERSIST: For single-answer, persist immediately.
    // For multi-answer, only persist 'correct' when ALL correct answers
    // are selected. A partial 'correct' causes the DOT-CONFIRMED FALLBACK
    // LOCK to treat the question as fully resolved on refresh, which
    // auto-highlights the 2nd correct answer the user never selected.
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

    // COMMIT STATE
    simulatedSelection = [...futureSelection];
    this.selectedOptionService.syncSelectionState(qIdx, simulatedSelection);
    this.quizService.updateUserAnswer(
      qIdx,
      Array.from(futureKeys).map(idx => {
        const o = state.optionsToDisplay[idx] || state.optionBindings[idx]?.option;
        const eid = getEffectiveId(o, idx);
        return typeof eid === 'number' ? eid : -1;
      }).filter(id => id !== -1)
    );

    // UPDATE UI

    // AUTHORITATIVE HIGHLIGHT SYNC for single-answer mode:
    // - isSelected (radio state): ONLY the current click
    // - highlight/showIcon: current click + all previously clicked options
    // - feedback: ONLY the current click (handled by _feedbackDisplay)
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

    // Detect shuffle mode early — needed for timer and scoring gates
    const isShuffleActive = (this.quizService as any)?.isShuffleEnabled?.() &&
      (this.quizService as any)?.shuffledQuestions?.length > 0;

    // Stop timer when correct answer(s) selected.
    // In shuffled mode, only trust isPristineCorrect — allCorrectFound uses
    // mutated binding flags which can be wrong.
    const shouldStopTimer = isShuffleActive
      ? (!isMultipleMode && isPristineCorrect(binding.option))
      : (allCorrectFound || (!isMultipleMode && isPristineCorrect(binding.option)));
    if (shouldStopTimer) {
      try { this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true }); } catch (e) {
        console.error('OptionInteractionService.handleOptionClick timer stop failed:', e);
      }
    }

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

    // ─── SCORING ───
    // In SHUFFLED mode, ALL scoring and FET is handled by the SOC
    // (runOptionContentClick) which has authoritative pristine-based logic.
    // OIS must NOT score or emit FET in shuffled mode — its data sources
    // (allCorrectFound, correctIndicesSet, binding flags) are unreliable
    // when questions are reordered.
    let scoreFired = false;

    if (!isShuffleActive) {
      // ── UNSHUFFLED: original gate ──
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

    // UPDATE ANCHOR: If we just selected something, that's the new anchor.
    // If we unselected, find the most recently selected option that's still selected.
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

    // AUTHORITATIVE FEEDBACK ANCHORING
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

    state.lastClickedOptionId = index;
    state.hasUserClicked = true;
    state.disableRenderTrigger++;

    // CALL UPDATE with THE AUTHORITATIVE CONTEXT (state)
    (updateOptionAndUI as any)(binding, index, mockEvent, state);


    // MESSAGE UPDATE
    this.syncMessageAfterClick(state, qIdx, isMultipleMode, futureKeys);
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