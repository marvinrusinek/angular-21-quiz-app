import { Service, signal, type Signal } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';

import { canonicalize, evaluateLocally, revealExpiredLocally } from './local-verdict.adapter';
import {
  IDLE_VERDICT_STATE,
  QuestionVerdictError,
  type QuestionCheckResult,
  type QuestionExpiredResult,
  type QuestionVerdictState,
} from './question-verdict.types';

/**
 * The single correctness authority for Topic Quizzes.
 *
 * Today every consumer reads `option.correct` straight off the in-memory quiz
 * bank — 100-odd files across selection, highlighting, gating, FET, timers, dot
 * status, results and scoring. That is only possible because the whole answer
 * key is in the browser, which is precisely what the security migration is
 * removing.
 *
 * This service is the seam. Consumers ask IT whether an answer was right;
 * it answers from the local bank today and from
 * `POST /api/quizzes/:quizId/check` after the flip. Because the result types
 * already match the backend's response shape, that flip changes this file and
 * nothing else.
 *
 * ── Identity ───────────────────────────────────────────────────────
 *
 * A question is (quizId, exact questionText). An option is its exact text
 * within that question. No ids, no indexes, no opaque references — matching the
 * approved public contract, and audited as unambiguous across the whole bank.
 *
 * ── Asynchrony is deliberate ───────────────────────────────────────
 *
 * `checkAnswer` returns an Observable even though the local adapter is
 * synchronous. If it returned a plain value, every consumer would be written
 * against a synchronous API and would ALL have to change again when the answer
 * starts coming from the network. Paying that cost now keeps stage 10 to a
 * one-file change.
 *
 * ── No persistence ─────────────────────────────────────────────────
 *
 * Verdicts, correct-option sets and explanations are held in memory only and
 * are never written to localStorage or sessionStorage. Persisting them would
 * put the answer key back on disk — the exact problem being removed.
 */
@Service()
export class QuestionVerdictService {
  /**
   * Per-question state, keyed by `quizId` + canonical question text.
   *
   * A single signal holding an immutable map rather than one signal per
   * question: consumers read through `verdictFor()`, and a computed over one
   * source recomputes reliably. (Per-question signals created lazily would not
   * be tracked by a computed that ran before the question was first seen.)
   */
  private readonly _states = signal<ReadonlyMap<string, QuestionVerdictState>>(new Map());

  /**
   * Separator for the composite state key.
   *
   * Written as an ESCAPE, not a literal control character: a raw NUL in source
   * makes the file binary to git and grep. NUL is used rather than a printable
   * character because it cannot occur in a quiz id or in question text, so no
   * combination of the two can collide with another.
   */
  private static readonly KEY_SEPARATOR = '\u0000';

  /** Composite key. Canonical text, so casing/whitespace cannot fork state. */
  private key(quizId: string, questionText: string): string {
    return `${quizId}${QuestionVerdictService.KEY_SEPARATOR}${canonicalize(questionText)}`;
  }

  /** Current state for one question. Never null — unseen questions read idle. */
  verdictFor(quizId: string, questionText: string): QuestionVerdictState {
    return this._states().get(this.key(quizId, questionText)) ?? IDLE_VERDICT_STATE;
  }

  /** Reactive handle for template/computed use. */
  readonly states: Signal<ReadonlyMap<string, QuestionVerdictState>> = this._states.asReadonly();

  hasResolved(quizId: string, questionText: string): boolean {
    const phase = this.verdictFor(quizId, questionText).phase;
    return phase === 'resolved' || phase === 'expired';
  }

  /**
   * Was a SELECTED option correct?
   *
   * Returns null when the option was not selected, so a consumer cannot use
   * this to discover the correctness of something the user never picked while
   * the question is still incomplete. After resolution the full correct set is
   * available through the state, which is the authorized reveal.
   */
  verdictForOption(quizId: string, questionText: string, optionText: string): boolean | null {
    const state = this.verdictFor(quizId, questionText);
    return state.selectedVerdicts.get(canonicalize(optionText)) ?? null;
  }

  /**
   * Submit the CURRENT selection for one question.
   *
   * The full selection is sent every time rather than a delta: it makes the
   * call idempotent, it matches the backend contract, and it means a dropped
   * response cannot leave the server's view of the selection behind the
   * client's.
   */
  checkAnswer(
    quizId: string,
    questionText: string,
    selectedOptionTexts: readonly string[]
  ): Observable<QuestionCheckResult> {
    // SHAPE FIRST, before any state is touched. `markChecking` copies the
    // selection, and a non-array would throw a raw TypeError out of the spread
    // rather than the domain error — leaving the question stuck in `checking`
    // with no verdict ever arriving.
    if (!Array.isArray(selectedOptionTexts)) {
      return throwError(() => new QuestionVerdictError('Invalid submission'));
    }

    this.markChecking(quizId, questionText, selectedOptionTexts);

    let result: QuestionCheckResult;
    try {
      result = evaluateLocally(quizId, questionText, selectedOptionTexts);
    } catch (err: unknown) {
      this.markError(quizId, questionText);
      return throwError(() =>
        err instanceof QuestionVerdictError ? err : new QuestionVerdictError('Invalid submission')
      );
    }

    this.applyResult(quizId, questionText, selectedOptionTexts, result);
    return of(result);
  }

  /**
   * Reveal a question because its timer expired.
   *
   * Local-only in this stage: the caller's timer decides. After the API flip
   * the signed receipt's deadline decides instead, and a client claim of expiry
   * is ignored entirely.
   */
  revealExpiredQuestion(quizId: string, questionText: string): Observable<QuestionExpiredResult> {
    let result: QuestionExpiredResult;
    try {
      result = revealExpiredLocally(quizId, questionText);
    } catch (err: unknown) {
      this.markError(quizId, questionText);
      return throwError(() =>
        err instanceof QuestionVerdictError ? err : new QuestionVerdictError('Invalid submission')
      );
    }

    const existing = this.verdictFor(quizId, questionText);
    this.write(quizId, questionText, {
      ...existing,
      phase: 'expired',
      correctOptionTexts: result.correctOptionTexts,
      explanation: result.explanation,
      // Expiry reveals the answer; it does not claim the user got it right.
      isResolvedCorrect: existing.isResolvedCorrect,
    });
    return of(result);
  }

  /** Drop one question's verdict — e.g. a quiz restart. */
  clearQuestion(quizId: string, questionText: string): void {
    const next = new Map(this._states());
    next.delete(this.key(quizId, questionText));
    this._states.set(next);
  }

  /** Drop everything. In-memory only, so nothing else needs cleaning up. */
  clearAll(): void {
    this._states.set(new Map());
  }

  // ── internals ────────────────────────────────────────────────────

  private write(quizId: string, questionText: string, state: QuestionVerdictState): void {
    const next = new Map(this._states());
    next.set(this.key(quizId, questionText), state);
    this._states.set(next);
  }

  private markChecking(
    quizId: string,
    questionText: string,
    selectedOptionTexts: readonly string[]
  ): void {
    // The optimistic phase: the selection is shown immediately while the
    // verdict is pending, and navigation stays blocked until it lands. Local
    // evaluation resolves in the same tick, but the phase exists so consumers
    // are already written for the asynchronous case.
    this.write(quizId, questionText, {
      ...this.verdictFor(quizId, questionText),
      phase: 'checking',
      selectedOptionTexts: [...selectedOptionTexts],
    });
  }

  private markError(quizId: string, questionText: string): void {
    // The LAST CONFIRMED state is kept; only the phase changes. A failed check
    // must never be displayed as though it were a recorded answer.
    this.write(quizId, questionText, {
      ...this.verdictFor(quizId, questionText),
      phase: 'error',
    });
  }

  private applyResult(
    quizId: string,
    questionText: string,
    selectedOptionTexts: readonly string[],
    result: QuestionCheckResult
  ): void {
    const selected = [...selectedOptionTexts];

    if (result.status === 'incomplete') {
      this.write(quizId, questionText, {
        phase: 'incomplete',
        selectedOptionTexts: selected,
        selectedVerdicts: new Map(
          result.selectedVerdicts.map((verdict) => [canonicalize(verdict.text), verdict.correct])
        ),
        remainingCorrectCount: result.remainingCorrectCount,
        // Nothing revealed yet.
        correctOptionTexts: [],
        explanation: null,
        isResolvedCorrect: null,
      });
      return;
    }

    if (result.status === 'resolved') {
      this.write(quizId, questionText, {
        phase: 'resolved',
        selectedOptionTexts: selected,
        selectedVerdicts: new Map(
          selected.map((text) => [
            canonicalize(text),
            result.correctOptionTexts.some(
              (correct) => canonicalize(correct) === canonicalize(text)
            ),
          ])
        ),
        remainingCorrectCount: 0,
        correctOptionTexts: result.correctOptionTexts,
        explanation: result.explanation,
        isResolvedCorrect: result.correct,
      });
      return;
    }

    this.write(quizId, questionText, {
      ...this.verdictFor(quizId, questionText),
      phase: 'expired',
      selectedOptionTexts: selected,
      correctOptionTexts: result.correctOptionTexts,
      explanation: result.explanation,
    });
  }
}
