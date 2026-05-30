import { inject, Injectable } from '@angular/core';

import { OptionBindings } from '../../../models/OptionBindings.model';

import { QuizService } from '../../data/quiz.service';
import { TimerService } from '../../features/timer/timer.service';

/**
 * Timer-expiry probes for option-item visual state.
 *
 * - Authoritative `isExpiredForQuestion`: cross-checks
 *   `TimerService.expiredForQuestionIndexSig` and a direct-subscription
 *   flag against the active qIdx, so a stale `timerExpired` input from a
 *   prior question can't bleed into the next.
 * - Stamp checks: the timer-expiry handler may pre-stamp CSS classes on
 *   bindings; stamps without a scoped `_timerExpiredStampedForIndex` are
 *   not trusted.
 */
@Injectable({ providedIn: 'root' })
export class OptionItemTimerStateService {
  private readonly quizService = inject(QuizService);
  private readonly timerService = inject(TimerService);

  isExpiredForQuestion(
    qIdxInput: number,
    directExpired: boolean,
    directExpiredForIndex: number
  ): boolean {
    const qIdx = this.quizService.currentQuestionIndex ?? qIdxInput;

    const expiredIdx = this.timerService.expiredForQuestionIndexSig();
    if (expiredIdx >= 0 && expiredIdx === qIdx) return true;

    if (directExpired && directExpiredForIndex === qIdx) return true;

    return false;
  }

  isStamped(binding: OptionBindings | undefined, qIdxInput: number): boolean {
    const stamped = binding?._timerExpiredStamped;
    if (!stamped) return false;

    const stampedFor = binding?._timerExpiredStampedForIndex;
    if (stampedFor == null) return false;

    const qIdx = this.quizService.currentQuestionIndex ?? qIdxInput;
    return stampedFor === qIdx;
  }

  isStampedCorrect(binding: OptionBindings | undefined, qIdxInput: number): boolean {
    return this.isStamped(binding, qIdxInput)
      && binding?.cssClasses?.['correct-option'] === true;
  }
}
