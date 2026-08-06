import { Router } from 'express';

import type { QuizRepository } from '../quiz/quiz.repository';
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
export function createQuizzesRouter(repository: QuizRepository): Router {
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

  return router;
}
