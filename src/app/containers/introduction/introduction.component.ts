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
  quiz: Quiz | null = null;
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
      console.warn('[QuizSelection] Quiz was not found or failed to load.');
      return;
    }
  
    console.debug('[QuizSelection] Quiz loaded:', quiz.quizId);
  }

  private handleLoadedQuiz(quiz: Quiz | null): void {
    if (quiz) {
      const questionCount = quiz.questions?.length ?? 0;

      this.selectedQuiz$.next(quiz);
      this.quiz = quiz;
      this.introImg = this.imagePath + quiz.image;
      this.questionCountSig.set(questionCount);

      this.cdRef.markForCheck();
    } else {
      console.warn('[QuizSelection] Quiz was not found or failed to load.');
  
      this.selectedQuiz$.next(null);
      this.quiz = null;
      this.introImg = '';
      this.questionCountSig.set(0);
  
      this.cdRef.markForCheck();
    }
  }

  private handleError(error: unknown): void {
    console.error('[QuizSelection] Failed to load quiz:', error);
  
    this.selectedQuiz$.next(null);
    this.quiz = null;
    this.introImg = '';
    this.questionCountSig.set(0);
  
    this.cdRef.markForCheck();
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
      const targetQuizId = this.resolveTargetQuizId(quizId);
      if (!targetQuizId) return;

      this.clearCachesAndResetSession(targetQuizId);

      const activeQuiz = await this.resolveActiveQuiz(targetQuizId);
      if (!activeQuiz) return;

      const shouldShuffleOptions = !!this.preferencesForm.value?.shouldShuffleOptions;
      this.applySelectedQuizState(activeQuiz, targetQuizId, shouldShuffleOptions);

      this.resetQuizForFreshStart(targetQuizId);

      await this.prepareAndSetCurrentQuiz(activeQuiz, targetQuizId);

      await this.navigateToFirstQuestion(targetQuizId);
    } finally {
      this.isStartingQuiz.set(false);
      this.cdRef.markForCheck();
    }
  }

  // Resolve which quiz id the user is starting: explicit override → field
  // → localStorage fallback. Returns null when nothing resolves.
  private resolveTargetQuizId(override?: string): string | null {
    return override ?? this.quizId ?? this.getStoredQuizId();
  }

  // Drop cached questions + shuffle state for this quiz so the run that
  // follows gets a fresh shuffle, then reset the in-memory session.
  private clearCachesAndResetSession(targetQuizId: string): void {
    this.quizDataService.clearQuizQuestionCache(targetQuizId);
    this.quizShuffleService.clear(targetQuizId);
    this.quizService.resetQuizSessionState();
  }

  // Apply the user's selected quiz across services, persist the id, and
  // commit the shuffle preference. Index resets to Q1 (0).
  private applySelectedQuizState(
    activeQuiz: Quiz,
    targetQuizId: string,
    shouldShuffleOptions: boolean
  ): void {
    this.quizDataService.setSelectedQuiz(activeQuiz);
    this.quizService.setSelectedQuiz(activeQuiz);
    this.quizService.setActiveQuiz(activeQuiz);
    this.persistQuizId(targetQuizId);
    this.quizService.setCheckedShuffle(shouldShuffleOptions);
    this.quizService.setQuizId(targetQuizId);
    this.quizService.setCurrentQuestionIndex(0);
  }

  // Hard fresh-start reset for same-tab runs before entering Q1.
  // Prevents stale state (e.g. 1/6 score) leaking from a prior attempt.
  // Storage cleanup is delegated to QuizPersistenceService.
  private resetQuizForFreshStart(targetQuizId: string): void {
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
    this.quizPersistence.clearAllForFreshStart(targetQuizId);
  }

  // Prepare the quiz session (which produces shuffled questions) and
  // commit the resulting quiz to the data service. Falls back to the
  // un-shuffled quiz if preparation fails.
  private async prepareAndSetCurrentQuiz(
    activeQuiz: Quiz,
    targetQuizId: string
  ): Promise<void> {
    try {
      const preparedQuestions = (await firstValueFrom(
        this.quizDataService.prepareQuizSession(targetQuizId),
      )) as QuizQuestion[];
      this.quizDataService.setCurrentQuiz({
        ...activeQuiz,
        questions: preparedQuestions ?? activeQuiz.questions
      });
    } catch {
      this.quizDataService.setCurrentQuiz(activeQuiz);
    }
  }

  private async navigateToFirstQuestion(targetQuizId: string): Promise<boolean> {
    // Resolve the effective quiz id (override → service → component → localStorage)
    const quizId = this.quizNavigationService.resolveEffectiveQuizId(targetQuizId);
    if (!quizId) return false;

    // Ensure the session is ready and can resolve Q0 (best-effort; don’t block nav)
    await this.quizNavigationService.ensureSessionQuestions(quizId);

    const firstQuestion = await this.quizNavigationService.tryResolveQuestion(0);
    if (!firstQuestion) {
      console.warn('[QuizSelection] Could not resolve first question before navigation.');
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
      const fallbackSucceeded = await this.router.navigate([
        '/quiz/question',
        quizId,
        1,
      ]);
    
      if (!fallbackSucceeded) {
        console.warn(
          '[QuizSelection] Fallback navigation returned false.',
          { quizId }
        );
      }
    
      return fallbackSucceeded;
    } catch (fallbackErr: unknown) {
      console.error(
        '[QuizSelection] Fallback navigation failed.',
        { quizId, error: fallbackErr }
      );
    
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
}