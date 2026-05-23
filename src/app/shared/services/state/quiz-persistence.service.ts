import { Injectable, inject } from '@angular/core';

import { SK_DOT_CONFIRMED, SK_DISPLAY_MODE, SK_IS_ANSWERED, SK_SEL_Q, SK_SELECTED_OPTIONS_MAP } from '../../constants/session-keys';

import { QuizStatus } from '../../models/quiz-status.enum';

import { QuizDataService } from '../data/quizdata.service';
import { QuizService } from '../data/quiz.service';
import { SelectedOptionService } from './selectedoption.service';

/**
 * Manages localStorage/sessionStorage persistence for quiz dot status,
 * progress, and continue-status.
 * Extracted from QuizComponent to reduce its size.
 */
@Injectable({ providedIn: 'root' })
export class QuizPersistenceService {
  // ── injects ─────────────────────────────────────────────────────
  private quizDataService = inject(QuizDataService);
  private quizService = inject(QuizService);
  private selectedOptionService = inject(SelectedOptionService);

  // ── public methods ──────────────────────────────────────────────

  // ═══════════════════════════════════════════════════════════════
  // STORAGE KEY HELPERS
  // ═══════════════════════════════════════════════════════════════

  getEffectiveQuizId(quizId: string): string {
    return quizId
      || this.quizService.quizId
      || localStorage.getItem('lastQuizId')
      || 'default';
  }

  getDotStatusStorageKey(quizId: string): string {
    return `quiz_dot_status_${this.getEffectiveQuizId(quizId)}`;
  }

  getProgressStorageKey(quizId: string): string {
    return `quiz_progress_${this.getEffectiveQuizId(quizId)}`;
  }

  // ═══════════════════════════════════════════════════════════════
  // PROGRESS PERSISTENCE
  // ═══════════════════════════════════════════════════════════════

  getPersistedProgress(quizId: string): number | null {
    try {
      const keys = [this.getProgressStorageKey(quizId), 'quiz_progress_default'];
      for (const key of keys) {
        const raw = localStorage.getItem(key);
        if (raw == null) continue;
        
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) return Math.trunc(n);
      }
    } catch { }
    return null;
  }

  setPersistedProgress(quizId: string, value: number): void {
    try {
      const keys = Array.from(new Set([
        this.getProgressStorageKey(quizId),
        'quiz_progress_default',
      ]));
      for (const key of keys) {
        localStorage.setItem(key, String(Math.max(0, Math.trunc(value))));
      }
    } catch { }
  }

  // ═══════════════════════════════════════════════════════════════
  // DOT STATUS PERSISTENCE
  // ═══════════════════════════════════════════════════════════════

  getPersistedDotStatus(quizId: string, index: number): 'correct' | 'wrong' | null {
    try {
      const keys = [
        this.getDotStatusStorageKey(quizId),
        'quiz_dot_status_default',
      ];

      for (const key of keys) {
        const raw = localStorage.getItem(key);
        if (!raw) {
          continue;
        }
        const parsed = JSON.parse(raw) as Record<string, 'correct' | 'wrong'>;
        const value = parsed[String(index)];
        if (value === 'correct' || value === 'wrong') return value;
      }

      return null;
    } catch {
      return null;
    }
  }

  setPersistedDotStatus(quizId: string, index: number, status: 'correct' | 'wrong'): void {
    try {
      const keys = Array.from(new Set([
        this.getDotStatusStorageKey(quizId),
        'quiz_dot_status_default',
      ]));

      for (const key of keys) {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : {};
        parsed[String(index)] = status;
        localStorage.setItem(key, JSON.stringify(parsed));
      }
    } catch { }
  }

  clearPersistedDotStatus(quizId: string, index: number): void {
    try {
      const keys = Array.from(new Set([
        this.getDotStatusStorageKey(quizId),
        'quiz_dot_status_default',
      ]));

      for (const key of keys) {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          delete parsed[String(index)];
          localStorage.setItem(key, JSON.stringify(parsed));
        }
      }
    } catch { }
  }

  /** Remove ALL persisted dot status entries (used on quiz restart). */
  clearAllPersistedDotStatus(quizId: string): void {
    try {
      const keys = Array.from(new Set([
        this.getDotStatusStorageKey(quizId),
        'quiz_dot_status_default',
      ]));
      for (const key of keys) localStorage.removeItem(key);
    } catch { }
  }

  // ═══════════════════════════════════════════════════════════════
  // CLICK CONFIRMED DOT STATUS (sessionStorage)
  // ═══════════════════════════════════════════════════════════════

  /** Clear clickConfirmedDotStatus map AND its sessionStorage backing. */
  clearClickConfirmedDotStatus(totalQuestions: number): void {
    // Clear sessionStorage entries before clearing the map
    for (const [key] of this.selectedOptionService.clickConfirmedDotStatus) {
      try {
        sessionStorage.removeItem(SK_DOT_CONFIRMED + key);
      } catch {}
    }
    // Also sweep any orphaned session keys (up to totalQuestions)
    const total = totalQuestions || 20;
    for (let i = 0; i < total; i++) {
      try {
        sessionStorage.removeItem(SK_DOT_CONFIRMED + i);
      } catch {}
    }
    this.selectedOptionService.clickConfirmedDotStatus.clear();
  }

  // Wipe every browser-storage key that could leak state from a prior
  // attempt into a fresh-start of `quizId`. Called by IntroductionComponent
  // before navigating to Q1. Pulls together the localStorage and
  // sessionStorage cleanup that was previously inlined in onStartQuiz.
  clearAllForFreshStart(quizId: string): void {
    try {
      localStorage.setItem('savedQuestionIndex', '0');
      localStorage.setItem('correctAnswersCount', '0');
      localStorage.removeItem('questionCorrectness');
      localStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
      localStorage.removeItem('userAnswers');

      sessionStorage.removeItem(SK_SELECTED_OPTIONS_MAP);
      sessionStorage.removeItem('rawSelectionsMap');
      sessionStorage.removeItem('selectionHistory');
      sessionStorage.removeItem(SK_IS_ANSWERED);
      sessionStorage.removeItem('finalResult');
      sessionStorage.removeItem('elapsedTimes');
      sessionStorage.removeItem('completionTime');

      // Drop this quiz from the completed list (we're restarting it)
      try {
        const ids: string[] = JSON.parse(sessionStorage.getItem('completedQuizIds') || '[]');
        const filtered = ids.filter(id => id !== quizId);
        if (filtered.length > 0) {
          sessionStorage.setItem('completedQuizIds', JSON.stringify(filtered));
        } else {
          sessionStorage.removeItem('completedQuizIds');
        }
      } catch {
        sessionStorage.removeItem('completedQuizIds');
      }

      // Per-question session entries from the previous quiz
      for (let i = 0; i < 100; i++) {
        sessionStorage.removeItem(SK_SEL_Q + i);
        sessionStorage.removeItem(SK_DOT_CONFIRMED + i);
        sessionStorage.removeItem('quiz_selection_' + i);
        sessionStorage.removeItem(SK_DISPLAY_MODE + i);
        sessionStorage.removeItem('feedbackText_' + i);
      }

      // localStorage dot-status / progress keys (any quiz)
      const lsKeysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && (key.startsWith('quiz_dot_status_') || key.startsWith('quiz_progress_'))) {
          lsKeysToRemove.push(key);
        }
      }
      for (const key of lsKeysToRemove) localStorage.removeItem(key);
    } catch {}
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTINUE STATUS
  // ════════════════════════════════════════════════════��══════════

  persistContinueStatusIfNeeded(quizId: string, currentQuestionIndex: number): void {
    if (!quizId) return;

    // Hard Block: never persist CONTINUE after completion
    if (this.quizService.quizCompleted === true) return;

    // Only persist if the user actually answered something
    const hasAnsweredAny =
      currentQuestionIndex > 0 ||
      this.selectedOptionService.isQuestionAnswered(0) === true;

    if (!hasAnsweredAny) return;

    // Store the current question index for resume
    this.quizService.currentQuestionIndex = currentQuestionIndex;

    // Set CONTINUE status
    this.quizDataService.updateQuizStatus(quizId, QuizStatus.CONTINUE);
    this.quizService.setQuizStatus(QuizStatus.CONTINUE);
  }
}