import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree } from '@angular/router';

import { QuizGuard } from './quiz-guard';

describe('QuizGuard', () => {
  let guard: QuizGuard;
  let router: any;
  let quizDataService: any;
  let quizService: any;

  const mockRouterState = {} as RouterStateSnapshot;

  function makeRoute(params: Record<string, string>): ActivatedRouteSnapshot {
    return { params } as unknown as ActivatedRouteSnapshot;
  }

  beforeEach(() => {
    // Create a mock UrlTree for comparison
    const mockUrlTree = new UrlTree();

    router = {
      createUrlTree: jest.fn().mockReturnValue(mockUrlTree),
    };

    quizDataService = {
      getCachedQuizById: jest.fn().mockReturnValue(null),
      getCurrentQuizSnapshot: jest.fn().mockReturnValue(null),
    };

    quizService = {
      questions: [],
    };

    guard = new QuizGuard(quizDataService, quizService, router as Router);
  });

  it('should be created', () => {
    expect(guard).toBeTruthy();
  });

  it('should redirect to /quiz when quizId is missing', () => {
    const result = guard.canActivate(makeRoute({}), mockRouterState);
    expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz']);
    expect(result).toBeInstanceOf(UrlTree);
  });

  it('should redirect to question 1 when questionIndex is null', () => {
    const result = guard.canActivate(
      makeRoute({ quizId: 'angular' }),
      mockRouterState
    );
    expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz/question', 'angular', 1]);
  });

  it('should redirect to intro when questionIndex is non-numeric', () => {
    const result = guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: 'abc' }),
      mockRouterState
    );
    expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz/intro', 'angular']);
  });

  it('should redirect to question 1 when questionIndex < 1', () => {
    const result = guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: '0' }),
      mockRouterState
    );
    expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz/question', 'angular', 1]);
  });

  it('should allow navigation when quiz is not cached (let resolver load)', () => {
    const result = guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: '1' }),
      mockRouterState
    );
    expect(result).toBe(true);
  });

  it('should allow navigation for valid question index within range', () => {
    const mockQuiz = {
      quizId: 'angular',
      questions: [
        { questionText: 'Q1', options: [], explanation: '' },
        { questionText: 'Q2', options: [], explanation: '' },
        { questionText: 'Q3', options: [], explanation: '' },
      ],
    };
    quizDataService.getCachedQuizById.mockReturnValue(mockQuiz);

    const result = guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: '2' }),
      mockRouterState
    );
    expect(result).toBe(true);
  });

  it('should clamp out-of-bounds question index to max', () => {
    const mockQuiz = {
      quizId: 'angular',
      questions: [
        { questionText: 'Q1', options: [], explanation: '' },
        { questionText: 'Q2', options: [], explanation: '' },
      ],
    };
    quizDataService.getCachedQuizById.mockReturnValue(mockQuiz);

    guard.canActivate(
      makeRoute({ quizId: 'angular', questionIndex: '5' }),
      mockRouterState
    );
    expect(router.createUrlTree).toHaveBeenCalledWith(['/quiz/question', 'angular', 2]);
  });
});
