import { computed, inject, Service, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { InterviewApiService } from '../api/interview-api.service';
import { InterviewApiError } from '../api/interview-api.errors';
import { InterviewSessionReferenceStorage } from './interview-session-reference.storage';
import { canonicalize, sameSelection } from './interview-answer-transitions';
import type {
  InterviewQuestionViewModel,
  InterviewResultViewModel,
  InterviewSessionConfigViewModel,
  InterviewSessionViewModel
} from '../../models/interview/interview-view-models';

/**
 * Backend-oriented Interview session state.
 *
 * NEW in Stage 9B and NOT yet wired to any component, guard or route — the
 * shipped Interview flow still runs entirely through the old
 * `InterviewSessionService`. Stage 9C performs the first cutover.
 *
 * This service holds NO correctness: there is no `correct`, no
 * `correctOptionIds`, no `explanation`, and no scoring. It never reads the
 * local quiz bank and never generates an assessment.
 */

export type BackendSessionStatus = 'idle' | 'loading' | 'active' | 'expired' | 'submitted' | 'error';

export type ResumeOutcome =
  | { readonly kind: 'active' }
  | { readonly kind: 'none' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'submitted' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unavailable' };

export type SaveOutcome =
  | { readonly kind: 'saved'; readonly selectedOptionIds: readonly number[] }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'failed'; readonly error: InterviewApiError };

interface QuestionSaveState {
  /** Incremented on every requested save. */
  requestedVersion: number;
  /** Highest version whose response has been applied. */
  confirmedVersion: number;
  /** Serializes saves for THIS question only. */
  chain: Promise<unknown>;
}

@Service()
export class BackendInterviewSessionService {
  private readonly api = inject(InterviewApiService);
  private readonly storage = inject(InterviewSessionReferenceStorage);

  // ── state ─────────────────────────────────────────────────────────
  private readonly _status = signal<BackendSessionStatus>('idle');
  private readonly _sessionId = signal<string>('');
  private readonly _questions = signal<readonly InterviewQuestionViewModel[]>([]);
  /** CONFIRMED by the server. */
  private readonly _answers = signal<ReadonlyMap<string, readonly number[]>>(new Map());
  /** Optimistic overlay, cleared as saves confirm or roll back. */
  private readonly _optimistic = signal<ReadonlyMap<string, readonly number[]>>(new Map());
  private readonly _currentIndex = signal(0);
  private readonly _config = signal<InterviewSessionConfigViewModel | null>(null);
  private readonly _createdAtMs = signal(0);
  private readonly _expiresAtMs = signal(0);
  private readonly _durationSeconds = signal(0);
  private readonly _serverRemainingSeconds = signal(0);
  private readonly _answeredCount = signal(0);
  private readonly _pendingSaveCount = signal(0);
  private readonly _saving = signal<ReadonlySet<string>>(new Set());
  private readonly _error = signal<InterviewApiError | null>(null);
  private readonly _submitting = signal(false);
  /** IN MEMORY ONLY. Never persisted — the results route re-fetches it. */
  private readonly _result = signal<InterviewResultViewModel | null>(null);

  private token = '';
  private readonly saveState = new Map<string, QuestionSaveState>();

  // ── public surface ────────────────────────────────────────────────
  readonly status = this._status.asReadonly();
  readonly sessionId = this._sessionId.asReadonly();
  readonly questions = this._questions.asReadonly();
  readonly currentIndex = this._currentIndex.asReadonly();
  readonly config = this._config.asReadonly();
  readonly createdAtMs = this._createdAtMs.asReadonly();
  readonly expiresAtMs = this._expiresAtMs.asReadonly();
  readonly durationSeconds = this._durationSeconds.asReadonly();
  readonly serverRemainingSeconds = this._serverRemainingSeconds.asReadonly();
  readonly answeredCount = this._answeredCount.asReadonly();
  readonly pendingSaveCount = this._pendingSaveCount.asReadonly();
  readonly error = this._error.asReadonly();
  readonly submitting = this._submitting.asReadonly();
  readonly result = this._result.asReadonly();

  readonly questionCount = computed(() => this._questions().length);
  readonly loading = computed(() => this._status() === 'loading');
  readonly isActive = computed(() => this._status() === 'active');
  readonly hasPendingSaves = computed(() => this._pendingSaveCount() > 0);

  /** What the UI renders: confirmed answers with the optimistic overlay applied. */
  readonly displayedAnswers = computed<ReadonlyMap<string, readonly number[]>>(() => {
    const merged = new Map(this._answers());
    for (const [questionId, selection] of this._optimistic()) merged.set(questionId, selection);
    return merged;
  });

  readonly currentQuestion = computed<InterviewQuestionViewModel | null>(
    () => this._questions()[this._currentIndex()] ?? null
  );

  selectionFor(questionId: string): readonly number[] {
    return this.displayedAnswers().get(questionId) ?? [];
  }

  isQuestionSaving(questionId: string): boolean {
    return this._saving().has(questionId);
  }

  // ── hydration ─────────────────────────────────────────────────────

  /**
   * Stage 9C entry point: adopt a freshly created session and persist the
   * minimal reference. The raw token is held in memory + sessionStorage and is
   * never logged.
   */
  activateCreatedSession(session: InterviewSessionViewModel, sessionToken: string): void {
    this.token = sessionToken;
    this.hydrate(session, 0);
    this.storage.write(session.sessionId, sessionToken, 0);
  }

  /** Stage 9D entry point. Never called from a constructor or an effect. */
  async resumeFromStoredReference(): Promise<ResumeOutcome> {
    const reference = this.storage.read();
    if (!reference) return { kind: 'none' };

    this._status.set('loading');
    this._error.set(null);

    try {
      const session = await firstValueFrom(
        this.api.resumeSession(reference.sessionId, reference.sessionToken)
      );
      this.token = reference.sessionToken;
      this.hydrate(session, reference.currentIndex);
      return { kind: 'active' };
    } catch (err: unknown) {
      const error = err instanceof InterviewApiError ? err : new InterviewApiError('UNKNOWN', 0);
      this._error.set(error);

      switch (error.code) {
        case 'SESSION_EXPIRED':
          this._status.set('expired');
          return { kind: 'expired' };
        case 'CONFLICT':
          this._status.set('submitted');
          return { kind: 'submitted' };
        case 'UNAUTHORIZED':
          // A dead reference is useless — drop it so the user is not stuck.
          this.clearSession();
          this._status.set('error');
          return { kind: 'unauthorized' };
        default:
          this._status.set('error');
          return { kind: 'unavailable' };
      }
    }
  }

  private hydrate(session: InterviewSessionViewModel, requestedIndex: number): void {
    this._sessionId.set(session.sessionId);
    // Order is delivered by the server and preserved verbatim.
    this._questions.set(session.questions);
    this._answers.set(new Map(session.answers));
    this._optimistic.set(new Map());
    this._config.set(session.config);
    this._createdAtMs.set(session.createdAtMs);
    this._expiresAtMs.set(session.expiresAtMs);
    this._durationSeconds.set(session.durationSeconds);
    this._serverRemainingSeconds.set(session.remainingSeconds);
    this._answeredCount.set(session.answers.size);
    this._currentIndex.set(this.clampIndex(requestedIndex, session.questions.length));
    this._pendingSaveCount.set(0);
    this._saving.set(new Set());
    this.saveState.clear();
    this._status.set('active');
  }

  private clampIndex(index: number, total: number): number {
    if (!Number.isInteger(index) || index < 0 || total === 0) return 0;
    return Math.min(index, total - 1);
  }

  setCurrentIndex(index: number): void {
    const clamped = this.clampIndex(index, this._questions().length);
    this._currentIndex.set(clamped);
    // Position only — the stored reference never grows beyond three fields.
    this.storage.updateCurrentIndex(clamped);
  }

  clearSession(): void {
    this.token = '';
    this.saveState.clear();
    this._status.set('idle');
    this._sessionId.set('');
    this._questions.set([]);
    this._answers.set(new Map());
    this._optimistic.set(new Map());
    this._config.set(null);
    this._createdAtMs.set(0);
    this._expiresAtMs.set(0);
    this._durationSeconds.set(0);
    this._serverRemainingSeconds.set(0);
    this._answeredCount.set(0);
    this._pendingSaveCount.set(0);
    this._saving.set(new Set());
    this._error.set(null);
    this._result.set(null);
    this.storage.clear();
  }

  // ── saving ────────────────────────────────────────────────────────

  /**
   * Persist the COMPLETE selection for one question.
   *
   * Optimistic: the UI updates immediately, then the canonical server response
   * replaces it. Saves for the SAME question are serialized so the last server
   * write always matches the last UI selection; different questions save
   * concurrently.
   */
  async updateAnswer(questionId: string, nextSelectedOptionIds: readonly number[]): Promise<SaveOutcome> {
    const question = this._questions().find((q) => q.questionId === questionId);
    if (!question) {
      return { kind: 'failed', error: new InterviewApiError('BAD_REQUEST', 400) };
    }

    const next = canonicalize(nextSelectedOptionIds);
    const state = this.stateFor(questionId);
    const version = ++state.requestedVersion;

    this.applyOptimistic(questionId, next);
    this.markSaving(questionId, true);

    // Serialize per question: the previous request must settle before this one
    // is sent, so the backend's last write is the user's last selection.
    const run = state.chain.then(() => this.performSave(questionId, next, version));
    state.chain = run.catch(() => undefined);
    return run;
  }

  private async performSave(
    questionId: string,
    selection: readonly number[],
    version: number
  ): Promise<SaveOutcome> {
    const state = this.stateFor(questionId);

    try {
      const response = await firstValueFrom(
        this.api.saveAnswer(this._sessionId(), this.token, questionId, selection)
      );

      // A newer save has already been requested — its response is the truth.
      if (version < state.requestedVersion) return { kind: 'superseded' };
      if (version <= state.confirmedVersion) return { kind: 'superseded' };
      state.confirmedVersion = version;

      const canonical = [...response.selectedOptionIds];
      this.commitConfirmed(questionId, canonical);
      // answeredCount is the SERVER's, never derived locally.
      this._answeredCount.set(response.answeredCount);
      this._error.set(null);
      this.markSaving(questionId, false);
      return { kind: 'saved', selectedOptionIds: canonical };
    } catch (err: unknown) {
      const error = err instanceof InterviewApiError ? err : new InterviewApiError('UNKNOWN', 0);

      // A stale failure must never clobber a newer optimistic value.
      if (version < state.requestedVersion) {
        return { kind: 'superseded' };
      }

      // Latest attempt failed: fall back to the last CONFIRMED server value.
      this.rollback(questionId);
      this._error.set(error);
      this.markSaving(questionId, false);
      return { kind: 'failed', error };
    }
  }

  private stateFor(questionId: string): QuestionSaveState {
    let state = this.saveState.get(questionId);
    if (!state) {
      state = { requestedVersion: 0, confirmedVersion: 0, chain: Promise.resolve() };
      this.saveState.set(questionId, state);
    }
    return state;
  }

  private applyOptimistic(questionId: string, selection: readonly number[]): void {
    const next = new Map(this._optimistic());
    next.set(questionId, selection);
    this._optimistic.set(next);
  }

  private commitConfirmed(questionId: string, selection: readonly number[]): void {
    const answers = new Map(this._answers());
    if (selection.length === 0) answers.delete(questionId);
    else answers.set(questionId, selection);
    this._answers.set(answers);

    // Drop the overlay only when it now matches the confirmed value; a newer
    // optimistic selection must survive an older confirmation.
    const optimistic = new Map(this._optimistic());
    const pending = optimistic.get(questionId);
    if (pending && sameSelection(pending, selection)) {
      optimistic.delete(questionId);
      this._optimistic.set(optimistic);
    }
  }

  private rollback(questionId: string): void {
    const optimistic = new Map(this._optimistic());
    optimistic.delete(questionId);
    this._optimistic.set(optimistic);
  }

  private markSaving(questionId: string, saving: boolean): void {
    const next = new Set(this._saving());
    if (saving) {
      next.add(questionId);
      this._pendingSaveCount.update((count) => count + 1);
    } else {
      next.delete(questionId);
      this._pendingSaveCount.update((count) => Math.max(0, count - 1));
    }
    this._saving.set(next);
  }

  /** True when the LATEST save for this question failed and was rolled back. */
  hasFailedSave(questionId: string): boolean {
    const state = this.saveState.get(questionId);
    return !!state && state.confirmedVersion < state.requestedVersion && !this.isQuestionSaving(questionId);
  }

  /** Any question whose latest save failed — blocks navigation and submission. */
  readonly hasUnsavedChanges = computed(() => {
    void this._saving();
    void this._optimistic();
    for (const [, state] of this.saveState) {
      if (state.confirmedVersion < state.requestedVersion) return true;
    }
    return false;
  });

  // ── submission (Stage 9D handoff) ─────────────────────────────────

  /**
   * Finalize on the BACKEND. The result is held in MEMORY only — never written
   * to storage — while the v2 reference stays put so the results route can
   * re-fetch it after a refresh. Stage 9E renders it.
   */
  async submit(): Promise<InterviewResultViewModel> {
    if (this._submitting()) throw new InterviewApiError('CONFLICT', 409);

    const existing = this._result();
    if (existing) return existing;   // suppress duplicate submits in the UI

    this._submitting.set(true);
    try {
      // Never submit on top of a failed save — the server would score answers
      // the user believes they changed.
      await this.awaitPendingSaves();

      const result = await firstValueFrom(
        this.api.submitSession(this._sessionId(), this.token)
      );
      this._result.set(result);
      this._status.set('submitted');
      return result;
    } catch (err: unknown) {
      const error = err instanceof InterviewApiError ? err : new InterviewApiError('UNKNOWN', 0);
      this._error.set(error);
      throw error;
    } finally {
      this._submitting.set(false);
    }
  }

  /**
   * Resolve once every in-flight save has settled. Rejects when the LATEST
   * attempt for any question failed — Stage 9D gates submission on this.
   */
  async awaitPendingSaves(): Promise<void> {
    const chains = [...this.saveState.values()].map((state) => state.chain);
    await Promise.all(chains);

    for (const [questionId, state] of this.saveState) {
      if (state.confirmedVersion < state.requestedVersion) {
        throw new InterviewApiError('UNKNOWN', 0);
      }
      void questionId;
    }
  }
}
