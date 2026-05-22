import { Injectable, inject } from '@angular/core';
import { ActivatedRoute, ParamMap, Router } from '@angular/router';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { Quiz } from '../../models/Quiz.model';
import { QuizDataService } from '../data/quizdata.service';
import { QuizService } from '../data/quiz.service';

/**
 * Handles route parameter parsing and route-based quiz data resolution.
 * Extracted from QuizComponent to reduce its size.
 */
@Injectable({ providedIn: 'root' })
export class QuizRouteService {
  // ── injects ─────────────────────────────────────────────────────
  private quizDataService = inject(QuizDataService);
  private quizService = inject(QuizService);

  // ── public methods ──────────────────────────────────────────────

  // ═══════════════════════════════════════════════════════════════
  // PARSE NAVIGATION-END ROUTE PARAMS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Parses the snapshot's quizId + 0-based question index, and detects
   * whether the route quiz differs from the previous quiz id.
   */
  parseNavigationEndParams(
    activatedRoute: ActivatedRoute,
    previousQuizId: string
  ): { routeQuizId: string | null; index: number; isQuizSwitch: boolean } {
    const params = activatedRoute.snapshot.paramMap;
    const routeQuizId = params.get('quizId');
    const raw = params.get('questionIndex');
    const index = Math.max(0, (Number(raw) || 1) - 1);
    const prev = previousQuizId || this.quizService.quizId ||
      localStorage.getItem('lastQuizId') || '';
    const isQuizSwitch = !!(routeQuizId && prev && routeQuizId !== prev);
    return { routeQuizId, index, isQuizSwitch };
  }

  // ═══════════════════════════════════════════════════════════════
  // ROUTE QUESTION NUMBER (1-based)
  // ═══════════════════════════════════════════════════════════════

  getRouteQuestionNumber(
    activatedRoute: ActivatedRoute,
    router: Router
  ): number | null {
    const parseNum = (raw: string | null): number | null => {
      if (raw == null) return null;

      const n = Number(raw);
      if (!Number.isFinite(n)) return null;

      const qn = Math.trunc(n);
      return qn >= 1 ? qn : null;
    };

    const fromCurrent = parseNum(
      activatedRoute.snapshot.paramMap.get('questionIndex')
    );
    if (fromCurrent !== null) return fromCurrent;

    const walk = (snapshot: any): number | null => {
      if (!snapshot) return null;

      const found = parseNum(snapshot.paramMap?.get?.('questionIndex') ?? null);
      if (found !== null) return found;

      for (const child of snapshot.children ?? []) {
        const childFound = walk(child);
        if (childFound !== null) return childFound;
      }
      return null;
    };

    const fromTree = walk(router.routerState.snapshot.root);
    if (fromTree !== null) return fromTree;

    const m = router.url.match(/\/(\d+)(?:\/)?(?:\?|$)/);
    if (m) {
      const fromUrl = parseNum(m[1]);
      if (fromUrl !== null) return fromUrl;
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // ROUTE QUESTION INDEX (0-based)
  // ═══════════════════════════════════════════════════════════════

  getRouteQuestionIndex(
    activatedRoute: ActivatedRoute,
    router: Router
  ): number {
    const toIndex = (raw: string | null): number | null => {
      if (raw == null) return null;
      
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;

      return Math.max(0, Math.trunc(n) - 1);
    };

    const fromCurrent = toIndex(
      activatedRoute.snapshot.paramMap.get('questionIndex')
    );
    if (fromCurrent !== null) return fromCurrent;

    const walk = (snapshot: any): number | null => {
      if (!snapshot) return null;

      const found = toIndex(snapshot.paramMap?.get?.('questionIndex') ?? null);
      if (found !== null) return found;
      
      for (const child of snapshot.children ?? []) {
        const childFound = walk(child);
        if (childFound !== null) return childFound;
      }
      return null;
    };

    const fromTree = walk(router.routerState.snapshot.root);
    if (fromTree !== null) return fromTree;

    const fromUrl = (() => {
      const m = router.url.match(/\/(\d+)(?:\?|$)/);
      if (!m) return null;
      return toIndex(m[1]);
    })();
    if (fromUrl !== null) return fromUrl;

    return 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // HANDLE ROUTE PARAMS (quiz data resolution)
  // ═══════════════════════════════════════════════════════════════

  handleRouteParams(
    params: ParamMap
  ): Observable<{ quizId: string; questionIndex: number; quizData: Quiz }> {
    const quizId = params.get('quizId');
    const questionIndex = Number(params.get('questionIndex'));
    if (!quizId) return throwError(() => new Error('Quiz ID is required'));

    if (isNaN(questionIndex)) {
      return throwError(() => new Error('Invalid question index'));
    }

    return this.quizDataService.getQuizzes().pipe(
      map((quizzes: Quiz[]) => {
        const quizData = quizzes.find((quiz) => quiz.quizId === quizId);
        if (!quizData) {
          throw new Error(`Quiz with ID "${quizId}" not found.`);
        }
        return { quizId, questionIndex, quizData };
      }),
      catchError(() => {
        return throwError(() => new Error('Failed to process quiz data'));
      })
    );
  }
}