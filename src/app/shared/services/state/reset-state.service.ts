import { Service } from '@angular/core';
import { Subject } from 'rxjs';

@Service()
export class ResetStateService {
  // ── properties ──────────────────────────────────────────────────
  private resetStateSource = new Subject<void>();
  resetState$ = this.resetStateSource.asObservable();

  private resetFeedbackSource = new Subject<void>();
  resetFeedback$ = this.resetFeedbackSource.asObservable();

  // ── public methods ──────────────────────────────────────────────
  triggerResetState(): void {
    this.resetStateSource.next();
  }

  triggerResetFeedback(): void {
    this.resetFeedbackSource.next();
  }
}
