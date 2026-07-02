import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { AlphaDirection, DifficultyDirection } from '../../shared/models/QuizSort.type';

/**
 * Presentational sort control with two independent dimensions:
 *   - difficulty direction (↑ easiest-first / ↓ hardest-first) — the primary
 *     grouping, driven by two arrow buttons
 *   - alphabetical direction (A–Z / Z–A) applied WITHIN each difficulty group,
 *     driven by a dropdown
 * It holds NO sorting logic and knows nothing about quiz data — it reflects the
 * current values and emits changes; the parent performs the actual sort.
 */
@Component({
  selector: 'app-quiz-sort',
  standalone: true,
  imports: [MatIconModule, MatTooltipModule],
  templateUrl: './quiz-sort.component.html',
  styleUrls: ['./quiz-sort.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class QuizSortComponent {
  readonly difficultyDirection = input.required<DifficultyDirection>();
  readonly alphaDirection = input.required<AlphaDirection>();

  readonly difficultyDirectionChange = output<DifficultyDirection>();
  readonly alphaDirectionChange = output<AlphaDirection>();

  selectDifficulty(direction: DifficultyDirection): void {
    this.difficultyDirectionChange.emit(direction);
  }

  isDifficulty(direction: DifficultyDirection): boolean {
    return this.difficultyDirection() === direction;
  }

  onAlphaChange(value: string): void {
    if (value === 'az' || value === 'za') this.alphaDirectionChange.emit(value);
  }
}
