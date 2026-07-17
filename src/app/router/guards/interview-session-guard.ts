import { inject, Injectable } from '@angular/core';
import { CanActivate, Router, UrlTree } from '@angular/router';

import { InterviewSessionService } from '../../shared/services/features/interview/interview-session.service';

/**
 * Protects the URL-less Interview session route. Access requires a generated
 * assessment with a non-empty question collection (i.e. the user came through
 * Build Your Interview and pressed Start). Direct / stale / malformed access
 * redirects safely to the builder — no question index, score, or config is ever
 * exposed as a route param.
 */
@Injectable({ providedIn: 'root' })
export class InterviewSessionGuard implements CanActivate {
  private readonly session = inject(InterviewSessionService);
  private readonly router = inject(Router);

  canActivate(): boolean | UrlTree {
    return this.session.hasActiveSession()
      ? true
      : this.router.createUrlTree(['/interview']);
  }
}
