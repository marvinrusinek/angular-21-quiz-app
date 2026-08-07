import { InjectionToken, inject } from '@angular/core';
import type { Observable } from 'rxjs';

import { LocalTopicQuizVerdictAdapter } from './local-verdict.adapter.service';
import type { QuestionCheckResult, QuestionExpiredResult } from './question-verdict.types';

/**
 * Where a Topic Quiz verdict comes from.
 *
 * `QuestionVerdictService` owns the STATE MACHINE — phases, stale-response
 * ordering, what consumers may read. An adapter owns only the answer to
 * "is this selection correct?", which is the part that moves from the browser
 * to the server.
 *
 * Both methods are asynchronous even though the local adapter resolves
 * immediately. That is deliberate: the API adapter cannot be synchronous, and a
 * seam that pretends otherwise would let synchronous assumptions leak back into
 * consumers — which is exactly the coupling this migration exists to remove.
 *
 * An adapter must never expose the answer key beyond what these DTOs carry. In
 * particular it must not offer a "what are the correct options for this
 * question?" method: reveals are authorized per question, by an answer or by
 * expiry, and never in bulk.
 */
export interface TopicQuizVerdictAdapter {
  /** Submit the full current selection for one question. */
  check(
    quizId: string,
    questionText: string,
    selectedOptionTexts: readonly string[]
  ): Observable<QuestionCheckResult>;

  /**
   * Reveal a question whose timer expired.
   *
   * The API implementation does NOT get to assert expiry — the server decides
   * from the signed per-question deadline. A client that could claim expiry
   * could harvest the whole bank.
   */
  revealExpired(quizId: string, questionText: string): Observable<QuestionExpiredResult>;
}

/**
 * Defaults to the LOCAL adapter.
 *
 * The default is the pre-cutover source on purpose: the API adapter is opted
 * into explicitly by the application config, so nothing starts making network
 * calls merely by being constructed. It also keeps the unit suite running
 * against the bank without every spec having to provide an HTTP mock.
 *
 * When the public bank is removed this default goes with it, and the token
 * becomes provider-only — at which point a missing provider is a startup
 * failure rather than a silent fallback to data that no longer exists.
 */
export const TOPIC_QUIZ_VERDICT_ADAPTER = new InjectionToken<TopicQuizVerdictAdapter>(
  'TOPIC_QUIZ_VERDICT_ADAPTER',
  { providedIn: 'root', factory: () => inject(LocalTopicQuizVerdictAdapter) }
);
