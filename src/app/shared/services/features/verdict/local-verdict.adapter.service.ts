import { Service } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';

import { evaluateLocally, revealExpiredLocally } from './local-verdict.adapter';
import type { TopicQuizVerdictAdapter } from './verdict-adapter';
import {
  QuestionVerdictError,
  type QuestionCheckResult,
  type QuestionExpiredResult
} from './question-verdict.types';

/**
 * The pre-cutover verdict source: the quiz bank already in the browser.
 *
 * Kept behind the same asynchronous interface as the API adapter so the two are
 * interchangeable, and so no consumer can come to depend on a verdict being
 * available in the same tick it was requested. It resolves immediately, but
 * only because `of` emits immediately — not because callers may assume it.
 *
 * This adapter disappears with the public bank. Until then it is what the unit
 * suite runs against, which keeps ~1500 tests from each needing an HTTP mock.
 */
@Service()
export class LocalTopicQuizVerdictAdapter implements TopicQuizVerdictAdapter {
  check(
    quizId: string,
    questionText: string,
    selectedOptionTexts: readonly string[]
  ): Observable<QuestionCheckResult> {
    try {
      return of(evaluateLocally(quizId, questionText, selectedOptionTexts));
    } catch (err: unknown) {
      return throwError(() =>
        err instanceof QuestionVerdictError ? err : new QuestionVerdictError('Invalid submission')
      );
    }
  }

  revealExpired(quizId: string, questionText: string): Observable<QuestionExpiredResult> {
    try {
      return of(revealExpiredLocally(quizId, questionText));
    } catch (err: unknown) {
      return throwError(() =>
        err instanceof QuestionVerdictError ? err : new QuestionVerdictError('Invalid submission')
      );
    }
  }
}
