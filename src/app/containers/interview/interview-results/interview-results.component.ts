import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  HostListener,
  inject,
  signal,
  viewChild,
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
    InterviewReadinessComponent
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

  // The Review heading — the scroll target. The cue is only shown once the
  // review is open (see the template @if), so the heading always exists when the
  // cue can be clicked.
  private readonly reviewHeading = viewChild<ElementRef<HTMLElement>>('reviewHeading');

  // The scroll cue's idle bounce runs until the user interacts. A click OR any
  // page scroll counts, so the hint stops nudging once its job is done.
  readonly hasInteracted = signal(false);

  // Cue travel direction. Flips at the extremes (bottom → up, top → down) and
  // persists in between, so repeated presses keep travelling the same way.
  readonly direction = signal<'down' | 'up'>('down');

  // Cue labels ($localize because they're bound via [attr.] — the template i18n
  // attribute can't apply to a dynamic binding).
  readonly cueDownAria = $localize`Scroll to Review Answers`;
  readonly cueUpAria = $localize`Scroll back to top`;
  readonly cueDownTitle = $localize`Review Answers`;
  readonly cueUpTitle = $localize`Back to top`;

  // Any scroll: stop the idle bounce, and update the travel direction.
  @HostListener('window:scroll')
  onWindowScroll(): void {
    if (!this.hasInteracted()) this.hasInteracted.set(true);
    this.recomputeDirection();
  }

  private recomputeDirection(): void {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    // 4px slack for rounding. Only the extremes flip direction.
    if (window.scrollY >= scrollable - 4) this.direction.set('up');
    else if (window.scrollY <= 4) this.direction.set('down');
  }

  toggleReview(): void {
    if (!this.showReview()) {
      // Opening: reset the cue to its initial "nudge down from the top" state.
      this.hasInteracted.set(false);
      this.direction.set('down');
    }
    this.showReview.update((v) => !v);
  }

  /**
   * Scroll cue click — elevator behaviour.
   *  - Going UP → page up by ~a screenful (repeated presses keep climbing until
   *    the top, where it flips back to down).
   *  - Going DOWN, review heading still below the fold → jump to it.
   *  - Going DOWN otherwise → page down by ~a screenful.
   * Native smooth scrolling only — no library.
   */
  onCueClick(): void {
    this.hasInteracted.set(true);
    const step = Math.round(window.innerHeight * 0.85);

    if (this.direction() === 'up') {
      window.scrollBy({ top: -step, left: 0, behavior: 'smooth' });
      return;
    }

    const heading = this.reviewHeading()?.nativeElement;
    if (heading && heading.getBoundingClientRect().top > 8) {
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    window.scrollBy({ top: step, left: 0, behavior: 'smooth' });
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
