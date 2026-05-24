import { DestroyRef, Directive, ElementRef, inject, Renderer2, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { ResetBackgroundService } from '../shared/services/ui/reset-background.service';

@Directive({
  selector: '[appResetBackground]',
  standalone: true
})
export class ResetBackgroundDirective {
  // ── injects ─────────────────────────────────────────────────────
  private readonly destroyRef = inject(DestroyRef);
  private readonly el = inject(ElementRef);
  private readonly renderer = inject(Renderer2);
  private readonly resetBackgroundService = inject(ResetBackgroundService);

  // ── inputs ──────────────────────────────────────────────────────
  readonly appResetBackground = input(false);

  constructor() {
    this.resetBackgroundService.shouldResetBackground$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => {
        if (value) {
          this.resetBackground();
        }
      });
  }

  private resetBackground(): void {
    this.renderer.setStyle(this.el.nativeElement, 'background-color', 'white');
  }
}
