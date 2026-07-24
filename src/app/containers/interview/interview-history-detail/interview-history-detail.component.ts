import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  ViewEncapsulation
} from '@angular/core';
import { CommonModule, ViewportScroller } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';

import { formatDuration } from '../../../shared/utils/format-time';
import { InterviewResult } from '../../../shared/models/InterviewResult.model';
import { InterviewDifficulty } from '../../../shared/models/AssessmentConfig.model';
import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';
import { InterviewAttemptHistoryEntry } from '../../../shared/models/interview-history.model';
import { InterviewHistoryService } from '../../../shared/services/features/interview/interview-history.service';
import { InterviewAnalyticsService } from '../../../shared/services/features/interview/interview-analytics.service';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';
import { TopicPerformanceListComponent } from '../../../components/interview/topic-performance/topic-performance-list.component';
import { InterviewReviewComponent } from '../../../components/interview/interview-review/interview-review.component';
import { ScrollDownIndicatorComponent } from '../../../components/scroll-down-indicator/scroll-down-indicator.component';

/**
 * Read-only historical Interview summary. Reopens the details for ONE past
 * attempt (by id) from the shared InterviewHistoryService — it reconstructs an
 * InterviewResult from the compact stored analytics purely to reuse
 * InterviewAnalyticsService + the Topic Performance presentation.
 *
 * Strictly historical + read-only: no session, no timer, no answer controls, no
 * path back into an active interview. When the attempt retained a per-question
 * review snapshot it reopens the read-only Review Answers list (reusing
 * InterviewReviewComponent); legacy attempts without one show the "not retained"
 * note instead.
 */
@Component({
  selector: 'codelab-interview-history-detail',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    ThemeToggleComponent,
    TopicPerformanceListComponent,
    InterviewReviewComponent,
    ScrollDownIndicatorComponent
  ],
  templateUrl: './interview-history-detail.component.html',
  styleUrls: ['./interview-history-detail.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewHistoryDetailComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly history = inject(InterviewHistoryService);
  private readonly analyticsService = inject(InterviewAnalyticsService);
  private readonly viewport = inject(ViewportScroller);

  constructor() {
    // Deep-link support: arriving with #review (e.g. the "Review Answers"
    // shortcut on a History card) scrolls straight to the answers once rendered.
    afterNextRender(() => {
      if (this.route.snapshot.fragment === 'review' && this.hasReview()) {
        this.viewport.scrollToAnchor('review');
      }
    });
  }

  private readonly params = toSignal(this.route.paramMap, { initialValue: null });
  readonly id = computed(() => this.params()?.get('id') ?? null);

  // The requested attempt + its lifetime attempt number, or null if not found.
  readonly found = computed(() => {
    const all = this.history.history();
    const id = this.id();
    const index = all.findIndex((e) => e.id === id);
    if (index === -1) return null;
    const entry = all[index];
    // "of M" uses the highest lifetime attempt number (the newest retained entry
    // always holds it), so it stays correct even after older attempts age out.
    const total = all.reduce((m, e, i) => Math.max(m, e.attemptNumber ?? i + 1), all.length);
    return { entry, number: entry.attemptNumber ?? index + 1, total };
  });

  readonly entry = computed<InterviewAttemptHistoryEntry | null>(() => this.found()?.entry ?? null);

  // Reconstruct an InterviewResult once — reused for both the analytics pipeline
  // (topic bands, highlights) and the Review Answers summary/topic-name lookup.
  readonly result = computed<InterviewResult | null>(() => {
    const e = this.entry();
    return e ? toResult(e) : null;
  });

  readonly analytics = computed(() => {
    const r = this.result();
    return r ? this.analyticsService.analyze(r) : null;
  });

  // Whether this attempt retained a per-question review snapshot.
  readonly hasReview = computed(() => (this.entry()?.review?.length ?? 0) > 0);

  // Rebuild the read-only Review inputs from the stored snapshot. These are inert
  // plain-data QuizQuestion/answers shapes — never a live/scoreable session.
  readonly reviewQuestions = computed<QuizQuestion[]>(() =>
    (this.entry()?.review ?? []).map((s) => ({
      questionText: s.questionText,
      explanation: s.explanation,
      type: s.type,
      sourceQuizId: s.sourceQuizId,
      options: s.options.map((o) => ({ optionId: o.optionId, text: o.text, correct: o.correct }))
    }))
  );

  readonly reviewAnswers = computed<Record<number, number[]>>(() => {
    const out: Record<number, number[]> = {};
    (this.entry()?.review ?? []).forEach((s, i) => {
      out[i] = [...s.selectedOptionIds];
    });
    return out;
  });

  // Performance context — reuse the shared trends (no independent recalculation).
  readonly trends = this.history.trends;

  // An unretained duration reads as "Not recorded" — never a misleading "0s".
  duration(seconds: number | undefined): string {
    return seconds == null ? $localize`Not recorded` : formatDuration(seconds);
  }

  completionLabel(entry: InterviewAttemptHistoryEntry): string {
    return entry.completionReason === 'time-expired'
      ? $localize`Time expired`
      : $localize`Submitted`;
  }

  /** "July 21, 2026" — locale-formatted, safe fallback. */
  formatDate(iso: string): string {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return iso;
    }
  }
}

// Reconstruct an InterviewResult from a compact history entry. When a review
// snapshot was retained, answered/unanswered/incorrect are derived accurately
// from it (a question with no selection is unanswered, not incorrect). Without
// one, we fall back to treating every question as answered — focusChanges is not
// retained and is not shown.
function toResult(e: InterviewAttemptHistoryEntry): InterviewResult {
  const unanswered = e.review
    ? e.review.filter((q) => (q.selectedOptionIds?.length ?? 0) === 0).length
    : 0;
  const answered = Math.max(0, e.totalQuestions - unanswered);
  return {
    total: e.totalQuestions,
    answered,
    unanswered,
    correct: e.score,
    incorrect: Math.max(0, answered - e.score),
    percentage: e.percentage,
    timeUsedSeconds: e.durationSeconds ?? 0,
    timeRemainingSeconds: 0,
    difficulty: (e.configuredDifficulty ?? 'mixed') as InterviewDifficulty,
    topicIds: [...(e.selectedTopicIds ?? [])],
    perTopic: e.topicPerformance.map((t) => ({
      quizId: t.topicId,
      title: t.topicName,
      correct: t.correct,
      total: t.total,
      percentage: t.percentage
    })),
    submittedByExpiry: e.completionReason === 'time-expired',
    focusChanges: 0
  };
}
