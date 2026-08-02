import { ChangeDetectionStrategy, Component, inject, ViewEncapsulation } from '@angular/core';
import { Router } from '@angular/router';

import { BackendInterviewSessionService } from '../../../shared/services/interview/backend-interview-session.service';

/**
 * TEMPORARY Stage 9C handoff shell for `/interview/session/:sessionId`.
 *
 * The backend session now exists and is hydrated, but the real backend-backed
 * renderer arrives in Stage 9D. This shell exists so the builder's navigation
 * target is a real route rather than a 404, and so the session is visibly
 * mid-migration instead of silently broken.
 *
 * It deliberately renders NO questions. It does not touch the old
 * InterviewSessionService and it never maps backend questions into the
 * topic-quiz model — no `correct: false`, no empty `explanation`.
 *
 * DELETE THIS COMPONENT IN STAGE 9D, replacing the route with the real session
 * component.
 */
@Component({
  selector: 'codelab-interview-session-handoff',
  standalone: true,
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ish">
      <h1 class="ish__title" i18n>Preparing your interview…</h1>
      <p class="ish__text" i18n>
        Your assessment has been created on the server with
        {{ questionCount() }} questions. The updated interview screen is being
        connected.
      </p>
      <button type="button" class="ish__btn" (click)="backToBuilder()" i18n>
        Back to Build Your Interview
      </button>
    </div>
  `,
  styles: [`
    .ish { max-width: 620px; margin: 0 auto; padding: 32px 20px; text-align: center; }
    .ish__title { margin: 0 0 12px; font-size: 22px; font-weight: 800; }
    .ish__text { margin: 0 0 20px; font-size: 15px; line-height: 1.5; color: var(--text-secondary, #6a6a6a); }
    .ish__btn {
      min-height: 42px; padding: 8px 18px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--accent, #007aff); background: transparent; color: var(--accent, #007aff);
      font-size: 14px; font-weight: 700;
    }
  `]
})
export class InterviewSessionHandoffComponent {
  private readonly session = inject(BackendInterviewSessionService);
  private readonly router = inject(Router);

  readonly questionCount = this.session.questionCount;

  /** Leaves the session reference intact so Stage 9D can resume it. */
  async backToBuilder(): Promise<void> {
    await this.router.navigate(['/interview']);
  }
}
