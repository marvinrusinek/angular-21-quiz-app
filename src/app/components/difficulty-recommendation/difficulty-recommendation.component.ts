import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import {
  DifficultyAction,
  DifficultyRecommendation
} from '../../shared/models/difficulty-recommendation.model';

/**
 * Compact, advisory "Difficulty Recommendation" card for Quiz Selection, shown
 * beneath the Recommended Next Quiz card. Pure presentation: renders an
 * already-derived recommendation and emits the user's intent; the parent owns
 * navigation (Interview Builder / browsing). No readiness logic here.
 */
@Component({
  selector: 'codelab-difficulty-recommendation',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  template: `
    @if (recommendation(); as r) {
      <section class="dr" aria-labelledby="dr-heading" [class.dr--complete]="r.level === 'complete'">
        <p id="dr-heading" class="dr__heading">
          @if (r.level === 'complete') {
            <span class="dr__icon" aria-hidden="true">💼</span>
          }
          {{ r.heading }}
        </p>
        @if (r.message) {
          <p class="dr__message">{{ r.message }}</p>
        }

        @if (r.action; as a) {
          <button
            type="button"
            class="dr__btn"
            [class.dr__btn--ghost]="a.kind === 'browse'"
            (click)="act(a)"
            [attr.aria-label]="a.label"
          >
            {{ a.label }}
          </button>
        }
      </section>
    }
  `,
  styles: [`
    .dr {
      max-width: 560px;
      margin: 10px auto 18px;
      padding: 14px 18px;
      border: 1px solid var(--border-color, #e0e0e0);
      border-radius: 12px;
      background: var(--bg-secondary, #f5f5f5);
      box-sizing: border-box;
    }

    .dr__heading {
      margin: 0 0 6px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: var(--text-secondary, #555);
    }

    .dr--complete .dr__heading {
      /* Celebratory completion — a touch more prominent, still understated. */
      font-size: 15px;
      letter-spacing: 0.2px;
      text-transform: none;
      color: var(--text-primary, #212121);
    }

    .dr__icon {
      margin-right: 4px;
    }

    .dr__message {
      margin: 0 0 12px;
      font-size: 14px;
      line-height: 1.45;
      color: var(--text-primary, #212121);
    }

    .dr__message:last-child {
      margin-bottom: 0;
    }

    .dr__btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 16px;
      border: 1px solid #3b98fd;
      border-radius: 8px;
      background: #3b98fd;
      color: #fff;
      font-size: 13.5px;
      font-weight: 700;
      cursor: pointer;
      transition: filter 0.15s ease, background 0.15s ease, color 0.15s ease;
    }

    /* Browse is a lighter, secondary affordance (informational, not a primary CTA). */
    .dr__btn--ghost {
      background: transparent;
      color: #3b98fd;
    }

    .dr__btn:hover {
      filter: brightness(0.96);
    }

    .dr__btn--ghost:hover {
      background: rgba(59, 152, 253, 0.1);
    }

    .dr__btn:focus-visible {
      outline: 2px solid #3b98fd;
      outline-offset: 2px;
    }

    @media (max-width: 600px) {
      .dr__btn {
        width: 100%;
      }
    }
  `]
})
export class DifficultyRecommendationComponent {
  readonly recommendation = input.required<DifficultyRecommendation | null>();

  /** Emits when the user chooses to build an interview (completion state). */
  readonly buildInterview = output<void>();
  /** Emits the target difficulty when the user chooses to browse those quizzes. */
  readonly browse = output<string>();

  // Kept for template clarity; routing decisions stay in the parent.
  protected readonly hasAction = computed(() => !!this.recommendation()?.action);

  act(action: DifficultyAction): void {
    if (action.kind === 'interview') {
      this.buildInterview.emit();
    } else {
      this.browse.emit(action.difficulty ?? '');
    }
  }
}
