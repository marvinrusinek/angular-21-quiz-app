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
 * Self-contained option list for Weak Areas Practice.
 *
 * Modelled on InterviewOptionsComponent (same shared option styling, same
 * ownership of no quiz-load lifecycle) with ONE deliberate difference: practice
 * is a learning mode, so it reveals correctness inline rather than deferring it
 * the way Interview Mode does.
 *
 * It is a separate component rather than a flag on the interview one because
 * that component documents "NEVER shows correctness" as an invariant; adding a
 * mode would erode a guarantee Interview Mode depends on. It is equally NOT the
 * shared-option pipeline, whose sharedOptionConfig/explanation machinery has
 * historically been the source of FET flicker bugs.
 *
 * The reveal/lock rules reproduce the VERIFIED topic quiz exactly:
 *   - A wrong pick is marked wrong IMMEDIATELY, but the correct answer is NOT
 *     revealed and the options stay clickable, so the user can change it
 *     (qqc-orch-click.service.ts:167 — the disable pass runs only when the click
 *     was correct).
 *   - Once the question is RESOLVED (single: the correct option; multi: the
 *     exact correct set) the correct answers are revealed and the options lock.
 */
@Component({
  selector: 'app-practice-options',
  standalone: true,
  templateUrl: './practice-options.component.html',
  styleUrls: ['./practice-options.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PracticeOptionsComponent {
  readonly options = input.required<Option[]>();
  readonly selectedIds = input<number[]>([]);

  /**
   * True once the question is fully, exactly right — reveals the correct answers
   * and locks the list. A merely-answered (but wrong) question is NOT resolved.
   */
  readonly resolved = input<boolean>(false);

  readonly selectionChange = output<number[]>();

  /** "All of the above" pinned last, mirroring the topic quiz display. */
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

  /** The correct answers are revealed only once the question is RESOLVED. */
  isCorrectOption(option: Option): boolean {
    return this.resolved() && option.correct === true;
  }

  /**
   * A wrong pick the user actually made. Shown IMMEDIATELY — the topic quiz
   * marks a wrong click wrong at once; it just does not give away the answer.
   */
  isIncorrectChoice(option: Option): boolean {
    return this.isSelected(option) && option.correct !== true;
  }

  /** Status text per option, so correctness is never conveyed by colour alone. */
  statusLabel(option: Option): string {
    if (this.isCorrectOption(option)) return $localize`Correct answer`;
    if (this.isIncorrectChoice(option)) return $localize`Your answer — incorrect`;
    return '';
  }

  onToggle(option: Option): void {
    if (this.resolved()) return;   // locks only once fully correct
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
      this.selectionChange.emit([id]);
    }
  }
}
