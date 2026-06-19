import { inject, Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { CqcFetGuardService } from './cqc-fet-guard.service';

import type { CodelabQuizContentComponent } from '../../../../containers/quiz/quiz-content/codelab-quiz-content.component';
import { isOptionCorrect } from '../../../utils/is-option-correct';
import { norm } from '../../../utils/text-norm';

type Host = CodelabQuizContentComponent;

/** Flags derivable before the fast-path short-circuit (no interaction lookups). */
interface EarlyDisplayFlags {
  currentIdx: number;
  lowerText: string;
  isQuestionText: boolean;
  isTimedOutForIdx: boolean;
  latestExpIdx: number;
  fetBypass: boolean;
}

/** Full derived context for one displayText emission, threaded across the gate phases. */
interface DisplayTextCtx extends EarlyDisplayFlags {
  hasRealInteraction: boolean;
  isResolvedForGuard: boolean;
  qForMultiCheck: any;
  multiAnswerBlocked: boolean;
  fetBypassActive: boolean;
  fetConfirmed: boolean;
}

/**
 * Manages the displayText$ subscription for CodelabQuizContentComponent.
 * Extracted from CqcOrchestratorService.
 *
 * Responsible for:
 * - runSubscribeToDisplayText: the central pipeline subscription that decides
 *   what text (question or FET) to write into the qText DOM element
 */
@Injectable({ providedIn: 'root' })
export class CqcDisplayTextService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly fetGuard = inject(CqcFetGuardService);

  runSubscribeToDisplayText(host: Host): void {
    host.combinedText$ = host.displayText$;

    if (host.combinedSub) host.combinedSub.unsubscribe();

    host.combinedSub = host.combinedText$
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe({
        next: (text: string) => this.handleDisplayText(host, text),
        error: () => { }
      });
  }

  /**
   * Decide what text (question or FET) to write into qText for one pipeline
   * emission: derive the context flags, run the fast-path FET writes, apply
   * explanation substitution, then run the DOM-write guards. Extracted verbatim.
   */
  private handleDisplayText(host: Host, text: string): void {
    const early = this.computeEarlyFlags(host, text);

    // REVISIT GUARD: the FET belongs to the CURRENT view only — it shows right
    // after the user answers (a live selection exists for this index) or when
    // the timer has just expired (transient timedOutIdxSubject === idx). On ANY
    // revisit, selections are cleared on navigation and the transient timeout is
    // reset, so show the question text (+ "N correct answers" banner for
    // multi-answer) instead of the FET — overriding the durable FET-forcing
    // fast-paths below.
    if (this.shouldForceQuestionOnRevisit(host, early)) {
      const qText = this.fetGuard.buildQuestionDisplayHTML(host, early.currentIdx);
      if (qText) {
        this.fetGuard.writeQText(host, qText);
        return;
      }
    }

    // DURABLE TIMEOUT FAST-PATH: a question whose timer expired shows its FET on
    // (re)display, even on revisit — timedOutIdxSubject is transient (reset on
    // nav), so the question-forcing guards below would otherwise restore the
    // question. Stamp the cached/computed FET directly so it survives
    // navigate-away/back, for single- and multi-answer alike.
    if (this.tryDurableTimeoutFet(host, early.currentIdx, early.lowerText)) {
      return;
    }

    // FAST-PATH FET writes (SOC-confirmed or timer-expiry) skip all gates.
    if (this.tryFastPathWrites(host, text, early.currentIdx, early.isQuestionText, early.lowerText, early.isTimedOutForIdx, early.fetBypass)) {
      return;
    }

    const ctx = this.buildDisplayTextContext(host, early);
    const finalText = this.applyExplanationSubstitution(host, text, ctx);

    const el = host.qText?.()?.nativeElement;
    if (!el) return;
    this.writeWithDomGuards(host, el, finalText, ctx);
  }

  /**
   * REVISIT detection: true when the FET should be suppressed in favor of the
   * question text. The FET shows only on the current view — right after the user
   * answers (a genuine click flips questionFresh to false) or when the timer has
   * just expired (transient flag, reset on navigation). On any navigation the
   * per-question reset sets questionFresh back to true, and rehydration of a
   * prior answer's selections does NOT touch it — so questionFresh stays true on
   * revisit until the user actively clicks again, which is exactly when the
   * heading should show the question text rather than the FET. (Live selections
   * can't be used here: they're rehydrated on revisit to show the prior answer.)
   */
  private shouldForceQuestionOnRevisit(host: Host, early: EarlyDisplayFlags): boolean {
    if (early.currentIdx < 0) return false;
    if (early.isTimedOutForIdx) return false;
    // A question the user has actually answered in-session shows its FET — the
    // revisit suppression must never hide the FET on the live answer view. This
    // is index-specific and durable (clicks, SOC-confirm, timer-expiry). Without
    // it, when quizQuestionComponent() is undefined (the CQC template has no
    // QuizQuestionComponent child) questionFresh defaults true and the FET is
    // forced back to question text for Q2+ even right after a correct click —
    // the "FET only shows on Q1" regression.
    if (this.fetGuard.hasInteractionEvidence(host, early.currentIdx)) return false;
    const fresh = host.quizQuestionComponent?.()?.questionFresh?.() ?? true;
    return fresh === true;
  }

  /**
   * Compute the flags needed before the fast-path short-circuit: the live index
   * (read from the input signal, which is sync-correct unlike host.currentIndex),
   * whether the text is question text, timer-expiry, and the FET bypass.
   * Extracted verbatim.
   */
  private computeEarlyFlags(host: Host, text: string): EarlyDisplayFlags {
    const lowerText = (text ?? '').toLowerCase();
    // Read currentIdx from the input signal — host.currentIndex is a plain
    // field updated asynchronously by an effect, so it lags questionIndex() by
    // a microtask. Without this, after timer expiry on Q(N), a Next click to
    // Q(N+1) hits the FAST-PATH branches with stale currentIdx === N. (FET flash)
    const liveIdx = host.questionIndex?.() ?? host.currentIndex ?? 0;
    const currentQ = host.quizService.getQuestionsInDisplayOrder()?.[liveIdx];
    const qTextRaw = (currentQ?.questionText ?? '').trim();
    const isQuestionText = qTextRaw.length > 0 && (text ?? '').trim().startsWith(qTextRaw);
    const currentIdx = liveIdx;
    const isTimedOutForIdx = host.timedOutIdxSubject?.getValue?.() === currentIdx && currentIdx >= 0;
    const latestExpIdx = host.explanationTextService?.latestExplanationIndex ?? -1;
    const fetBypass = this.computeFetBypass(host, currentIdx, text, latestExpIdx);
    return { currentIdx, lowerText, isQuestionText, isTimedOutForIdx, latestExpIdx, fetBypass };
  }

  /**
   * Compute the post-fast-path context: interaction/resolution evidence, the
   * multi-answer block, auto-reveal bypass, and FET-confirmed — merged onto the
   * early flags. Extracted verbatim.
   */
  private buildDisplayTextContext(host: Host, early: EarlyDisplayFlags): DisplayTextCtx {
    const { currentIdx, isTimedOutForIdx, latestExpIdx, lowerText } = early;
    const hasRealInteraction = this.fetGuard.hasInteractionEvidence(host, currentIdx);
    const isResolvedForGuard = hasRealInteraction
      ? this.fetGuard.isQuestionResolvedFromStorage(host, currentIdx)
      : false;

    const qForMultiCheck = host.quizService.getQuestionsInDisplayOrder()?.[currentIdx]
      ?? host.quizService.questions?.[currentIdx];
    const isMultiAnswer = this.computeIsMultiAnswer(host, qForMultiCheck);
    // AUTO-REVEAL BYPASS: soc-answer-processing's auto-reveal sets
    // fetBypassForQuestion, which must allow multi-answer FET writes.
    const fetBypassActive =
      host.explanationTextService?.fetBypassForQuestion?.get(currentIdx) === true;
    const multiAnswerBlocked = isMultiAnswer && hasRealInteraction && !isResolvedForGuard && !isTimedOutForIdx && !fetBypassActive;
    const fetConfirmed = this.computeFetConfirmed(host, currentIdx, latestExpIdx, lowerText);

    return {
      ...early,
      hasRealInteraction, isResolvedForGuard, qForMultiCheck,
      multiAnswerBlocked, fetBypassActive, fetConfirmed
    };
  }

  /**
   * Run the two fast-path FET writes: SOC-confirmed FET (incoming FET + bypass),
   * and timer-expiry FET (timed out + non-question content). Returns true when a
   * write happened. Extracted verbatim.
   */
  private tryFastPathWrites(host: Host, text: string, currentIdx: number, isQuestionText: boolean, lowerText: string, isTimedOutForIdx: boolean, fetBypass: boolean): boolean {
    if (!isQuestionText && lowerText.includes('correct because') && fetBypass) {
      this.stampFastPathFet(host, text, currentIdx);
      return true;
    }
    if (isTimedOutForIdx && !isQuestionText && (text ?? '').trim().length > 0) {
      this.stampFastPathFet(host, text, currentIdx);
      return true;
    }
    return false;
  }

  /** Write text directly into qText and lock the FET for this index. */
  private stampFastPathFet(host: Host, text: string, currentIdx: number): void {
    host.qTextHtmlSig?.set(text);
    host._lastDisplayedText = text;
    host._fetLockedForIndex = currentIdx;
  }

  /**
   * DURABLE TIMEOUT: when the active question's timer expired (durable flag,
   * survives navigation) and the incoming text isn't already a FET, stamp the
   * cached/freshly-formatted FET directly and lock it — so a timed-out question
   * keeps its explanation across navigate-away/back. No-op for non-timed-out
   * questions. Returns true when handled. Single- and multi-answer alike.
   */
  private tryDurableTimeoutFet(host: Host, currentIdx: number, lowerText: string): boolean {
    if (currentIdx < 0 || !this.fetGuard.isDurablyTimedOut(currentIdx)) return false;
    if (lowerText.includes('correct because')) return false;  // already a FET — let normal flow run
    const fet = this.resolveTimeoutFet(host, currentIdx);
    if (!fet || !fet.toLowerCase().includes('correct because')) return false;
    this.stampFastPathFet(host, fet, currentIdx);
    return true;
  }

  /**
   * Resolve a timed-out question's FET: the cached explanation (stored at expiry
   * via storeFormattedExplanation), else format it fresh from the question's
   * correct indices. Mirrors the cached-then-compute idiom in
   * applyExplanationSubstitution.
   */
  private resolveTimeoutFet(host: Host, idx: number): string {
    const cached = (host.explanationTextService.formattedExplanations?.[idx]?.explanation ?? '').trim()
      || (host.explanationTextService.fetByIndex?.get(idx) ?? '').trim();
    if (cached) return cached;
    try {
      const q = host.quizService.getQuestionsInDisplayOrder()?.[idx];
      if (q?.options?.length > 0 && q.explanation) {
        const correctIndices = host.explanationTextService.getCorrectOptionIndices(q, q.options, idx);
        if (correctIndices.length > 0) {
          return host.explanationTextService.formatExplanation(q, correctIndices, q.explanation);
        }
      }
    } catch { /* ignore */ }
    return '';
  }

  /**
   * FAST-PATH FET BYPASS predicate: accept incoming FET when SOC has confirmed
   * the question correct (fetBypassForQuestion / _multiAnswerPerfect, at
   * currentIdx or latestExpIdx), or as a race fallback when the incoming text
   * matches the cached FET AND a correct option is selected (the required-AND
   * prevents a timer-expiry leak). Extracted verbatim.
   */
  private computeFetBypass(host: Host, currentIdx: number, text: string, latestExpIdx: number): boolean {
    const _cachedFetForCurr = (
      host.explanationTextService?.formattedExplanations?.[currentIdx]?.explanation
      ?? host.explanationTextService?.fetByIndex?.get?.(currentIdx)
      ?? ''
    ).toString().trim();
    const _incomingMatchesCachedFet =
      !!_cachedFetForCurr && (text ?? '').trim() === _cachedFetForCurr;
    // The cached-FET race fallback must require ALL correct options selected, not
    // just one — otherwise a multi-answer question shows its all-correct FET on
    // the FIRST correct click. For single-answer the one correct option IS all of
    // them, so behavior is unchanged. The durable bypass/perfect flags above stay
    // the authoritative resolved-signal once the SOC confirms.
    const _allCorrectSelected = this.allCorrectOptionsSelected(host, currentIdx);
    const _latestExpMatchesCurr = latestExpIdx === currentIdx;
    return host.explanationTextService?.fetBypassForQuestion?.get(currentIdx) === true
      || host.quizService?._multiAnswerPerfect?.get(currentIdx) === true
      || (_latestExpMatchesCurr && (
          host.explanationTextService?.fetBypassForQuestion?.get(latestExpIdx) === true
          || host.quizService?._multiAnswerPerfect?.get(latestExpIdx) === true
      ))
      || (_incomingMatchesCachedFet && _allCorrectSelected);
  }

  /**
   * Whether EVERY pristine-correct option for the displayed question is currently
   * selected. Multi-answer needs all; single-answer needs its one. Falls back to
   * "any correct selected" only when pristine correct texts are unavailable, so a
   * missing pristine lookup never hard-blocks a legitimate single-answer FET.
   */
  private allCorrectOptionsSelected(host: Host, currentIdx: number): boolean {
    try {
      const selOpts = host.selectedOptionService?.getSelectedOptionsForQuestion?.(currentIdx) ?? [];
      const sel = Array.isArray(selOpts) ? selOpts : [];
      const selectedCorrect = new Set(
        sel
          .filter((s: any) => isOptionCorrect(s) && s?.selected !== false)
          .map((s: any) => norm(s?.text))
          .filter((t: string) => !!t)
      );
      const anyCorrectSelected = selectedCorrect.size > 0;

      const q = host.quizService?.getDisplayedQuestion?.(currentIdx)
        ?? host.quizService?.questions?.[currentIdx];
      const pristineCorrect = Array.from(
        host.quizService?.getPristineCorrectTextsForQuestion?.(q?.questionText) ?? []
      ) as string[];

      if (pristineCorrect.length > 1) {
        return pristineCorrect.every((t) => selectedCorrect.has(t));
      }
      return anyCorrectSelected;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the effective multi-answer flag for the question: the higher of the
   * live correct-option count and the pristine count. Extracted verbatim.
   */
  private computeIsMultiAnswer(host: Host, qForMultiCheck: any): boolean {
    let multiCorrectCount = (qForMultiCheck?.options ?? []).filter(
      (o: any) => isOptionCorrect(o)
    ).length;
    try {
      const _pq = host.quizService?.getPristineQuestionByText(qForMultiCheck?.questionText);
      if (_pq) {
        const pristineCount = (_pq.options ?? []).filter(
          (o: any) => isOptionCorrect(o)
        ).length;
        if (pristineCount > multiCorrectCount) {
          multiCorrectCount = pristineCount;
        }
      }
    } catch { /* ignore */ }
    return multiCorrectCount > 1;
  }

  /**
   * Whether the incoming FET is SOC-confirmed (used by the question-first and
   * FET-block guards): incoming-is-FET AND confirmed at currentIdx or
   * latestExpIdx. Extracted verbatim.
   */
  private computeFetConfirmed(host: Host, currentIdx: number, latestExpIdx: number, lowerText: string): boolean {
    const _incomingIsFet = lowerText.includes('correct because');
    return _incomingIsFet && (
      host.explanationTextService?.fetBypassForQuestion?.get(currentIdx) === true
      || host.quizService?._multiAnswerPerfect?.get(currentIdx) === true
      || (latestExpIdx >= 0 && (
          host.explanationTextService?.fetBypassForQuestion?.get(latestExpIdx) === true
          || host.quizService?._multiAnswerPerfect?.get(latestExpIdx) === true
      ))
    );
  }

  /**
   * EXPLANATION SUBSTITUTION: when the emission is a genuine (non-FET, non-
   * question) explanation for this index with interaction/timeout evidence,
   * substitute the cached or freshly-formatted FET. Extracted verbatim.
   */
  private applyExplanationSubstitution(host: Host, finalText: string, ctx: DisplayTextCtx): string {
    // On in-app revisit, latestExplanationIndex can still point at a DIFFERENT
    // index (e.g. after another question timed out) when this question's raw
    // explanation emits — a timing race that skips FET substitution and lets the
    // raw explanation through (the tab-return path already resolves it). Accept
    // either the live-index match OR an existing cached FET for THIS index; both
    // are keyed to currentIdx, so there's no cross-question leak.
    const cachedFetForCurr = (
      (host.explanationTextService.formattedExplanations[ctx.currentIdx]?.explanation ?? '').trim()
      || (host.explanationTextService.fetByIndex?.get(ctx.currentIdx) ?? '').trim()
    );
    const hasCachedFetForCurr = !!cachedFetForCurr
      && cachedFetForCurr.toLowerCase().includes('correct because');
    const latestIdx = host.explanationTextService.latestExplanationIndex ?? -1;
    const explanationForThisIdx =
      (latestIdx === ctx.currentIdx && latestIdx >= 0) || hasCachedFetForCurr;

    const isExplanation = ctx.lowerText.length > 0
      && !ctx.isQuestionText
      && !ctx.lowerText.includes('correct because')
      && explanationForThisIdx
      && (ctx.hasRealInteraction || ctx.isTimedOutForIdx)
      && !ctx.multiAnswerBlocked;
    if (isExplanation) {
      const idx = ctx.currentIdx;
      const cached = (host.explanationTextService.formattedExplanations[idx]?.explanation ?? '').trim()
        || (host.explanationTextService.fetByIndex?.get(idx) ?? '').trim();
      if (cached && cached.toLowerCase().includes('correct because')) {
        finalText = cached;
      } else {
        try {
          const questions = host.quizService.getQuestionsInDisplayOrder();
          const q = questions?.[idx];
          if (q?.options?.length > 0 && q.explanation) {
            const correctIndices = host.explanationTextService.getCorrectOptionIndices(q, q.options, idx);
            if (correctIndices.length > 0) {
              finalText = host.explanationTextService.formatExplanation(q, correctIndices, q.explanation);
            }
          }
        } catch { /* ignore */ }
      }
    }
    return finalText;
  }

  /**
   * Run the ordered DOM-write guards for a non-fast-path emission: empty-incoming
   * handling, question-first guard, FET-over-question guard, FET lock, the
   * multi/single FET block, then banner preservation and the final write.
   * Extracted verbatim.
   */
  private writeWithDomGuards(host: Host, el: any, finalText: string, ctx: DisplayTextCtx): void {
    const incoming = (finalText ?? '').trim();
    const cached = (host._lastDisplayedText ?? '').trim();
    if (!incoming) {
      this.handleEmptyIncoming(host, ctx, cached);
      return;
    }

    if (this.tryQuestionFirstGuard(host, ctx, incoming)) return;
    if (this.tryFetOverQuestionGuard(host, el, ctx)) return;

    // FET LOCK
    if (host._fetLockedForIndex === ctx.currentIdx &&
      ctx.isQuestionText &&
      !ctx.multiAnswerBlocked
    ) return;

    if (this.tryMultiSingleFetBlock(host, ctx, finalText)) return;

    // BANNER PRESERVATION
    if (ctx.isQuestionText) {
      const enriched = this.fetGuard.buildQuestionDisplayHTML(host, ctx.currentIdx);
      if (enriched) finalText = enriched;
    }

    this.fetGuard.writeQText(host, finalText);
  }

  /**
   * Empty-incoming handling: honor the FET lock, else re-write the last cached
   * text, else rebuild the question display. Extracted verbatim.
   */
  private handleEmptyIncoming(host: Host, ctx: DisplayTextCtx, cached: string): void {
    if (host._fetLockedForIndex === ctx.currentIdx && !ctx.multiAnswerBlocked) {
      return;
    }
    if (cached) {
      this.fetGuard.writeQText(host, cached);
      return;
    }
    try {
      const rebuilt = this.fetGuard.buildQuestionDisplayHTML(host, ctx.currentIdx);
      if (rebuilt) {
        this.fetGuard.writeQText(host, rebuilt);
        return;
      }
    } catch { /* ignore */ }
  }

  /**
   * UNIVERSAL QUESTION-FIRST GUARD: with no interaction/timeout/FET-confirmed
   * evidence, force the question display text unless the incoming already
   * starts with the raw question text. Returns true when handled. Extracted verbatim.
   */
  private tryQuestionFirstGuard(host: Host, ctx: DisplayTextCtx, incoming: string): boolean {
    if (!ctx.hasRealInteraction && !ctx.isTimedOutForIdx && !ctx.fetConfirmed) {
      try {
        const forcedQText = this.fetGuard.buildQuestionDisplayHTML(host, ctx.currentIdx);
        if (forcedQText) {
          const isShuffled = host.quizService.isShuffleEnabled?.()
            && Array.isArray(host.quizService.shuffledQuestions)
            && host.quizService.shuffledQuestions.length > 0;
          const qForCurrent = isShuffled
            ? host.quizService.shuffledQuestions[ctx.currentIdx]
            : host.quizService.questions?.[ctx.currentIdx];
          const rawQ = (qForCurrent?.questionText ?? '').trim();
          const incomingStartsWithQ = incoming.length > 0 && incoming.startsWith(rawQ);
          if (!incomingStartsWithQ) {
            this.fetGuard.writeQText(host, forcedQText);
            return true;
          }
        }
      } catch { /* ignore */ }
    }
    return false;
  }

  /**
   * FET-OVER-QUESTION-TEXT GUARD: when the user has interacted and the incoming
   * is question text but the question is resolved/bypassed, keep/restore the
   * cached FET instead. Returns true when handled. Extracted verbatim.
   */
  private tryFetOverQuestionGuard(host: Host, el: any, ctx: DisplayTextCtx): boolean {
    if (ctx.hasRealInteraction && ctx.isQuestionText && (ctx.isResolvedForGuard || ctx.fetBypass)) {
      const fetCached =
        (host.explanationTextService.formattedExplanations[ctx.currentIdx]?.explanation ?? '').trim()
        || (host.explanationTextService.fetByIndex?.get(ctx.currentIdx) ?? '').trim();
      if (fetCached && fetCached.toLowerCase().includes('correct because')) {
        this.fetGuard.writeQText(host, fetCached);
        return true;
      }
      const lastText = (host._lastDisplayedText ?? '').trim();
      if (lastText && lastText.toLowerCase().includes('correct because')) {
        return true;
      }
      const domNow = (el.innerHTML ?? '').trim();
      if (domNow && domNow.toLowerCase().includes('correct because')) {
        return true;
      }
    }
    return false;
  }

  /**
   * MULTI-ANSWER / SINGLE-ANSWER FET BLOCK (skipped when timed out): when the
   * outgoing text is FET for an unresolved question, rebuild it back to the
   * question display text. Returns true when handled. Extracted verbatim.
   */
  private tryMultiSingleFetBlock(host: Host, ctx: DisplayTextCtx, finalText: string): boolean {
    if (ctx.isTimedOutForIdx) return false;
    const finalNorm = norm(finalText);
    const qTextNormForFet = norm(ctx.qForMultiCheck?.questionText);
    const rawExplanation = norm(
      host.quizService?.questions?.[ctx.currentIdx]?.explanation
        ?? ctx.qForMultiCheck?.explanation
    );
    const isFetText = !!finalNorm && (
      finalNorm.includes('correct because')
      || (!!rawExplanation && finalNorm.includes(rawExplanation))
      || (!!qTextNormForFet && !finalNorm.includes(qTextNormForFet))
    );
    const rawQForBlock: any =
      host.quizService?.questions?.[ctx.currentIdx] ?? ctx.qForMultiCheck;
    const rawCorrectCountBlock = this.resolveBlockCorrectCount(host, rawQForBlock, ctx.qForMultiCheck);
    const isMultiQ = host.quizService.multipleAnswer || rawCorrectCountBlock > 1;

    if (isFetText && isMultiQ) {
      if (this.tryRebuildUnresolvedFet(host, ctx)) return true;
    }

    if (isFetText && !isMultiQ) {
      if (this.tryRebuildUnresolvedFet(host, ctx)) return true;
    }
    return false;
  }

  /**
   * Effective correct-option count for the FET block: the higher of the live
   * count and the pristine quizInitialState count. Extracted verbatim.
   */
  private resolveBlockCorrectCount(host: Host, rawQForBlock: any, qForMultiCheck: any): number {
    const rawOptsForBlock: any[] = rawQForBlock?.options ?? [];
    let rawCorrectCountBlock = rawOptsForBlock.filter(
      (o: any) => isOptionCorrect(o)
    ).length;
    try {
      const _qText2 = norm(rawQForBlock?.questionText ?? qForMultiCheck?.questionText);
      const _bundle2 = host.quizService?.quizInitialState ?? [];
      for (const _quiz2 of _bundle2) {
        for (const _pq2 of (_quiz2?.questions ?? [])) {
          if (norm(_pq2?.questionText) !== _qText2) continue;
          const pc2 = (_pq2?.options ?? []).filter(
            (o: any) => isOptionCorrect(o)
          ).length;
          if (pc2 > rawCorrectCountBlock) rawCorrectCountBlock = pc2;
          break;
        }
      }
    } catch { /* ignore */ }
    return rawCorrectCountBlock;
  }

  /**
   * When the question isn't scored correct / bypassed / FET-confirmed, rebuild
   * the heading back to the question display text. Returns true when written.
   * Extracted verbatim (shared by the multi- and single-answer FET branches).
   */
  private tryRebuildUnresolvedFet(host: Host, ctx: DisplayTextCtx): boolean {
    if (!this.fetGuard.isScoredCorrectAtDisplay(host, ctx.currentIdx) && !ctx.fetBypassActive && !ctx.fetConfirmed) {
      const qText = this.fetGuard.buildQuestionDisplayHTML(host, ctx.currentIdx);
      if (qText) {
        this.fetGuard.writeQText(host, qText);
        return true;
      }
    }
    return false;
  }
}
