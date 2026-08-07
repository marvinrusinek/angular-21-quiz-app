import { Router, type RequestHandler } from 'express';

import type { QuizRepository } from '../quiz/quiz.repository';
import {
  AnswerCheckError,
  checkAnswer,
  type CheckOutcome
} from '../quiz/answer-check';
import {
  AttemptReceiptError,
  issueAttemptReceipt,
  verifyAttemptReceipt,
  RECEIPT_VERSION
} from '../quiz/attempt-receipt';
import {
  toQuizMetadataListDto,
  toTopicQuizQuestionsDto,
  type QuizMetadataDto
} from '../quiz/quiz.dto';
import { setResponsePolicy } from '../api/response-guard';
import { ApiError } from '../shared/errors';

export interface QuizzesListBody {
  readonly quizzes: readonly QuizMetadataDto[];
}

/**
 * Read-only quiz metadata, and Topic Quiz question delivery.
 *
 * `GET /quizzes/:quizId/questions` returns a whole quiz's questions WITHOUT any
 * correctness or explanations, and without identifiers of any kind. That is a
 * deliberate change from the earlier position that questions may only reach a
 * client through a generated session: Topic Quizzes are moving off the public
 * `assets/data/quiz.json`, and the whole point is that the browser can render
 * the questions while the answer key stays on the server.
 *
 * The answer key is released only per question, after an answer, by the check
 * endpoint — not here, and never in bulk.
 */
/**
 * Seconds a Topic Quiz attempt is allowed, per question.
 *
 * Mirrors the Angular `TimerService.timePerQuestion = 30`. The receipt's
 * deadline is a COARSE upper bound for the whole attempt (30s × question
 * count), not a mirror of the per-question UI timer: tracking that server-side
 * would need per-question state this design deliberately does not keep. It is
 * used for one purpose — deciding whether a reveal is authorized by expiry.
 */
export const SECONDS_PER_QUESTION = 30;

export interface QuizzesRouterDeps {
  readonly repository: QuizRepository;
  /** HMAC key for attempt receipts. Never logged, never serialized. */
  readonly receiptSecret: string;
  /** Injected clock, so expiry is testable without waiting. */
  readonly now?: (() => number) | undefined;
  /** Applied to the check route only. */
  readonly checkRateLimiter?: RequestHandler | undefined;
}

export function createQuizzesRouter(deps: QuizRepository | QuizzesRouterDeps): Router {
  // Accepts a bare repository so existing call sites keep working unchanged.
  const options: QuizzesRouterDeps =
    'repository' in deps ? deps : { repository: deps, receiptSecret: '' };
  const repository = options.repository;
  const now = options.now ?? (() => Date.now());

  const router = Router();

  router.get('/quizzes', (_req, res) => {
    setResponsePolicy(res, 'PUBLIC_METADATA');
    // Repository order is source order, so the listing is deterministic.
    const body: QuizzesListBody = { quizzes: toQuizMetadataListDto(repository.getQuizMetadata()) };
    res.status(200).json(body);
  });

  router.get('/quizzes/:quizId', (req, res, next) => {
    setResponsePolicy(res, 'PUBLIC_METADATA');
    const quizId = req.params.quizId;
    const metadata = repository.getQuizMetadata().find((quiz) => quiz.quizId === quizId);

    if (!metadata) {
      next(ApiError.notFound('Quiz not found'));
      return;
    }

    // METADATA ONLY — never `quiz.questions`.
    res.status(200).json(toQuizMetadataListDto([metadata])[0]);
  });

  /**
   * Topic Quiz questions — no correctness, no explanations, no identifiers.
   *
   * Served from the PostgreSQL-backed repository's in-memory bank. There is no
   * JSON fallback: the repository refuses to exist if PostgreSQL had no bank,
   * so reaching this handler already implies the database was authoritative.
   *
   * Retired quizzes are not loaded by the repository at all, so they 404 here
   * exactly like an unknown id — the client cannot distinguish the two, which
   * is intentional.
   */
  router.get('/quizzes/:quizId/questions', (req, res, next) => {
    setResponsePolicy(res, 'QUIZ_QUESTIONS');

    const quizId = req.params.quizId;
    const quiz = repository.getQuizById(quizId);

    if (!quiz) {
      next(ApiError.notFound('Quiz not found'));
      return;
    }

    res.status(200).json(toTopicQuizQuestionsDto(quiz));
  });

  /**
   * Start an attempt. Issues the signed timing receipt.
   *
   * No database state: the receipt IS the attempt record, which is why there is
   * no `quiz_attempts` table. Per-attempt reveal accounting would need one, and
   * is deferred until abuse monitoring shows it is warranted.
   */
  router.post('/quizzes/:quizId/attempts', (req, res, next) => {
    setResponsePolicy(res, 'ATTEMPT_ISSUED');

    const quiz = repository.getQuizById(req.params.quizId);
    if (!quiz) {
      next(ApiError.notFound('Quiz not found'));
      return;
    }

    const startedAt = now();
    const durationSeconds = quiz.questions.length * SECONDS_PER_QUESTION;
    const expiresAt = startedAt + durationSeconds * 1000;

    res.status(201).json({
      quizId: quiz.quizId,
      durationSeconds,
      startedAt,
      expiresAt,
      attemptReceipt: issueAttemptReceipt(
        { v: RECEIPT_VERSION, quizId: quiz.quizId, startedAt, expiresAt },
        options.receiptSecret
      )
    });
  });

  /**
   * Check ONE question's answer and, when the question is terminal, reveal that
   * question's correct options and explanation.
   *
   * Everything that decides authorization comes from the SIGNED receipt: the
   * quiz it belongs to and the deadline. A client cannot assert expiry, remaining
   * time, or that a question was submitted by timeout.
   *
   * Every rejection — missing receipt, tampered receipt, wrong quiz, unknown
   * question, unknown option, duplicate selection — produces the same shape, so
   * a prober cannot tell how close it got.
   */
  const checkHandlers: RequestHandler[] = [];
  if (options.checkRateLimiter) checkHandlers.push(options.checkRateLimiter);

  checkHandlers.push((req, res, next) => {
    setResponsePolicy(res, 'ANSWER_REVEAL');

    const quizId = req.params['quizId'];

    let payload;
    try {
      payload = verifyAttemptReceipt(req.header('X-Attempt-Receipt'), options.receiptSecret);
    } catch (err: unknown) {
      // 401: the caller is not authorized to check anything without a valid
      // receipt. The message never says why.
      next(err instanceof AttemptReceiptError
        ? ApiError.unauthorized('Invalid attempt receipt')
        : err);
      return;
    }

    // The receipt is bound to ONE quiz. A receipt for quiz A must not authorize
    // reveals in quiz B, which is what stops one attempt draining the bank.
    if (payload.quizId !== quizId) {
      next(ApiError.unauthorized('Invalid attempt receipt'));
      return;
    }

    const quiz = repository.getQuizById(quizId);
    if (!quiz) {
      next(ApiError.notFound('Quiz not found'));
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    let outcome: CheckOutcome;
    try {
      outcome = checkAnswer({
        quiz,
        questionText: body['questionText'],
        selectedOptionTexts: body['selectedOptionTexts'],
        // SERVER-DERIVED. The signed deadline against the server clock.
        expired: now() >= payload.expiresAt
      });
    } catch (err: unknown) {
      next(err instanceof AnswerCheckError ? ApiError.badRequest('Invalid submission') : err);
      return;
    }

    res.status(200).json(outcome);
  });

  router.post('/quizzes/:quizId/check', ...checkHandlers);

  return router;
}
