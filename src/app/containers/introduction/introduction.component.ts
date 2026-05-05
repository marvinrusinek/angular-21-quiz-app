import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, computed, OnDestroy, 
  OnInit, signal
} from '@angular/core';
import { CommonModule, NgOptimizedImage } from '@angular/common';
import { ActivatedRoute, Params, Router } from '@angular/router';
import {
  FormBuilder, FormGroup, FormsModule, ReactiveFormsModule
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleChange, MatSlideToggleModule }
  from '@angular/material/slide-toggle';
import {
  BehaviorSubject, combineLatest, EMPTY, firstValueFrom, of, Subject
} from 'rxjs';
import { catchError, filter, switchMap, takeUntil, tap } from 'rxjs/operators';

import { Quiz } from '../../shared/models/Quiz.model';
import { QuizQuestion } from '../../shared/models/QuizQuestion.model';
import { QuizService } from '../../shared/services/data/quiz.service';
import { QuizDataService } from '../../shared/services/data/quizdata.service';
import { QuizDotStatusService } from '../../shared/services/flow/quiz-dot-status.service';
import { QuizShuffleService } from '../../shared/services/flow/quiz-shuffle.service';
import { QuizNavigationService } from '../../shared/services/flow/quiz-navigation.service';
import { QuizPersistenceService } from '../../shared/services/state/quiz-persistence.service';
import { SelectedOptionService } from '../../shared/services/state/selectedoption.service';

@Component({
  selector: 'codelab-quiz-intro',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatSlideToggleModule,
    NgOptimizedImage,
    ReactiveFormsModule
  ],
  templateUrl: './introduction.component.html',
  styleUrls: ['./introduction.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class IntroductionComponent implements OnInit, OnDestroy {
  quiz!: Quiz;
  quizId: string | undefined;
  selectedQuiz: Quiz | null = null;
  selectedQuiz$ = new BehaviorSubject<Quiz | null>(null);
  preferencesForm: FormGroup;
  private isCheckedSubject = new BehaviorSubject<boolean>(false);
  readonly isStartingQuiz = signal(false);
  readonly questionCountSig = signal(0);
  readonly questionLabelSig = computed(() =>
    this.questionCountSig() === 1 ? 'question' : 'questions'
  );

  shuffledQuestions: QuizQuestion[] = [];
  shouldShuffleOptions = false;

  highlightPreference = false;
  isImmediateFeedback = false;

  questionLabel = '';
  introImg = '';
  imagePath = '../../../assets/images/milestones/';

  private destroy$ = new Subject<void>();

  constructor(
    private quizService: QuizService,
    private quizDataService: QuizDataService,
    private dotStatusService: QuizDotStatusService,
    private quizShuffleService: QuizShuffleService,
    private quizNavigationService: QuizNavigationService,
    private quizPersistence: QuizPersistenceService,
    private selectedOptionService: SelectedOptionService,
    private activatedRoute: ActivatedRoute,
    private router: Router,
    private fb: FormBuilder,
    private cdRef: ChangeDetectorRef
  ) {
    // Initialize the form group with default values
    this.preferencesForm = this.fb.group({
      shouldShuffleOptions: [false],
      isImmediateFeedback: [false]
    });
  }

  ngOnInit(): void {
    this.quizService.clearStoredCorrectAnswersText();
    this.subscribeToRouteParameters();
    this.handleQuizSelectionAndFetchQuestions();

    this.selectedQuiz$
      .pipe(
        takeUntil(this.destroy$),
        filter((quiz) => quiz !== null)  // proceed only if there's a valid quiz
      )
      .subscribe(() => {
        this.cdRef.markForCheck();
      });

    this.preferencesForm.get('shouldShuffleOptions')!
      .valueChanges.pipe(takeUntil(this.destroy$))
      .subscribe((isChecked: boolean) => {
        this.highlightPreference = isChecked;
        this.shouldShuffleOptions = isChecked;
        this.quizService.setCheckedShuffle(isChecked);
        this.isCheckedSubject.next(isChecked);
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private subscribeToRouteParameters(): void {
    this.activatedRoute.params
      .pipe(
        tap((params) => this.handleRouteParams(params)),
        switchMap((params) => this.fetchQuiz(params)),
        tap((quiz) => this.logQuizLoaded(quiz)),
        takeUntil(this.destroy$)
      )
      .subscribe({
        next: (quiz: Quiz | null) => this.handleLoadedQuiz(quiz),
        error: (error) => this.handleError(error)
      });
  }

  private handleRouteParams(params: Params): void {
    this.quizId = params['quizId'];
  }

  private fetchQuiz(params: Params) {
    const quizId = params['quizId'];
    if (!quizId) {
      return EMPTY;  // return EMPTY if no quizId is available
    }

    return this.quizDataService.getQuiz(quizId).pipe(
      catchError(() => {
        return EMPTY;  // handle the error by returning EMPTY to keep the Observable flow intact
      })
    );
  }

  private logQuizLoaded(quiz: Quiz | null): void {
    if (!quiz) {
      // quiz is undefined or null after fetching
    }
  }

  private handleLoadedQuiz(quiz: Quiz | null): void {
    if (quiz) {
      this.selectedQuiz$.next(quiz);
      this.quiz = quiz;
      this.introImg = this.imagePath + quiz.image;
      this.questionCountSig.set(quiz.questions?.length ?? 0);
      this.questionLabel = this.getPluralizedQuestionLabel(
        quiz.questions?.length ?? 0
      );
      this.cdRef.markForCheck();
    } else {
      // quiz is undefined or null
    }
  }

  private handleError(error: any): void {
    // error handled silently
  }

  private handleQuizSelectionAndFetchQuestions(): void {
    combineLatest([this.selectedQuiz$, this.isCheckedSubject])
      .pipe(
        takeUntil(this.destroy$),
        // Narrow the entire tuple: [Quiz, boolean]
        filter((tuple): tuple is [Quiz, boolean] => !!tuple[0]),
        tap(([quiz, checked]) => {
          this.shouldShuffleOptions = checked;
          this.fetchAndHandleQuestions(quiz.quizId);
        })
      )
      .subscribe();
  }

  private fetchAndHandleQuestions(quizId: string): void {
    this.quizDataService
      .getQuestionsForQuiz(quizId)
      .pipe(
        switchMap((questions: QuizQuestion[]) => {
          // NOTE: Shuffle is handled by quiz.service.ts fetchQuizQuestions()
          // Do NOT shuffle here - it would break question-option correspondence
          return of(questions);
        }),
        catchError(() => {
          return of([]);
        }),
        takeUntil(this.destroy$)
      )
      .subscribe((questions: QuizQuestion[]) => {
        this.shuffledQuestions = questions;
        this.cdRef.markForCheck();
      });
  }

  onSlideToggleChange(event: MatSlideToggleChange): void {
    const isChecked = event.checked;
    this.highlightPreference = isChecked;
    this.shouldShuffleOptions = isChecked;
    this.quizService.setCheckedShuffle(isChecked);
    this.isCheckedSubject.next(isChecked);
  }

  async onStartQuiz(quizId?: string): Promise<void> {
    if (this.isStartingQuiz()) return;

    this.isStartingQuiz.set(true);
    this.cdRef.markForCheck();

    try {
      const targetQuizId = quizId ?? this.quizId ?? this.getStoredQuizId();
      if (!targetQuizId) return;

      // Clear cache before starting to ensure fresh shuffle with correct flag
      this.quizDataService.clearQuizQuestionCache(targetQuizId);
      this.quizShuffleService.clear(targetQuizId);  // clear shuffle state to force fresh shuffle

      this.quizService.resetQuizSessionState();

      const activeQuiz = await this.resolveActiveQuiz(targetQuizId);
      if (!activeQuiz) return;

      // Retrieve form values
      const preferences = this.preferencesForm.value;

      // Access individual preferences from the form
      const shouldShuffleOptions = preferences.shouldShuffleOptions;

      this.quizDataService.setSelectedQuiz(activeQuiz);
      this.quizService.setSelectedQuiz(activeQuiz);
      this.quizService.setActiveQuiz(activeQuiz);
      this.persistQuizId(targetQuizId);
      this.quizService.setCheckedShuffle(shouldShuffleOptions);
      this.quizService.setQuizId(targetQuizId);
      this.quizService.setCurrentQuestionIndex(0);

      // Hard fresh-start reset for same-tab runs before entering Q1.
      // Prevent stale score like 1/6 from previous attempts.
      this.quizService.resetScore();
      this.quizService.questionCorrectness.clear();
      this.quizService.selectedOptionsMap.clear();
      this.quizService.userAnswers = [];
      this.quizService.answers = [];
      this.selectedOptionService.clearAllSelectionsForQuiz(targetQuizId);
      this.selectedOptionService.clearRefreshBackup();
      this.selectedOptionService.clickConfirmedDotStatus.clear();
      this.selectedOptionService.lastClickedCorrectByQuestion.clear();
      this.dotStatusService.clearAllMaps();
      this.quizPersistence.clearClickConfirmedDotStatus(20);
      this.quizPersistence.clearAllPersistedDotStatus(targetQuizId);
      try {
        localStorage.setItem('savedQuestionIndex', '0');
        localStorage.setItem('correctAnswersCount', '0');
        localStorage.removeItem('questionCorrectness');
        localStorage.removeItem('selectedOptionsMap');
        localStorage.removeItem('userAnswers');
        sessionStorage.removeItem('selectedOptionsMap');
        sessionStorage.removeItem('rawSelectionsMap');
        sessionStorage.removeItem('selectionHistory');
        sessionStorage.removeItem('isAnswered');
        // Remove this quiz from completed list (restarting it)
        try {
          const ids: string[] = JSON.parse(sessionStorage.getItem('completedQuizIds') || '[]');
          const filtered = ids.filter(id => id !== targetQuizId);
          if (filtered.length > 0) {
            sessionStorage.setItem('completedQuizIds', JSON.stringify(filtered));
          } else {
            sessionStorage.removeItem('completedQuizIds');
          }
        } catch { sessionStorage.removeItem('completedQuizIds'); }
        sessionStorage.removeItem('finalResult');
        sessionStorage.removeItem('elapsedTimes');
        sessionStorage.removeItem('completionTime');
        // Clear per-question sessionStorage entries from previous quiz
        for (let i = 0; i < 100; i++) {
          sessionStorage.removeItem('sel_Q' + i);
          sessionStorage.removeItem('dot_confirmed_' + i);
          sessionStorage.removeItem('quiz_selection_' + i);
          sessionStorage.removeItem('displayMode_' + i);
          sessionStorage.removeItem('feedbackText_' + i);
        }
        // Clear all localStorage dot status keys
        const lsKeysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (key.startsWith('quiz_dot_status_') || key.startsWith('quiz_progress_'))) {
            lsKeysToRemove.push(key);
          }
        }
        for (const key of lsKeysToRemove) {
          localStorage.removeItem(key);
        }
      } catch {}

      try {
        const preparedQuestions = (await firstValueFrom(
          this.quizDataService.prepareQuizSession(targetQuizId),
        )) as QuizQuestion[];

        // Now set current quiz with the SHUFFLED questions
        const quizWithShuffledQuestions = {
          ...activeQuiz,
          questions: preparedQuestions ?? activeQuiz.questions
        };
        this.quizDataService.setCurrentQuiz(quizWithShuffledQuestions);
      } catch (error) {
        // Fallback: set with original questions if shuffle fails
        this.quizDataService.setCurrentQuiz(activeQuiz);
      }

      const navigationSucceeded =
        await this.navigateToFirstQuestion(targetQuizId);

      if (!navigationSucceeded) {
        // navigation to first question was prevented
      }
    } finally {
      this.isStartingQuiz.set(false);
      this.cdRef.markForCheck();
    }
  }

  private async navigateToFirstQuestion(targetQuizId: string): Promise<boolean> {
    // Resolve the effective quiz id (override → service → component → localStorage)
    const quizId = this.quizNavigationService.resolveEffectiveQuizId(targetQuizId);
    if (!quizId) return false;

    // Ensure the session is ready and can resolve Q0 (best-effort; don’t block nav)
    await this.quizNavigationService.ensureSessionQuestions(quizId);
    const q0 = await this.quizNavigationService.tryResolveQuestion(0);
    if (!q0) {
    }

    try {
      // Preferred path: let the service reset UI and navigate to Q1 (index 0)
      const viaService = await this.quizNavigationService.resetUIAndNavigate(
        0,
        quizId
      );
      if (viaService) return true;  // if the service explicitly succeeded, we’re done

      // Service returned false/undefined/non-boolean – fall back to direct navigation
    } catch (error) {
      // error handled silently
    }

    // Fallback to direct router navigation
    try {
      // Router expects 1-based question in URL; index 0 ⇒ "/.../1"
      const fallbackSucceeded = await this.router.navigate(['/quiz/question', quizId, 1]);
      if (!fallbackSucceeded) {
        // fallback navigation returned false
      }

      return fallbackSucceeded;
    } catch (fallbackErr) {
      // error handled silently
      return false;
    }
  }

  private async resolveActiveQuiz(targetQuizId: string): Promise<Quiz | null> {
    const quizFromState = this.selectedQuiz$.getValue() ?? this.quiz ?? null;

    if (quizFromState?.quizId === targetQuizId) return quizFromState;

    try {
      const loadedQuiz = await this.quizDataService.loadQuizById(targetQuizId);
      if (loadedQuiz) {
        this.selectedQuiz$.next(loadedQuiz);
        this.quiz = loadedQuiz;
      }
      return loadedQuiz;
    } catch (error) {
      // error handled silently
      return null;
    }
  }

  private getStoredQuizId(): string | null {
    try {
      if (typeof localStorage === 'undefined') {
        return null;
      }
      return localStorage.getItem('quizId');
    } catch {
      return null;
    }
  }

  private persistQuizId(quizId: string): void {
    try {
      localStorage.setItem('quizId', quizId);
    } catch (storageError) { }
  }

  public get milestone(): string {
    return this.selectedQuiz?.milestone || 'Milestone not found';
  }

  public getPluralizedQuestionLabel(count: number): string {
    return `${count === 1 ? 'question' : 'questions'}`;
  }
}