import { Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { EMPTY, firstValueFrom, of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';

import { Quiz } from '../../models/Quiz.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { Option } from '../../models/Option.model';
import { QuestionPayload } from '../../models/QuestionPayload.model';
import { QuizService } from '../data/quiz.service';
import { QuizDataService } from '../data/quizdata.service';
import { QuizStateService } from '../state/quizstate.service';
import { SelectedOptionService } from '../state/selectedoption.service';
import { NextButtonStateService } from '../state/next-button-state.service';
import { TimerService } from '../features/timer/timer.service';
import { ExplanationTextService } from '../features/explanation/explanation-text.service';
import { QuizQuestionDataService } from './quiz-question-data.service';
import { QuizContentLoaderService } from './quiz-content-loader.service';
import type { QuizComponent } from '../../../containers/quiz/quiz.component';

type Host = QuizComponent;

/**
 * Handles quiz data loading, session hydration, and question stream initialization for QuizComponent.
 * Extracted from QuizSetupService.
 */
@Injectable({ providedIn: 'root' })
export class QuizSetupDataService {
  constructor(
    private router: Router,
    private quizService: QuizService,
    private quizDataService: QuizDataService,
    private quizStateService: QuizStateService,
    private selectedOptionService: SelectedOptionService,
    private nextButtonStateService: NextButtonStateService,
    private timerService: TimerService,
    private explanationTextService: ExplanationTextService,
    private quizQuestionDataService: QuizQuestionDataService,
    private quizContentLoaderService: QuizContentLoaderService
  ) {}

  // â”€â”€ Data loading â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async loadQuestions(host: Host): Promise<void> {
    try {
      const questions = await this.quizService.fetchQuizQuestions(host.quizId);
      if (!questions?.length) return;
      host.questionsArray = [...questions];
      host.totalQuestions = questions.length;
      host.isQuizDataLoaded = true;
      host.cdRef.detectChanges();
    } catch (error: any) {
      // question loading failed
    }
    this.pushInitialQuestionPayload(host);
  }

  private pushInitialQuestionPayload(host: Host): void {
    const initialIdx = host.currentQuestionIndex() || 0;
    const initialQuestion = this.quizService.questions?.[initialIdx]
      ?? host.questionsArray?.[initialIdx];
    if (!initialQuestion?.options?.length) return;

    host.currentQuestion = initialQuestion;
    host.questionToDisplaySig.set(initialQuestion.questionText?.trim() ?? '');
    const payload = {
      question: initialQuestion,
      options: initialQuestion.options,
      explanation: initialQuestion.explanation
    };
    host.combinedQuestionData.set(payload);
    host.cdRef.detectChanges();

    Promise.resolve().then(() => {
      const current = host.combinedQuestionData();
      if (!current || current.options?.length === 0) {
        host.combinedQuestionData.set(payload);
        host.cdRef.detectChanges();
      }
    });
  }

  async loadQuizData(host: Host): Promise<boolean> {
    if (host.isQuizLoaded) return true;
    if (!host.quizId) return false;

    try {
      const result = await this.quizContentLoaderService.loadQuizDataFromService(host.quizId);
      if (!result) return false;

      host.quiz = result.quiz;
      this.applyQuestionsFromSession(host, result.questions);

      const safeIndex = Math.min(Math.max(host.currentQuestionIndex() ?? 0, 0), host.questions.length - 1);
      host.currentQuestionIndex.set(safeIndex);
      host.currentQuestion = host.questions[safeIndex] ?? null;

      this.quizService.setCurrentQuiz(host.quiz);
      host.isQuizLoaded = true;
      return true;
    } catch (error: any) {
      host.questions = [];
      return false;
    }
  }

  loadCurrentQuestion(host: Host): void {
    this.quizService.getQuestionByIndex(host.currentQuestionIndex())
      .pipe(
        tap((question: QuizQuestion | null) => {
          if (!question) return;
          host.question = question;
          this.quizService.getOptions(host.currentQuestionIndex()).subscribe({
            next: (options: Option[]) => {
              host.optionsToDisplay = options || [];
              if (!this.selectedOptionService.isQuestionAnswered(host.currentQuestionIndex())) {
                this.timerService.restartForQuestion(host.currentQuestionIndex());
              }
            },
            error: () => {
              host.optionsToDisplay = [];
            }
          });
        }),
        catchError(() => {
          return of(null);
        })
      )
      .subscribe();
  }

  refreshQuestionOnReset(host: Host): void {
    firstValueFrom(this.quizService.getQuestionByIndex(0))
      .then((question: QuizQuestion | null) => {
        if (!question) return;
        this.quizService.setCurrentQuestion(question);
        this.loadCurrentQuestion(host);
      })
      .catch(() => { });
  }

  async getQuestion(host: Host): Promise<void | null> {
    const quizId = host.activatedRoute.snapshot.params['quizId'];
    const question = await this.quizContentLoaderService.fetchQuestionFromAPI(
      quizId, host.currentQuestionIndex()
    );
    host.question = question ?? null;
  }

  // â”€â”€ Session hydration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  applyQuestionsFromSession(host: Host, questions: QuizQuestion[]): void {
    const result = this.quizContentLoaderService.hydrateQuestionsFromSession({
      questions, quiz: host.quiz, selectedQuiz: host.selectedQuiz,
    });

    host.questions = result.hydratedQuestions;

    if (result.quizQuestions && host.quiz) {
      host.quiz = { ...host.quiz, questions: result.quizQuestions };
    }
    if (result.selectedQuizQuestions && host.selectedQuiz) {
      host.selectedQuiz = { ...host.selectedQuiz, questions: result.selectedQuizQuestions };
    }

    this.syncQuestionSnapshotFromSession(host, result.hydratedQuestions);
  }

  private syncQuestionSnapshotFromSession(host: Host, hydratedQuestions: QuizQuestion[]): void {
    const result = this.quizContentLoaderService.syncQuestionSnapshot({
      hydratedQuestions, currentQuestionIndex: host.currentQuestionIndex(),
      previousIndex: host.previousIndex, serviceCurrentIndex: this.quizService?.currentQuestionIndex,
    });
    if (result.isEmpty) {
      host.questionToDisplaySig.set('');
      host.qaToDisplay = undefined;
      host.currentQuestion = null;
      host.optionsToDisplay = [];
      host.optionsToDisplaySig.set([]);
      host.hasOptionsLoaded = false;
      host.shouldRenderOptions.set(false);
      host.explanationToDisplay.set('');
      this.explanationTextService.setExplanationText('', { index: host.currentQuestionIndex() ?? 0 });
      return;
    }
    host.currentQuestionIndex.set(result.normalizedIndex);
    host.question = result.question;
    host.currentQuestion = result.question;
    host.qaToDisplay = { question: result.question!, options: result.normalizedOptions };
    host.questionToDisplaySig.set(result.trimmedQuestionText);
    host.optionsToDisplay = [...result.normalizedOptions];
    host.optionsToDisplaySig.set([...result.normalizedOptions]);
    host.hasOptionsLoaded = result.normalizedOptions.length > 0;
    host.shouldRenderOptions.set(host.hasOptionsLoaded);
    host.explanationToDisplay.set(result.trimmedExplanation);
    const qqc = host.quizQuestionComponent?.();
    if (qqc) qqc.optionsToDisplay.set([...result.normalizedOptions]);
  }

  // â”€â”€ Quiz initialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  resolveQuizData(host: Host): void {
    host.activatedRoute.data
      .pipe(takeUntilDestroyed(host.destroyRef))
      .subscribe(async (data: any) => {
        const quizData = data['quizData'];
        if (!quizData?.questions?.length) {
          void this.router.navigate(['/select']);
          return;
        }
        host.selectedQuiz = quizData;
        this.quizContentLoaderService.initializeFetForQuizData(quizData);
        await this.initializeQuiz(host);
        this.quizContentLoaderService.initializeFetForShuffledQuiz();
      });
  }

  private async initializeQuiz(host: Host): Promise<void> {
    if (host.quizAlreadyInitialized) return;
    host.quizAlreadyInitialized = true;

    await this.prepareQuizSession(host);

    // Honour the URL-derived question index. host.currentQuestionIndex is
    // set by initializeQuestionIndex earlier in runOnInit (which parses the
    // route param). Hard-coding 0 here on direct nav to /question/.../5
    // overwrote it and made the entire init use Q1 â€” visible to the user
    // as Q1's text + options on Q5.
    const currentIdx = host.currentQuestionIndex();
    const targetIdx = Number.isFinite(currentIdx) && currentIdx >= 0
      ? currentIdx
      : (Number.isFinite(host.questionIndex) && host.questionIndex >= 0 ? host.questionIndex : 0);

    if (targetIdx >= 0) {
      this.quizContentLoaderService.fetchAndSubscribeQuestionAndOptions(host.quizId, targetIdx);
    }
    this.quizService.setCurrentQuestionIndex(targetIdx);

    const targetQuestion = await firstValueFrom(this.quizService.getQuestionByIndex(targetIdx));
    if (targetQuestion) {
      this.quizService.setCurrentQuestion(targetQuestion);
      this.quizQuestionDataService.forceRegenerateExplanation(targetQuestion, targetIdx);
    }
  }

  private async prepareQuizSession(host: Host): Promise<void> {
    // Don't blow away host.currentQuestionIndex here â€” initializeQuestionIndex
    // ran earlier in runOnInit and may have set it from the URL param.
    // Reset only when no URL-derived index was established yet.
    const idx = host.currentQuestionIndex();
    if (!Number.isFinite(idx) || idx < 0) {
      host.currentQuestionIndex.set(0);
    }
    host.quizId = host.activatedRoute.snapshot.paramMap.get('quizId') ?? '';
    await this.quizContentLoaderService.prepareQuizSession({
      quizId: host.quizId,
      applyQuestionsFromSession: (questions: QuizQuestion[]) => this.applyQuestionsFromSession(host, questions)
    });
  }

  initializeQuizFromRoute(host: Host): void {
    host.activatedRoute.data
      .pipe(
        takeUntilDestroyed(host.destroyRef),
        switchMap((data: { quizData?: Quiz }) => {
          if (!data.quizData) {
            void this.router.navigate(['/select']);
            return EMPTY;
          }
          host.quiz = data.quizData;
          this.quizContentLoaderService.resetFetStateForInit();
          return of(true);
        })
      )
      .subscribe(() => {
        const trimmed = (this.quizService.questions?.[0]?.questionText ?? '').trim();
        if (trimmed) host.questionToDisplaySig.set(trimmed);
        this.quizContentLoaderService.seedFirstQuestionText();
        host.cdRef.markForCheck();
      });
  }

  initializeQuestionStreams(host: Host): void {
    host.questions$ = this.quizDataService.getQuestionsForQuiz(host.quizId);
    host.questions$.subscribe((questions: QuizQuestion[]) => {
      if (!questions?.length) return;
      // Honour the URL-derived index that initializeQuestionIndex set
      // earlier in runOnInit. Hard-resetting to 0/questions[0] here
      // overwrote it on direct URL navigation to /question/.../3,
      // making Q3's view start with Q1's question and options.
      const currentIdx = host.currentQuestionIndex();
      const idx = Number.isFinite(currentIdx) && currentIdx >= 0
        ? currentIdx : 0;
      const safeIdx = idx < questions.length ? idx : 0;
      for (const [index] of questions.entries()) {
        this.quizStateService.setQuestionState(
          host.quizId, index, this.quizStateService.createDefaultQuestionState()
        );
      }
      host.currentQuestionIndex.set(safeIdx);
      host.currentQuestion = questions[safeIdx];
    });
  }

  loadQuizQuestionsForCurrentQuiz(host: Host): void {
    host.isQuizDataLoaded = false;
    this.quizDataService.getQuestionsForQuiz(host.quizId).subscribe({
      next: (questions: QuizQuestion[]) => {
        this.applyQuestionsFromSession(host, questions);
        host.isQuizDataLoaded = true;
      },
      error: () => { host.isQuizDataLoaded = true; }
    });
  }

  createQuestionData(host: Host): void {
    const sub = this.quizContentLoaderService.createNormalizedQuestionPayload$()
      .subscribe((payload: QuestionPayload) => {
        host.combinedQuestionData.set(payload);
        host.qaToDisplay = { question: payload.question, options: payload.options };
        host.questionToDisplaySig.set(payload.question?.questionText?.trim() ?? 'No question available');
        host.explanationToDisplay.set(payload.explanation ?? '');
        host.question = payload.question;
        host.currentQuestion = payload.question;
        host.optionsToDisplay = [...payload.options];
        host.optionsToDisplaySig.set([...payload.options]);
        host.cdRef.detectChanges();
      });
    host.subscriptions.add(sub);
  }

  // â”€â”€ Question state + answer handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async handleNavigationToQuestion(host: Host, questionIndex: number): Promise<void> {
    this.quizService.getCurrentQuestion(questionIndex).subscribe({
      next: (question: QuizQuestion | null) => {
        if (question?.type != null) this.quizDataService.setQuestionType(question);
        this.quizContentLoaderService.restoreSelectionState(host.currentQuestionIndex());
        this.nextButtonStateService.evaluateNextButtonState(
          this.selectedOptionService.isAnsweredSig(),
          this.quizStateService.isLoadingSig(),
          this.quizStateService.isNavigatingSig()
        );
      },
      error: () => { }
    });
  }

  async updateQuestionStateAndExplanation(host: Host, questionIndex: number): Promise<void> {
    const result = await this.quizContentLoaderService.evaluateQuestionStateAndExplanation({
      quizId: host.quizId, questionIndex,
    });
    if (!result.handled) return;
    host.explanationToDisplay.set(result.explanationText);
    if (result.showExplanation) host.cdRef.detectChanges();
  }

  selectedAnswer(host: Host, optionIndex: number): void {
    const idx = host.currentQuestionIndex();
    host.markQuestionAnswered(idx);

    const result = this.quizContentLoaderService.processSelectedAnswer({
      optionIndex,
      question: host.question,
      optionsToDisplay: host.optionsToDisplay,
      currentQuestionIndex: idx,
      answers: host.answers
    });

    if (!result.option) return;
    host.answers = result.answers;
    void this.updateQuestionStateAndExplanation(host, idx);
  }
}