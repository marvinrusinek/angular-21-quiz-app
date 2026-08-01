import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  viewChild,
  ViewEncapsulation
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { PracticeSessionService } from '../../../shared/services/features/practice/practice-session.service';
import { PracticeOptionsComponent } from '../../../components/practice/practice-options/practice-options.component';
import { ThemeToggleComponent } from '../../../components/theme-toggle/theme-toggle.component';
import { ScrollDownIndicatorComponent } from '../../../components/scroll-down-indicator/scroll-down-indicator.component';
import { getQuizData } from '../../../shared/quiz-data-cache';

/**
 * Weak Areas Practice session — a THIN container.
 *
 * It deliberately does not reuse QuizComponent: that component owns the topic
 * quiz's load/navigation/timer lifecycle, and driving a dynamically generated,
 * untimed session through it would put the normal quiz flow at risk. Instead the
 * session state lives in PracticeSessionService and this container renders it
 * with PracticeOptionsComponent.
 *
 * Practice is a LEARNING mode: untimed, with the source topic labelled on every
 * question. Feedback and navigation follow the VERIFIED topic-quiz rules exactly
 * (see practice-scoring.ts) — Interview Mode's deferred policy is never engaged,
 * and no new selection or scoring semantics are introduced.
 */
@Component({
  selector: 'codelab-weak-areas-practice',
  standalone: true,
  imports: [RouterLink, PracticeOptionsComponent, ThemeToggleComponent, ScrollDownIndicatorComponent],
  templateUrl: './weak-areas-practice.component.html',
  styleUrls: ['./weak-areas-practice.component.scss'],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown)': 'onGlobalKey($event)' }
})
export class WeakAreasPracticeComponent {
  private readonly session = inject(PracticeSessionService);
  private readonly router = inject(Router);

  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');

  readonly total = this.session.total;
  readonly currentIndex = this.session.currentIndex;
  readonly currentQuestion = this.session.currentQuestion;
  readonly answersByIndex = this.session.answersByIndex;
  readonly answeredCount = this.session.answeredCount;
  readonly allAnswered = this.session.allAnswered;
  readonly canGoPrevious = this.session.canGoPrevious;
  readonly canGoNext = this.session.canGoNext;
  readonly canSubmit = this.session.canSubmit;
  readonly isLastQuestion = this.session.isLastQuestion;
  readonly isCurrentAnswered = this.session.isCurrentAnswered;
  readonly isCurrentResolved = this.session.isCurrentResolved;
  readonly currentSelection = this.session.currentSelection;

  readonly displayNumber = computed(() => this.currentIndex() + 1);

  /** Human-readable source topic for the current question. Never colour alone. */
  readonly currentTopicName = computed(() => {
    const sourceQuizId = this.currentQuestion()?.sourceQuizId;
    if (!sourceQuizId) return '';
    return getQuizData().find((q) => q.quizId === sourceQuizId)?.milestone ?? sourceQuizId;
  });

  /**
   * The FET, revealed on the SAME rule as the topic quiz: only once the question
   * is RESOLVED — the correct option for single/true-false, the complete correct
   * set for multi-answer. A wrong or partial selection never reveals it.
   * Explanations for questions the user got wrong are available afterwards in
   * Practice Results → Answer Review.
   */
  readonly explanation = computed(() =>
    this.isCurrentResolved() ? (this.currentQuestion()?.explanation ?? '') : ''
  );

  constructor() {
    // Move focus to the practice heading after navigation so keyboard and screen
    // reader users land on the session rather than at the top of the document.
    afterNextRender(() => this.heading()?.nativeElement.focus());
  }

  onSelectionChange(optionIds: number[]): void {
    this.session.select(this.currentIndex(), optionIds);
  }

  previous(): void {
    this.session.previous();
  }

  next(): void {
    this.session.next();
  }

  /** Score the session and move to Results. Same gate as the visible button. */
  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.session.submit();
    await this.router.navigate(['/practice/results']);
  }

  /**
   * Keyboard navigation, matching the interview session's shortcuts. Ignored
   * while the user is typing in a field.
   *
   * ArrowRight calls the SAME session.next() the Next button calls, so it obeys
   * the identical gate — a partial multi-answer cannot be skipped with the
   * keyboard. It deliberately does NOT submit; ending the session stays an
   * explicit click.
   */
  onGlobalKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.key === 'ArrowLeft') {
      this.previous();
    } else if (event.key === 'ArrowRight') {
      this.next();
    }
  }

  /**
   * Leaves the session and drops it. `replaceUrl` keeps the abandoned session
   * out of the history entry the user would return to with browser Back.
   */
  async backToQuizzes(): Promise<void> {
    this.session.clear();
    await this.router.navigate(['/quiz'], { replaceUrl: true });
  }
}
