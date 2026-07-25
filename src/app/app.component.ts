import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs/operators';

import { GoogleSpinnerComponent } from './components/google-spinner/google-spinner.component';
import { PwaUpdateService } from './shared/services/pwa-update.service';
import { QuizStartSpinnerService } from './shared/services/ui/quiz-start-spinner.service';

@Component({
  selector: 'codelab-root',
  standalone: true,
  imports: [RouterOutlet, GoogleSpinnerComponent],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  questionIndexKey = '';
  showOutlet = true;
  outletKey = '';

  // Drives the brief "Start the Quiz!" loading overlay (set by IntroductionComponent).
  readonly startSpinner = inject(QuizStartSpinnerService);

  // Detects a freshly deployed bundle (via the service worker) and offers a
  // one-click reload, so users don't have to hard-refresh to get the new version.
  private readonly pwaUpdate = inject(PwaUpdateService);

  private readonly router = inject(Router);

  constructor() {
    // Start watching for new deployed versions (no-op when the SW is disabled,
    // e.g. local dev). Prompts to reload on VERSION_READY.
    this.pwaUpdate.init();

    this.router.events.pipe(filter((event) => event instanceof NavigationEnd)).subscribe(() => {
      this.outletKey = this.router.url;
      const segments = this.router.url.split('/');
      const maybeIndex = segments[segments.length - 1];
      this.questionIndexKey = isNaN(+maybeIndex) ? '' : maybeIndex;

      // Force destroy and recreate router-outlet
      if (this.showOutlet) {
        this.showOutlet = false;
        setTimeout(() => {
          this.showOutlet = true;
        }, 0);
      }
    });
  }
}
