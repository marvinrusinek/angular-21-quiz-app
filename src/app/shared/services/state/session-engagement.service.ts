import { Injectable, signal } from '@angular/core';

/**
 * Tracks whether the user has started using quizzes in THIS app session.
 *
 * In-memory ONLY (a plain signal, no storage), so it resets on a real page
 * reload but survives in-app (SPA) navigation — e.g. going into a quiz and back
 * to the Quiz Selection screen keeps it set. The Quiz Selection screen reads it
 * to keep the progress-driven pieces (achievements summary, "You accessed…"
 * banner, "Your Progress" panel, per-card best-score line) HIDDEN on a fresh
 * load, then reveal them once the user engages with a quiz.
 *
 * This gates DISPLAY only — saved progress in localStorage is never touched, so
 * a returning user still keeps their scores/achievements; they simply don't
 * surface until the user starts using a quiz again this session.
 */
@Injectable({ providedIn: 'root' })
export class SessionEngagementService {
  private readonly _engaged = signal(false);

  /** True once the user has started using a quiz this session. */
  readonly engaged = this._engaged.asReadonly();

  /** Mark the session as engaged (called when a quiz is selected/started). */
  markEngaged(): void {
    this._engaged.set(true);
  }
}
