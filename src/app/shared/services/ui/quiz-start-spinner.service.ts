import { Service, signal } from '@angular/core';

/**
 * Drives the brief "starting the quiz" loading overlay. IntroductionComponent
 * calls showForStart() when the user clicks "Start the Quiz!" and awaits it
 * BEFORE navigating to Q1 — so the overlay plays over the intro and the first
 * question's timer doesn't start (and tick) behind it. AppComponent renders the
 * overlay; it fades out over the freshly-loaded Q1 once navigation happens.
 *
 * Deliberately time-boxed to one full spinner rotation: the quiz data is already
 * cached by the time Start is clicked, so this is a polished transition, NOT a
 * data-load indicator. Shown ONLY on Start (never on Next/Previous or while
 * browsing the Quiz Selection screen).
 */
@Service()
export class QuizStartSpinnerService {
  // Hold over the intro for one full spinner rotation (slightly longer than the
  // 1.5s CSS rotation) before the caller navigates to Q1. Time-boxed on purpose:
  // the data's already cached, so this is a brief polished transition.
  private static readonly ROTATION_MS = 1600;
  private static readonly DEFAULT_LABEL = $localize`Preparing quiz…`;

  private readonly _visible = signal(false);
  readonly visible = this._visible.asReadonly();
  // The overlay label. Defaults to the quiz-start wording; Interview Mode passes
  // "Preparing Interview…" so the same single overlay is reused (never duplicated).
  private readonly _label = signal<string>(QuizStartSpinnerService.DEFAULT_LABEL);
  readonly label = this._label.asReadonly();
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Show the spinner (over the intro) and resolve after one full rotation. The
   * caller navigates to Q1 on resolve; the overlay begins fading out at the same
   * moment, so it fades away over the fresh question with only a sliver of timer
   * time spent behind the fade. An optional label overrides the default wording.
   */
  showForStart(label: string = QuizStartSpinnerService.DEFAULT_LABEL): Promise<void> {
    this._label.set(label);
    this._visible.set(true);
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    return new Promise<void>((resolve) => {
      this.timer = setTimeout(() => {
        this._visible.set(false);  // begin fading out (CSS opacity transition)
        this.timer = null;
        resolve();                 // caller navigates to Q1 now
      }, QuizStartSpinnerService.ROTATION_MS);
    });
  }
}
