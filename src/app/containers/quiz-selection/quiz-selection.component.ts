import { ChangeDetectionStrategy, Component, computed, inject, OnInit,
  signal, ViewEncapsulation } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CommonModule, NgOptimizedImage } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { SK_COMPLETED_QUIZ_IDS, SK_STARTED_QUIZ_IDS } from '../../shared/constants/session-keys';

import { QuizRoutes } from '../../shared/models/quiz-routes.enum';
import { QuizStatus } from '../../shared/models/quiz-status.enum';

import { AnimationState } from '../../shared/models/AnimationState.type';
import { Quiz } from '../../shared/models/Quiz.model';
import { QuizSelectionParams } from '../../shared/models/QuizSelectionParams.model';
import { QuizTileStyles } from '../../shared/models/QuizTileStyles.model';

import { QuizDataService } from '../../shared/services/data/quizdata.service';
import { QuizService } from '../../shared/services/data/quiz.service';

import { BackToTopComponent } from '../../components/back-to-top/back-to-top.component';
import { ScrollDownIndicatorComponent } from '../../components/scroll-down-indicator/scroll-down-indicator.component';

import { SlideLeftToRightAnimation } from '../../animations/animations';

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
export class QuizSelectionComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly quizDataService = inject(QuizDataService);
  private readonly quizService = inject(QuizService);
  private readonly router = inject(Router);

  // ── remaining variables ─────────────────────────────────────────
  readonly quizzes = this.quizDataService.quizzesSig;
  private readonly completedQuizIds = signal<ReadonlySet<string>>(new Set());

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
  readonly selectionParams = signal<QuizSelectionParams | null>(null);

  ngOnInit(): void {
    this.initializeQuizSelection();
  }

  async onSelect(quizId: string, _index: number): Promise<void> {
    try {
      if (!quizId) return;

      // Track this quiz as accessed AT SELECTION TIME so the
      // "You've accessed N quizzes" / "ALL quizzes accessed" banner
      // counts every quiz the user has clicked into, not just ones
      // that reached the results page.
      this.recordQuizAccess(quizId);

      // this.quizService.quizId = quizId;
      this.quizService.setQuizId(quizId);
      const currentQuiz = this.quizDataService.getCachedQuizById(quizId);
      const isCompleted = currentQuiz?.status === QuizStatus.COMPLETED
        || this.completedQuizIds().has(quizId);
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
    if (
      quiz.status === QuizStatus.STARTED && (
        !this.selectionParams()?.quizCompleted ||
        quiz.quizId === this.selectionParams()?.startedQuizId ||
        quiz.quizId === this.selectionParams()?.continueQuizId ||
        this.completedQuizIds().has(quiz.quizId)
      )
    ) {
      classes.push('link');
    }
    return classes;
  }

  getTooltip(quiz: Quiz): string {
    if (quiz.status === QuizStatus.COMPLETED || this.completedQuizIds().has(quiz.quizId)) {
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
    const isCompletedQuiz = this.completedQuizIds().has(quiz.quizId);
    return hasKnownStatus || isCompletedQuiz;
  }

  getLinkRouterLink(quiz: Quiz): string[] {
    const quizId = quiz.quizId;
    const isCompleted = quiz.status === QuizStatus.COMPLETED
      || this.completedQuizIds().has(quizId);
    return isCompleted ? ['/results/', quizId] : ['/intro/', quizId];
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
        if (this.completedQuizIds().has(quiz.quizId)) return 'done';
        return '';
    }
  }

  animationDoneHandler(): void {
    this.animationStateSignal.set('none');
  }

  public isCompleted(quiz: any): boolean {
    return (quiz?.status ?? '').toString().toLowerCase() === 'completed'
      || this.completedQuizIds().has(quiz?.quizId);
  }

  private initializeQuizSelection(): void {
    this.restoreSessionAccessState();
    this.selectionParams.set(this.quizService.returnQuizSelectionParams());
    this.loadQuizCatalog();
  }

  // Restore quiz statuses from sessionStorage (one-time consumption)
  private restoreSessionAccessState(): void {
    try {
      const completedIds = this.consumeCompletedQuizIds();
      const startedIds = this.consumeStartedQuizIds();

      const allAccessed = new Set([...completedIds, ...startedIds]);
      this.accessedCount.set(allAccessed.size);
    } catch (error: unknown) {
      console.warn('[QuizSelection] Failed to restore quiz access state.', error);
      this.accessedCount.set(0);
    }
  }

  private consumeCompletedQuizIds(): string[] {
    // Read but DON'T remove — the user's accessed-quiz history needs to
    // persist across visits to the selection page, otherwise the
    // "You've accessed N quizzes" banner resets to whatever the latest
    // results page wrote (typically 1).
    const completedIds: string[] = JSON.parse(
      sessionStorage.getItem(SK_COMPLETED_QUIZ_IDS) || '[]'
    );

    for (const id of completedIds) {
      this.completedQuizIds.update(s => new Set(s).add(id));
      this.quizDataService.updateQuizStatus(id, QuizStatus.COMPLETED);
    }

    if (completedIds.length > 0) {
      this.quizService.setCompletedQuizId(completedIds[completedIds.length - 1]);
      this.quizService.quizCompleted = true;
    }

    return completedIds;
  }

  private consumeStartedQuizIds(): string[] {
    // Read but DON'T remove — see consumeCompletedQuizIds.
    const startedIds: string[] = JSON.parse(
      sessionStorage.getItem(SK_STARTED_QUIZ_IDS) || '[]'
    );

    for (const id of startedIds) {
      this.quizDataService.updateQuizStatus(id, QuizStatus.STARTED);
    }

    return startedIds;
  }

  // Persist a quiz access at selection time so the accessed-quizzes count
  // reflects every quiz the user has clicked into, regardless of whether
  // they completed it. The previous tracking in results.component.ts only
  // fires when the user reaches the results page, so quizzes the user
  // bailed on were uncounted.
  private recordQuizAccess(quizId: string): void {
    if (!quizId) return;
    try {
      const completed: string[] = JSON.parse(
        sessionStorage.getItem(SK_COMPLETED_QUIZ_IDS) || '[]'
      );
      if (completed.includes(quizId)) return;  // already counted

      const started: string[] = JSON.parse(
        sessionStorage.getItem(SK_STARTED_QUIZ_IDS) || '[]'
      );
      if (!started.includes(quizId)) {
        started.push(quizId);
        sessionStorage.setItem(SK_STARTED_QUIZ_IDS, JSON.stringify(started));
      }

      // Update the live count immediately so the banner refreshes without
      // needing a route round-trip back to the selection page.
      const accessedSet = new Set([...completed, ...started]);
      this.accessedCount.set(accessedSet.size);
    } catch { /* ignore storage failures */ }
  }

  // Load quizzes once – replaces constructor side-effect
  private loadQuizCatalog(): void {
    this.quizDataService.loadQuizzes().subscribe((quizzes) => {
      this.totalQuizCountSig.set(quizzes?.length ?? 0);
    });

  }
}
