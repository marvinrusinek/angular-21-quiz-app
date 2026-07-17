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

export type ReviewStatus = 'correct' | 'incorrect' | 'unanswered';
export type ReviewFilter = 'all' | 'correct' | 'incorrect';

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

  readonly filter = signal<ReviewFilter>('all');

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
        options
      };
    });
  });

  readonly correctCount = computed(() => this.items().filter((i) => i.status === 'correct').length);
  readonly incorrectCount = computed(() => this.items().filter((i) => i.status !== 'correct').length);

  readonly filtered = computed<ReviewItem[]>(() => {
    const f = this.filter();
    if (f === 'correct') return this.items().filter((i) => i.status === 'correct');
    if (f === 'incorrect') return this.items().filter((i) => i.status !== 'correct');
    return this.items();
  });

  setFilter(f: ReviewFilter): void {
    this.filter.set(f);
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
