import { Injectable, inject } from '@angular/core';
import { 
  ActivatedRouteSnapshot, Resolve, Router, RouterStateSnapshot, UrlTree
} from '@angular/router';
import { Observable, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';

import { Quiz } from '../../models/Quiz.model';

import { QuizService } from '../data/quiz.service';
import { QuizDataService } from '../data/quizdata.service';

@Injectable({ providedIn: 'root' })
export class QuizResolverService implements Resolve<Quiz | UrlTree | null> {
  // ── injects ─────────────────────────────────────────────────────
  private quizDataService = inject(QuizDataService);
  private quizService = inject(QuizService);
  private router = inject(Router);

  // ── public methods ──────────────────────────────────────────────
  resolve(
    route: ActivatedRouteSnapshot,
    _state: RouterStateSnapshot,
  ): Observable<Quiz | UrlTree | null> {
    const quizId = route.params['quizId'];

    // Fast Path: If we already have the quiz loaded, don't re-fetch.
    // This prevents "cold observable" stutter or "waiting for data" hangs during Q1->Q2 nav.
    const activeQuiz = this.quizService.selectedQuiz;
    if (activeQuiz && activeQuiz.quizId === quizId) return of(activeQuiz);

    return this.quizDataService.ensureQuizzesLoaded().pipe(
      switchMap(() => this.quizDataService.getQuiz(quizId)),
      map((quiz) => {
        if (!quiz) {
          return this.router.createUrlTree(['/quiz']);
        }
        return quiz;
      }),
      catchError(() => {
        return of(this.router.createUrlTree(['/quiz']));
      })
    );
  }
}