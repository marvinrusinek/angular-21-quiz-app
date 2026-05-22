import { Injectable } from '@angular/core';
import {
  ActivatedRouteSnapshot, CanActivate, Router, RouterStateSnapshot, UrlTree
} from '@angular/router';

import { Quiz } from '../../shared/models/Quiz.model';

import { QuizService } from '../../shared/services/data/quiz.service';
import { QuizDataService } from '../../shared/services/data/quizdata.service';

@Injectable({ providedIn: 'root' })
export class QuizGuard implements CanActivate {
  constructor(
    private quizDataService: QuizDataService,
    private quizService: QuizService,
    private router: Router
  ) { }

  canActivate(
    route: ActivatedRouteSnapshot,
    _state: RouterStateSnapshot
  ): boolean | UrlTree {
    const quizId = route.params['quizId'];
    const questionParam = route.params['questionIndex'];

    if (!quizId) {
      return this.router.createUrlTree(['/quiz']);
    }

    const normalized = this.normalizeQuestionIndex(questionParam, quizId);
    if (normalized instanceof UrlTree) return normalized;

    const knownQuiz = this.findKnownQuiz(quizId);
    if (!knownQuiz) {
      // Let resolver load quiz
      return true;
    }

    return this.evaluateQuestionRequest(knownQuiz, normalized, quizId);
  }

  private normalizeQuestionIndex(
    questionParam: unknown,
    quizId: string
  ): number | UrlTree {
    if (questionParam == null) {
      return this.router.createUrlTree(['/quiz/question', quizId, 1]);
    }

    const parsed = Number.parseInt(String(questionParam).trim(), 10);
    if (!Number.isFinite(parsed)) {
      return this.router.createUrlTree(['/quiz/intro', quizId]);
    }

    if (parsed < 1) {
      return this.router.createUrlTree(['/quiz/question', quizId, 1]);
    }

    return parsed;
  }

  private findKnownQuiz(quizId: string): Quiz | null {
    return (
      this.quizDataService.getCachedQuizById(quizId) ??
      this.quizDataService.getCurrentQuizSnapshot() ??
      null
    );
  }

  private evaluateQuestionRequest(
    quiz: Quiz,
    questionIndex: number,
    quizId: string
  ): boolean | UrlTree {
    // Use the maximum known count from all sources to avoid false-negative blocks
    const quizQuestionsCount = quiz.questions?.length ?? 0;
    const serviceQuestionsCount = this.quizService.questions?.length ?? 0;
    const total = Math.max(quizQuestionsCount, serviceQuestionsCount, 1);

    if (total <= 0) {
      return this.router.createUrlTree(['/quiz']);
    }

    const zeroIdx = questionIndex - 1;
    if (zeroIdx >= 0 && zeroIdx < total) return true;

    const fallback = Math.min(total, Math.max(1, questionIndex));

    if (fallback !== questionIndex) {
      return this.router.createUrlTree(['/quiz/question', quizId, fallback]);
    }

    return this.router.createUrlTree(['/quiz/intro', quizId]);
  }
}