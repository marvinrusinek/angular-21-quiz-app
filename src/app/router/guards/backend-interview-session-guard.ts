import { inject, Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, CanActivate, Router, UrlTree } from '@angular/router';

import { BackendInterviewSessionService } from '../../shared/services/interview/backend-interview-session.service';
import { InterviewSessionReferenceStorage } from '../../shared/services/interview/interview-session-reference.storage';

/**
 * THE single hydration pipeline for `/interview/session/:sessionId`.
 *
 * Resume happens here and nowhere else — the component reads already-hydrated
 * state, so there is exactly one HTTP call per navigation.
 *
 * Outcomes:
 *   active        allow
 *   none          no stored reference        → builder
 *   mismatch      route id ≠ stored id       → builder (reference kept: it may
 *                                              belong to a different, valid tab)
 *   unauthorized  reference already cleared  → builder
 *   expired       ALLOW — the component finalizes and forwards to results
 *   submitted     → results
 *   unavailable   ALLOW — the component shows a retry state; the reference is
 *                 deliberately preserved so a transient outage cannot destroy a
 *                 live assessment
 */
@Injectable({ providedIn: 'root' })
export class BackendInterviewSessionGuard implements CanActivate {
  private readonly session = inject(BackendInterviewSessionService);
  private readonly storage = inject(InterviewSessionReferenceStorage);
  private readonly router = inject(Router);

  async canActivate(route: ActivatedRouteSnapshot): Promise<boolean | UrlTree> {
    const routeSessionId = route.paramMap.get('sessionId') ?? '';
    const reference = this.storage.read();

    if (!reference) return this.toBuilder();

    // A route id that does not match the stored reference is not authorized by
    // it. The reference is left intact rather than destroyed on the strength of
    // a URL someone may have typed.
    if (routeSessionId !== reference.sessionId) return this.toBuilder();

    const outcome = await this.session.resumeFromStoredReference();

    switch (outcome.kind) {
      case 'active':
      case 'expired':
      case 'unavailable':
        return true;
      case 'submitted':
        return this.router.createUrlTree(['/interview/results']);
      case 'unauthorized':
      case 'none':
      default:
        return this.toBuilder();
    }
  }

  private toBuilder(): UrlTree {
    return this.router.createUrlTree(['/interview']);
  }
}
