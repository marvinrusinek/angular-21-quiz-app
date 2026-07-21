import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
  ViewEncapsulation
} from '@angular/core';
import { CommonModule } from '@angular/common';

import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';
import { pinAllOfTheAboveLast } from '../../../shared/utils/all-of-the-above';
import { isAnswerCorrect } from '../../../shared/utils/interview-scoring';
import {
  REVIEW_FILTERS,
  ReviewFilterDef,
  ReviewFilterId,
  ReviewStatus
} from './interview-review-filters';

// Re-exported so existing importers keep working after the type moved to the
// pure filters module.
export type { ReviewStatus, ReviewFilterId };

interface ReviewOption {
  text: string;
  correct: boolean;
  selected: boolean;
}

interface ReviewItem {
  number: number;
  questionText: string;
  explanation: string;
  status: ReviewStatus;
  /** Reserved for a future flagging feature; always false until then. */
  flagged: boolean;
  options: ReviewOption[];
}

/**
 * Post-submission per-question Review for Interview Mode. Unlike the active
 * assessment (feedback deferred), the Review DOES show correctness: each
 * question's status, the user's selected answer(s), the correct answer(s), and
 * the explanation. Filterable by all / correct / incorrect. Read-only.
 */
@Component({
  selector: 'app-interview-review',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './interview-review.component.html',
  styleUrls: ['./interview-review.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class InterviewReviewComponent {
  readonly questions = input.required<QuizQuestion[]>();
  readonly answersByIndex = input<Record<number, number[]>>({});
  // Future-ready: when a flagging feature ships, set this true (or populate
  // item.flagged) and the Flagged chip appears with no other change.
  readonly flaggingEnabled = input<boolean>(false);

  readonly filter = signal<ReviewFilterId>('all');

  readonly items = computed<ReviewItem[]>(() => {
    const answers = this.answersByIndex();
    return (this.questions() ?? []).map((q, i) => {
      const selectedIds = new Set((answers[i] ?? []).filter((id) => id != null));
      const answered = selectedIds.size > 0;
      const correct = isAnswerCorrect(q, answers[i] ?? []);
      const status: ReviewStatus = correct ? 'correct' : answered ? 'incorrect' : 'unanswered';

      const options: ReviewOption[] = pinAllOfTheAboveLast([...(q.options ?? [])], (o) => o.text).map(
        (o) => ({
          text: o.text,
          correct: o.correct === true,
          selected: o.optionId != null && selectedIds.has(o.optionId)
        })
      );

      return {
        number: i + 1,
        questionText: q.questionText ?? '',
        explanation: q.explanation ?? '',
        status,
        flagged: false,   // no flagging feature yet
        options
      };
    });
  });

  private readonly anyFlagged = computed(() => this.items().some((i) => i.flagged));

  // Chips to show: everything except flag-gated filters, unless flagging is
  // enabled OR something is already flagged (auto-reveals when the feature lands).
  readonly visibleFilters = computed<ReviewFilterDef[]>(() =>
    REVIEW_FILTERS.filter(
      (f) => !f.requiresFlagging || this.flaggingEnabled() || this.anyFlagged()
    )
  );

  // Count per filter — derived from the same predicates, so chips stay in sync.
  readonly counts = computed<Record<ReviewFilterId, number>>(() => {
    const items = this.items();
    const out = {} as Record<ReviewFilterId, number>;
    for (const f of REVIEW_FILTERS) {
      out[f.id] = items.filter((i) => f.match(i)).length;
    }
    return out;
  });

  readonly activeFilter = computed<ReviewFilterDef>(
    () => REVIEW_FILTERS.find((f) => f.id === this.filter()) ?? REVIEW_FILTERS[0]
  );

  readonly filtered = computed<ReviewItem[]>(() => {
    const match = this.activeFilter().match;
    return this.items().filter((i) => match(i));
  });

  setFilter(id: ReviewFilterId): void {
    this.filter.set(id);
  }

  // Option display class: correct answers green, a wrong PICK red, else neutral.
  optionClass(option: ReviewOption): string {
    if (option.correct) return 'rv-correct';
    if (option.selected) return 'rv-wrong';
    return '';
  }

  optionLabel(option: ReviewOption): string {
    if (option.correct && option.selected) return 'Your answer ✓';
    if (option.correct) return 'Correct answer';
    if (option.selected) return 'Your answer ✗';
    return '';
  }
}
