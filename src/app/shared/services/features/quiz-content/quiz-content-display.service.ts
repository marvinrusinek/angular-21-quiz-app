import { inject, Injectable, signal } from '@angular/core';
import { combineLatest, Observable } from 'rxjs';
import {
  distinctUntilChanged, filter, map, shareReplay, startWith, switchMap
} from 'rxjs/operators';

import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { QuizService } from '../../data/quiz.service';
import { QuizNavigationService } from '../../flow/quiz-navigation.service';
import { QuizQuestionManagerService } from '../../flow/quizquestionmgr.service';
import { QuizStateService } from '../../state/quizstate.service';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { ExplanationTextService, FETPayload } from '../explanation/explanation-text.service';

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
    const rawQText = qObj?.questionText || '';
    const serviceQText = (qObj?.questionText ?? '').trim();
    const effectiveQText = serviceQText || rawQText || '';

    // Build the base question text display (with multi-answer banner if applicable)
    let qDisplay = effectiveQText;
    // Use PRISTINE quizInitialState as the source of truth for the correct
    // count. Live quizService.questions[] can be mutated by option-lock-policy.
    const rawQuestion = (this.quizService as any)?.questions?.[safeIdx] as QuizQuestion | undefined;
    const sourceOpts = rawQuestion?.options ?? qObj?.options ?? [];
    let numCorrect = sourceOpts.filter((o: Option) => o?.correct === true).length;
    // Cross-check against pristine data — always prefer pristine count.
    // After Restart Quiz, live options can have ALL correct flags set to
    // true (stale mutation), inflating numCorrect. Pristine is immutable.
    try {
      const _n = (t: any) => String(t ?? '').trim().toLowerCase();
      const _qText = _n(rawQuestion?.questionText ?? qObj?.questionText);
      const _bundle: any[] = (this.quizService as any)?.quizInitialState ?? [];
      for (const _quiz of _bundle) {
        for (const _pq of (_quiz?.questions ?? [])) {
          if (_n(_pq?.questionText) === _qText) {
            const pc = (_pq?.options ?? []).filter(
              (o: any) => o?.correct === true || String(o?.correct) === 'true'
            ).length;
            if (pc > 0) numCorrect = pc;
            break;
          }
        }
      }
    } catch { /* ignore */ }
    if (numCorrect > 1 && sourceOpts.length) {
      const banner = this.quizQuestionManagerService.getNumberOfCorrectAnswersText(
        numCorrect,
        sourceOpts.length
      );
      qDisplay = `${qDisplay} <span class="correct-count">${banner}</span>`;
    }

    // AUTHORITATIVE RESOLUTION FOR THIS INDEX
    const safeSelections = Array.isArray(selections) ? selections : [];
    const isMultipleAnswer = numCorrect > 1;

    // Multi-answer resolution uses RAW source options so mutated qObj.options
    // with reduced correct flags can't make a 1-of-2 correct pick resolve true.
    let isResolved = false;
    if (qObj) {
      if (isMultipleAnswer) {
        // Multi-answer: NEVER resolve from this pipeline. The
        // selectedOptionsMap is polluted (timer expiry / history writes
        // mark all options as selected:true). FET for multi-answer
        // questions must ONLY be triggered by the explicit click handler
        // that verifies all correct answers at the moment of the click.
        isResolved = false;
      } else {
        isResolved = this.selectedOptionService.isQuestionResolvedLeniently(qObj, safeSelections);

        // PRISTINE SINGLE-ANSWER GATE: getSelectedOptionsForQuestion can
        // return polluted data (e.g. ID collisions add the correct option
        // even though the user never clicked it). Cross-check: the LAST
        // actively-selected entry's text must match a pristine correct
        // option. If not, the "correct" hit was pollution.
        if (isResolved) {
          try {
            const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
            const qTextLookup = nrm(qObj?.questionText);
            const bundle: any[] = (this.quizService as any)?.quizInitialState ?? [];
            let pristineCorrectTexts = new Set<string>();
            for (const quiz of bundle) {
              for (const pq of (quiz?.questions ?? [])) {
                if (nrm(pq?.questionText) !== qTextLookup) continue;
                for (const o of (pq?.options ?? [])) {
                  if (o?.correct === true || String(o?.correct) === 'true') {
                    const t = nrm(o?.text);
                    if (t) pristineCorrectTexts.add(t);
                  }
                }
                break;
              }
              if (pristineCorrectTexts.size > 0) break;
            }
            if (pristineCorrectTexts.size > 0) {
              // Find the last actively-selected entry (most recent click)
              const activeSelections = safeSelections.filter(
                (s: any) => s?.selected !== false
              );
              const lastSel = activeSelections.length > 0
                ? activeSelections[activeSelections.length - 1]
                : null;
              const lastSelText = nrm(lastSel?.text);
              if (lastSelText && !pristineCorrectTexts.has(lastSelText)) {
                isResolved = false;
              }
            }
          } catch { /* ignore */ }
        }
      }
    }

    // Was this question answered in a prior session (e.g. before a page
    // refresh)? The answered set is persisted to sessionStorage and
    // restored in QuizStateService's constructor, so this survives F5.
    // NOTE: This flag alone is NOT sufficient to show the FET — a
    // single-answer wrong click also marks a question "answered", but the
    // FET must only appear when ALL correct answers have been selected.
    // We keep it around for the nav-back hasPriorAnswer check below.
    const wasPreviouslyAnswered = this.quizStateService.isQuestionAnswered(safeIdx);

    // Allow FET only if the question is actually resolved (all correct
    // answers selected) OR the timer expired for a SINGLE-answer question.
    // For multi-answer questions, FET requires ALL correct selected even
    // on timeout — the user must select all correct to see the explanation.
    let shouldShowExplanation: boolean;
    if (isMultipleAnswer) {
      shouldShowExplanation = isResolved || isTimedOut;
    } else {
      shouldShowExplanation = isResolved || isTimedOut;
    }

    // CRITICAL GUARD: Only show FET if user has actively interacted with
    // this question in the current session. On a page refresh the in-memory
    // interaction set is empty, so we also accept the presence of restored
    // selections (safeSelections) OR a resolved state as proof of prior
    // interaction — both are persisted via sel_Q*/selectedOptionsMap.
    const hasInteracted =
      this.quizStateService.hasUserInteracted(safeIdx) ||
      lastInteractedIdx === safeIdx ||
      safeSelections.length > 0 ||
      isResolved;
    if (!hasInteracted && !isTimedOut) shouldShowExplanation = false;

    // When navigating backwards (Previous button), show question text
    // UNLESS the question was previously answered / resolved — in that
    // case we want the FET to persist so the user sees their prior result.
    const hasPriorAnswer = wasPreviouslyAnswered || isResolved || safeSelections.length > 0;
    if (isNavBack && !hasPriorAnswer) shouldShowExplanation = false;

    // DIRECT OIS BYPASS: If OIS has already confirmed all correct answers
    // are selected, trust it — but validate against pristine data first
    // to prevent false positives from mutated bindings.
    if (!shouldShowExplanation) {
      const perfectMap = (this.quizService as any)?._multiAnswerPerfect as Map<number, boolean> | undefined;
      if (perfectMap?.get(safeIdx) === true && hasInteracted) {
        // Validate: for multi-answer questions, confirm all correct are truly selected
        let oisBypassAllowed = true;
        try {
          const nrm2 = (t: any) => String(t ?? '').trim().toLowerCase();
          const bundle2: any[] = (this.quizService as any)?.quizInitialState ?? [];
          const qs2: any = this.quizService;
          const isShuf2 = qs2?.isShuffleEnabled?.() && Array.isArray(qs2?.shuffledQuestions) && qs2.shuffledQuestions.length > 0;
          const liveQ2: any = isShuf2 ? qs2?.shuffledQuestions?.[safeIdx] : qs2?.questions?.[safeIdx];
          const qText2 = nrm2(liveQ2?.questionText ?? qObj?.questionText ?? '');
          let pCorrect: string[] = [];
          for (const quiz of bundle2) {
            for (const pq of (quiz?.questions ?? [])) {
              if (nrm2(pq?.questionText) !== qText2) continue;
              pCorrect = (pq?.options ?? [])
                .filter((o: any) => o?.correct === true || String(o?.correct) === 'true')
                .map((o: any) => nrm2(o?.text)).filter((t: string) => !!t);
              break;
            }
            if (pCorrect.length > 0) break;
          }
          if (pCorrect.length >= 2) {
            const selNow2 = new Set<string>();
            for (const s of safeSelections) {
              if (s?.selected !== true) continue;
              const t = nrm2(s?.text);
              if (t) selNow2.add(t);
            }
            const liveOpts2: any[] = Array.isArray(liveQ2?.options) ? liveQ2.options : [];
            for (const o of liveOpts2) {
              if (o?.selected === true || o?.highlight === true || o?.showIcon === true) {
                const t = nrm2(o?.text);
                if (t) selNow2.add(t);
              }
            }
            if (!pCorrect.every(t => selNow2.has(t))) {
              oisBypassAllowed = false;
              perfectMap?.delete?.(safeIdx);
            }
          }
        } catch { /* ignore */ }
        if (oisBypassAllowed) {
          shouldShowExplanation = true;
        }
      }
    }

    if (!shouldShowExplanation && state?.mode === 'explanation' && safeSelections.length > 0 && hasInteracted) {
      // Only show FET when the question is actually resolved (correct answer selected).
      shouldShowExplanation = isResolved;
    }

    // SCORING SERVICE OVERRIDE: if questionCorrectness says this question
    // is correctly answered, trust it — it's set by scoreDirectly() which
    // is called by SharedOptionClickService when all correct options are
    // confirmed selected. This bypasses the selection text matching that
    // fails in shuffled mode because option flags on quizService.questions
    // don't reflect the SharedOptionComponent's binding state.
    if (!shouldShowExplanation && hasInteracted) {
      try {
        const scoringSvc = (this.quizService as any)?.scoringService;
        if (scoringSvc?.questionCorrectness) {
          let scored = scoringSvc.questionCorrectness.get(safeIdx) === true;
          if (!scored) {
            // Full quizId resolution chain (mirrors incrementScore)
            let effectiveQuizId = (this.quizService as any)?.quizId || '';
            if (!effectiveQuizId) {
              try { effectiveQuizId = localStorage.getItem('lastQuizId') || ''; } catch {}
            }
            if (!effectiveQuizId) {
              try {
                const shuffleKeys = 
                  Object.keys(localStorage).filter((k: string) => k.startsWith('shuffleState:'));
                if (shuffleKeys.length > 0) {
                  effectiveQuizId = shuffleKeys[0].replace('shuffleState:', '');
                }
              } catch {}
            }
            if (effectiveQuizId) {
              const origIdx = scoringSvc.quizShuffleService?.toOriginalIndex?.(effectiveQuizId, safeIdx);
              if (typeof origIdx === 'number' && origIdx >= 0) {
                scored = scoringSvc.questionCorrectness.get(origIdx) === true;
              }
            }
          }
          if (scored) shouldShowExplanation = true;
        }
        // Also check fetBypassForQuestion — set by SOC before scoring
        if (!shouldShowExplanation) {
          if (this.explanationTextService.fetBypassForQuestion?.get(safeIdx) === true) {
            shouldShowExplanation = true;
          }
        }
      } catch { /* ignore */ }
    }

    // FINAL HARD GUARD: authoritative check via hasClickedInSession.
    // This Set only grows on real user clicks or refresh-of-answered, so it's
    // immune to sessionStorage contamination affecting other flags. If the user
    // hasn't clicked this idx in this session and it wasn't just timed out, 
    // force question text.
    const hasClickedThisIdx = this.quizStateService.hasClickedInSession?.(safeIdx) ?? false;
    if (shouldShowExplanation && !isTimedOut && !hasClickedThisIdx) {
      shouldShowExplanation = false;
    }

    // ABSOLUTE PRISTINE GATE: re-validate multi-answer resolution
    // directly against pristine quizInitialState regardless of which
    // upstream flag flipped shouldShowExplanation to true. This closes
    // every path that can set the flag erroneously (isResolved,
    // _multiAnswerPerfect, explanation-mode override, etc.).
    if (shouldShowExplanation && !isTimedOut) {
      try {
        const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
        const qs: any = this.quizService;
        const isShuffled = qs?.isShuffleEnabled?.()
          && Array.isArray(qs?.shuffledQuestions)
          && qs.shuffledQuestions.length > 0;
        const liveQForGate: any = isShuffled
          ? qs?.shuffledQuestions?.[safeIdx]
          : qs?.questions?.[safeIdx];
        const qText = nrm(liveQForGate?.questionText ?? qObj?.questionText ?? '');
        let pristineCorrect: string[] = [];
        const bundle: any[] = qs?.quizInitialState ?? [];
        for (const quiz of bundle) {
          for (const pq of quiz?.questions ?? []) {
            if (nrm(pq?.questionText) !== qText) continue;
            pristineCorrect = (pq?.options ?? [])
              .filter((o: any) => o?.correct === true || String(o?.correct) === 'true')
              .map((o: any) => nrm(o?.text))
              .filter((t: string) => !!t);
            break;
          }
          if (pristineCorrect.length > 0) break;
        }
        if (pristineCorrect.length >= 2) {
          const selectedNow = new Set<string>();
          // Active selections only
          for (const s of safeSelections) {
            if (s?.selected !== true) continue;
            const t = nrm(s?.text);
            if (t) selectedNow.add(t);
          }
          // Live question options
          const liveOpts: any[] = Array.isArray(liveQForGate?.options)
            ? liveQForGate.options : [];
          for (const o of liveOpts) {
            const isSel = o?.selected === true
              || o?.highlight === true
              || o?.showIcon === true;
            if (!isSel) continue;
            const t = nrm(o?.text);
            if (t) selectedNow.add(t);
          }
          const allSel = pristineCorrect.every(t => selectedNow.has(t));
          if (!allSel) {
            // Before blocking, check questionCorrectness — the most
            // authoritative signal for whether the question is correctly
            // answered. scoreDirectly() sets it and handles shuffle key
            // conversion internally.
            let scoringOverrideGate = false;
            try {
              const scoringSvc4 = (this.quizService as any)?.scoringService;
              if (scoringSvc4?.questionCorrectness) {
                scoringOverrideGate = scoringSvc4.questionCorrectness.get(safeIdx) === true;
                if (!scoringOverrideGate) {
                  // Full quizId resolution chain
                  let eqId4 = (this.quizService as any)?.quizId || '';
                  if (!eqId4) {
                    try { eqId4 = localStorage.getItem('lastQuizId') || ''; } catch {}
                  }
                  if (!eqId4) {
                    try {
                      const sk4 = Object.keys(localStorage).filter((k: string) => k.startsWith('shuffleState:'));
                      if (sk4.length > 0) eqId4 = sk4[0].replace('shuffleState:', '');
                    } catch {}
                  }
                  if (eqId4) {
                    const origIdx4 = scoringSvc4.quizShuffleService?.toOriginalIndex?.(eqId4, safeIdx);
                    if (typeof origIdx4 === 'number' && origIdx4 >= 0) {
                      scoringOverrideGate = scoringSvc4.questionCorrectness.get(origIdx4) === true;
                    }
                  }
                }
              }
              // Also check fetBypassForQuestion
              if (!scoringOverrideGate) {
                scoringOverrideGate =
                  this.explanationTextService.fetBypassForQuestion?.get(safeIdx) === true;
              }
            } catch { /* ignore */ }
            if (!scoringOverrideGate) {
              shouldShowExplanation = false;
              // Also clear any falsely-set perfect flag so downstream
              // OIS-bypass can't re-trigger on the next emission.
              (this.quizService as any)?._multiAnswerPerfect?.delete?.(safeIdx);
            }
          }
        }
      } catch { /* ignore */ }
    }

    const finalFet = (fetText ?? '').trim();
    const hasFet = finalFet.length > 0;
    const hasRaw = !!qObj?.explanation;

    const isFetForThisQuestion = hasFet && (
      this.explanationTextService.latestExplanationIndex === safeIdx ||
      (this.explanationTextService.formattedExplanations[safeIdx]?.explanation ?? '').trim() === finalFet ||
      (this.explanationTextService as any).fetByIndex?.get(safeIdx)?.trim() === finalFet ||
      finalFet.toLowerCase().includes('correct because')
    );


    if (shouldShowExplanation) {
      if (isFetForThisQuestion) {
        return finalFet;
      }
      // Before falling back to raw explanation, check formatted caches directly.
      // The reactive stream (fetText) may not have the formatted text yet due to
      // timing (e.g. resetExplanationState cleared _byIndex subjects), but the
      // formattedExplanations cache or fetByIndex may still have it.
      const cachedFet = (this.explanationTextService.formattedExplanations[safeIdx]?.explanation ?? '').trim()
        || ((this.explanationTextService as any).fetByIndex?.get(safeIdx) ?? '').trim();
      if (cachedFet && cachedFet.toLowerCase().includes('correct because')) {
        return cachedFet;
      }
      if (hasRaw) {
        // Last resort: format the raw explanation on-the-fly with option #s
        const correctIndices = this.explanationTextService.getCorrectOptionIndices(
          qObj, qObj.options, safeIdx
        );
        if (correctIndices.length > 0) {
          const formatted = this.explanationTextService.formatExplanation(
            qObj, correctIndices, qObj.explanation
          );
          return formatted;
        }
        return qObj.explanation || '';
      }
      // We WANT to show FET but no text is producible in this emission
      // (caches not yet populated after refresh). Try regenerating from
      // scratch using the raw question data so we don't have to fall back
      // to question text — that would cause the visible FET to flicker
      // back to the question on every stray emission.
      const regenerated = this.regenerateFetForIndex(safeIdx);
      if (regenerated) return regenerated;
      
      // Last resort: return empty string so the subscribeToDisplayText
      // guard preserves the previously cached FET in the DOM rather than
      // overwriting it with question text.
      return '';
    }

    return qDisplay;
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
    } catch {
      return '';
    }
  }
}
