import { ApplicationRef, Injectable } from '@angular/core';

import { Option } from '../../../models/Option.model';
import { OptionBindings } from '../../../models/OptionBindings.model';
import { SelectedOption } from '../../../models/SelectedOption.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { QuestionType } from '../../../models/question-type.enum';
import { FeedbackProps } from '../../../models/FeedbackProps.model';

import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { TimerService } from '../../features/timer/timer.service';
import { FeedbackService } from '../../features/feedback/feedback.service';
import { SelectionMessageService } from '../../features/selection-message/selection-message.service';
import { NextButtonStateService } from '../../state/next-button-state.service';

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
  constructor(
    private quizService: QuizService,
    private quizStateService: QuizStateService,
    private selectedOptionService: SelectedOptionService,
    private timerService: TimerService,
    private feedbackService: FeedbackService,
    private selectionMessageService: SelectionMessageService,
    private nextButtonStateService: NextButtonStateService,
    private appRef: ApplicationRef
  ) { }

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
      const nrmH = (t: any) => String(t ?? '').trim().toLowerCase();
      const liveQText = nrmH(state.currentQuestion?.questionText);
      const allQs: any[] = (this.quizService as any)?.questions ?? [];
      if (liveQText && allQs.length) {
        const atQIdx = nrmH(allQs[qIdx]?.questionText);
        if (liveQText !== atQIdx) {
          const fixed = allQs.findIndex((q: any) => nrmH(q?.questionText) === liveQText);
          if (fixed >= 0) qIdx = fixed;
        }
      }
    } catch { /* ignore */ }
    const isCorrectHelper = (o: any): boolean => {
      if (!o) return false;
      const c = o.correct ?? o.isCorrect ?? (o as any).correct;
      return c === true || String(c) === 'true' || c === 1 || c === '1';
    };

    // PRISTINE CORRECTNESS RESOLVER: Resolve whether the clicked option is
    // truly correct from quizInitialState, not from potentially-mutated binding data.
    // Uses question TEXT matching (not index) to handle shuffled mode correctly.
    const isPristineCorrect = (o: any): boolean => {
      if (!o) return false;
      try {
        const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
        const optText = nrm(o?.text);
        const bundle: any[] = (this.quizService as any)?.quizInitialState ?? [];
        if (optText && bundle.length > 0) {
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
          const qText = nrm(question?.questionText);
          if (qText) {
            // Match by question text across all pristine quizzes
            let pcMatched = false;
            for (const quiz of bundle) {
              for (const pq of (quiz?.questions ?? [])) {
                if (nrm(pq?.questionText) !== qText) continue;
                pcMatched = true;
                const matchedOpt = (pq?.options ?? []).find((po: any) => nrm(po?.text) === optText);
                if (matchedOpt !== undefined) {
                  const result = matchedOpt?.correct === true || String(matchedOpt?.correct) === 'true';
                  return result;
                }
                break;
              }
              if (pcMatched) break;
            }
          }
        }
      } catch { /* ignore */ }
      // Do NOT fall back to binding flags — they can be stale/wrong.
      // If pristine lookup fails, return false to avoid false positives.
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
    // Use a DIRECT quizInitialState lookup (independent of isPristineCorrect)
    // to ensure correct clicks are always recorded even when isPristineCorrect
    // fails due to stale question text resolution.
    try {
      const nrmR = (t: any) => String(t ?? '').trim().toLowerCase();
      const optTextR = nrmR(binding.option?.text);
      if (optTextR) {
        const bundleR: any[] = (this.quizService as any)?.quizInitialState ?? [];
        // Try multiple sources for question text
        const qTextCandidates = [
          nrmR(state.currentQuestion?.questionText),
          nrmR(this.quizService.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText),
          nrmR((this.quizService as any)?.shuffledQuestions?.[qIdx]?.questionText),
          nrmR((this.quizService as any)?.questions?.[qIdx]?.questionText)
        ].filter((t: string) => !!t);
        for (const qTextR of qTextCandidates) {
          let found = false;
          for (const quiz of bundleR) {
            for (const pq of (quiz?.questions ?? [])) {
              if (nrmR(pq?.questionText) !== qTextR) continue;
              const matchedOpt = (pq?.options ?? []).find((po: any) => nrmR(po?.text) === optTextR);
              if (matchedOpt && (matchedOpt.correct === true || String(matchedOpt.correct) === 'true')) {
                (this.quizService as any)?.scoringService?.recordCorrectClick?.(qIdx, binding.option.text);
                found = true;
              }
              break;
            }
            if (found) break;
          }
          if (found) break;
        }
      }
    } catch { /* ignore */ }
    this.selectedOptionService.clickConfirmedDotStatus.set(qIdx, dotStatusEarly);
    this.selectedOptionService.lastClickedCorrectByQuestion.set(qIdx, clickedIsCorrectEarly);
    // NOTE: sessionStorage persist of dot_confirmed is deferred to AFTER we
    // know the question type. For multi-answer, a single correct click must
    // NOT persist 'correct' — only full resolution should. The in-memory
    // map is fine for live dot rendering; the sessionStorage value drives
    // the DOT-CONFIRMED FALLBACK LOCK on refresh.

    const bindingsForScore = state.optionBindings ?? [];
    const correctCountInBindings = bindingsForScore.filter(b => isCorrectHelper(b.option)).length;

    // PRISTINE correct-count: bindings can have mutated correct flags (e.g.
    // only 1 of 2 shown as correct). Cross-check against quizInitialState
    // so multi-answer questions are never misidentified as single-answer.
    let pristineCorrectCount = correctCountInBindings;
    try {
      const nrmQ = (t: any) => String(t ?? '').trim().toLowerCase();
      const qTextLookup = nrmQ(state.currentQuestion?.questionText)
        || nrmQ(this.quizService.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText)
        || nrmQ((this.quizService as any)?.questions?.[qIdx]?.questionText);
      if (qTextLookup) {
        const bundleQ: any[] = (this.quizService as any)?.quizInitialState ?? [];
        for (const quiz of bundleQ) {
          for (const pq of (quiz?.questions ?? [])) {
            if (nrmQ(pq?.questionText) !== qTextLookup) continue;
            pristineCorrectCount = (pq?.options ?? [])
              .filter((o: any) => o?.correct === true || String(o?.correct) === 'true').length;
            break;
          }
          if (pristineCorrectCount !== correctCountInBindings) break;
        }
      }
    } catch { /* ignore */ }

    // Authoritative Type Resolution
    const qText = state.currentQuestion?.questionText?.toLowerCase() || '';
    const isExplicitMulti = qText.includes('select all') || qText.includes('multiple') || qText.includes('apply');
    const isMultipleMode = state.type === 'multiple' || (state as any).isMultiMode === true ||
                          isExplicitMulti || correctCountInBindings > 1 || pristineCorrectCount > 1;
    const isTrulyMulti = isMultipleMode;

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
    // LOCAL simulatedSelection shape; do NOT call clearAllSelectionsForQuestion
    // here — it wipes _selectionHistory and sel_Q* in sessionStorage.
    let simulatedSelection = isStaleFromRefresh ? [] : [...storedSelection];

    // Check if ALREADY selected using composite (id + displayIndex) matching.
    // See targetCompositeKey comment above — optionId alone can collide.
    const existingIdx = simulatedSelection.findIndex(o => {
      const sIdx = (o as any).displayIndex ?? (o as any).index ?? (o as any).idx;
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
        // Do NOT call clearAllSelectionsForQuestion here: it wipes
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
      const sId = (s as any).optionId;
      const sText = (s as any).text?.trim().toLowerCase();
      let idx = (s as any).displayIndex ?? (s as any).index ?? (s as any).idx;

      if (idx === undefined || idx === null || idx === -1 || isNaN(Number(idx))) {
        const foundIdx = state.optionBindings.findIndex(b => {
          if (b.option === s) return true;
          const bId = b.option?.optionId;
          if (sId != null && sId !== -1 && bId != null && bId !== -1 && String(sId) === String(bId)) return true;
          return !!sText && b.option?.text?.trim().toLowerCase() === sText;
        });
        if (foundIdx !== -1) idx = foundIdx;
        else {
          const oIdx = state.optionsToDisplay.findIndex(o => {
            if (o === s) return true;
            if (sId != null && sId !== -1 && o.optionId != null && o.optionId !== -1 && String(sId) === String(o.optionId)) return true;
            return !!sText && o.text?.trim().toLowerCase() === sText;
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
    futureSelection = futureSelection.map((s: any) => {
      const hasIdx =
        s?.displayIndex != null && Number.isFinite(Number(s.displayIndex));
      if (hasIdx) return s;
      const sId = s?.optionId;
      const sText = (s?.text ?? '').trim().toLowerCase();
      let pos = state.optionBindings.findIndex((b: any) => {
        const bId = b?.option?.optionId;
        if (sId != null && sId !== -1 && bId != null && bId !== -1 && String(sId) === String(bId)) return true;
        return !!sText && (b?.option?.text ?? '').trim().toLowerCase() === sText;
      });
      if (pos === -1) {
        pos = state.optionsToDisplay.findIndex((o: any) => {
          if (sId != null && sId !== -1 && o?.optionId != null && o.optionId !== -1 && String(sId) === String(o.optionId)) return true;
          return !!sText && (o?.text ?? '').trim().toLowerCase() === sText;
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
      const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
      const qTextForLookup = nrm(question?.questionText ?? state.currentQuestion?.questionText);
      const bundle: any[] = (this.quizService as any)?.quizInitialState ?? [];
      if (qTextForLookup && bundle.length > 0) {
        for (const quiz of bundle) {
          for (const pq of (quiz?.questions ?? [])) {
            if (nrm(pq?.questionText) !== qTextForLookup) continue;
            const pristineCorrectTexts = new Set<string>(
              (pq?.options ?? [])
                .filter((o: any) => o?.correct === true || String(o?.correct) === 'true')
                .map((o: any) => nrm(o?.text))
                .filter((t: string) => !!t)
            );
            for (const [i, o] of questionOptions.entries()) {
              if (pristineCorrectTexts.has(nrm((o as any)?.text))) {
                correctIndicesSet.add(i);
              }
            }
            break;
          }
          if (correctIndicesSet.size > 0) break;
        }
      }
    } catch { /* ignore */ }

    // Fallback: use questionOptions directly (may have stale flags but better than nothing)
    if (correctIndicesSet.size === 0) {
      for (const [i, o] of questionOptions.entries()) {
        if (isCorrectHelper(o)) correctIndicesSet.add(i);
      }
    }

    // Fallback: cross-reference raw _questions
    if (correctIndicesSet.size === 0 && question?.questionText) {
      const rawQs: any[] = (this.quizService as any)._questions ?? [];
      const qText = (question.questionText ?? '').trim().toLowerCase();
      for (const rq of rawQs) {
        if ((rq.questionText ?? '').trim().toLowerCase() === qText) {
          const rawCorrectTexts = new Set<string>(
            (rq.options ?? []).filter((o: any) => isCorrectHelper(o)).map((o: any) => (o.text ?? '').trim().toLowerCase())
          );
          for (const [i, o] of questionOptions.entries()) {
            if (rawCorrectTexts.has(((o as any).text ?? '').trim().toLowerCase())) {
              correctIndicesSet.add(i);
            }
          }
          break;
        }
      }
    }

    // Also try bindings as a source of correct info
    if (correctIndicesSet.size === 0) {
      for (const [i, b] of state.optionBindings.entries()) {
        if (b.isCorrect || isCorrectHelper(b.option)) correctIndicesSet.add(i);
      }
      if (correctIndicesSet.size > 0) {
      }
    }

    const allCorrectFound = correctIndicesSet.size > 0 && [...correctIndicesSet].every(i => futureKeys.has(i));
    const numIncorrectInFuture = futureSelection.filter(o => !isCorrectHelper(o)).length;
    const isPerfect = allCorrectFound && numIncorrectInFuture === 0;

    // DEFERRED DOT PERSIST: For single-answer, persist immediately.
    // For multi-answer, only persist 'correct' when ALL correct answers
    // are selected. A partial 'correct' causes the DOT-CONFIRMED FALLBACK
    // LOCK to treat the question as fully resolved on refresh, which
    // auto-highlights the 2nd correct answer the user never selected.
    try {
      if (!isMultipleMode) {
        sessionStorage.setItem('dot_confirmed_' + qIdx, dotStatusEarly);
      } else if (allCorrectFound) {
        sessionStorage.setItem('dot_confirmed_' + qIdx, 'correct');
      } else if (!clickedIsCorrectEarly) {
        sessionStorage.setItem('dot_confirmed_' + qIdx, 'wrong');
      }
      // For multi-answer partial correct: don't persist to sessionStorage.
      // The in-memory map handles live rendering; refresh should NOT see
      // a 'correct' status for an incomplete multi-answer question.
    } catch {}

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
          const sText = ((s as any)?.text ?? '').trim().toLowerCase();
          const sId = (s as any)?.optionId;
          let pos = -1;
          if (sText) {
            pos = state.optionBindings.findIndex((b: any) =>
              (b?.option?.text ?? '').trim().toLowerCase() === sText
            );
          }
          if (pos === -1 && sId != null && sId !== -1) {
            pos = state.optionBindings.findIndex((b: any) =>
              b?.option?.optionId != null && String(b.option.optionId) === String(sId)
            );
          }
          if (pos === -1) {
            const sIdx = (s as any)?.displayIndex ?? (s as any)?.index;
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
      try { this.timerService.stopTimer?.(undefined, { force: true, bypassAntiThrash: true }); } catch {}
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
    let pristineIsMultiAnswer = false;
    try {
      const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
      // In shuffled mode, prefer display-order question text over state.currentQuestion
      const isShuffledPM = (this.quizService as any)?.isShuffleEnabled?.()
        && (this.quizService as any)?.shuffledQuestions?.length > 0;
      let qTextForLookup: string;
      if (isShuffledPM) {
        qTextForLookup = nrm(
          question?.questionText
          ?? this.quizService.getQuestionsInDisplayOrder?.()?.[qIdx]?.questionText
          ?? (this.quizService as any)?.shuffledQuestions?.[qIdx]?.questionText
          ?? state.currentQuestion?.questionText
        );
      } else {
        qTextForLookup = nrm(question?.questionText ?? state.currentQuestion?.questionText);
      }
      const bundle: any[] = (this.quizService as any)?.quizInitialState ?? [];
      let pmMatched = false;
      for (const quiz of bundle) {
        for (const pq of (quiz?.questions ?? [])) {
          if (nrm(pq?.questionText) !== qTextForLookup) continue;
          pmMatched = true;
          const pristineCorrectCount = (pq?.options ?? [])
            .filter((o: any) => o?.correct === true || String(o?.correct) === 'true').length;
          if (pristineCorrectCount > 1) pristineIsMultiAnswer = true;
          break;
        }
        if (pmMatched) break;
      }
    } catch { /* ignore */ }

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
        if (!(this.quizService as any)._multiAnswerPerfect) {
          (this.quizService as any)._multiAnswerPerfect = new Map<number, boolean>();
        }
        (this.quizService as any)._multiAnswerPerfect.set(qIdx, true);
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
    try {
      const message = this.selectionMessageService.computeFinalMessage({
        index: qIdx,
        total: this.quizService?.totalQuestions,
        qType: isMultipleMode ? QuestionType.MultipleAnswer : QuestionType.SingleAnswer,
        opts: state.optionBindings.map((b, i) => ({
          ...b.option,
          selected: futureKeys.has(i)
        })) as Option[]
      });
      this.selectionMessageService.pushMessage(message, qIdx);
    } catch {
      // Message sync failed
    }
  }
}