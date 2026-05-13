import { Injectable, signal, WritableSignal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { BehaviorSubject, from, Observable, of, Subject } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import { getQuizData } from '../../quiz-data-cache';
import { QuizStatus } from '../../models/quiz-status.enum';
import { FinalResult } from '../../models/Final-Result.model';
import { Option } from '../../models/Option.model';
import { QuestionPayload } from '../../models/QuestionPayload.model';
import { Quiz } from '../../models/Quiz.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { QuizScore } from '../../models/QuizScore.model';
import { QuizSelectionParams } from '../../models/QuizSelectionParams.model';
import { Resource } from '../../models/Resource.model';
import { SelectedOption } from '../../models/SelectedOption.model';
import { QuizStateService } from '../state/quizstate.service';
import { QuizShuffleService } from '../flow/quiz-shuffle.service';
import { QuizBannerService } from './quiz-banner.service';
import { QuizDataLoaderService } from './quiz-data-loader.service';
import { QuizQuestionResolverService } from './quiz-question-resolver.service';
import { QuizOptionsService } from './quiz-options.service';
import { QuizScoringService } from './quiz-scoring.service';
import { QuizAnswerEvaluationService } from './quiz-answer-evaluation.service';
import { QuizQuestionEmitterService } from './quiz-question-emitter.service';
import { QuizSessionManagerService } from './quiz-session-manager.service';

@Injectable({ providedIn: 'root' })
export class QuizService {
  /**
   * Field-style accessor backed by currentQuestionIndexSig (the signal
   * source of truth) and currentQuestionIndexSubject (the sync BS
   * mirror added in commit 1f7ae3e0 to fix the FET flash bug).
   * Plain `quizService.currentQuestionIndex = X` writes route through
   * the setter so external writers always update both stores.
   */
  get currentQuestionIndex(): number { return this.currentQuestionIndexSig(); }
  set currentQuestionIndex(v: number) {
    this.currentQuestionIndexSig.set(v);
    this.currentQuestionIndexSubject.next(v);
  }
  activeQuiz: Quiz | null = null;
  quizInitialState: Quiz[] = structuredClone(getQuizData());
  quizData: Quiz[] | null = this.quizInitialState;
  data: {
    questionText: string,
    correctAnswersText?: string,
    currentOptions: Option[]
  } = {
      questionText: '',
      correctAnswersText: '',
      currentOptions: []
    };
  quizId = (() => {
    try { return localStorage.getItem('quizId') ?? ''; }
    catch { return ''; }
  })();
  private _questions: QuizQuestion[] = [];

  // Scoring state delegated to QuizScoringService â€” getters for backwards compat
  public get questionCorrectness(): Map<number, boolean> {
    return this.scoringService.questionCorrectness;
  }
  public set questionCorrectness(val: Map<number, boolean>) {
    this.scoringService.questionCorrectness = val;
  }

  // Delegate to dataLoader's signal for single source of truth.
  private get currentQuizSig(): WritableSignal<Quiz | null> {
    return this.dataLoader.currentQuizSig;
  }
  private get currentQuiz$(): Observable<Quiz | null> {
    return this.dataLoader.currentQuiz$;
  }

  private questionsSig = signal<QuizQuestion[]>([]);
  questions$: Observable<QuizQuestion[]> = toObservable(this.questionsSig);

  private questionsQuizId: string | null = (() => {
    try { return localStorage.getItem('shuffledQuestionsQuizId'); }
    catch { return null; }
  })();

  currentQuestionIndexSig = signal<number>(0);
  // Sync mirror so observable subscribers (displayText$, etc.) receive
  // index changes in the same microtask as the signal write â€” avoids the
  // toObservable() async lag that caused FET-to-q-text flicker on Next.
  currentQuestionIndexSubject = new BehaviorSubject<number>(0);
  currentQuestionIndex$: Observable<number> = this.currentQuestionIndexSubject.asObservable();

  selectedOptionsMap: Map<number, SelectedOption[]> = new Map();

  answers: Option[] = [];
  resources: Resource[] = [];

  totalQuestions = 0;
  get correctCount(): number { return this.scoringService.correctCountSig(); }
  set correctCount(val: number) { this.scoringService.correctCountSig.set(val); }

  selectedQuiz: Quiz | null = null;
  selectedQuizSig = signal<Quiz | null>(null);
  selectedQuiz$: Observable<Quiz | null> = toObservable(this.selectedQuizSig);
  startedQuizId = '';
  continueQuizId = '';
  completedQuizId = '';
  quizCompleted = false;
  status = '';

  correctAnswers: Map<string, number[]> = new Map<string, number[]>();

  public get correctAnswersCount$(): Observable<number> {
    return this.scoringService.correctAnswersCount$;
  }
  public get correctAnswersCountSig() {
    return this.scoringService.correctAnswersCountSig;
  }

  public get correctAnswersCountTextSig(): WritableSignal<string> {
    return this.bannerService.correctAnswersCountTextSig;
  }
  public get correctAnswersText$(): Observable<string> {
    return this.bannerService.correctAnswersText$;
  }

  multipleAnswer = false;

  currentQuestionSig = signal<QuizQuestion | null>(null);
  public currentQuestion$: Observable<QuizQuestion | null> =
    toObservable(this.currentQuestionSig);

  currentOptionsSig = signal<Option[]>([]);
  totalQuestionsSig = signal<number>(0);
  totalQuestions$: Observable<number> = toObservable(this.totalQuestionsSig);

  readonly questionDataSig = signal<any>(null);
  questionData$ = toObservable(this.questionDataSig);

  private readonly shuffleEnabledSig = signal<boolean>(
    localStorage.getItem('checkedShuffle') === 'true'
  );
  checkedShuffle$ = toObservable(this.shuffleEnabledSig);

  public shuffledQuestions: QuizQuestion[] = (() => {
    try {
      // One-time purge of stale cache with corrupted correct flags
      if (!localStorage.getItem('_shuffleCacheV2')) {
        localStorage.removeItem('shuffledQuestions');
        localStorage.removeItem('shuffledQuestionsQuizId');
        localStorage.setItem('_shuffleCacheV2', '1');
        return [];
      }
      const stored = localStorage.getItem('shuffledQuestions');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  })();

  // Canonical question data is stored in dataLoader â€” access via getters below
  private get canonicalQuestionsByQuiz(): Map<string, QuizQuestion[]> {
    return this.dataLoader.getCanonicalQuestionsByQuiz();
  }
  private get canonicalQuestionIndexByText(): Map<string, Map<string, number>> {
    return this.dataLoader.getCanonicalQuestionIndexByText();
  }

  userAnswers: any[] = (() => {
    try { return JSON.parse(localStorage.getItem('userAnswers') ?? '[]'); }
    catch { return []; }
  })();
  optionsSource: Subject<Option[]> = new Subject<Option[]>();

  nextQuestionSig = signal<QuizQuestion | null>(null);
  nextQuestion$: Observable<QuizQuestion | null> = toObservable(this.nextQuestionSig);

  nextOptionsSig = signal<Option[]>([]);
  nextOptions$: Observable<Option[]> = toObservable(this.nextOptionsSig);

  public get badgeTextSig(): WritableSignal<string> {
    return this.bannerService.badgeTextSig;
  }
  public get badgeText(): Observable<string> {
    return this.bannerService.badgeText$;
  }

  readonly questionsLoadedSig = signal<boolean>(false);
  questionsLoaded$ = toObservable(this.questionsLoadedSig);

  private quizResetSource = new Subject<void>();
  quizReset$ = this.quizResetSource.asObservable();

  get score(): number { return this.scoringService.scoreSig(); }
  set score(val: number) { this.scoringService.scoreSig.set(val); }
  get quizScore(): QuizScore | null { return this.scoringService.quizScore; }
  set quizScore(val: QuizScore | null) { this.scoringService.quizScore = val; }
  get highScores(): QuizScore[] { return this.scoringService.highScores; }
  set highScores(val: QuizScore[]) { this.scoringService.highScores = val; }
  get highScoresLocal(): any { return this.scoringService.highScoresLocal; }
  set highScoresLocal(val: any) { this.scoringService.highScoresLocal = val; }

  questionPayloadSig = signal<QuestionPayload | null>(null);
  questionPayload$ = toObservable(this.questionPayloadSig).pipe(
    map((payload) => {
      if (!payload?.question) return payload;
      
      if (this.isShuffleEnabled() && this.shuffledQuestions?.length > 0) {
        const idx = this.currentQuestionIndex ?? 0;
        const correctQ = this.shuffledQuestions[idx];
        if (correctQ) {
          // ALWAYS use shuffled data when shuffle is active
          return {
            question: correctQ,
            options: correctQ.options ?? [],
            explanation: correctQ.explanation ?? ''
          };
        }
      }
      return payload;
    })
  );
  readonly finalResultSig = signal<FinalResult | null>(null);
  finalResult$ = toObservable(this.finalResultSig);

  private readonly _preReset$ = new Subject<number>();
  // Emitted with the target question index just before navigation hydrates it
  readonly preReset$ = this._preReset$.asObservable();

  constructor(
    private quizShuffleService: QuizShuffleService,
    private quizStateService: QuizStateService,
    public dataLoader: QuizDataLoaderService,
    public questionResolver: QuizQuestionResolverService,
    public optionsService: QuizOptionsService,
    public scoringService: QuizScoringService,
    public answerEvaluation: QuizAnswerEvaluationService,
    public questionEmitter: QuizQuestionEmitterService,
    public sessionManager: QuizSessionManagerService,
    public bannerService: QuizBannerService
  ) {
    // Scoring state is loaded in QuizScoringService constructor (loadQuestionCorrectness)
    this.scoringService.restoreScoreFromPersistence(this.quizId);
    this.initializeData();

    // Reset State Sync
    // When quizReset$ emits (e.g. on Shuffle Toggle), clear the internal state cache
    // in QuizStateService. Otherwise, "isAnswered" state for index 0 persists across shuffles.
    this.quizReset$.subscribe(() => {
      this.quizStateService.reset();
    });
  }

  get questions() {
    // Sync Safeguard
    // Direct access to .questions should ALSO return shuffled data if active.
    // This fixes components (like CodelabQuizContentComponent) that read array indices directly.
    if (this.isShuffleEnabled() && this.shuffledQuestions.length > 0) {
      return this.shuffledQuestions;
    }
    return this._questions;
  }
  set questions(value: any) {
    // Prevent shuffled data from overwriting canonical _questions
    // Check if the incoming data is the shuffled array to prevent pollution
    const isIncomingShuffledData =
      this.shuffledQuestions.length > 0 &&
      Array.isArray(value) &&
      value.length > 0 &&
      value === this.shuffledQuestions;

    if (isIncomingShuffledData) {
      // Do NOT update _questions - the canonical data should remain unshuffled
      // But still emit the shuffled questions for subscribers
      this.questionsSig.set(this.shuffledQuestions);
      return;
    }

    this._questions = value;

    // Sync Safeguard
    // If shuffle is active and we have shuffled questions, DO NOT overwrite with incoming (likely unshuffled) data.
    // Instead, re-emit the shuffled questions to keep everyone in sync.
    // Use isShuffleEnabled() instead of checkedShuffle property
    if (this.isShuffleEnabled() && this.shuffledQuestions.length > 0) {
      this.questionsSig.set(this.shuffledQuestions);
      this.questionsQuizId = this.quizId ?? null;
    } else {
      this.questionsSig.set(value);
      this.questionsQuizId = this.quizId ?? null;
    }
  }

  get shuffleEnabled(): boolean {
    return this.isShuffleEnabled();
  }

  initializeData(): void {
    const result = this.dataLoader.initializeData(this.quizId);

    this.quizId = result.resolvedQuizId;
    this.questions = result.questions;
    this.totalQuestions = result.totalQuestions;
    this.quizData = this.dataLoader.quizData;
    this.quizInitialState = this.dataLoader.quizInitialState;

    if (this.questions.length > 0) {
      this.totalQuestionsSig.set(this.totalQuestions);
    }
  }

  public setActiveQuiz(quiz: Quiz): void {
    this.activeQuiz = quiz;
    this.quizId = quiz.quizId;
    // When shuffle is active, emit shuffled questions to subscribers so
    // host.questionsArray doesn't get poisoned with unshuffled data.
    if (this.isShuffleEnabled() && this.shuffledQuestions.length > 0) {
      this.questionsSig.set(this.shuffledQuestions);
    } else {
      this.questionsSig.set(quiz.questions ?? []);
    }
    this.questionsQuizId = quiz.quizId;
    this.questions = quiz.questions ?? [];
    this.totalQuestions = (quiz.questions ?? []).length;
    this.totalQuestionsSig.set(this.totalQuestions);

    // Load resources for this quiz
    this.loadResourcesForQuiz(quiz.quizId);

    // Push quiz into the source-of-truth signal
    this.currentQuizSig.set(quiz);
  }

  // Load resources for a specific quiz ID
  loadResourcesForQuiz(quizId: string): void {
    this.dataLoader.loadResourcesForQuiz(quizId);
    this.resources = this.dataLoader.resources;
  }

  getActiveQuiz(): Quiz | null {
    return this.activeQuiz;
  }

  setCurrentQuiz(q: Quiz): void {
    this.activeQuiz = q;
    this.currentQuizSig.set(q);
    if (q?.quizId) this.quizId = q.quizId;
    
    if (Array.isArray(q?.questions)) {
      // When shuffle is active, do NOT emit unshuffled questions to subscribers.
      // That causes questionsArray in QuizComponent to briefly hold unshuffled
      // data, which downstream code reads as the display question source.
      if (this.isShuffleEnabled() && this.shuffledQuestions.length > 0) {
        this.questionsSig.set(this.shuffledQuestions);
      } else {
        this.questionsSig.set(q.questions);
      }
      this.questionsQuizId = q.quizId;
      this.questions = q.questions;
      this.totalQuestions = q.questions.length;
      this.totalQuestionsSig.set(this.totalQuestions);
    }
  }

  getCurrentQuizId(): string {
    return this.quizId;
  }

  setSelectedQuiz(selectedQuiz: Quiz): void {
    this.selectedQuizSig.set(selectedQuiz);
    this.selectedQuiz = selectedQuiz;
  }

  setQuizId(id: string): void {
    if (id && this.questionsQuizId && this.questionsQuizId !== id) {
      this.questionsSig.set([]);
      this.questionsQuizId = null;
      this.questions = [];
      this.shuffledQuestions = [];
    }
    this.quizId = id;
  }

  setQuizStatus(value: QuizStatus): void {
    // Hard lock: once completed, status is immutable
    if (this.quizCompleted && value === QuizStatus.CONTINUE) {
      return;
    }

    this.status = value;
  }

  setCompletedQuizId(value: string) {
    this.completedQuizId = value;
  }

  // Return a sanitized array of options for the given question index.
  getOptions(index: number): Observable<Option[]> {
    return this.optionsService.getOptions(
      index,
      (idx) => this.getQuestionByIndex(idx),
      this.currentOptionsSig
    );
  }

  getQuestionByIndex(index: number): Observable<QuizQuestion | null> {
    return this.questionResolver.getQuestionByIndex(
      index,
      () => this.resolveShuffleQuizId(),
      (idx, q) => this.resolveCanonicalQuestion(idx, q),
      () => this.isShuffleEnabled(),
      this.shuffledQuestions,
      this.questions$
    );
  }

  getQuestionsInDisplayOrder(): QuizQuestion[] {
    const shuffled = this.shuffledQuestions ?? [];
    return this.shuffleEnabled && shuffled.length
      ? shuffled : (this.questions ?? []);
  }

  async fetchQuizQuestions(quizId: string): Promise<QuizQuestion[]> {
    const questions = await this.dataLoader.fetchQuizQuestions(
      quizId,
      this.questionsSig,
      (qs) => { this._questions = qs; }
    );
    this.quizId = quizId;
    this.totalQuestions = questions.length;
    return questions;
  }

  getAllQuestions(): Observable<QuizQuestion[]> {
    // Prioritize shuffled questions if they exist!
    if (this.shuffledQuestions && this.shuffledQuestions.length > 0) {
      return of(this.shuffledQuestions);
    }

    if (this.questionsSig().length === 0) {
      // Delegate to fetchQuizQuestions which handles normalization AND shuffling!
      // This prevents getAllQuestions from returning raw/unshuffled data that bypasses the shuffle logic.
      return from(this.fetchQuizQuestions(this.quizId));
    }
    return this.questions$;
  }

  getQuestionData(
    quizId: string,
    questionIndex: number
  ): {
    questionText: string;
    currentOptions: Option[];
  } | null {
    const currentQuiz = (this.quizData ?? []).find(
      (quiz) => quiz.quizId === quizId
    );

    const questions = currentQuiz?.questions ?? [];
    if (questions.length > questionIndex) {
      const currentQuestion = questions[questionIndex];

      return {
        questionText: currentQuestion.questionText ?? '',
        currentOptions: currentQuestion.options
      };
    }

    return null;
  }

  public setCurrentQuestion(question: QuizQuestion): void {
    if (!question) return;

    const previousQuestion = this.currentQuestionSig();
    if (previousQuestion && question && JSON.stringify(previousQuestion) === JSON.stringify(question)) return;
    if (!Array.isArray(question.options) || question.options.length === 0) return;

    const updatedOptions = question.options.map((option, index) => ({
      ...option,
      optionId: option.optionId ?? index,
      correct: option.correct ?? false,
      selected: option.selected ?? false,
      active: option.active ?? true,
      showIcon: option.showIcon ?? false
    }));

    this.currentQuestionSig.set({ ...question, options: updatedOptions });
  }

  public getCurrentQuestion(
    questionIndex: number,
  ): Observable<QuizQuestion | null> {
    return this.questionResolver.getCurrentQuestion(questionIndex, this.questions);
  }

  public getLastKnownOptions(): Option[] {
    return this.currentQuestionSig()?.options || [];
  }

  // Get the current options for the current quiz and question
  getCurrentOptions(
    questionIndex: number = this.currentQuestionIndex ?? 0
  ): Observable<Option[]> {
    return this.optionsService.getCurrentOptions(
      questionIndex,
      (idx) => this.getQuestionByIndex(idx)
    );
  }

  setCurrentQuestionIndex(idx: number) {
    const safeIndex = Number.isFinite(idx) ? Math.max(0, Math.trunc(idx)) : 0;

    // Setter routes to both currentQuestionIndexSig and ...Subject.
    this.currentQuestionIndex = safeIndex;

    // Restore answers from persistence if available to prevent score decrement on navigation
    const prevSelected = this.selectedOptionsMap.get(safeIndex);

    if (prevSelected && prevSelected.length > 0) {
      // Re-hydrate full Option objects (needing .correct flag) from the source question
      const question = this.questions[safeIndex];  // use getter (handles shuffle)
      if (question && question.options) {
        const selectedIds = new Set(prevSelected.map(s => s.optionId));
        // text-match fallback for robustness
        const restoredAnswers = question.options.filter((o: Option) =>
          selectedIds.has(o.optionId) ||
          prevSelected.some(s => (s.text || '').trim() === (o.text || '').trim())
        );
        this.answers = restoredAnswers;
      } else {
        this.answers = [];
      }
    } else {
      this.answers = [];
    }
  }

  getCurrentQuestionIndex(): number {
    return this.currentQuestionIndexSig();
  }

  getCurrentQuestionIndexObservable(): Observable<number> {
    return this.currentQuestionIndex$;
  }

  updateCurrentQuestionIndex(index: number): void {
    this.currentQuestionIndex = index;
  }

  updateBadgeText(questionIndex: number, totalQuestions: number): void {
    this.bannerService.updateBadgeText(questionIndex, totalQuestions);
  }
  updateCorrectAnswersText(newText: string): void {
    this.bannerService.updateCorrectAnswersText(newText);
  }
  clearStoredCorrectAnswersText(): void {
    this.bannerService.clearStoredCorrectAnswersText();
  }

  isAnswered(questionIndex: number): Observable<boolean> {
    const options = this.selectedOptionsMap.get(questionIndex) ?? [];
    const isAnswered = options.length > 0;
    return of(isAnswered);
  }

  getTotalQuestionsCount(quizId: string): Observable<number> {
    return this.currentQuiz$.pipe(
      map((quiz) => {
        // Try to get count from the emitted quiz object
        if (quiz && quiz.quizId === quizId) {
          return quiz.questions?.length ?? 0;
        }

        // Fallback: If quiz object missing (e.g. cached/shuffled session), check active state
        // Validation of IDs proved flaky. If we have active questions, return their count.
        if (Array.isArray(this.questions) && this.questions.length > 0) {
          return this.questions.length;
        }

        return 0;
      }),
      distinctUntilChanged()
    );
  }

  handleQuestionChange(
    question: QuizQuestion | null,
    selectedOptions: Array<string | number> | null | undefined,
    options: Option[]
  ): {
    updatedOptions: Option[];
    nextQuestion: QuizQuestion | null;
    questionText: string;
    correctAnswersText: string;
  } {
    const result = this.sessionManager.handleQuestionChange(
      this, question, selectedOptions, options,
      this._questions, this.questionsSig, this.questionsQuizId
    );
    this.questionsQuizId = result.restoredQuestionsQuizId;
    return result;
  }

  getCorrectAnswersAsString(): string {
    return Array.from(this.correctAnswers.values())
      .map((a) => a.join(','))
      .join(';');
  }

  updateAnswersForOption(selectedOption: Option): void {
    if (!this.answers) this.answers = [];

    const isOptionSelected = this.answers.some(
      (answer: Option) => answer.optionId === selectedOption.optionId
    );
    if (!isOptionSelected) this.answers.push(selectedOption);

    const answerIds = this.answers
      .map((answer: Option) => answer.optionId)
      .filter((id): id is number => id !== undefined);

    // Update the persistent userAnswers array for the current question
    if (this.currentQuestionIndex >= 0) {
      if (!this.userAnswers) this.userAnswers = [];
      this.userAnswers[this.currentQuestionIndex] = answerIds;
    }
  }


  returnQuizSelectionParams(): QuizSelectionParams {
    return {
      startedQuizId: this.startedQuizId,
      continueQuizId: this.continueQuizId,
      completedQuizId: this.completedQuizId,
      quizCompleted: this.quizCompleted,
      status: this.status
    };
  }

  setQuestionsLoaded(state: boolean): void {
    this.questionsLoadedSig.set(state);
  }

  saveHighScores(): void {
    this.scoringService.saveHighScores(this.quizId, this.totalQuestions);
  }

  calculatePercentageOfCorrectlyAnsweredQuestions(): number {
    return this.scoringService.calculatePercentageOfCorrectlyAnsweredQuestions(this.totalQuestions);
  }

  private shouldShuffle(): boolean {
    return this.shuffleEnabledSig();
  }

  isShuffleEnabled(): boolean {
    // Keep using local signal since it's initialized in this service
    return this.shuffleEnabledSig();
  }

  // Expose sub-services for direct access by consumers that need them
  get quizDataLoader(): QuizDataLoaderService { return this.dataLoader; }
  get quizQuestionResolver(): QuizQuestionResolverService {
    return this.questionResolver;
  }
  get quizOptions(): QuizOptionsService { return this.optionsService; }
  get quizScoring(): QuizScoringService { return this.scoringService; }

  setCheckedShuffle(isChecked: boolean): void {
    this.shuffleEnabledSig.set(isChecked);
    try {
      localStorage.setItem('checkedShuffle', String(isChecked));

      // Clear stale shuffledQuestions from localStorage to prevent mismatch
      localStorage.removeItem('shuffledQuestions');
      localStorage.removeItem('shuffledQuestionsQuizId');
    } catch { }

    // Clear shuffle state on toggle to ensure fresh shuffle
    // This prevents stale shuffled data from being used when toggling
    this.quizShuffleService.clearAll();
    this.shuffledQuestions = [];

    // Also clear basic questions to force a fresh fetch/shuffle cycle
    this.questions = [];
    this.questionsSig.set([]);
    this.questionsQuizId = null;

    // Reset score when shuffle is toggled to clear stale questionCorrectness.
    // Otherwise, questions might be marked as "already correct" from previous sessions.
    this.resetScore();

    this.quizId = '';
  }

  setCanonicalQuestions(
    quizId: string,
    questions: QuizQuestion[] | null | undefined
  ): void {
    this.dataLoader.setCanonicalQuestions(
      quizId,
      questions,
      (q, idx) => this.questionResolver.cloneQuestionForSession(q, idx),
      (text) => this.dataLoader.normalizeQuestionText(text)
    );
  }

  /**
   * Returns a PRISTINE version of the question from the canonical cache.
   * This version has not been shuffled or mutated by user interactions.
   * @param index The original (unshuffled) index of the question.
   */
  public getPristineQuestion(index: number): QuizQuestion | null {
    return this.dataLoader.getPristineQuestion(
      this.quizId,
      index,
      (q, idx) => this.questionResolver.cloneQuestionForSession(q, idx)
    );
  }

  /**
   * Lazy O(1) lookup of the pristine question object for a given live
   * questionText (matched case-insensitive after trim). Returns null on
   * cache miss. Backed by a single lazy-built Map over `quizInitialState`
   * so callers don't re-scan the bundle on every click.
   */
  public getPristineQuestionByText(
    questionText: string | null | undefined
  ): QuizQuestion | null {
    const key = String(questionText ?? '').trim().toLowerCase();
    if (!key) return null;
    if (!this._pristineByQText) {
      this._pristineByQText = this.buildPristineByTextCache();
    }
    return this._pristineByQText.get(key) ?? null;
  }

  /**
   * Lazy O(1) lookup of pristine correct option texts for a given live
   * questionText. Replaces the nested `for (quiz) for (question)` scan
   * over `quizInitialState` that was being run inside hot template
   * methods (isDisabled / getOptionBackgroundColor / etc.) on every CD
   * cycle for every option-item â€” easily thousands of string compares
   * per click. Derived on-demand from the pristine-by-text cache and
   * memoized so repeat lookups are also O(1).
   */
  public getPristineCorrectTextsForQuestion(
    questionText: string | null | undefined
  ): Set<string> {
    const key = String(questionText ?? '').trim().toLowerCase();
    if (!key) return new Set();
    if (!this._correctTextsByQText) this._correctTextsByQText = new Map();
    const cached = this._correctTextsByQText.get(key);
    if (cached) return cached;
    const pq = this.getPristineQuestionByText(questionText);
    if (!pq) {
      const empty = new Set<string>();
      this._correctTextsByQText.set(key, empty);
      return empty;
    }
    const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
    const isCorrect = (v: any) =>
      v === true || String(v) === 'true' || v === 1 || v === '1';
    const texts = new Set<string>();
    for (const opt of (pq as any).options ?? []) {
      if (isCorrect(opt?.correct)) {
        const txt = nrm(opt?.text);
        if (txt) texts.add(txt);
      }
    }
    this._correctTextsByQText.set(key, texts);
    return texts;
  }

  private _pristineByQText: Map<string, QuizQuestion> | null = null;
  private _correctTextsByQText: Map<string, Set<string>> | null = null;

  private buildPristineByTextCache(): Map<string, QuizQuestion> {
    const cache = new Map<string, QuizQuestion>();
    const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
    for (const quiz of this.quizInitialState ?? []) {
      for (const pq of quiz?.questions ?? []) {
        const key = nrm(pq?.questionText);
        if (!key || cache.has(key)) continue;
        cache.set(key, pq as QuizQuestion);
      }
    }
    return cache;
  }

  applySessionQuestions(quizId: string, questions: QuizQuestion[]): void {
    const newQuizId = this.sessionManager.applySessionQuestions(
      this, quizId, questions,
      this.questionsSig, this.quizResetSource
    );
    if (newQuizId) {
      this.questionsQuizId = newQuizId;
      // Update the source-of-truth signal from the now-mutated activeQuiz
      if (this.activeQuiz) {
        this.currentQuizSig.set(this.activeQuiz);
      }
    }
  }

  findQuestionIndex(question: QuizQuestion | null): number {
    if (!question || !Array.isArray(this.selectedQuiz?.questions) || this.selectedQuiz.questions.length === 0) {
      return -1;
    }
    return this.selectedQuiz.questions.findIndex(
      (q) => q.questionText === question.questionText
    );
  }

  resetQuestions(): void {
    this.sessionManager.resetQuestions(this);
  }

  // Ensure quiz ID exists, retrieving it if necessary
  async ensureQuizIdExists(): Promise<boolean> {
    const result = await this.dataLoader.ensureQuizIdExists(this.quizId);
    if (result.resolvedId && result.resolvedId !== this.quizId) {
      this.quizId = result.resolvedId;
    }
    return result.exists;
  }

  updateUserAnswer(questionIndex: number, answerIds: number[]): void {
    this.userAnswers[questionIndex] = answerIds;
    try {
      localStorage.setItem('userAnswers', JSON.stringify(this.userAnswers));
    } catch (err) {}

    let question = this.questions[questionIndex];
    if (this.shouldShuffle() && this.quizId) {
      const resolved = this.resolveCanonicalQuestion(questionIndex, null);
      if (resolved) question = resolved;
    }

    this.answers = this.answerEvaluation.resolveAnswerOptions(
      answerIds,
      question,
      questionIndex,
      this.shouldShuffle()
    );

    if (!this.shouldShuffle()) {
      this.checkIfAnsweredCorrectly(questionIndex, false);
    }
  }

  async checkIfAnsweredCorrectly(index: number = -1, updateScore: boolean = false): Promise<boolean> {
    const qIndex = index >= 0 ? index : this.currentQuestionIndex;

    let currentQuestionValue: QuizQuestion | null = null;
    if (this.shouldShuffle()) {
      const resolved = this.resolveCanonicalQuestion(qIndex, null);
      if (resolved) currentQuestionValue = resolved;
    } else {
      currentQuestionValue = this.questions[qIndex] ?? this.currentQuestionSig();
    }

    if (!currentQuestionValue) return false;

    const storedAnswerIds = Array.isArray(this.userAnswers[qIndex])
      ? (this.userAnswers[qIndex] as number[]) : [];

    const result = await this.answerEvaluation.evaluateCorrectness(
      qIndex,
      currentQuestionValue,
      storedAnswerIds
    );

    this.multipleAnswer = result.multipleAnswer;
    this.answers = result.resolvedAnswers;

    if (updateScore && result.answerIds.length > 0) {
      this.incrementScore(result.answerIds, result.isCorrect, this.multipleAnswer, qIndex);
    }

    return result.isCorrect;
  }

  public scoreDirectly(
    questionIndex: number, 
    isCorrect: boolean, 
    isMultipleAnswer: boolean
  ): void {
    const shouldProceed = this.answerEvaluation.verifyScoreAgainstPristine(
      questionIndex,
      isCorrect,
      isMultipleAnswer,
      this.shouldShuffle(),
      this.quizId,
      this.quizInitialState,
      this.questions,
      this.answers,
      this.userAnswers
    );

    if (!shouldProceed) return;

    this.scoringService.scoreDirectly(
      questionIndex, isCorrect, isMultipleAnswer, this.shouldShuffle(), this.quizId
    );
  }

  incrementScore(
    answers: number[],
    correctAnswerFound: boolean,
    isMultipleAnswer: boolean,
    questionIndex: number = -1
  ): void {
    const qIndex = questionIndex >= 0 ? questionIndex : this.currentQuestionIndex;
    this.scoringService.incrementScore(
      answers, correctAnswerFound, isMultipleAnswer, qIndex, this.shouldShuffle(), this.quizId
    );
  }

  resetScore(): void {
    this.scoringService.resetScore(this.quizId);
  }

  sendCorrectCountToResults(value: number): void {
    this.scoringService.sendCorrectCountToResults(value, this.quizId);
  }

  resetQuizSessionState(): void {
    this.sessionManager.resetQuizSessionState(this, this.quizResetSource);
    this.questionsQuizId = null;
  }

  resetAll(): void {
    this.sessionManager.resetAll(this, this.quizResetSource);
    // Tail items not on the QuizSessionState interface â€” kept here so the
    // session manager doesn't need to know about dataLoader internals or
    // private QuizService fields.
    this.questionsQuizId = null;
    this.dataLoader.clearFetchPromise();
    (this as any)._multiAnswerPerfect?.clear?.();
  }

  private resolveShuffleQuizId(): string | null {
    return this.quizId 
      || this.activeQuiz?.quizId 
      || this.selectedQuiz?.quizId || null;
  }

  private resolveCanonicalQuestion(
    index: number,
    currentQuestion?: QuizQuestion | null
  ): QuizQuestion | null {
    return this.questionEmitter.resolveCanonicalQuestion(
      index,
      currentQuestion ?? null,
      this.quizId,
      this.activeQuiz?.quizId ?? null,
      this.selectedQuiz?.quizId ?? null,
      () => this.isShuffleEnabled(),
      () => this.shouldShuffle(),
      this.shuffledQuestions,
      this.canonicalQuestionsByQuiz,
      this.canonicalQuestionIndexByText,
      this.questions
    );
  }

  emitQuestionAndOptions(
    currentQuestion: QuizQuestion,
    options: Option[],
    indexOverride?: number
  ): void {
    const canonical = this.isShuffleEnabled()
      ? null
      : this.resolveCanonicalQuestion(
          Number.isFinite(indexOverride as number)
            ? Math.max(0, Math.trunc(indexOverride as number))
            : Math.max(0, Math.trunc(this.currentQuestionIndex ?? 0)),
          currentQuestion
        );

    const result = this.questionEmitter.prepareQuestionAndOptions(
      currentQuestion,
      options,
      this.currentQuestionIndex,
      indexOverride,
      this.isShuffleEnabled(),
      canonical
    );

    if (!result) return;

    // Emit to individual subjects
    this.nextQuestionSig.set(result.questionToEmit);
    this.updateCurrentQuestion(result.questionToEmit);
    this.nextOptionsSig.set(result.optionsToUse);

    // Emit the combined payload
    this.questionPayloadSig.set({
      question: result.questionToEmit,
      options: result.optionsToUse,
      explanation: result.questionToEmit.explanation ?? ''
    });
  }

  // When the service receives a new question (usually in a method
  // that loads the next question), push the text into the source:
  public updateCurrentQuestion(_question: QuizQuestion): void {
    // Kept as an extension point; callers notify QuizService of question changes
  }

  /**
   * Clears any cached question payloads so a stale value from a previous
   * run cannot leak into a freshly loaded quiz.
   */
  resetQuestionPayload(): void {
    this.questionPayloadSig.set(null);
  }

  getFinalResultSnapshot(): FinalResult | null {
    // Prefer in-memory snapshot
    const live = this.finalResultSig();
    if (live) return live;

    // Fallback to sessionStorage (tab switch / reload safe)
    try {
      const raw = sessionStorage.getItem('finalResult');
      return raw ? (JSON.parse(raw) as FinalResult) : null;
    } catch (err) {
      return null;
    }
  }

  clearFinalResult(): void {
    this.finalResultSig.set(null);
    try {
      sessionStorage.removeItem('finalResult');
    } catch { }
  }

  resetQuizSessionForNewRun(quizId: string): void {
    this.sessionManager.resetQuizSessionForNewRun(this, quizId);
  }
}