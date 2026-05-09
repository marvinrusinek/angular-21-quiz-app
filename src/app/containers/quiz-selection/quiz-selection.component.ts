import { ChangeDetectionStrategy, Component, computed, OnDestroy, OnInit, 
  signal, ViewEncapsulation } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CommonModule, NgOptimizedImage } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { EMPTY, Observable, of, Subject, Subscription } from 'rxjs';
import { catchError, takeUntil } from 'rxjs/operators';

import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { SlideLeftToRightAnimation } from '../../animations/animations';
import { AnimationState } from '../../shared/models/AnimationState.type';
import { Quiz } from '../../shared/models/Quiz.model';
import { QuizRoutes } from '../../shared/models/quiz-routes.enum';
import { QuizStatus } from '../../shared/models/quiz-status.enum';
import { QuizSelectionParams } from '../../shared/models/QuizSelectionParams.model';
import { QuizTileStyles } from '../../shared/models/QuizTileStyles.model';
import { QuizService } from '../../shared/services/data/quiz.service';
import { QuizDataService } from '../../shared/services/data/quizdata.service';
import { ScrollDownIndicatorComponent } from '../../components/scroll-down-indicator/scroll-down-indicator.component';
import { BackToTopComponent } from '../../components/back-to-top/back-to-top.component';

@Component({
  selector: 'codelab-quiz-selection',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    MatCardModule,
    MatIconModule,
    MatMenuModule,
    MatTooltipModule,
    NgOptimizedImage,
    ScrollDownIndicatorComponent,
    BackToTopComponent
  ],
  templateUrl: './quiz-selection.component.html',
  styleUrls: ['./quiz-selection.component.scss'],
  animations: [SlideLeftToRightAnimation.slideLeftToRight],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class QuizSelectionComponent implements OnInit, OnDestroy {
  quizzes$: Observable<Quiz[]> = of([]);
  selectedQuiz: Quiz | null = null;
  currentQuestionIndex = 0;
  private completedQuizIds = new Set<string>();
  
  readonly accessedCount = signal(0);
  readonly totalQuizCountSig = signal(0);
  readonly hasAccessedQuizzes = computed(() => this.accessedCount() > 0);

  readonly allQuizzesAccessed = computed(() =>
    this.totalQuizCountSig() > 0 &&
    this.accessedCount() >= this.totalQuizCountSig()
  );
  
  readonly accessedQuizLabel = computed(() =>
    this.accessedCount() === 1 ? 'quiz' : 'quizzes'
  );
  
  readonly accessedBannerMessage = computed(() => {
    const accessedCount = this.accessedCount();
  
    if (this.allQuizzesAccessed()) {
      return 'ALL quizzes accessed! You are an Angular master!';
    }
  
    return `You've accessed ${accessedCount} ${this.accessedQuizLabel()}. Keep going!`;
  });

  private animationStateSignal = signal<AnimationState>('none');
  readonly animationState$ = toObservable(this.animationStateSignal);
  readonly animationStateSig = this.animationStateSignal.asReadonly();
  selectionParams!: QuizSelectionParams;
  selectedQuizSubscription!: Subscription;
  unsubscribe$ = new Subject<void>();

  constructor(
    private quizService: QuizService,
    private quizDataService: QuizDataService,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.initializeQuizSelection();
  }

  ngOnDestroy(): void {
    this.unsubscribe$.next();
    this.unsubscribe$.complete();
    this.selectedQuizSubscription?.unsubscribe();
  }

  private initializeQuizSelection(): void {
    this.currentQuestionIndex = this.quizService.currentQuestionIndex;
  
    // Restore quiz statuses from sessionStorage (one-time consumption)
    try {
      const completedIds: string[] = JSON.parse(
        sessionStorage.getItem('completedQuizIds') || '[]'
      );
  
      sessionStorage.removeItem('completedQuizIds');
  
      for (const id of completedIds) {
        this.completedQuizIds.add(id);
        this.quizDataService.updateQuizStatus(id, QuizStatus.COMPLETED);
      }
  
      if (completedIds.length > 0) {
        this.quizService.setCompletedQuizId(completedIds[completedIds.length - 1]);
        this.quizService.quizCompleted = true;
      }
  
      const startedIds: string[] = JSON.parse(
        sessionStorage.getItem('startedQuizIds') || '[]'
      );
  
      sessionStorage.removeItem('startedQuizIds');
  
      for (const id of startedIds) {
        this.quizDataService.updateQuizStatus(id, QuizStatus.STARTED);
      }
  
      const allAccessed = new Set([...completedIds, ...startedIds]);
      this.accessedCount.set(allAccessed.size);
    } catch (error: unknown) {
      console.warn('[QuizSelection] Failed to restore quiz access state.', error);
      this.accessedCount.set(0);
    }
  
    this.selectionParams = this.quizService.returnQuizSelectionParams();
  
    // Load quizzes once – replaces constructor side-effect
    this.quizDataService.loadQuizzes().subscribe((quizzes) => {
      this.totalQuizCountSig.set(quizzes?.length ?? 0);
    });
  
    // Use live observable to receive status updates
    this.quizzes$ = this.quizDataService.quizzes$;
  
    this.subscribeToSelectedQuiz();
  }

  private subscribeToSelectedQuiz(): void {
    this.selectedQuizSubscription = this.quizService.selectedQuiz$
      .pipe(
        takeUntil(this.unsubscribe$),
        catchError(() => {
          return EMPTY;  // completes the stream safely
        })
      )
      .subscribe((quiz: Quiz | null) => {
        this.selectedQuiz = (quiz as Quiz) ?? null;
      });
  }

  async onSelect(quizId: string, index: number): Promise<void> {
    try {
      if (!quizId) return;

      // this.quizService.quizId = quizId;
      this.quizService.setQuizId(quizId);
      const currentQuiz = this.quizDataService.getCachedQuizById(quizId);
      const isCompleted = currentQuiz?.status === QuizStatus.COMPLETED
        || this.completedQuizIds.has(quizId);
      this.quizService.quizCompleted = isCompleted;

      // If quiz is completed, go to results instead of intro
      if (isCompleted) {
        this.quizService.setQuizStatus(QuizStatus.COMPLETED);
        this.quizService.setCompletedQuizId(quizId);
        await this.router.navigate([QuizRoutes.RESULTS, quizId]);
        return;
      }
      
      // Set status to STARTED if not already CONTINUE or COMPLETED
      if (!currentQuiz?.status || currentQuiz.status === QuizStatus.STARTED) {
        this.quizDataService.updateQuizStatus(quizId, QuizStatus.STARTED);
        this.quizService.setQuizStatus(QuizStatus.STARTED);
      }
      
      await this.router.navigate([QuizRoutes.INTRO, quizId]);
    } catch (error: any) {
      // error handled silently
    }
  }

  getQuizTileStyles(quiz: Quiz): QuizTileStyles {
    return {
      background: 'url(' + quiz.image + ') no-repeat center 10px',
      'background-size': '300px 210px'
    };
  }

  getLinkClass(quiz: Quiz): string[] {
    const classes = ['status-link'];
    switch (quiz.status) {
      case QuizStatus.STARTED:
        if (
          !this.selectionParams.quizCompleted ||
          quiz.quizId === this.selectionParams.startedQuizId ||
          quiz.quizId === this.selectionParams.continueQuizId ||
          this.completedQuizIds.has(quiz.quizId)
        ) {
          classes.push('link');
        }
        break;
    }
    return classes;
  }

  getTooltip(quiz: Quiz): string {
    if (quiz.status === QuizStatus.COMPLETED || this.completedQuizIds.has(quiz.quizId)) {
      return 'Completed';
    }
    switch (quiz.status) {
      case QuizStatus.STARTED:
        return 'Start';
      case QuizStatus.CONTINUE:
        return 'Continue';
      default:
        return '';
    }
  }

  shouldShowLink(quiz: Quiz): boolean {
    const hasKnownStatus = quiz.status === QuizStatus.STARTED
      || quiz.status === QuizStatus.CONTINUE
      || quiz.status === QuizStatus.COMPLETED;
    const isCompletedQuiz = this.completedQuizIds.has(quiz.quizId);
    return hasKnownStatus || isCompletedQuiz;
  }

  getLinkRouterLink(quiz: any): any[] {
    const quizId = quiz?.quizId;
    if (quiz?.status === QuizStatus.COMPLETED || this.completedQuizIds.has(quizId)) {
      return ['/results/', quizId];
    }
    if (quiz?.status === QuizStatus.CONTINUE) {
      return ['/intro/', quizId];
    }
    return ['/intro/', quizId];
  }

  getIconClass(quiz: Quiz): string {
    switch (quiz.status) {
      case QuizStatus.STARTED:
        return 'play_arrow';
      case QuizStatus.CONTINUE:
        return 'fast_forward';
      case QuizStatus.COMPLETED:
        return 'done';
      default:
        // Fallback: if this quiz matches the completedQuizId, show checkmark
        if (this.completedQuizIds.has(quiz.quizId)) return 'done';
        return '';
    }
  }

  animationDoneHandler(): void {
    this.animationStateSignal.set('none');
  }

  public isCompleted(quiz: any): boolean {
    return (quiz?.status ?? '').toString().toLowerCase() === 'completed'
      || this.completedQuizIds.has(quiz?.quizId);
  }
}