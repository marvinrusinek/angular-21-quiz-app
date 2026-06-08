import { inject, Injectable, signal } from '@angular/core';
import { combineLatest, Observable } from 'rxjs';
import {
  distinctUntilChanged, filter, map, shareReplay, startWith, switchMap
} from 'rxjs/operators';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { ExplanationTextService, FETPayload } from '../explanation/explanation-text.service';
import { QuizNavigationService } from '../../flow/quiz-navigation.service';
import { QuizQuestionManagerService } from '../../flow/quizquestionmgr.service';
import { QuizService } from '../../data/quiz.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { withCorrectCountBanner } from '../../../utils/correct-count-banner';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

@Injectable({ providedIn: 'root' })
export class QuizContentDisplayService {
  // ═══════════════════════════════════════════════════════════════════════
  // FET State
  // ═══════════════════════════════════════════════════════════════════════

  // Lock flag to prevent displayText$ from overwriting FET
  readonly _fetLockedSig = signal<boolean>(false);
  readonly _lockedForIndexSig = signal<number>(-1);

  // Session-based tracking: which questions have had FET displayed this session
  _fetDisplayedThisSession = new Set<number>();

  _lastQuestionTextByIndex = new Map<number, string>();

  // ═══════════════════════════════════════════════════════════════════════
  // Reactive Observables (initialized via setup methods)
  // ═══════════════════════════════════════════════════════════════════════

  displayText$!: Observable<string>;
  shouldShowFet$!: Observable<boolean>;
  fetToDisplay$!: Observable<string>;

  // ── injects ─────────────────────────────────────────────────────
  private readonly explanationTextService = inject(ExplanationTextService);
  private readonly quizService = inject(QuizService);
  private readonly quizNavigationService = inject(QuizNavigationService);
  private readonly quizQuestionManagerService = inject(QuizQuestionManagerService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);

  // ═══════════════════════════════════════════════════════════════════════
  // Formatted Explanation Observables (factory methods)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Creates the reactive FET observable that combines the current index
   * with service cache updates to guarantee latest data.
   */
  createFormattedExplanation$(
    currentIndex$: Observable<number>
  ): Observable<FETPayload> {
    return combineLatest([
      currentIndex$,
      this.explanationTextService.explanationsUpdated
    ]).pipe(
      map(([idx, explanations]) => {
        const explanation = explanations[idx]?.explanation || '';
        return { idx, text: explanation, token: 0 } as FETPayload;
      }),
      distinctUntilChanged((a, b) => a.idx === b.idx && a.text === b.text),
      shareReplay(1)
    );
  }

  /**
   * Creates the active FET text observable that resolves from
   * both fetByIndex map and formattedExplanations record.
   */
  createActiveFetText$(
    currentIndex$: Observable<number>
  ): Observable<string> {
    return combineLatest([
      currentIndex$,
      this.explanationTextService.explanationsUpdated.pipe(startWith({}))
    ]).pipe(
      map(([idx]) => {
        const safeIdx = Number.isFinite(idx) ? Number(idx) : 0;
        const fromMap = this.explanationTextService.fetByIndex?.get(safeIdx)?.trim() || '';
        const fromRecord = this.explanationTextService.formattedExplanations?.[safeIdx]?.explanation?.trim() || '';
        return fromMap || fromRecord;
      }),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Display Text Pipeline
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Builds the main displayText$ observable that switches between
   * question text and formatted explanation text based on resolution state.
   */
  initDisplayTextPipeline(
    currentIndex$: Observable<number>,
    timedOutIdx$: Observable<number>,
    displayState$: Observable<{ mode: 'question' | 'explanation'; answered: boolean }>
  ): void {
    this.displayText$ = currentIndex$.pipe(
      filter(idx => idx >= 0),
      switchMap(safeIdx => {
        return combineLatest([
          this.quizService.getQuestionByIndex(safeIdx),
          this.selectedOptionService.getSelectedOptionsForQuestion$(safeIdx).pipe(startWith([])),
          this.explanationTextService.getExplanationText$(safeIdx).pipe(startWith('')),
          timedOutIdx$.pipe(
            startWith(-1),
            map(tIdx => tIdx === safeIdx)
          ),
          displayState$.pipe(startWith({ mode: 'question', answered: false })),
          this.quizNavigationService.getIsNavigatingToPrevious().pipe(startWith(false)),
          this.quizStateService.userHasInteracted$.pipe(startWith(-1))
        ]).pipe(
          map(([qObj, selections, fetText, isTimedOut, state, isNavBack, lastInteractedIdx]) => {
            return this.resolveDisplayText(
              safeIdx, qObj, selections, fetText, isTimedOut, state, isNavBack, lastInteractedIdx
            );
          })
        );
      }),
      distinctUntilChanged()
    );
  }

  /**
   * Pure resolution logic: given all inputs for a question index,
   * determine what text to display (question text or FET).
   */
  private resolveDisplayText(
    safeIdx: number,
    qObj: QuizQuestion | null,
    selections: any[],
    fetText: string | null,
    isTimedOut: boolean,
    state: { mode: string; answered: boolean } | null,
    isNavBack: boolean,
    lastInteractedIdx: number
  ): string {
    const { qDisplay, numCorrect } = this.buildQuestionDisplay(safeIdx, qObj);
    const safeSelections = Array.isArray(selections) ? selections : [];
    const isMultipleAnswer = numCorrect > 1;
    const isResolved = this.computeIsResolved(qObj, safeSelections, isMultipleAnswer);
    const wasPreviouslyAnswered = this.quizStateService.isQuestionAnswered(safeIdx);

    // Base: FET when resolved (all-correct selected) or a single-answer timeout.
    let shouldShowExplanation = isResolved || isTimedOut;

    // Require active interaction this session (restored state counts after refresh).
    const hasInteracted =
      this.quizStateService.hasUserInteracted(safeIdx) ||
      lastInteractedIdx === safeIdx ||
      safeSelections.length > 0 ||
      isResolved;
    if (!hasInteracted && !isTimedOut) shouldShowExplanation = false;

    const hasPriorAnswer = wasPreviouslyAnswered || isResolved || safeSelections.length > 0;
    if (isNavBack && !hasPriorAnswer) shouldShowExplanation = false;

    shouldShowExplanation = this.applyOisBypass(shouldShowExplanation, safeIdx, qObj, safeSelections, hasInteracted);

    if (!shouldShowExplanation && state?.mode === 'explanation' && safeSelections.length > 0 && hasInteracted) {
      shouldShowExplanation = isResolved;
    }

    shouldShowExplanation = this.applyScoringOverride(shouldShowExplanation, safeIdx, hasInteracted);

    const _socConfirmed =
      this.explanationTextService.fetBypassForQuestion?.get(safeIdx) === true
      || this.quizService._multiAnswerPerfect.get(safeIdx) === true;
    if (_socConfirmed && hasInteracted) shouldShowExplanation = true;

    // Final hard guard: require a real in-session click (immune to sessionStorage contamination).
    const hasClickedThisIdx = this.quizStateService.hasClickedInSession?.(safeIdx) ?? false;
    if (shouldShowExplanation && !isTimedOut && !hasClickedThisIdx && !_socConfirmed) {
      shouldShowExplanation = false;
    }

    shouldShowExplanation = this.applyAbsolutePristineGate(shouldShowExplanation, safeIdx, qObj, safeSelections, isTimedOut, _socConfirmed);

    return this.resolveExplanationOrQuestion(shouldShowExplanation, safeIdx, qObj, fetText, qDisplay);
  }

  /** Build the question-text display (with the multi-answer "N correct" banner). Extracted verbatim. */
  private buildQuestionDisplay(safeIdx: number, qObj: QuizQuestion | null): { qDisplay: string; numCorrect: number } {
    const rawQText = qObj?.questionText || '';
    const serviceQText = (qObj?.questionText ?? '').trim();
    let qDisplay = serviceQText || rawQText || '';
    // Prefer the PRISTINE correct count (live options can be mutated by option-lock-policy / Restart).
    const rawQuestion = this.quizService?.questions?.[safeIdx] as QuizQuestion | undefined;
    const sourceOpts = rawQuestion?.options ?? qObj?.options ?? [];
    let numCorrect = sourceOpts.filter((o: Option) => isOptionCorrect(o)).length;
    try {
      const _pq = this.quizService?.getPristineQuestionByText(rawQuestion?.questionText ?? qObj?.questionText);
      if (_pq) {
        const pc = (_pq.options ?? []).filter((o: any) => isOptionCorrect(o)).length;
        if (pc > 0) numCorrect = pc;
      }
    } catch { /* ignore */ }
    if (numCorrect > 1 && sourceOpts.length) {
      const banner = this.quizQuestionManagerService.getNumberOfCorrectAnswersText(numCorrect, sourceOpts.length);
      qDisplay = withCorrectCountBanner(qDisplay, banner);
    }
    return { qDisplay, numCorrect };
  }

  /**
   * Single-answer resolution: multi-answer NEVER resolves from this pipeline
   * (the selectedOptionsMap is polluted by timer/history writes). Single-answer
   * is cross-checked: the last actively-selected text must be pristine-correct.
   * Extracted verbatim.
   */
  private computeIsResolved(qObj: QuizQuestion | null, safeSelections: any[], isMultipleAnswer: boolean): boolean {
    if (!qObj || isMultipleAnswer) return false;
    let isResolved = this.selectedOptionService.isQuestionResolvedLeniently(qObj, safeSelections);
    if (isResolved) {
      try {
        const pristineCorrectTexts = new Set(
          this.quizService?.getPristineCorrectTextsForQuestion(qObj?.questionText) ?? []
        );
        if (pristineCorrectTexts.size > 0) {
          const activeSelections = safeSelections.filter((s: any) => s?.selected !== false);
          const lastSel = activeSelections.length > 0 ? activeSelections[activeSelections.length - 1] : null;
          const lastSelText = norm(lastSel?.text);
          if (lastSelText && !pristineCorrectTexts.has(lastSelText)) {
            isResolved = false;
          }
        }
      } catch { /* ignore */ }
    }
    return isResolved;
  }

  /** Shuffle-aware live question at an index. */
  private getLiveQuestionForIndex(safeIdx: number): any {
    const qs: any = this.quizService;
    const isShuf = qs?.isShuffleEnabled?.() && Array.isArray(qs?.shuffledQuestions) && qs.shuffledQuestions.length > 0;
    return isShuf ? qs?.shuffledQuestions?.[safeIdx] : qs?.questions?.[safeIdx];
  }

  /** Collect every active-selected option text (from the selections array + live option flags). */
  private collectActiveSelectedTexts(safeSelections: any[], liveQ: any): Set<string> {
    const out = new Set<string>();
    for (const s of safeSelections) {
      if (s?.selected !== true) continue;
      const t = norm(s?.text);
      if (t) out.add(t);
    }
    const liveOpts: any[] = Array.isArray(liveQ?.options) ? liveQ.options : [];
    for (const o of liveOpts) {
      if (o?.selected === true || o?.highlight === true || o?.showIcon === true) {
        const t = norm(o?.text);
        if (t) out.add(t);
      }
    }
    return out;
  }

  /**
   * For a multi-answer question (>=2 pristine correct), is every pristine-correct
   * text currently selected? Returns true when not multi-answer (no gate applies).
   */
  private allMultiCorrectSelected(safeIdx: number, qObj: QuizQuestion | null, safeSelections: any[]): boolean {
    const liveQ = this.getLiveQuestionForIndex(safeIdx);
    const pCorrect = Array.from(
      this.quizService?.getPristineCorrectTextsForQuestion(liveQ?.questionText ?? qObj?.questionText) ?? []
    );
    if (pCorrect.length < 2) return true;
    const selNow = this.collectActiveSelectedTexts(safeSelections, liveQ);
    return pCorrect.every(t => selNow.has(t));
  }

  /** Resolve the effective quizId (quizService, then localStorage lastQuizId / shuffleState keys). */
  private resolveEffectiveQuizId(): string {
    let effectiveQuizId = this.quizService?.quizId || '';
    if (!effectiveQuizId) {
      try { effectiveQuizId = localStorage.getItem('lastQuizId') || ''; } catch {}
    }
    if (!effectiveQuizId) {
      try {
        const shuffleKeys = Object.keys(localStorage).filter((k: string) => k.startsWith('shuffleState:'));
        if (shuffleKeys.length > 0) effectiveQuizId = shuffleKeys[0].replace('shuffleState:', '');
      } catch {}
    }
    return effectiveQuizId;
  }

  /** Is this index scored correct in questionCorrectness (direct, then via the shuffle origIdx)? */
  private isQuestionScoredCorrect(safeIdx: number): boolean {
    const scoringSvc = this.quizService?.scoringService;
    if (!scoringSvc?.questionCorrectness) return false;
    if (scoringSvc.questionCorrectness.get(safeIdx) === true) return true;
    const effectiveQuizId = this.resolveEffectiveQuizId();
    if (effectiveQuizId) {
      const origIdx = scoringSvc.quizShuffleService?.toOriginalIndex?.(effectiveQuizId, safeIdx);
      if (typeof origIdx === 'number' && origIdx >= 0) {
        return scoringSvc.questionCorrectness.get(origIdx) === true;
      }
    }
    return false;
  }

  /** Authoritative "this question is correct" signal: scored-correct OR fetBypass. */
  private isScoredOrFetBypassed(safeIdx: number): boolean {
    if (this.isQuestionScoredCorrect(safeIdx)) return true;
    return this.explanationTextService.fetBypassForQuestion?.get(safeIdx) === true;
  }

  /** OIS bypass: when _multiAnswerPerfect is set, show FET if pristine-validated. */
  private applyOisBypass(shouldShow: boolean, safeIdx: number, qObj: QuizQuestion | null, safeSelections: any[], hasInteracted: boolean): boolean {
    if (shouldShow) return shouldShow;
    if (this.quizService._multiAnswerPerfect.get(safeIdx) === true && hasInteracted) {
      let oisBypassAllowed = true;
      try {
        oisBypassAllowed = this.allMultiCorrectSelected(safeIdx, qObj, safeSelections);
      } catch { /* ignore */ }
      if (oisBypassAllowed) return true;
    }
    return shouldShow;
  }

  /** Scoring-service / fetBypass override (authoritative when shuffled selection flags lag). */
  private applyScoringOverride(shouldShow: boolean, safeIdx: number, hasInteracted: boolean): boolean {
    if (shouldShow || !hasInteracted) return shouldShow;
    try {
      if (this.isScoredOrFetBypassed(safeIdx)) return true;
    } catch { /* ignore */ }
    return shouldShow;
  }

  /**
   * Absolute pristine gate: for an unconfirmed multi-answer that isn't fully
   * selected, block the FET unless scoring/fetBypass says it's correct.
   * Extracted verbatim.
   */
  private applyAbsolutePristineGate(
    shouldShow: boolean, safeIdx: number, qObj: QuizQuestion | null, safeSelections: any[],
    isTimedOut: boolean, socConfirmed: boolean
  ): boolean {
    if (!(shouldShow && !isTimedOut && !socConfirmed)) return shouldShow;
    try {
      if (this.allMultiCorrectSelected(safeIdx, qObj, safeSelections)) return shouldShow;
      let scoringOverrideGate = false;
      try { scoringOverrideGate = this.isScoredOrFetBypassed(safeIdx); } catch { /* ignore */ }
      if (!scoringOverrideGate) return false;
    } catch { /* ignore */ }
    return shouldShow;
  }

  /**
   * Resolve the text to display: when showing FET, return the live/cached/raw/
   * regenerated explanation (empty string preserves the cached DOM FET); else
   * the question display. Extracted verbatim.
   */
  private resolveExplanationOrQuestion(shouldShow: boolean, safeIdx: number, qObj: QuizQuestion | null, fetText: string | null, qDisplay: string): string {
    const finalFet = (fetText ?? '').trim();
    const hasFet = finalFet.length > 0;
    const hasRaw = !!qObj?.explanation;

    const isFetForThisQuestion = hasFet && (
      this.explanationTextService.latestExplanationIndex === safeIdx ||
      (this.explanationTextService.formattedExplanations[safeIdx]?.explanation ?? '').trim() === finalFet ||
      (this.explanationTextService as any).fetByIndex?.get(safeIdx)?.trim() === finalFet ||
      finalFet.toLowerCase().includes('correct because')
    );

    if (!shouldShow) return qDisplay;
    if (isFetForThisQuestion) return finalFet;

    // Caches may hold the formatted FET even when the reactive stream doesn't yet.
    const cachedFet = (this.explanationTextService.formattedExplanations[safeIdx]?.explanation ?? '').trim()
      || ((this.explanationTextService as any).fetByIndex?.get(safeIdx) ?? '').trim();
    if (cachedFet && cachedFet.toLowerCase().includes('correct because')) {
      return cachedFet;
    }
    if (qObj && hasRaw) {
      // Last resort: format the raw explanation on-the-fly with option numbers.
      const correctIndices = this.explanationTextService.getCorrectOptionIndices(qObj, qObj.options, safeIdx);
      if (correctIndices.length > 0) {
        return this.explanationTextService.formatExplanation(qObj, correctIndices, qObj.explanation);
      }
      return qObj.explanation || '';
    }
    // Want FET but no text producible yet: regenerate, else '' so the DOM keeps the cached FET.
    const regenerated = this.regenerateFetForIndex(safeIdx);
    if (regenerated) return regenerated;
    return '';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Should Show FET
  // ═══════════════════════════════════════════════════════════════════════

  setupShouldShowFet(currentIndex$: Observable<number>): void {
    this.shouldShowFet$ = currentIndex$.pipe(
      filter(idx => idx >= 0),
      distinctUntilChanged(),
      switchMap((idx) =>
        combineLatest([
          this.quizService.getQuestionByIndex(idx).pipe(startWith(null)),
          this.selectedOptionService.getSelectedOptionsForQuestion$(idx).pipe(
            startWith([])
          )
        ]).pipe(
          map(([question, selected]: [QuizQuestion | null, any[]]) => {
            const resolved = question
              ? this.selectedOptionService.isQuestionResolvedCorrectly(
                question,
                selected ?? []
              )
              : false;
            return resolved;
          })
        )
      ),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FET To Display
  // ═══════════════════════════════════════════════════════════════════════

  setupFetToDisplay(
    currentIndex$: Observable<number>,
    timedOutIdx$: Observable<number>,
    activeFetText$: Observable<string>,
    currentQuestion$: Observable<QuizQuestion | null>
  ): void {
    const showOnTimeout$ = combineLatest([
      currentIndex$.pipe(startWith(-1)),
      timedOutIdx$.pipe(startWith(-1))
    ]).pipe(
      map(([idx, timedOutIdx]) => idx >= 0 && idx === timedOutIdx),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    this.fetToDisplay$ = combineLatest([
      activeFetText$.pipe(startWith('')),
      this.shouldShowFet$.pipe(startWith(false)),
      showOnTimeout$.pipe(startWith(false)),
      currentQuestion$.pipe(startWith(null))
    ]).pipe(
      map(([fet, resolved, timedOut, question]) => {
        const text = (fet ?? '').trim();

        // Allow display if: Resolved OR TimedOut
        if (resolved || timedOut) {
          if (text.length > 0) return text;
          
          // Fallback if formatted text is missing
          if (question && question.explanation) return question.explanation;
        }
        return '';
      }),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true })
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FET Regeneration
  // ═══════════════════════════════════════════════════════════════════════

  regenerateFetForIndex(idx: number): string {
    try {
      const displayQuestions = this.quizService.getQuestionsInDisplayOrder?.() ?? [];
      const question = displayQuestions[idx] ?? this.quizService.questions?.[idx];
      if (!question || !Array.isArray(question.options) || question.options.length === 0) {
        return '';
      }

      const rawExplanation = (question.explanation ?? '').trim();
      if (!rawExplanation) return '';

      this.explanationTextService.storeFormattedExplanation(
        idx,
        rawExplanation,
        question,
        question.options,
        true
      );

      return this.explanationTextService.fetByIndex?.get(idx)?.trim() || '';
    } catch (e) {
      console.error('QuizContentDisplayService.regenerateFetForIndex FET regeneration failed:', e);
      return '';
    }
  }
}
