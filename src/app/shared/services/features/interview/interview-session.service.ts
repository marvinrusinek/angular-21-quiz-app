import { computed, Injectable, inject, signal } from '@angular/core';

import { AssessmentConfig } from '../../../models/AssessmentConfig.model';
import { GeneratedAssessment } from '../../../models/GeneratedAssessment.model';
import { InterviewResult } from '../../../models/InterviewResult.model';
import { InterviewSessionStatus } from '../../../models/InterviewSession.model';

import { getQuizData } from '../../../quiz-data-cache';
import { computeInterviewResult } from '../../../utils/interview-scoring';
import { SK_INTERVIEW_SESSION } from '../../../constants/session-keys';
import { readSessionJson, removeSessionKey, writeSessionJson } from '../../../utils/session-storage';

import { AssessmentBuilderService } from '../assessment/assessment-builder.service';
import { FeedbackPolicyService } from './feedback-policy.service';
import { InterviewHistoryService } from './interview-history.service';

// Persisted shape for resume (only an 'active' session is ever written).
interface PersistedInterviewSession {
  assessment: GeneratedAssessment;
  answersByIndex: Record<number, number[]>;
  currentIndex: number;
  expiresAt: number;        // epoch ms — drift-proof remaining time
  durationSeconds: number;
  attemptId?: string;       // stable id for this attempt (durable history dedup)
}

/**
 * Owns the active Interview session: the generated assessment, the per-question
 * answers, the current position, and the session status. It deliberately does
 * NOT touch any topic-quiz progress/best-score/achievement state, and it holds
 * its OWN current index (the session component mirrors it into
 * QuizService.currentQuestionIndexSig so the existing renderers stay in sync).
 *
 * Timer, sessionStorage persistence/resume, and submission land in a later
 * milestone.
 */
@Injectable({ providedIn: 'root' })
export class InterviewSessionService {
  private readonly builder = inject(AssessmentBuilderService);
  private readonly feedbackPolicy = inject(FeedbackPolicyService);
  private readonly history = inject(InterviewHistoryService);

  private readonly _assessment = signal<GeneratedAssessment | null>(null);
  readonly assessment = this._assessment.asReadonly();

  private readonly _currentIndex = signal<number>(0);
  readonly currentIndex = this._currentIndex.asReadonly();

  // display index → selected optionIds
  private readonly _answersByIndex = signal<Record<number, number[]>>({});
  readonly answersByIndex = this._answersByIndex.asReadonly();

  private readonly _status = signal<InterviewSessionStatus>('active');
  readonly status = this._status.asReadonly();

  private readonly _result = signal<InterviewResult | null>(null);
  readonly result = this._result.asReadonly();

  // Timer state (persisted for resume). Owned here so it survives a refresh; the
  // session component sets it from the timer on a fresh start and reads it back
  // to RESTORE the timer on resume.
  private _expiresAtMs = 0;
  private _durationSec = 0;
  private _restored = false;

  // A stable id for the current attempt, minted at start() and preserved across
  // a resume. Passed to the history service at submission so re-recording the
  // same finalized attempt is a durable no-op (survives reloads / reconstruction).
  private _attemptId = '';
  private _attemptSeq = 0;

  // Access to the interview Results route requires a completed result.
  readonly hasResult = computed(() => this._result() !== null && this._status() === 'submitted');

  readonly total = computed(() => this._assessment()?.questions?.length ?? 0);

  // Session-route access: a real generated assessment with a non-empty question
  // collection that is still ACTIVE (not submitted). This blocks re-entering the
  // session screen after submission — that state belongs on the Results route.
  readonly hasActiveSession = computed(
    () => this.total() > 0 && this._status() === 'active'
  );

  constructor() {
    // On first injection (e.g. a refresh landing on the guarded session route),
    // rehydrate an in-progress session from sessionStorage so the guard sees an
    // active session and the component can restore the same questions/answers/
    // position + remaining time.
    this.restoreFromStorage();
  }

  // Indices that have at least one selected option (for the paginator's
  // answered/unanswered state — NEVER correctness).
  readonly answeredIndices = computed<ReadonlySet<number>>(() => {
    const map = this._answersByIndex();
    const set = new Set<number>();
    for (const key of Object.keys(map)) {
      if ((map[+key]?.length ?? 0) > 0) set.add(+key);
    }
    return set;
  });

  readonly answeredCount = computed(() => this.answeredIndices().size);

  /**
   * THE single rule for forward navigation, consumed by BOTH the keyboard
   * (InterviewSessionComponent#onGlobalKey) and the paginator's Next button —
   * defined once here so the two can never drift apart.
   *
   * "Answered" deliberately means AT LEAST ONE option selected, for every
   * question type including multi-select. It must NOT require the selection
   * count to match the number of correct answers: that would let a user probe
   * Next to discover the hidden correct-answer count, which Interview Mode never
   * reveals during the assessment.
   *
   * Correctness and completeness are not validated here — that stays deferred
   * until submission. Previous navigation and direct page jumps are deliberately
   * NOT gated, so users can still skip, review and come back.
   */
  readonly canNavigateNext = computed<boolean>(() =>
    this.answeredIndices().has(this.currentIndex())
  );
  readonly unansweredCount = computed(() => Math.max(0, this.total() - this.answeredCount()));

  // Build a temporary assessment and begin the session. Throws (via the builder)
  // if the pool can't satisfy the request — callers validate first.
  start(config: AssessmentConfig): GeneratedAssessment {
    const assessment = this.builder.build(config);
    this._assessment.set(assessment);
    this._currentIndex.set(0);
    this._answersByIndex.set({});
    this._status.set('active');
    this._result.set(null);
    this._expiresAtMs = 0;
    this._durationSec = 0;
    this._restored = false;
    this._attemptId = this.newAttemptId();
    this.persist();
    return assessment;
  }

  private newAttemptId(): string {
    this._attemptSeq += 1;
    return `att_${Date.now().toString(36)}_${this._attemptSeq}`;
  }

  // Enter the interview: defer correctness feedback. Called by the session
  // component ON MOUNT (not by start()), so 'deferred' is only ever active while
  // the interview screen is displayed — it can never get stuck on if navigation
  // into the session fails.
  activateDeferredFeedback(): void {
    this.feedbackPolicy.setMode('deferred');
  }

  // Restored-from-storage flag + persisted timer state, read by the session
  // component to decide whether to RESTORE the timer (resume) or START it fresh.
  wasRestored(): boolean {
    return this._restored;
  }

  expiresAt(): number {
    return this._expiresAtMs;
  }

  timerDurationSeconds(): number {
    return this._durationSec;
  }

  // Record the countdown's expiry timestamp + duration (from the timer) so a
  // refresh can restore the correct remaining time.
  setTiming(expiresAtMs: number, durationSeconds: number): void {
    this._expiresAtMs = expiresAtMs;
    this._durationSec = durationSeconds;
    this.persist();
  }

  // ── navigation (index only; no router, no URL) ──────────────────
  goTo(index: number): void {
    const max = this.total() - 1;
    if (max < 0) return;
    this._currentIndex.set(Math.min(Math.max(index, 0), max));
    this.persist();
  }

  next(): void {
    this.goTo(this._currentIndex() + 1);
  }

  previous(): void {
    this.goTo(this._currentIndex() - 1);
  }

  // ── answers ─────────────────────────────────────────────────────
  setAnswer(index: number, optionIds: number[]): void {
    this._answersByIndex.update((map) => ({ ...map, [index]: [...optionIds] }));
    this.persist();
  }

  isAnswered(index: number): boolean {
    return (this._answersByIndex()[index]?.length ?? 0) > 0;
  }

  // ── submission ──────────────────────────────────────────────────
  // Score + finalize the assessment. Idempotent (double-submit guard): once
  // submitted it returns the stored result and re-scores nothing — so a manual
  // submit and a timer-expiry submit racing produce ONE result. Restores
  // immediate feedback (the interview is over) but KEEPS the assessment/answers/
  // result so the Results + Review can read them.
  submit(
    timeUsedSeconds: number,
    timeRemainingSeconds: number,
    submittedByExpiry: boolean,
    focusChanges = 0
  ): InterviewResult | null {
    if (this._status() === 'submitted') {
      return this._result();
    }
    const assessment = this._assessment();
    if (!assessment) {
      return null;
    }
    const result = computeInterviewResult(
      assessment,
      this._answersByIndex(),
      timeUsedSeconds,
      timeRemainingSeconds,
      submittedByExpiry,
      (quizId) => getQuizData().find((q) => q.quizId === quizId)?.milestone ?? quizId,
      focusChanges
    );
    this._status.set('submitted');
    this._result.set(result);
    this.feedbackPolicy.reset();
    // Persist this completed attempt to Interview Mode history EXACTLY ONCE. This
    // is the single finalization chokepoint — the early-return above makes submit
    // idempotent, so a manual submit racing a timer-expiry submit records one
    // attempt, and a Results re-render / refresh / Review toggle never re-enters
    // here. History is compact analytics only; it never touches topic-quiz state.
    this.history.record(result, this._attemptId, {
      questions: assessment.questions ?? [],
      answersByIndex: this._answersByIndex()
    });
    // Submitted → no longer resumable; drop the persisted active session.
    this.persist();
    return result;
  }

  // Tear the session down (on abandon, or when leaving the Results page). ALWAYS
  // restores immediate feedback so Interview state can never leak into normal
  // topic quizzes, and drops any persisted session.
  clear(): void {
    this._assessment.set(null);
    this._currentIndex.set(0);
    this._answersByIndex.set({});
    this._status.set('active');
    this._result.set(null);
    this._expiresAtMs = 0;
    this._durationSec = 0;
    this._restored = false;
    this._attemptId = '';
    this.feedbackPolicy.reset();
    removeSessionKey(SK_INTERVIEW_SESSION);
  }

  // ── persistence / resume ────────────────────────────────────────
  private persist(): void {
    // Only an ACTIVE session with a real assessment is resumable.
    if (this._status() !== 'active' || (this._assessment()?.questions?.length ?? 0) === 0) {
      removeSessionKey(SK_INTERVIEW_SESSION);
      return;
    }
    const payload: PersistedInterviewSession = {
      assessment: this._assessment()!,
      answersByIndex: this._answersByIndex(),
      currentIndex: this._currentIndex(),
      expiresAt: this._expiresAtMs,
      durationSeconds: this._durationSec,
      attemptId: this._attemptId
    };
    writeSessionJson(SK_INTERVIEW_SESSION, payload);
  }

  private restoreFromStorage(): void {
    const saved = readSessionJson<PersistedInterviewSession | null>(SK_INTERVIEW_SESSION, null);
    if (!saved?.assessment?.questions?.length) {
      return;
    }
    this._assessment.set(saved.assessment);
    this._answersByIndex.set(saved.answersByIndex ?? {});
    const max = saved.assessment.questions.length - 1;
    this._currentIndex.set(Math.min(Math.max(saved.currentIndex ?? 0, 0), max));
    this._status.set('active');
    this._result.set(null);
    this._expiresAtMs = saved.expiresAt ?? 0;
    this._durationSec = saved.durationSeconds ?? 0;
    this._attemptId = saved.attemptId ?? this.newAttemptId();
    this._restored = true;
  }
}
