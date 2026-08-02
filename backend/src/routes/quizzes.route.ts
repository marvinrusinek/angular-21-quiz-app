import { Router } from 'express';

import type { QuizRepository } from '../quiz/quiz.repository';
import { toQuizMetadataListDto, type QuizMetadataDto } from '../quiz/quiz.dto';
import { setResponsePolicy } from '../api/response-guard';
import { ApiError } from '../shared/errors';

export interface QuizzesListBody {
  readonly quizzes: readonly QuizMetadataDto[];
}

/**
 * Read-only quiz METADATA.
 *
 * There is deliberately no `GET /api/quizzes/:quizId` returning questions.
 * Questions reach a client only through a generated session (Stage 6+), so a
 * whole quiz — answer key stripped or not — is never fetchable in one call.
 * The single-quiz route below returns metadata only, for the same reason.
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

  return router;
}
