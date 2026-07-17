import { computed, Injectable, inject, signal } from '@angular/core';

import { AssessmentConfig } from '../../../models/AssessmentConfig.model';
import { GeneratedAssessment } from '../../../models/GeneratedAssessment.model';
import { InterviewSessionStatus } from '../../../models/InterviewSession.model';

import { AssessmentBuilderService } from '../assessment/assessment-builder.service';
import { FeedbackPolicyService } from './feedback-policy.service';

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

  private readonly _assessment = signal<GeneratedAssessment | null>(null);
  readonly assessment = this._assessment.asReadonly();

  private readonly _currentIndex = signal<number>(0);
  readonly currentIndex = this._currentIndex.asReadonly();

  // display index → selected optionIds
  private readonly _answersByIndex = signal<Record<number, number[]>>({});
  readonly answersByIndex = this._answersByIndex.asReadonly();

  private readonly _status = signal<InterviewSessionStatus>('active');
  readonly status = this._status.asReadonly();

  readonly total = computed(() => this._assessment()?.questions?.length ?? 0);

  readonly hasActiveSession = computed(() => this.total() > 0);

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
  readonly unansweredCount = computed(() => Math.max(0, this.total() - this.answeredCount()));

  // Build a temporary assessment and begin the session. Throws (via the builder)
  // if the pool can't satisfy the request — callers validate first.
  start(config: AssessmentConfig): GeneratedAssessment {
    const assessment = this.builder.build(config);
    this._assessment.set(assessment);
    this._currentIndex.set(0);
    this._answersByIndex.set({});
    this._status.set('active');
    return assessment;
  }

  // Enter the interview: defer correctness feedback. Called by the session
  // component ON MOUNT (not by start()), so 'deferred' is only ever active while
  // the interview screen is displayed — it can never get stuck on if navigation
  // into the session fails.
  activateDeferredFeedback(): void {
    this.feedbackPolicy.setMode('deferred');
  }

  // ── navigation (index only; no router, no URL) ──────────────────
  goTo(index: number): void {
    const max = this.total() - 1;
    if (max < 0) return;
    this._currentIndex.set(Math.min(Math.max(index, 0), max));
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
  }

  isAnswered(index: number): boolean {
    return (this._answersByIndex()[index]?.length ?? 0) > 0;
  }

  // Tear the session down (on leave, submit, or abandon). ALWAYS restores
  // immediate feedback so Interview state can never leak into normal topic
  // quizzes — the session component calls this on destroy, and submission too.
  clear(): void {
    this._assessment.set(null);
    this._currentIndex.set(0);
    this._answersByIndex.set({});
    this._status.set('active');
    this.feedbackPolicy.reset();
  }
}
