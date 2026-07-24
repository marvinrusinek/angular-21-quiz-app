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
import { InterviewResult } from '../../../shared/models/InterviewResult.model';
import { pinAllOfTheAboveLast } from '../../../shared/utils/all-of-the-above';
import {
  REVIEW_FILTERS,
  ReviewFilterDef,
  ReviewFilterId,
  ReviewStatus
} from './interview-review-filters';
import {
  countReviewStatuses,
  getCorrectAnswerLabels,
  getReviewOptionLabel,
  getReviewOptionState,
  getReviewQuestionStatus,
  getReviewQuestionType,
  InterviewReviewOptionState,
  joinWithAnd
} from './interview-review-status';

// Re-exported so existing importers keep working after the type moved to the
// pure filters module.
export type { ReviewStatus, ReviewFilterId };

interface ReviewOptionView {
  text: string;
  state: InterviewReviewOptionState;
  label: string;
  cssClass: string;   // 'rv-correct' | 'rv-wrong' | ''  (visual only)
  mark: string;       // decorative ✓ / ✕ (aria-hidden)
}

interface ReviewItem {
  number: number;
  topicName: string;
  typeLabel: string;
  questionText: string;
  explanation: string;
  status: ReviewStatus;
  /** Reserved for a future flagging feature; always false until then. */
  flagged: boolean;
  options: ReviewOptionView[];
  /** "A and C" — shown for multi-answer / unanswered where it aids clarity. */
  correctSummary: string;
}

/**
 * Post-submission per-question Review for Interview Mode. Unlike the active
 * assessment (feedback deferred), the Review DOES show correctness: each
 * question's status, the user's selected answer(s), the correct answer(s), and
 * the explanation. Filterable by All / Incorrect / Unanswered / Correct.
 *
 * READ-ONLY: options render as inert list items (never active-session controls),
 * inputs are treated as immutable, and it never mutates answers/result/session.
 * The summary uses the submitted InterviewResult as the source of truth.
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
  // The submitted result — the source of truth for the summary + header meta.
  readonly result = input<InterviewResult | null>(null);
  // Optional header meta (from the just-recorded history entry), shown when set.
  readonly attemptNumber = input<number | null>(null);
  readonly completedAt = input<string | null>(null);
  // Future-ready: when a flagging feature ships, set this true (or populate
  // item.flagged) and the Flagged chip appears with no other change.
  readonly flaggingEnabled = input<boolean>(false);
  // Embedded mode: hide the internal header meta (attempt #, date, score, etc.)
  // when the host page already shows that context (e.g. the Interview History
  // detail page). Purely presentational; the review list is unchanged.
  readonly embedded = input<boolean>(false);

  readonly filter = signal<ReviewFilterId>('all');

  // sourceQuizId → human topic name, from the result's per-topic breakdown.
  private readonly topicNames = computed<Map<string, string>>(
    () => new Map((this.result()?.perTopic ?? []).map((t) => [t.quizId, t.title]))
  );

  readonly items = computed<ReviewItem[]>(() => {
    const answers = this.answersByIndex();
    const topics = this.topicNames();
    return (this.questions() ?? []).map((q, i) => {
      const selectedIds = new Set((answers[i] ?? []).filter((id) => id != null));
      const status = getReviewQuestionStatus(q, answers[i] ?? []);

      const options: ReviewOptionView[] = pinAllOfTheAboveLast([...(q.options ?? [])], (o) => o.text).map(
        (o) => {
          const selected = o.optionId != null && selectedIds.has(o.optionId);
          const state = getReviewOptionState(o.correct === true, selected);
          return {
            text: o.text,
            state,
            label: getReviewOptionLabel(state),
            cssClass:
              state === 'incorrect-selected'
                ? 'rv-wrong'
                : state === 'correct-selected' || state === 'correct-missed'
                  ? 'rv-correct'
                  : '',
            mark: state === 'incorrect-selected' ? '✕' : state === 'neutral' ? '' : '✓'
          };
        }
      );

      const correctLabels = getCorrectAnswerLabels(q.options ?? []);
      // A concise "Correct answers: …" line helps most for multi-answer questions
      // and for questions the user skipped; single-answer answered questions read
      // clearly from the option labels alone.
      const showSummary = (correctLabels.length > 1 || status === 'unanswered') && correctLabels.length > 0;

      return {
        number: i + 1,
        topicName: topics.get(q.sourceQuizId ?? '') ?? '',
        typeLabel: getReviewQuestionType(q),
        questionText: q.questionText ?? '',
        explanation: q.explanation ?? '',
        status,
        flagged: false,
        options,
        correctSummary: showSummary ? joinWithAnd(correctLabels) : ''
      };
    });
  });

  // Summary — the submitted result is authoritative; fall back to the derived
  // per-question tally only if no result was supplied.
  readonly summary = computed(() => {
    const r = this.result();
    if (r) {
      return { correct: r.correct, incorrect: r.incorrect, unanswered: r.unanswered, total: r.total };
    }
    return countReviewStatuses(this.items().map((i) => i.status));
  });

  readonly completionReason = computed(() =>
    this.result()?.submittedByExpiry ? $localize`Time expired` : $localize`Submitted`
  );

  private readonly anyFlagged = computed(() => this.items().some((i) => i.flagged));

  readonly visibleFilters = computed<ReviewFilterDef[]>(() =>
    REVIEW_FILTERS.filter(
      (f) => !f.requiresFlagging || this.flaggingEnabled() || this.anyFlagged()
    )
  );

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
    return this.items().filter((i) => match(i));   // preserves original order
  });

  setFilter(id: ReviewFilterId): void {
    this.filter.set(id);
  }

  /** Accessible chip name with correct singular/plural. */
  filterAria(f: ReviewFilterDef): string {
    const n = this.counts()[f.id];
    return `${f.label}, ${n} ${n === 1 ? $localize`question` : $localize`questions`}`;
  }

  /** "July 23, 2026" — locale-formatted, safe fallback. */
  formatDate(iso: string): string {
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    } catch {
      return iso;
    }
  }
}
