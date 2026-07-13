import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * The iconic Google-style loading spinner: a single SVG arc that continuously
 * rotates while its length grows/shrinks and its stroke cycles through the four
 * Google brand colors (blue → red → yellow → green). Presentation-only and
 * self-contained (no inputs) — drop it inside any loading placeholder.
 */
@Component({
  selector: 'app-google-spinner',
  standalone: true,
  imports: [],
  templateUrl: './google-spinner.component.html',
  styleUrls: ['./google-spinner.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class GoogleSpinnerComponent {}
