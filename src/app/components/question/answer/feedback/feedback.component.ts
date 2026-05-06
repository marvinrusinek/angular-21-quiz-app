import {
  ChangeDetectorRef, ChangeDetectionStrategy, Component, Input, input, OnInit,
  OnChanges, signal, SimpleChanges
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';

import { FeedbackProps } from '../../../../shared/models/FeedbackProps.model';
import { FeedbackService } from '../../../../shared/services/features/feedback/feedback.service';
import { QuizService } from '../../../../shared/services/data/quiz.service';
import { SelectedOptionService } from '../../../../shared/services/state/selectedoption.service';

@Component({
  selector: 'codelab-quiz-feedback',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  templateUrl: './feedback.component.html',
  styleUrls: ['./feedback.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FeedbackComponent implements OnInit, OnChanges {
  @Input() feedbackConfig?: FeedbackProps | null;
  readonly stylePreset = input<'default' | 'inline'>('default');
  readonly feedbackMessageClass = signal('');
  readonly displayMessage = signal('');

  constructor(
    private feedbackService: FeedbackService,
    private quizService: QuizService,
    private selectedOptionService: SelectedOptionService,
    private cdRef: ChangeDetectorRef
  ) { }

  ngOnInit(): void {
    this.updateFeedback();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.shouldUpdateFeedback(changes)) {
      this.updateFeedback();
      this.cdRef.markForCheck();  // force view update
    }
  }

  private shouldUpdateFeedback(changes: SimpleChanges): boolean {
    return (
      'feedbackConfig' in changes && !!changes['feedbackConfig'].currentValue
    );
  }

  private updateFeedback(): void {
    if (this.feedbackConfig?.showFeedback) {
      this.updateDisplayMessage();
      this.feedbackMessageClass.set(this.determineFeedbackMessageClass());
    } else {
      this.displayMessage.set('');
    }
    this.cdRef.detectChanges();
  }


  private determineFeedbackMessageClass(): string {
    const isCorrect = !!this.feedbackConfig?.selectedOption?.correct;
    return isCorrect ? 'correct-message' : 'wrong-message';
  }

  private updateDisplayMessage(): void {
    if (!this.feedbackConfig) {
      this.displayMessage.set('');
      return;
    }

    // Prioritize the feedback message already computed by the Parent (SharedOptionComponent)
    // This message has been carefully reconciled with authoritative correct flags and visual order.
    if (this.feedbackConfig?.feedback && this.feedbackConfig.feedback.trim()) {
      this.displayMessage.set(this.feedbackConfig.feedback);
      return;
    }

    const fallbackIndex = Number.isFinite(this.feedbackConfig.idx)
      ? this.feedbackConfig.idx
      : 0;
    const selectedQuestionIndex = Number.isFinite(
      (this.feedbackConfig.selectedOption as { questionIndex?: number } | null)
        ?.questionIndex
    )
      ? ((this.feedbackConfig.selectedOption as { questionIndex?: number })
        .questionIndex as number)
      : undefined;
    const activeQuestionIndex = Number.isFinite(
      this.quizService.currentQuestionIndex
    )
      ? (this.quizService.currentQuestionIndex as number)
      : undefined;
    const idx =
      this.feedbackConfig.questionIndex ?? selectedQuestionIndex ?? activeQuestionIndex ?? fallbackIndex;

    const question =
      this.feedbackConfig.question ??
      this.quizService.questions?.[idx] ??
      (this.feedbackConfig.options
        ? {
          questionText: '',
          options: this.feedbackConfig.options,
          explanation: '',
          type: undefined
        }
        : null);

    // MULTI-ANSWER: use ALL selections for this question
    const selectedFromMap =
      this.selectedOptionService.getSelectedOptionsForQuestion(idx) ?? [];
    const fallbackSelected = this.feedbackConfig.selectedOption
      ? [
        {
          ...this.feedbackConfig.selectedOption,
          selected: true,
          questionIndex: idx
        }
      ]
      : [];
    const selected =
      selectedFromMap.length > 0 ? selectedFromMap : fallbackSelected;

    const msg = question
      ? this.feedbackService.buildFeedbackMessage(
        question,
        selected,
        false,
        this.feedbackConfig?.timedOut === true,
        idx
      )
      : '';

    // If feedbackService decided on a message, USE IT and STOP
    if (msg && msg.trim()) {
      this.displayMessage.set(msg);
      return;
    }

    this.displayMessage.set('');
  }
}
