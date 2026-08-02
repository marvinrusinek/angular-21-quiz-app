/**
 * Stable identifier generation.
 *
 * Both schemes are derived from ORIGINAL, UNSHUFFLED source positions so a
 * generated assessment can shuffle freely without changing identity.
 */

/**
 * Question id: `<quizId>:q:<originalQuestionIndex>`.
 *
 * Treated as OPAQUE outside this module — Angular must never parse it to
 * recover a quiz id or an index, and no DTO documents its structure.
 *
 * DOCUMENTED CONSEQUENCE: because it encodes source position, REORDERING or
 * INSERTING questions in quiz.json changes the ids of every question at or
 * after the edit. Sessions are unaffected — from Stage 4 they store a frozen
 * snapshot of their own questions — but any id persisted elsewhere would go
 * stale. Adding permanent ids to the source data is the long-term fix and is
 * deliberately deferred until before the topic-quiz migration.
 */
export function makeQuestionId(quizId: string, sourceQuestionIndex: number): string {
  return `${quizId}:q:${sourceQuestionIndex}`;
}

/**
 * Option id: `(questionIndex + 1) * 100 + (optionIndex + 1)`.
 *
 * Reproduces the existing Angular runtime formula EXACTLY
 * (quiz-shuffle.service.ts:262-280 and assessment-builder.service.ts:406-417)
 * so backend ids and current client ids agree.
 *
 * ── COLLISION PROPERTY (intentional, and safe) ──────────────────────
 * The formula uses the question's index WITHIN ITS SOURCE QUIZ, so question 3
 * of `rxjs` and question 3 of `signals` both yield 401, 402, 403…
 *
 * Option ids are therefore unique only WITHIN A QUESTION — never globally, and
 * never within a mixed-topic assessment. Every lookup must be scoped by
 * question identity; `getOptionForQuestion(questionId, optionId)` is the only
 * supported way to resolve one, and answer validation must reject an option id
 * that exists elsewhere but not on the submitted question.
 */
export function makeOptionId(sourceQuestionIndex: number, sourceOptionIndex: number): number {
  return (sourceQuestionIndex + 1) * 100 + (sourceOptionIndex + 1);
}
