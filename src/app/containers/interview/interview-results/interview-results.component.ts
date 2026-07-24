import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  ViewEncapsulation
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink } from '@angular/router';

import { formatMMSS } from '../../../shared/utils/format-time';
import { InterviewSessionService } from '../../../shared/services/features/interview/interview-session.service';
import { InterviewAnalyticsService } from '../../../shared/services/features/interview/interview-analytics.service';
import { InterviewHistoryService } from '../../../shared/services/features/interview/interview-history.service';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';
import { InterviewReviewComponent } from '../../../components/interview/interview-review/interview-review.component';
import { PerformanceTrendsComponent } from '../../../components/interview/performance-trends/performance-trends.component';
import { TopicPerformanceListComponent } from '../../../components/interview/topic-performance/topic-performance-list.component';
import { InterviewReadinessComponent } from '../../../components/interview/interview-readiness/interview-readiness.component';
import { InterviewReadinessService } from '../../../shared/services/features/interview/interview-readiness.service';
import { ScrollDownIndicatorComponent } from '../../../components/scroll-down-indicator/scroll-down-indicator.component';

/**
 * Interview Results ("Assessment Complete"). Self-contained score summary +
 * per-topic breakdown from the submitted result. It NEVER writes topic-quiz
 * progress/best-score/achievement state. Full Review (per-question answers +
 * explanations) is added in the next milestone.
 */
@Component({
  selector: 'codelab-interview-results',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    ThemeToggleComponent,
    InterviewReviewComponent,
    PerformanceTrendsComponent,
    TopicPerformanceListComponent,
    InterviewReadinessComponent,
    ScrollDownIndicatorComponent
  ],
  templateUrl: './interview-results.component.html',
  styleUrls: ['./interview-results.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewResultsComponent {
  private readonly session = inject(InterviewSessionService);
  private readonly router = inject(Router);
  private readonly analyticsService = inject(InterviewAnalyticsService);
  private readonly history = inject(InterviewHistoryService);
  private readonly readinessService = inject(InterviewReadinessService);

  readonly result = this.session.result;
  readonly assessment = this.session.assessment;
  readonly answersByIndex = this.session.answersByIndex;
  readonly timeUsed = computed(() => formatMMSS(this.result()?.timeUsedSeconds ?? 0));

  // Topic Performance analytics — REUSES result.perTopic (no re-scoring). Derives
  // per-topic bands + strongest / needs-review from the immutable result model.
  readonly analytics = computed(() => this.analyticsService.analyze(this.result()));

  // Performance Trends — derived purely from the persisted attempt history (which
  // already includes this attempt: it is recorded at submission, before Results
  // renders). Presentation only; storage + trend math live in the history service.
  readonly trends = this.history.trends;

  // Interview Readiness — coaching indicator derived from retained history (which
  // already includes this attempt). Presentation-free scoring lives in the service.
  readonly readiness = this.readinessService.readiness;

  readonly reviewQuestions = computed(() => this.assessment()?.questions ?? []);
  // The just-recorded attempt (last in history) — supplies Review's header meta
  // (attempt number + date). Read-only; never mutated.
  readonly latestAttempt = computed(() => this.history.history().at(-1) ?? null);
  readonly showReview = signal(false);

  toggleReview(): void {
    this.showReview.update((v) => !v);
  }

  buildAnother(): void {
    this.session.clear();
    this.router.navigate(['/interview']);
  }

  returnToSelection(): void {
    this.session.clear();
    this.router.navigate(['/quiz']);
  }
}
