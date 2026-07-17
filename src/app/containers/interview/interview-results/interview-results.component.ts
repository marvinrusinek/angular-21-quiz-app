import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  ViewEncapsulation
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';

import { formatMMSS } from '../../../shared/utils/format-time';
import { InterviewSessionService } from '../../../shared/services/features/interview/interview-session.service';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';
import { InterviewReviewComponent } from '../../../components/interview/interview-review/interview-review.component';

/**
 * Interview Results ("Assessment Complete"). Self-contained score summary +
 * per-topic breakdown from the submitted result. It NEVER writes topic-quiz
 * progress/best-score/achievement state. Full Review (per-question answers +
 * explanations) is added in the next milestone.
 */
@Component({
  selector: 'codelab-interview-results',
  standalone: true,
  imports: [CommonModule, ThemeToggleComponent, InterviewReviewComponent],
  templateUrl: './interview-results.component.html',
  styleUrls: ['./interview-results.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewResultsComponent {
  private readonly session = inject(InterviewSessionService);
  private readonly router = inject(Router);

  readonly result = this.session.result;
  readonly assessment = this.session.assessment;
  readonly answersByIndex = this.session.answersByIndex;
  readonly timeUsed = computed(() => formatMMSS(this.result()?.timeUsedSeconds ?? 0));

  readonly reviewQuestions = computed(() => this.assessment()?.questions ?? []);
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
