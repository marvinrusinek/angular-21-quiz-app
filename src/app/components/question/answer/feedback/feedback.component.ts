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

    // Prioritize the feedback message already computed by the Parent
    // (SharedOptionComponent) — but ONLY if the cached "Option N" matches
    // the live URL question's actual correct option index. Without this
    // gate, a Q1-built feedback string ("The correct answer is Option 1.")
    // displays verbatim on Q3 even after navigation.
    const cachedFeedback = this.feedbackConfig?.feedback?.trim();
    if (cachedFeedback) {
      let cacheMatchesUrl = true;
      try {
        const m = window.location.pathname.match(/\/question\/[^/]+\/(\d+)/);
        if (m) {
          const urlIdx = Number(m[1]) - 1;
          const liveQ = this.quizService.questions?.[urlIdx];
          const correctIdxs: number[] = (liveQ?.options ?? [])
            .map((o: any, i: number) => o?.correct ? i + 1 : null)
            .filter((n: number | null): n is number => n !== null);
          // If the cached string says "Option N" but the live question's
          // actual correct option isn't N, fall through and regenerate.
          const optionMatch = cachedFeedback.match(/Option\s+(\d+)/i);
          if (optionMatch && correctIdxs.length > 0) {
            const cachedOptN = Number(optionMatch[1]);
            cacheMatchesUrl = correctIdxs.includes(cachedOptN);
          }

          // ALSO reject a cached "Not this one, try again!" when the user
          // actually clicked an option whose text matches a correct option
          // in the live URL question. Single-answer questions on the last
          // index were cementing the negative message because the upstream
          // click handler couldn't see the canonical correct flag.
          if (cacheMatchesUrl && /not this one/i.test(cachedFeedback)) {
            const candidates: string[] = [];
            const sel: any = this.feedbackConfig?.selectedOption;
            if (sel?.text) candidates.push(String(sel.text).trim().toLowerCase());

            // Also look at the selectedOptionService — it carries the
            // authoritative committed click for this question, which can
            // be more current than feedbackConfig.selectedOption when the
            // upstream click handler hasn't refreshed the config yet.
            try {
              const liveSelections =
                this.selectedOptionService?.getSelectedOptionsForQuestion?.(urlIdx) ?? [];
              for (const s of liveSelections) {
                if (s?.text) candidates.push(String(s.text).trim().toLowerCase());
              }
            } catch { /* ignore */ }

            if (candidates.length && Array.isArray(liveQ?.options)) {
              for (const candidateText of candidates) {
                const match = liveQ.options.find(
                  (o: any) => (o?.text ?? '').trim().toLowerCase() === candidateText
                );
                const isCorrectFlag = match && (
                  match.correct === true ||
                  match.correct === 1 ||
                  String(match.correct) === 'true'
                );
                if (isCorrectFlag) {
                  cacheMatchesUrl = false;
                  break;
                }
              }
            }
          }
        }
      } catch {}
      if (cacheMatchesUrl) {
        this.displayMessage.set(this.feedbackConfig!.feedback!);
        return;
      }
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