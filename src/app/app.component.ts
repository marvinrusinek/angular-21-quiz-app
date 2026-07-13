import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationStart,
  Router,
  RouterOutlet,
} from '@angular/router';
import { filter } from 'rxjs/operators';

import { GoogleSpinnerComponent } from './components/google-spinner/google-spinner.component';

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

  // Navigation spinner. The "before the first question loads" window is the
  // route RESOLVER (QuizResolverService) running during navigation to the quiz
  // question route — and resolvers run BEFORE QuizComponent activates, so a
  // spinner inside QuizComponent can never cover it. It belongs here, at the
  // router level. A short delay means instant (cached) navigations — including
  // Q1→Q2, which hit the resolver's fast path — never flash it; only a genuinely
  // slow first-question load keeps the spinner on screen.
  readonly navigating = signal(false);
  private navSpinnerTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly NAV_SPINNER_DELAY_MS = 150;

  constructor(private router: Router) {
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

    // Show the Google spinner while a quiz-question navigation is in flight.
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        if (event.url.includes('/quiz/question/')) {
          this.clearNavSpinnerTimer();
          this.navSpinnerTimer = setTimeout(
            () => this.navigating.set(true),
            AppComponent.NAV_SPINNER_DELAY_MS
          );
        }
      } else if (
        event instanceof NavigationEnd ||
        event instanceof NavigationCancel ||
        event instanceof NavigationError
      ) {
        this.clearNavSpinnerTimer();
        this.navigating.set(false);
      }
    });
  }

  private clearNavSpinnerTimer(): void {
    if (this.navSpinnerTimer !== null) {
      clearTimeout(this.navSpinnerTimer);
      this.navSpinnerTimer = null;
    }
  }
}
