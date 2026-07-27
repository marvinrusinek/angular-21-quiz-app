import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  ViewEncapsulation
} from '@angular/core';

import { Option } from '../../../shared/models/Option.model';
import { pinAllOfTheAboveLast } from '../../../shared/utils/all-of-the-above';

/**
 * Self-contained option list for Interview Mode. It renders the current
 * question's options using the shared option styling (light-gray `--bg-option`,
 * neutral selected) but owns NO quiz-load lifecycle — so it always renders,
 * stays clickable, and refreshes cleanly when the `options` input changes on
 * navigation. It NEVER shows correctness (that's reserved for Results/Review);
 * only a neutral selected marker.
 *
 * Single- vs multiple-answer is inferred from the number of correct options
 * (used only to pick radio vs checkbox — correctness itself is never displayed).
 */
@Component({
  selector: 'app-interview-options',
  standalone: true,
  templateUrl: './interview-options.component.html',
  styleUrls: ['./interview-options.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewOptionsComponent {
  readonly options = input.required<Option[]>();
  readonly selectedIds = input<number[]>([]);

  // Emits the full set of selected optionIds for the current question.
  readonly selectionChange = output<number[]>();

  // "All of the above" pinned last, mirroring the topic quiz display.
  readonly displayOptions = computed(() =>
    pinAllOfTheAboveLast([...(this.options() ?? [])], (o) => o?.text)
  );

  readonly isMultiSelect = computed(
    () => (this.options() ?? []).filter((o) => o?.correct === true).length > 1
  );

  private readonly selectedSet = computed(() => new Set(this.selectedIds() ?? []));

  isSelected(option: Option): boolean {
    return option.optionId != null && this.selectedSet().has(option.optionId);
  }

  onToggle(option: Option): void {
    const id = option.optionId;
    if (id == null) return;

    if (this.isMultiSelect()) {
      const next = new Set(this.selectedSet());
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      this.selectionChange.emit([...next]);
    } else {
      // Single-answer: selecting replaces the prior choice.
      this.selectionChange.emit([id]);
    }
  }
}
