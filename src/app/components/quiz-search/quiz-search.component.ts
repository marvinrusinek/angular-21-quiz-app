import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/**
 * Presentational search box. It renders an input (with an optional leading
 * icon and an optional clear button) and emits the current text — it does NOT
 * know about quiz data, filtering or sorting. The parent owns the state.
 */
@Component({
  selector: 'app-quiz-search',
  standalone: true,
  imports: [MatIconModule],
  templateUrl: './quiz-search.component.html',
  styleUrls: ['./quiz-search.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class QuizSearchComponent {
  // Current text (owned by the parent; this component is a controlled input).
  readonly searchTerm = input('');
  // Presentation toggles.
  readonly showIcon = input(true);
  readonly showClear = input(true);
  readonly placeholder = input('Search quizzes…');

  readonly searchTermChange = output<string>();

  onInput(value: string): void {
    this.searchTermChange.emit(value);
  }

  clear(): void {
    this.searchTermChange.emit('');
  }
}
