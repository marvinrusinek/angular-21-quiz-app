import { Service } from '@angular/core';
import { Subject } from 'rxjs';

@Service()
export class SharedVisibilityService {
  // ── properties ──────────────────────────────────────────────────
  private pageVisibilitySubject = new Subject<boolean>();
  pageVisibility$ = this.pageVisibilitySubject.asObservable();

  // ── constructor / lifecycle ─────────────────────────────────────
  constructor() {
    document.addEventListener('visibilitychange', () => {
      this.pageVisibilitySubject.next(document.hidden);
    });
  }
}
