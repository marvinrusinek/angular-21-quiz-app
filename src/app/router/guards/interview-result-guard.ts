import { inject, Service } from '@angular/core';
import { CanActivate, Router, UrlTree } from '@angular/router';

import { InterviewSessionService } from '../../shared/services/features/interview/interview-session.service';

/**
 * Protects the Interview Results route. Access requires a completed, submitted
 * result. Direct / stale access redirects safely to the builder — no score or
 * result data is ever exposed via route params.
 */
@Service()
export class InterviewResultGuard implements CanActivate {
  private readonly session = inject(InterviewSessionService);
  private readonly router = inject(Router);

  canActivate(): boolean | UrlTree {
    return this.session.hasResult()
      ? true
      : this.router.createUrlTree(['/interview']);
  }
}
