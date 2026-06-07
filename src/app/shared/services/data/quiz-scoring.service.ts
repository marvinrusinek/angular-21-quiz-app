import { inject, Injectable, signal } from '@angular/core';

import { SK_CORRECT_ANSWERS_COUNT, SK_SAVED_QUESTION_INDEX } from '../../constants/session-keys';

import { QuizScore } from '../../models/QuizScore.model';

import { QuizShuffleService } from '../flow/quiz-shuffle.service';

import { getQuizData } from '../../quiz-data-cache';
import { isOptionCorrect } from '../../utils/is-option-correct';
import { norm } from '../../utils/text-norm';

@Injectable({ providedIn: 'root' })
export class QuizScoringService {
  // ── injects ─────────────────────────────────────────────────────
  public readonly quizShuffleService = inject(QuizShuffleService);

  // ── signals ─────────────────────────────────────────────────────
  readonly correctCountSig = signal<number>(0);
  readonly scoreSig = signal<number>(0);
  public readonly correctAnswersCountSig = signal<number>(0);

  // ── properties ──────────────────────────────────────────────────
  // State tracking for scoring (Index -> IsCorrect)
  public questionCorrectness = new Map<number, boolean>();

  quizScore: QuizScore | null = null;
  highScores: QuizScore[] = [];
  highScoresLocal = JSON.parse(localStorage.getItem('highScoresLocal') ?? '[]');

  // Tracks confirmed correct clicks per question. Each call to recordCorrectClick
  // adds the option text; the pristine gate only allows scoring when the count
  // matches the pristine correct count. This avoids relying on SelectedOptionService
  // which can return polluted/extra selections.
  private _confirmedCorrectClicks = new Map<number, Set<string>>();

  private readonly scoreQuizIdStorageKey = 'scoreQuizId';

  // ── constructor / lifecycle ─────────────────────────────────────
  constructor() {
    this.loadQuestionCorrectness();
  }

  // ── public methods ──────────────────────────────────────────────

  // ═══════════════════════════════════════════════════════════════════════
  // Core Scoring
  // ═══════════════════════════════════════════════════════════════════════

  /** Record that a correct option was clicked for a multi-answer question. */
  recordCorrectClick(questionIndex: number, optionText: string): void {
    const nrm = norm(optionText);
    if (!nrm) return;

    if (!this._confirmedCorrectClicks.has(questionIndex)) {
      this._confirmedCorrectClicks.set(questionIndex, new Set());
    }
    this._confirmedCorrectClicks.get(questionIndex)!.add(nrm);
  }

  /** Clear confirmed clicks for a question (used on reset). */
  clearConfirmedClicks(questionIndex?: number): void {
    if (questionIndex !== undefined) {
      this._confirmedCorrectClicks.delete(questionIndex);
    } else {
      this._confirmedCorrectClicks.clear();
    }
  }

  /**
   * Simple Scoring: Direct scoring method that bypasses complex answer matching.
   * Call this when you already know whether the user's selection is correct.
   * @param questionIndex The display index of the question
   * @param isCorrect Whether the user's current answer state is correct
   * @param isMultipleAnswer Whether this is a multi-answer question
   * @param shouldShuffle Whether shuffle is currently enabled
   * @param quizId The current quiz ID
   */
  public scoreDirectly(
    questionIndex: number,
    isCorrect: boolean,
    isMultipleAnswer: boolean,
    shouldShuffle: boolean,
    quizId: string
  ): void {
    this.incrementScore([], isCorrect, isMultipleAnswer, questionIndex, shouldShuffle, quizId);
  }

  incrementScore(
    _answers: number[],
    correctAnswerFound: boolean,
    isMultipleAnswer: boolean,
    questionIndex: number,
    shouldShuffle: boolean,
    quizId: string
  ): void {
    const qIndex = questionIndex >= 0 ? questionIndex : 0;

    const scoringKey = this.resolveScoringKey(qIndex, shouldShuffle, quizId);
    const wasCorrect = this.resolveWasCorrect(scoringKey);
    const isNowCorrect = this.applyPristineMultiAnswerGate(
      correctAnswerFound, quizId, isMultipleAnswer, qIndex, scoringKey
    );

    this.applyCorrectnessUpdate(scoringKey, isNowCorrect, wasCorrect);
    this.saveQuestionCorrectness();
  }

  // Scoring Key Resolution — Strict Shuffle Guard: only use the shuffle-service
  // mapping when shuffle is explicitly ENABLED. A stale QuizShuffleService map
  // (from a prev session) could otherwise remap an unshuffled question (0->3)
  // and update the wrong score key.
  private resolveScoringKey(qIndex: number, shouldShuffle: boolean, quizId: string): number {
    let scoringKey = qIndex;
    if (shouldShuffle) {
      // Try to get quizId from various sources if it's empty
      let effectiveQuizId = quizId;
      if (!effectiveQuizId) {
        try {
          effectiveQuizId = localStorage.getItem('lastQuizId') || '';
        } catch { }
      }
      if (!effectiveQuizId) {
        const shuffleKeys = Object.keys(localStorage).filter(k => k.startsWith('shuffleState:'));
        if (shuffleKeys.length > 0) {
          effectiveQuizId = shuffleKeys[0].replace('shuffleState:', '');
        }
      }

      if (effectiveQuizId) {
        const originalIndex = this.quizShuffleService.toOriginalIndex(effectiveQuizId, qIndex);
        if (typeof originalIndex === 'number' && originalIndex >= 0) {
          scoringKey = originalIndex;
        }
      }
    }
    return scoringKey;
  }

  // Read prior correctness (keyed by scoringKey only). Self-heal a stale
  // "already correct" entry when correctCount is 0 so scoring can proceed.
  private resolveWasCorrect(scoringKey: number): boolean {
    let wasCorrect = this.questionCorrectness.get(scoringKey) || false;
    if (wasCorrect && this.correctCountSig() === 0) {
      wasCorrect = false;
      this.questionCorrectness.set(scoringKey, false);
    }
    return wasCorrect;
  }

  // PRISTINE GATE: block a multi-answer increment unless ALL pristine correct
  // answers have been confirmed clicked. Safety net for non-OIS callers.
  private applyPristineMultiAnswerGate(
    correctAnswerFound: boolean,
    quizId: string,
    isMultipleAnswer: boolean,
    qIndex: number,
    scoringKey: number
  ): boolean {
    let isNowCorrect = correctAnswerFound;  // simplified
    if (isNowCorrect && quizId && isMultipleAnswer) {
      const confirmed = this._confirmedCorrectClicks.get(qIndex) ?? new Set<string>();
      const pristineCorrectTexts = this.resolvePristineCorrectTexts(quizId, scoringKey, confirmed);
      if (pristineCorrectTexts.length > 1) {
        const allConfirmed = pristineCorrectTexts.every((t: string) => confirmed.has(t));
        if (!allConfirmed) isNowCorrect = false;
      }
    }
    return isNowCorrect;
  }

  // Resolve pristine correct texts by index lookup, then cross-validate against
  // confirmed clicks (in shuffled mode the index lookup can hit the wrong
  // question; the right one's correct texts ALL appear in confirmed clicks).
  private resolvePristineCorrectTexts(
    quizId: string,
    scoringKey: number,
    confirmed: Set<string>
  ): string[] {
    let pristineCorrectTexts: string[] = [];
    const pristineQuiz = getQuizData().find((qz: any) => qz?.quizId === quizId);

    // PRIMARY: index-based lookup
    const pristineQ = pristineQuiz?.questions?.[scoringKey];
    if (pristineQ) {
      pristineCorrectTexts = (pristineQ.options ?? [])
        .filter((o: any) => isOptionCorrect(o))
        .map((o: any) => norm(o?.text))
        .filter((t: string) => !!t);
    }

    // CROSS-VALIDATE: if index-based texts don't match confirmed clicks, scan
    // all questions for one whose correct texts match the confirmed clicks.
    if (pristineCorrectTexts.length > 1 && confirmed.size > 0) {
      const allMatch = pristineCorrectTexts.every((t: string) => confirmed.has(t));
      if (!allMatch && pristineQuiz?.questions) {
        for (const pq of pristineQuiz.questions) {
          const pqCorrect = (pq?.options ?? [])
            .filter((o: any) => isOptionCorrect(o))
            .map((o: any) => norm(o?.text))
            .filter((t: string) => !!t);
          if (pqCorrect.length > 1 && pqCorrect.every((t: string) => confirmed.has(t))) {
            pristineCorrectTexts = pqCorrect;
            break;
          }
        }
      }
    }
    return pristineCorrectTexts;
  }

  // Update the correctness map + running count based on now-vs-was correctness.
  private applyCorrectnessUpdate(scoringKey: number, isNowCorrect: boolean, wasCorrect: boolean): void {
    if (isNowCorrect && !wasCorrect) {
      this.questionCorrectness.set(scoringKey, true);
      this.updateCorrectCountForResults(this.correctCountSig() + 1);
    } else if (!isNowCorrect && wasCorrect) {
      this.updateCorrectCountForResults(Math.max(this.correctCountSig() - 1, 0));
      this.questionCorrectness.set(scoringKey, false);
    } else if (!isNowCorrect && !this.questionCorrectness.has(scoringKey)) {
      // Only set to false if not already set — don't overwrite a true
      // value that was set directly by the SOC's display-index path.
      this.questionCorrectness.set(scoringKey, false);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Score Updates & Guards
  // ═══════════════════════════════════════════════════════════════════════

  sendCorrectCountToResults(value: number, quizId?: string): void {
    const safeValue = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

    // GUARD: If something tries to set score to 0 but we have correctly answered
    // questions in our map, ignore the zero and re-derive from the map.
    // This prevents navigation-triggered accidental resets.
    if (safeValue === 0 && this.questionCorrectness.size > 0) {
      localStorage.setItem('DEBUG_sendCorrectCount_BLOCKED', new Error().stack || 'no stack');
      const trueCount = Array.from(this.questionCorrectness.values())
        .filter(v => v === true).length;
      if (trueCount > 0) {
        this.correctCountSig.set(trueCount);
        this.correctAnswersCountSig.set(trueCount);
        localStorage.setItem(SK_CORRECT_ANSWERS_COUNT, String(trueCount));
        if (quizId) localStorage.setItem(this.scoreQuizIdStorageKey, quizId);
        return;
      }
    }

    this.correctCountSig.set(safeValue);
    this.correctAnswersCountSig.set(safeValue);
    localStorage.setItem(SK_CORRECT_ANSWERS_COUNT, String(safeValue));
    if (quizId) {
      localStorage.setItem(this.scoreQuizIdStorageKey, quizId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Reset
  // ═══════════════════════════════════════════════════════════════════════

  resetScore(quizId?: string): void {
    localStorage.setItem('DEBUG_resetScore', new Error().stack || 'no stack');
    this.questionCorrectness.clear();
    this._confirmedCorrectClicks.clear();
    this.saveQuestionCorrectness();  // clear persistence
    this.correctCountSig.set(0);
    // Use _forceSetScore to bypass the guard in sendCorrectCountToResults
    this._forceSetScore(0, quizId);  }

  /** Bypass guard — only for explicit resets (restart, new quiz). */
  _forceSetScore(value: number, quizId?: string): void {
    const safeValue = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    this.correctCountSig.set(safeValue);
    this.correctAnswersCountSig.set(safeValue);
    localStorage.setItem(SK_CORRECT_ANSWERS_COUNT, String(safeValue));
    if (quizId) localStorage.setItem(this.scoreQuizIdStorageKey, quizId);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Persistence
  // ═══════════════════════════════════════════════════════════════════════

  loadQuestionCorrectness(): void {
    try {
      const stored = localStorage.getItem('questionCorrectness');
      if (stored) {
        const parsed = JSON.parse(stored);
        this.questionCorrectness = new Map(
          Object.entries(parsed).map(([k, v]) => [Number(k), Boolean(v)])
        );      }
    } catch (err) {
      console.error('QuizScoringService.loadQuestionCorrectness localStorage parse failed:', err);
    }
  }

  saveQuestionCorrectness(): void {
    try {
      const obj = Object.fromEntries(this.questionCorrectness);
      localStorage.setItem('questionCorrectness', JSON.stringify(obj));
    } catch (err) {
      console.error('QuizScoringService.saveQuestionCorrectness localStorage write failed:', err);
    }
  }

  restoreScoreFromPersistence(quizId: string): void {
    try {
      // If quizId is not yet known (e.g. called from QuizService constructor
      // before the route has resolved), do nothing. Wiping state here
      // destroys the localStorage-persisted score the user just earned
      // right before the refresh.
      if (!quizId || quizId.length === 0) return;

      const savedIndexRaw = localStorage.getItem(SK_SAVED_QUESTION_INDEX);
      const savedIndex = Number(savedIndexRaw);
      const hasInProgressIndex = Number.isFinite(savedIndex) && Math.trunc(savedIndex) >= 0;
      const scoreQuizId = localStorage.getItem(this.scoreQuizIdStorageKey) ?? '';
      const quizMatches = scoreQuizId.length > 0 && scoreQuizId === quizId;

      // Compute what we HAVE stored for this quiz. If there's real data,
      // this is an in-progress session and we must restore it on refresh,
      // even if the user was on Q1 (savedIndex === 0).
      const storedRaw = localStorage.getItem(SK_CORRECT_ANSWERS_COUNT);
      const storedCount = Number(storedRaw);
      const safeStored = Number.isFinite(storedCount)
        ? Math.max(0, Math.trunc(storedCount)) : 0;
      const mapTrueCount = Array.from(this.questionCorrectness.values())
        .filter((v) => v === true).length;
      const hasStoredScore = safeStored > 0 || mapTrueCount > 0;

      // Wipe ONLY when: (a) quiz doesn't match (switching quizzes), OR
      // (b) there is genuinely no progress (no stored score AND no
      // in-progress index). Otherwise, restore from the stronger source.
      const shouldWipe = !quizMatches || (!hasInProgressIndex && !hasStoredScore);
      if (shouldWipe) {
        this.correctCountSig.set(0);
        this.correctAnswersCountSig.set(0);
        this.questionCorrectness.clear();
        this.saveQuestionCorrectness();
        localStorage.setItem(SK_CORRECT_ANSWERS_COUNT, '0');
        localStorage.setItem(this.scoreQuizIdStorageKey, quizId);
        return;
      }

      const restored = Math.max(safeStored, mapTrueCount);
      this.correctCountSig.set(restored);
      this.correctAnswersCountSig.set(restored);
      localStorage.setItem(SK_CORRECT_ANSWERS_COUNT, String(restored));
    } catch (err) {
      console.error('QuizScoringService.restoreScoreFromPersistence score restore failed:', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // High Scores
  // ═══════════════════════════════════════════════════════════════════════

  saveHighScores(quizId: string, totalQuestions: number): void {
    this.quizScore = {
      quizId: quizId,
      attemptDateTime: new Date(),
      score: this.calculatePercentageOfCorrectlyAnsweredQuestions(totalQuestions),
      totalQuestions: totalQuestions
    };

    const MAX_HIGH_SCORES = 10;  // show results of the last 10 quizzes
    this.highScoresLocal = this.highScoresLocal ?? [];
    this.highScoresLocal.push(this.quizScore);

    // Sort descending by date
    this.highScoresLocal.sort((a: any, b: any) => {
      const dateA = new Date(a.attemptDateTime);
      const dateB = new Date(b.attemptDateTime);
      return dateB.getTime() - dateA.getTime();
    });
    // Filter out scores older than 7 days
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    this.highScoresLocal = this.highScoresLocal.filter((score: any) => {
      const scoreDate = new Date(score.attemptDateTime);
      return scoreDate >= oneWeekAgo;
    });

    this.highScoresLocal.splice(MAX_HIGH_SCORES);
    localStorage.setItem(
      'highScoresLocal',
      JSON.stringify(this.highScoresLocal)
    );
    this.highScores = this.highScoresLocal;
  }

  calculatePercentageOfCorrectlyAnsweredQuestions(totalQuestions: number): number {
    const correctAnswers = this.correctAnswersCountSig();

    if (totalQuestions === 0) return 0;  // handle division by zero

    return Math.round((correctAnswers / totalQuestions) * 100);
  }

  // ── private methods ─────────────────────────────────────────────
  private updateCorrectCountForResults(value: number): void {
    const safeValue = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    this.correctCountSig.set(safeValue);
    this.sendCorrectCountToResults(this.correctCountSig());
  }
}
