import {
  ChangeDetectionStrategy, Component, effect, inject, input, signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';

import { FeedbackProps } from '../../../../shared/models/FeedbackProps.model';
import { Option } from '../../../../shared/models/Option.model';
import { QuizQuestion } from '../../../../shared/models/QuizQuestion.model';

import { FeedbackService } from '../../../../shared/services/features/feedback/feedback.service';
import { QuizService } from '../../../../shared/services/data/quiz.service';
import { SelectedOptionService } from '../../../../shared/services/state/selectedoption.service';

import { QUESTION_ROUTE_REGEX } from '../../../../shared/constants/route-patterns';
import { isOptionCorrect } from '../../../../shared/utils/is-option-correct';
import { norm } from '../../../../shared/utils/text-norm';

@Component({
  selector: 'codelab-quiz-feedback',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  templateUrl: './feedback.component.html',
  styleUrls: ['./feedback.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FeedbackComponent {
  // ── injects ─────────────────────────────────────────────────────
  private readonly feedbackService = inject(FeedbackService);
  private readonly quizService = inject(QuizService);
  private readonly selectedOptionService = inject(SelectedOptionService);

  // ── inputs ──────────────────────────────────────────────────────
  readonly feedbackConfig = input<FeedbackProps | null | undefined>(undefined);
  readonly stylePreset = input<'default' | 'inline'>('default');

  // ── remaining variables ─────────────────────────────────────────
  readonly feedbackMessageClass = signal('');
  readonly displayMessage = signal('');

  constructor() {
    // Re-runs whenever the feedbackConfig signal input changes (replaces
    // the prior ngOnInit + ngOnChanges pair). Truthy-only gate matches the
    // old `'feedbackConfig' in changes && !!currentValue` check; an
    // initial undefined value is just ignored until the parent provides one.
    effect(() => {
      const cfg = this.feedbackConfig();
      if (cfg) {
        this.updateFeedback();
      }
    });
  }

  private updateFeedback(): void {
    if (this.feedbackConfig()?.showFeedback) {
      this.updateDisplayMessage();
      this.feedbackMessageClass.set(this.determineFeedbackMessageClass());
    } else {
      this.displayMessage.set('');
    }
  }


  private determineFeedbackMessageClass(): string {
    const isCorrect = !!this.feedbackConfig()?.selectedOption?.correct;
    return isCorrect ? 'correct-message' : 'wrong-message';
  }

  private updateDisplayMessage(): void {
    // Cache the signal value once — re-reading risks a different value mid-method.
    const cfg = this.feedbackConfig();
    if (!cfg) {
      this.displayMessage.set('');
      return;
    }

    // Prefer the parent-computed feedback, but only if its cached "Option N"
    // still matches the live URL question (see cachedFeedbackMatchesUrl).
    const cachedFeedback = cfg.feedback?.trim();
    if (cachedFeedback) {
      if (this.cachedFeedbackMatchesUrl(cfg, cachedFeedback) && cfg.feedback) {
        this.displayMessage.set(cfg.feedback);
        return;
      }
    }

    const msg = this.regenerateFeedbackMessage(cfg);
    if (msg && msg.trim()) {
      this.displayMessage.set(msg);
      return;
    }

    this.displayMessage.set('');
  }

  // Prioritize the parent-computed message ONLY if the cached "Option N" matches
  // the live URL question's correct option — otherwise a Q1 string ("The correct
  // answer is Option 1.") would display verbatim on Q3 after navigation.
  private cachedFeedbackMatchesUrl(cfg: FeedbackProps, cachedFeedback: string): boolean {
    let cacheMatchesUrl = true;
    try {
      const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
      if (m) {
        const urlIdx = Number(m[1]) - 1;
        const liveQ = this.quizService.questions?.[urlIdx];
        const correctIdxs: number[] = (liveQ?.options ?? [])
          .map((o: Option, i: number) => o?.correct ? i + 1 : null)
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
        if (cacheMatchesUrl && /not this one/i.test(cachedFeedback) &&
            this.clickedTextMatchesCorrectOption(cfg, urlIdx, liveQ)) {
          cacheMatchesUrl = false;
        }
      }
    } catch {}
    return cacheMatchesUrl;
  }

  // True when the user's clicked option text matches a correct option in the
  // live URL question — used to reject a stale "Not this one" cached message.
  private clickedTextMatchesCorrectOption(
    cfg: FeedbackProps,
    urlIdx: number,
    liveQ: QuizQuestion | undefined
  ): boolean {
    const candidates: string[] = [];
    const sel: any = cfg.selectedOption;
    if (sel?.text) candidates.push(norm(sel.text));

    // Also look at the selectedOptionService — it carries the
    // authoritative committed click for this question, which can
    // be more current than feedbackConfig.selectedOption when the
    // upstream click handler hasn't refreshed the config yet.
    try {
      const liveSelections =
        this.selectedOptionService?.getSelectedOptionsForQuestion?.(urlIdx) ?? [];
      for (const s of liveSelections) {
        if (s?.text) candidates.push(norm(s.text));
      }
    } catch { /* ignore */ }

    if (candidates.length && Array.isArray(liveQ?.options)) {
      for (const candidateText of candidates) {
        const match = liveQ.options.find(
          (o: Option) => norm(o?.text) === candidateText
        );
        if (isOptionCorrect(match)) {
          return true;
        }
      }
    }
    return false;
  }

  private regenerateFeedbackMessage(cfg: FeedbackProps): string {
    const fallbackIndex = Number.isFinite(cfg.idx) ? cfg.idx : 0;
    const selectedQuestionIndex = Number.isFinite(
      (cfg.selectedOption as { questionIndex?: number } | null)?.questionIndex
    )
      ? ((cfg.selectedOption as { questionIndex?: number }).questionIndex as number)
      : undefined;
    const activeQuestionIndex = Number.isFinite(
      this.quizService.currentQuestionIndex
    )
      ? (this.quizService.currentQuestionIndex as number)
      : undefined;
    const idx =
      cfg.questionIndex ?? selectedQuestionIndex ?? activeQuestionIndex ?? fallbackIndex;

    const question =
      cfg.question ??
      this.quizService.questions?.[idx] ??
      (cfg.options
        ? {
          questionText: '',
          options: cfg.options,
          explanation: '',
          type: undefined
        }
        : null);

    // MULTI-ANSWER: use ALL selections for this question
    const selectedFromMap =
      this.selectedOptionService.getSelectedOptionsForQuestion(idx) ?? [];
    const fallbackSelected = cfg.selectedOption
      ? [
        {
          ...cfg.selectedOption,
          selected: true,
          questionIndex: idx
        }
      ]
      : [];
    const selected =
      selectedFromMap.length > 0 ? selectedFromMap : fallbackSelected;

    return question
      ? this.feedbackService.buildFeedbackMessage(
        question,
        selected,
        false,
        cfg.timedOut === true,
        idx
      )
      : '';
  }
}
