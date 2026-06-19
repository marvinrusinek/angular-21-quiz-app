import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, effect,
  ElementRef, inject, input, OnInit, output, Renderer2, signal, untracked, viewChild
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, ParamMap } from '@angular/router';
import { BehaviorSubject, Observable, of, Subscription } from 'rxjs';

import { CombinedQuestionDataType } from
  '../../../shared/models/CombinedQuestionDataType.model';
import { Option } from '../../../shared/models/Option.model';
import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';

import { CqcOrchestratorService } from '../../../shared/services/features/quiz-content/cqc-orchestrator.service';
import { ExplanationTextService, FETPayload } from
      '../../../shared/services/features/explanation/explanation-text.service';
import { QuestionHeadingService } from '../../../shared/services/features/quiz-content/question-heading.service';
import { QuizContentDisplayService } from '../../../shared/services/features/quiz-content/quiz-content-display.service';
import { QuizDataService } from '../../../shared/services/data/quizdata.service';
import { QuizNavigationService } from '../../../shared/services/flow/quiz-navigation.service';
import { QuizQuestionManagerService } from '../../../shared/services/flow/quizquestionmgr.service';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { QuizStateService } from '../../../shared/services/state/quizstate.service';
import { SelectedOptionService } from '../../../shared/services/state/selectedoption.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';

import { QuizQuestionComponent } from
  '../../../components/question/quiz-question/quiz-question.component';

@Component({
  selector: 'codelab-quiz-content',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './codelab-quiz-content.component.html',
  styleUrls: ['./codelab-quiz-content.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CodelabQuizContentComponent implements OnInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly displayService = inject(QuizContentDisplayService);
  public readonly explanationTextService = inject(ExplanationTextService);
  private readonly orchestrator = inject(CqcOrchestratorService);
  public readonly questionHeadingService = inject(QuestionHeadingService);
  public readonly quizDataService = inject(QuizDataService);
  private readonly quizNavigationService = inject(QuizNavigationService);
  public readonly quizQuestionManagerService = inject(QuizQuestionManagerService);
  public readonly quizService = inject(QuizService);
  public readonly quizStateService = inject(QuizStateService);
  public readonly selectedOptionService = inject(SelectedOptionService);
  public readonly timerService = inject(TimerService);
  public readonly activatedRoute = inject(ActivatedRoute);
  public readonly cdRef = inject(ChangeDetectorRef);
  public readonly destroyRef = inject(DestroyRef);
  public readonly renderer = inject(Renderer2);

  // ── viewChilds ──────────────────────────────────────────────────
  readonly quizQuestionComponent = viewChild(QuizQuestionComponent);
  readonly qText = viewChild<ElementRef<HTMLHeadingElement>>('qText');

  // ── outputs ─────────────────────────────────────────────────────
  readonly isContentAvailableChange = output<boolean>();

  // ── inputs ──────────────────────────────────────────────────────
  readonly questionToDisplay = input<string>('');
  readonly questionToDisplay$ = input<Observable<string | null> | null>(null);
  readonly explanationToDisplay = input<string | null>(null);
  readonly question = input<QuizQuestion | null>(null);
  readonly question$ = input<Observable<QuizQuestion | null> | null>(null);
  readonly questions = input<QuizQuestion[]>([]);
  readonly options = input<Option[]>([]);
  readonly correctAnswersText = input<string>('');
  readonly questionText = input<string>('');
  readonly quizData = input<CombinedQuestionDataType | null>(null);
  readonly displayState$ = input<Observable<{ mode: 'question' | 'explanation', answered: boolean }> | null>(null);
  readonly displayVariables = input<{ question: string; explanation: string } | null>(null);
  readonly localExplanationText = input<string>('');
  readonly showLocalExplanation = input<boolean>(false);
  readonly questionIndex = input<number>(0);

  // ── remaining variables ─────────────────────────────────────────
  private _combinedQuestionDataSig = signal<Observable<CombinedQuestionDataType> | null>(null);
  readonly combinedQuestionData$ = this._combinedQuestionDataSig.asReadonly();
  readonly currentQuestionSig = signal<QuizQuestion | null>(null);
  readonly currentQuestion$ = toObservable(this.currentQuestionSig);
  private _quizIdSig = signal<string>('');
  readonly quizId = this._quizIdSig.asReadonly();

  currentQuestionIndexValue = 0;
  currentQuestionIndex$!: Observable<number>;

  // Aliased directly from the navigation service signal — no wrapper getter needed.
  readonly isNavigatingToPrevious = this.quizNavigationService.isNavigatingToPreviousSig;

  currentIndex = -1;
  // Signal source of truth + sync BS mirror so .asObservable() consumers
  // (displayText$ pipeline) keep their sync emission. Migrating fully to
  // toObservable(sig) would re-introduce the FET flash bug fixed earlier.
  readonly questionIndexSig = signal<number>(0);
  questionIndexSubject = new BehaviorSubject<number>(0);
  currentIndex$ = this.questionIndexSubject.asObservable();

  isExplanationTextDisplayed$: Observable<boolean>;

  formattedExplanation$!: Observable<FETPayload>;
  public activeFetText$!: Observable<string>;

  // Never written; cqc-orchestrator subscribes only to seed its
  // combineLatest pipeline. Constant observable keeps the API stable.
  readonly numberOfCorrectAnswers$ = of('0');

  readonly correctAnswersTextSig = signal<string>('');

  readonly questionRenderedSig = signal<boolean>(false);

  isContentAvailable$!: Observable<boolean>;

  // Single owner of the qText heading's innerHTML: QuestionHeadingService.
  // qTextHtmlSig is now a direct reference to the service's signal so that
  // legacy callers (`host.qTextHtmlSig?.set(x)`) keep working unchanged while
  // new code can inject QuestionHeadingService directly and call setHtml().
  readonly qTextHtmlSig = this.questionHeadingService.htmlSig;

  // Signal source of truth + sync BS mirror. The TIMER-EXPIRY FAST PATH
  // in cqc-display-text and the displayText$ pipeline both read .getValue()
  // / subscribe to currentIndex$/timedOutIdx$ and rely on sync emission
  // so they don't observe a stale-Q FET window during navigation.
  readonly timedOutIdxSig = signal<number>(-1);
  timedOutIdxSubject = new BehaviorSubject<number>(-1);
  public timedOutIdx$ = this.timedOutIdxSubject.asObservable();

  // Runtime-mutated state used by cqc-orchestrator + cqc-display-text +
  // cqc-fet-guard + cqc-question-nav services. Declared here so the Host
  // type sees them; values default to falsy/empty until the services
  // assign on init.
  combinedText$!: Observable<string>;
  combinedSub?: Subscription;
  _lastDisplayedText = '';
  _fetWatchdog: MutationObserver | null = null;
  _fetWatchdogClick: ((this: Document, ev: MouseEvent) => any) | null = null;
  _cqcComputeIntendedQText?: () => string;
  _qTextObserver: MutationObserver | null = null;
  _cqcVisibilityHandler?: () => void;
  _fetLockedForIndex = -1;
  _questionStampRetryTimers: any[] = [];
  _eagerFetRetryTimers: any[] = [];
  _refreshInitialIdx: number | null = null;
  _refreshInitialLoadConsumed: boolean | null = null;
  _postRefreshCleanedIndices?: Set<number>;
  lastQuestionIndexForReset = -1;
  explanationTexts: string[] = [];

  constructor() {
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

    // First-render latch. Replaces a now-unreachable ngOnChanges that
    // tried to flip questionRenderedSig the first time questionText
    // resolved to a non-empty string. Signal-input changes don't fire
    // ngOnChanges, so this only runs as an effect.
    effect(() => {
      if (!!this.questionText() && !this.questionRenderedSig()) {
        this.questionRenderedSig.set(true);
      }
    });

    // qText DOM-write effect: signal-driven binding from
    // QuestionHeadingService.htmlSig to the H3 element's innerHTML.
    // This is the single canonical writer of the heading's DOM state.
    // All other code should call QuestionHeadingService.setHtml(...) —
    // never mutate innerHTML directly via renderer.setProperty or
    // document.querySelector. Centralising here prevents the layered-gates
    // problem where many services fight over the H3.
    effect(() => {
      const el = this.qText()?.nativeElement;
      const html = this.questionHeadingService.htmlSig();
      if (!el) return;
      if ((el.innerHTML ?? '') === html) return;
      this.renderer.setProperty(el, 'innerHTML', html);
    });

    this.destroyRef.onDestroy(() => {
      // FET watchdog cleanup is handled by orchestrator.runOnDestroy via fetGuard.
      this.orchestrator.runOnDestroy(this);
    });
  }

  async ngOnInit(): Promise<void> {
    this.primeQuestionIndex();
    const result = this.orchestrator.runOnInit(this);
    this.orchestrator.runInstallFetWatchdog(this);
    return result;
  }

  setCombinedQuestionData$(v: Observable<CombinedQuestionDataType> | null): void { this._combinedQuestionDataSig.set(v); }

  setQuizId(v: string): void { this._quizIdSig.set(v); }

  get _lastQuestionTextByIndex(): Map<number, string> {
    return this.displayService._lastQuestionTextByIndex;
  }

  get _fetDisplayedThisSession(): Set<number> {
    return this.displayService._fetDisplayedThisSession;
  }

  get _fetLocked(): boolean { return this.displayService._fetLockedSig(); }
  set _fetLocked(v: boolean) { this.displayService._fetLockedSig.set(v); }
  get _lockedForIndex(): number { return this.displayService._lockedForIndexSig(); }
  set _lockedForIndex(v: number) { this.displayService._lockedForIndexSig.set(v); }

  get displayText$(): Observable<string> { return this.displayService.displayText$; }
  set displayText$(v: Observable<string>) { this.displayService.displayText$ = v; }

  get shouldShowFet$(): Observable<boolean> { return this.displayService.shouldShowFet$; }
  set shouldShowFet$(v: Observable<boolean>) { this.displayService.shouldShowFet$ = v; }
  get fetToDisplay$(): Observable<string> { return this.displayService.fetToDisplay$; }
  set fetToDisplay$(v: Observable<string>) { this.displayService.fetToDisplay$ = v; }

  resetInitialState(): void {
    this.explanationTextService.setIsExplanationTextDisplayed(false);
  }

  setupQuestionResetSubscription(): void {
    this.orchestrator.runSetupQuestionResetSubscription(this);
  }

  initDisplayTextPipeline(): void {
    this.displayService.initDisplayTextPipeline(
      this.currentIndex$,
      this.timedOutIdx$,
      this.displayState$() ?? this.quizStateService.displayState$
    );
  }

  resetExplanationService(): void {
    this.resetExplanationView();

    this.explanationTextService.setShouldDisplayExplanation(false);

    this.explanationTextService.resetForIndex(0);
    this.explanationTextService.setShouldDisplayExplanation(false, {
      force: true
    });
  }

  subscribeToDisplayText(): void {
    this.orchestrator.runSubscribeToDisplayText(this);
  }

  setupContentAvailability(): void {
    this.orchestrator.runSetupContentAvailability(this);
  }

  resetExplanationView(): void {
    this.explanationTextService.setShouldDisplayExplanation(false);
    this.explanationTextService.setExplanationText('');
  }


  emitContentAvailableState(): void {
    this.orchestrator.runEmitContentAvailableState(this);
  }

  loadQuizDataFromRoute(): void {
    this.orchestrator.runLoadQuizDataFromRoute(this);
  }

  async loadQuestion(quizId: string, zeroBasedIndex: number): Promise<void> {
    return this.orchestrator.runLoadQuestion(this, quizId, zeroBasedIndex);
  }

  async initializeComponent(): Promise<void> {
    await this.initializeQuestionData();
    this.initializeCombinedQuestionData();
  }

  fetchQuestionsAndExplanationTexts(params: ParamMap): Observable<[QuizQuestion[], string[]]> {
    return this.orchestrator.runFetchQuestionsAndExplanationTexts(this, params);
  }

  initializeCurrentQuestionIndex(): void {
    const idx = this.currentQuestionIndexValue ?? 0;
    this.quizService.currentQuestionIndex = idx;
    this.questionIndexSig.set(idx);
    this.questionIndexSubject.next(idx);
    this.currentIndex = idx;
    this.currentQuestionIndex$ =
      this.quizService.getCurrentQuestionIndexObservable();
  }

  updateCorrectAnswersDisplay(question: QuizQuestion | null): Observable<void> {
    return this.orchestrator.runUpdateCorrectAnswersDisplay(this, question);
  }

  combineCurrentQuestionAndOptions(): Observable<{
    currentQuestion: QuizQuestion | null;
    currentOptions: Option[];
    explanation: string;
    currentIndex: number;
  }> {
    return this.orchestrator.runCombineCurrentQuestionAndOptions(this);
  }

  haveSameOptionOrder(left: Option[] = [], right: Option[] = []): boolean {
    return this.orchestrator.runHaveSameOptionOrder(this, left, right);
  }

  calculateCombinedQuestionData(
    currentQuizData: CombinedQuestionDataType,
    numberOfCorrectAnswers: number,
    isExplanationDisplayed: boolean,
    formattedExplanation: string
  ): CombinedQuestionDataType {
    return this.orchestrator.runCalculateCombinedQuestionData(this, currentQuizData, numberOfCorrectAnswers, isExplanationDisplayed, formattedExplanation);
  }

  setupShouldShowFet(): void {
    this.displayService.setupShouldShowFet(this.currentIndex$);
  }

  setupFetToDisplay(): void {
    this.displayService.setupFetToDisplay(
      this.currentIndex$,
      this.timedOutIdx$,
      this.activeFetText$,
      this.currentQuestion$
    );
  }

  // Prime synchronously with the initial input value so runOnInit's
  // downstream setup sees the correct currentIndex / FET state.
  private primeQuestionIndex(): void {
    this.orchestrator.runQuestionIndexSet(this, this.questionIndex());
  }

  private async initializeQuestionData(): Promise<void> {
    return this.orchestrator.runInitializeQuestionData(this);
  }

  private initializeCombinedQuestionData(): void {
    this.orchestrator.runInitializeCombinedQuestionData(this);
  }

}
