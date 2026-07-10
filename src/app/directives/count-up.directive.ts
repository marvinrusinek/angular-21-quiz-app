import { afterNextRender, Directive, ElementRef, inject, input } from '@angular/core';

/**
 * Animates the host element's text from 0 up to a target number, once, on first
 * render. Subtle by design: ~0.8s ease-out, runs a single time, and respects
 * `prefers-reduced-motion` (those users see the final value immediately).
 *
 * Usage: <span [appCountUp]="quizStats().quizCount"></span>
 * The directive owns the element's text content while animating.
 */
@Directive({
  selector: '[appCountUp]',
  standalone: true
})
export class CountUpDirective {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The value to count up to. */
  readonly appCountUp = input.required<number>();
  /** Animation duration in milliseconds. */
  readonly countUpDuration = input(800);
  /** Delay before this number starts counting (used to stagger the row left-to-right). */
  readonly countUpDelay = input(0);

  constructor() {
    // afterNextRender only runs in the browser, so DOM/window APIs are safe here.
    afterNextRender(() => this.animate());
  }

  private animate(): void {
    const target = Math.round(this.appCountUp() ?? 0);
    const node = this.el.nativeElement;

    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

    if (prefersReduced || target <= 0) {
      node.textContent = String(target);
      return;
    }

    // Show 0 while waiting for this cell's turn (countUpDelay = 0 → all at once).
    node.textContent = '0';
    const duration = this.countUpDuration();
    const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

    setTimeout(() => {
      const start = performance.now();
      const tick = (now: number): void => {
        const progress = Math.min(1, (now - start) / duration);
        node.textContent = String(Math.round(easeOutCubic(progress) * target));
        if (progress < 1) {
          requestAnimationFrame(tick);
        } else {
          node.textContent = String(target);
          // A little scale-bounce as the number lands.
          node.classList.add('count-up-pop');
        }
      };
      requestAnimationFrame(tick);
    }, this.countUpDelay());
  }
}
