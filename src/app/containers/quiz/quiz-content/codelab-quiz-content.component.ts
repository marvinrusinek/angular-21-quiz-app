
import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, effect, ElementRef,
  input, OnChanges, OnDestroy, OnInit, output, Renderer2, signal, SimpleChanges, 
  untracked, ViewChild 
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, ParamMap } from '@angular/router';
import { BehaviorSubject, Observable, of, Subject } from 'rxjs';

import { CombinedQuestionDataType } from
  '../../../shared/models/CombinedQuestionDataType.model';
import { Option } from '../../../shared/models/Option.model';
import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { QuizNavigationService } from '../../../shared/services/flow/quiz-navigation.service';
import { QqcQuestionLoaderService } from
  '../../../shared/services/features/qqc/qqc-question-loader.service';
import { QuizQuestionManagerService } from '../../../shared/services/flow/quizquestionmgr.service';
import { QuizStateService } from '../../../shared/services/state/quizstate.service';
import { SelectedOptionService } from '../../../shared/services/state/selectedoption.service';
import { ExplanationTextService, FETPayload } from
      '../../../shared/services/features/explanation/explanation-text.service';
import { QuizQuestionComponent } from
  '../../../components/question/quiz-question/quiz-question.component';
import { TimerService } from '../../../shared/services/features/timer/timer.service';
import { QuizContentDisplayService } from '../../../shared/services/features/quiz-content/quiz-content-display.service';
import { CqcOrchestratorService } from '../../../shared/services/features/quiz-content/cqc-orchestrator.service';

@Component({
  selector: 'codelab-quiz-content',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './codelab-quiz-content.component.html',
  styleUrls: ['./codelab-quiz-content.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CodelabQuizContentComponent implements OnInit, OnChanges, OnDestroy {
  @ViewChild(QuizQuestionComponent, { static: false })
  quizQuestionComponent!: QuizQuestionComponent;
  @ViewChild('qText', { static: true })
  qText!: ElementRef<HTMLHeadingElement>;

  readonly isContentAvailableChange = output<boolean>();

  private _combinedQuestionDataSig = signal<Observable<CombinedQuestionDataType> | null>(null);
  readonly combinedQuestionData$ = this._combinedQuestionDataSig.asReadonly();
  setCombinedQuestionData$(v: Observable<CombinedQuestionDataType> | null): void { this._combinedQuestionDataSig.set(v); }
  readonly currentQuestionSig = signal<QuizQuestion | null>(null);
  readonly currentQuestion$ = toObservable(this.currentQuestionSig);
  readonly questionToDisplay = input<string>('');
  readonly questionToDisplay$ = input<Observable<string | null> | null>(null);
  readonly explanationToDisplay = input<string | null>(null);
  readonly question = input<QuizQuestion | null>(null);
  readonly question$ = input<Observable<QuizQuestion | null> | null>(null);
  readonly questions = input<QuizQuestion[]>([]);
  readonly options = input<Option[]>([]);
  private _quizIdSig = signal<string>('');
  readonly quizId = this._quizIdSig.asReadonly();
  setQuizId(v: string): void { this._quizIdSig.set(v); }
  readonly correctAnswersText = input<string>('');
  readonly questionText = input<string>('');
  readonly quizData = input<CombinedQuestionDataType | null>(null);
  readonly displayState$ = input<Observable<{ mode: 'question' | 'explanation', answered: boolean }> | null>(null);
  readonly displayVariables = input<{ question: string; explanation: string } | null>(null);
  readonly localExplanationText = input<string>('');
  readonly showLocalExplanation = input<boolean>(false);

  readonly questionIndex = input<number>(0);

  currentQuestionIndexValue = 0;
  currentQuestionIndex$!: Observable<number>;
  nextQuestion$: Observable<QuizQuestion | null>;

  // Read live from the navigation service signal — no local mirror needed.
  get isNavigatingToPrevious(): boolean {
    return this.quizNavigationService.isNavigatingToPreviousSig();
  }

  private get _lastQuestionTextByIndex(): Map<number, string> {
    return this.displayService._lastQuestionTextByIndex;
  }

  private get _fetDisplayedThisSession(): Set<number> {
    return this.displayService._fetDisplayedThisSession;
  }

  private currentIndex = -1;
  // Signal source of truth + sync BS mirror so .asObservable() consumers
  // (displayText$ pipeline) keep their sync emission. Migrating fully to
  // toObservable(sig) would re-introduce the FET flash bug fixed earlier.
  readonly questionIndexSig = signal<number>(0);
  questionIndexSubject = new BehaviorSubject<number>(0);
  currentIndex$ = this.questionIndexSubject.asObservable();
  private readonly questionLoadingText = 'Loading question…';

  // Restored after commit ed9f41d2 ("Clean up CodelabQuizContentComponent")
  // dropped them — runSetupCorrectAnswersTextDisplay reads both .pipe before
  // reassigning them and crashes when they're undefined.
  private shouldDisplayCorrectAnswersSubject = new BehaviorSubject<boolean>(false);
  shouldDisplayCorrectAnswers$: Observable<boolean> =
    this.shouldDisplayCorrectAnswersSubject.asObservable();
  isExplanationDisplayed$ = new BehaviorSubject<boolean>(false);
  displayCorrectAnswersText$!: Observable<string | null>;

  isExplanationTextDisplayed$: Observable<boolean>;

  private get _fetLocked(): boolean { return this.displayService._fetLockedSig(); }
  private set _fetLocked(v: boolean) { this.displayService._fetLockedSig.set(v); }
  private get _lockedForIndex(): number { return this.displayService._lockedForIndexSig(); }
  private set _lockedForIndex(v: number) { this.displayService._lockedForIndexSig.set(v); }

  formattedExplanation$!: Observable<FETPayload>;
  public activeFetText$!: Observable<string>;
  get displayText$(): Observable<string> { return this.displayService.displayText$; }
  set displayText$(v: Observable<string>) { this.displayService.displayText$ = v; }

  // Never written; cqc-orchestrator subscribes only to seed its
  // combineLatest pipeline. Constant observable keeps the API stable.
  readonly numberOfCorrectAnswers$ = of('0');

  readonly correctAnswersTextSig = signal<string>('');
  readonly correctAnswersText$ = toObservable(this.correctAnswersTextSig);

  readonly questionRenderedSig = signal<boolean>(false);

  isContentAvailable$!: Observable<boolean>;

  // Signal-backed source of truth for the qText heading's innerHTML.
  // Binding the template to this signal makes Angular's change detection
  // keep the heading stable across tab visibility flips and async restores —
  // no more fighting the DOM imperatively.
  readonly qTextHtmlSig = signal<string>('');

  get shouldShowFet$(): Observable<boolean> { return this.displayService.shouldShowFet$; }
  set shouldShowFet$(v: Observable<boolean>) { this.displayService.shouldShowFet$ = v; }
  get fetToDisplay$(): Observable<string> { return this.displayService.fetToDisplay$; }
  set fetToDisplay$(v: Observable<string>) { this.displayService.fetToDisplay$ = v; }

  // Signal source of truth + sync BS mirror. The TIMER-EXPIRY FAST PATH
  // in cqc-display-text and the displayText$ pipeline both read .getValue()
  // / subscribe to currentIndex$/timedOutIdx$ and rely on sync emission
  // so they don't observe a stale-Q FET window during navigation.
  readonly timedOutIdxSig = signal<number>(-1);
  timedOutIdxSubject = new BehaviorSubject<number>(-1);
  public timedOutIdx$ = this.timedOutIdxSubject.asObservable();

  private destroy$ = new Subject<void>();

  constructor(
    private quizService: QuizService,
    private quizDataService: QuizDataService,
    private quizNavigationService: QuizNavigationService,
    private quizStateService: QuizStateService,
    private explanationTextService: ExplanationTextService,
    private quizQuestionLoaderService: QqcQuestionLoaderService,
    private quizQuestionManagerService: QuizQuestionManagerService,
    private selectedOptionService: SelectedOptionService,
    private timerService: TimerService,
    private activatedRoute: ActivatedRoute,
    private cdRef: ChangeDetectorRef,
    private renderer: Renderer2,
    private displayService: QuizContentDisplayService,
    private orchestrator: CqcOrchestratorService
  ) {
    this.nextQuestion$ = this.quizService.nextQuestion$;

    this.formattedExplanation$ = this.displayService.createFormattedExplanation$(this.currentIndex$);
    this.activeFetText$ = this.displayService.createActiveFetText$(this.currentIndex$);

    this.isExplanationTextDisplayed$ =
      this.explanationTextService.isExplanationTextDisplayed$;

    let effectFiredOnce = false;
    effect(() => {
      const idx = this.questionIndex();
      untracked(() => {
        if (!effectFiredOnce) {
          // Skip the effect's own first run — ngOnInit primes synchronously.
          effectFiredOnce = true;
          return;
        }
        this._fetLocked = false;
        this._lockedForIndex = -1;
        this.orchestrator.runQuestionIndexSet(this, idx);
        this.currentIndex = idx;
        this.resetExplanationView();
        this.cdRef.markForCheck();
      });
    });
  }

  async ngOnInit(): Promise<void> {
    this.primeQuestionIndex();
    const result = this.orchestrator.runOnInit(this);
    this.orchestrator.runInstallFetWatchdog(this);
    return result;
  }

  // Prime synchronously with the initial input value so runOnInit's
  // downstream setup sees the correct currentIndex / FET state.
  private primeQuestionIndex(): void {
    this.orchestrator.runQuestionIndexSet(this, this.questionIndex());
  }

  ngOnChanges(changes: SimpleChanges) {
    if (!!this.questionText() && !this.questionRenderedSig()) {
      this.questionRenderedSig.set(true);
    }
  }

  ngOnDestroy(): void {
    // FET watchdog cleanup is handled by orchestrator.runOnDestroy via fetGuard.
    this.orchestrator.runOnDestroy(this);
  }

  private resetInitialState(): void {
    this.explanationTextService.setIsExplanationTextDisplayed(false);
  }

  private setupQuestionResetSubscription(): void {
    this.orchestrator.runSetupQuestionResetSubscription(this);
  }

  private initDisplayTextPipeline(): void {
    this.displayService.initDisplayTextPipeline(
      this.currentIndex$,
      this.timedOutIdx$,
      this.displayState$() ?? this.quizStateService.displayState$
    );
  }

  private resetExplanationService(): void {
    this.resetExplanationView();

    this.explanationTextService.setShouldDisplayExplanation(false);
    this.explanationTextService.explanationText$.next('');

    this.explanationTextService.resetForIndex(0);
    this.explanationTextService.setShouldDisplayExplanation(false, {
      force: true
    });
  }

  private subscribeToDisplayText(): void {
    this.orchestrator.runSubscribeToDisplayText(this);
  }

  private setupContentAvailability(): void {
    this.orchestrator.runSetupContentAvailability(this);
  }

  private resetExplanationView(): void {
    this.explanationTextService.setShouldDisplayExplanation(false);
    this.explanationTextService.setExplanationText('');
  }

  private regenerateFetForIndex(idx: number): string {
    return this.displayService.regenerateFetForIndex(idx);
  }

  private emitContentAvailableState(): void {
    this.orchestrator.runEmitContentAvailableState(this);
  }

  private loadQuizDataFromRoute(): void {
    this.orchestrator.runLoadQuizDataFromRoute(this);
  }

  private async loadQuestion(quizId: string, zeroBasedIndex: number): Promise<void> {
    return this.orchestrator.runLoadQuestion(this, quizId, zeroBasedIndex);
  }

  private async initializeComponent(): Promise<void> {
    await this.initializeQuestionData();
    this.initializeCombinedQuestionData();
  }

  private async initializeQuestionData(): Promise<void> {
    return this.orchestrator.runInitializeQuestionData(this);
  }

  private fetchQuestionsAndExplanationTexts(params: ParamMap): Observable<[QuizQuestion[], string[]]> {
    return this.orchestrator.runFetchQuestionsAndExplanationTexts(this, params);
  }

  private initializeCurrentQuestionIndex(): void {
    const idx = this.currentQuestionIndexValue ?? 0;
    this.quizService.currentQuestionIndex = idx;
    this.questionIndexSig.set(idx);
    this.questionIndexSubject.next(idx);
    this.currentIndex = idx;
    this.currentQuestionIndex$ =
      this.quizService.getCurrentQuestionIndexObservable();
  }

  private updateCorrectAnswersDisplay(question: QuizQuestion | null): Observable<void> {
    return this.orchestrator.runUpdateCorrectAnswersDisplay(this, question);
  }

  private initializeCombinedQuestionData(): void {
    this.orchestrator.runInitializeCombinedQuestionData(this);
  }

  private combineCurrentQuestionAndOptions(): Observable<{
    currentQuestion: QuizQuestion | null;
    currentOptions: Option[];
    explanation: string;
    currentIndex: number;
  }> {
    return this.orchestrator.runCombineCurrentQuestionAndOptions(this);
  }

  private haveSameOptionOrder(left: Option[] = [], right: Option[] = []): boolean {
    return this.orchestrator.runHaveSameOptionOrder(this, left, right);
  }

  private calculateCombinedQuestionData(
    currentQuizData: CombinedQuestionDataType,
    numberOfCorrectAnswers: number,
    isExplanationDisplayed: boolean,
    formattedExplanation: string
  ): CombinedQuestionDataType {
    return this.orchestrator.runCalculateCombinedQuestionData(this, currentQuizData, numberOfCorrectAnswers, isExplanationDisplayed, formattedExplanation);
  }

  private setupCorrectAnswersTextDisplay(): void {
    this.orchestrator.runSetupCorrectAnswersTextDisplay(this);
  }

  private setupShouldShowFet(): void {
    this.displayService.setupShouldShowFet(this.currentIndex$);
  }

  private setupFetToDisplay(): void {
    this.displayService.setupFetToDisplay(
      this.currentIndex$,
      this.timedOutIdx$,
      this.activeFetText$,
      this.currentQuestion$
    );
  }

  private normalizeKeySource(value: string | null | undefined): string {
    return (value ?? '')
      .toString()
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }
}