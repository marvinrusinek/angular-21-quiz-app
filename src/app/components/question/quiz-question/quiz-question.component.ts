import {
  AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component,
  computed, DestroyRef, effect, HostListener, input, model, OnDestroy, OnInit,
  output, signal, viewChild, ViewContainerRef
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable, of, Subscription } from 'rxjs';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatRadioModule } from '@angular/material/radio';
import { Option } from '../../../shared/models/Option.model';
import { OptionBindings } from '../../../shared/models/OptionBindings.model';
import { QuestionPayload } from '../../../shared/models/QuestionPayload.model';
import { Quiz } from '../../../shared/models/Quiz.model';
import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';
import { SelectedOption } from '../../../shared/models/SelectedOption.model';
import { QuizQuestionEvent } from '../../../shared/models/QuizQuestionEvent.type';
import { SharedOptionConfig } from '../../../shared/models/SharedOptionConfig.model';
import { FeedbackService } from '../../../shared/services/features/feedback/feedback.service';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { QuizStateService } from '../../../shared/services/state/quizstate.service';
// QuizQuestionLoaderService consolidated into QqcQuestionLoaderService
import { QuizQuestionManagerService } from '../../../shared/services/flow/quizquestionmgr.service';
import { DynamicComponentService } from '../../../shared/services/ui/dynamic-component.service';
import { ExplanationTextService } from '../../../shared/services/features/explanation/explanation-text.service';
import { NextButtonStateService } from '../../../shared/services/state/next-button-state.service';
import { SelectedOptionService } from '../../../shared/services/state/selectedoption.service';
import { SelectionMessageService } from '../../../shared/services/features/selection-message/selection-message.service';
import { TimerService } from '../../../shared/services/features/timer/timer.service';
import { QqcQuestionLoaderService } from '../../../shared/services/features/qqc/qqc-question-loader.service';
import { QuizQuestionFacadeService } from '../../../shared/services/features/qqc/quiz-question-facade.service';
import { QuizShuffleService } from '../../../shared/services/flow/quiz-shuffle.service';
import { BaseQuestion } from '../base/base-question';
import { SharedOptionComponent } from '../answer/shared-option-component/shared-option.component';
import { FeedbackKey, FeedbackConfig } from '../../../shared/models/FeedbackConfig.model';

@Component({
  selector: 'codelab-quiz-question',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatCheckboxModule,
    MatRadioModule
  ],
  templateUrl: './quiz-question.component.html',
  styleUrls: ['./quiz-question.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class QuizQuestionComponent extends BaseQuestion
  implements OnInit, OnDestroy, AfterViewInit {
  readonly dynamicAnswerContainer = viewChild('dynamicAnswerContainer', { read: ViewContainerRef });
  readonly sharedOptionComponent = viewChild(SharedOptionComponent);
  readonly answer = output<number>();
  readonly answeredChange = output<boolean>();
  readonly selectionChanged = output<{
    question: QuizQuestion,
    selectedOptions: Option[]
  }>();
  readonly questionAnswered = output<QuizQuestion>();
  readonly isAnswerSelectedChange = output<boolean>();
  readonly showExplanationChange = output<boolean>();
  readonly selectionMessageChange = output<string>();
  readonly isAnsweredChange = output<boolean>();
  readonly feedbackTextChange = output<string>();
  readonly answerSelected = output<boolean>();
  readonly optionSelected = output<SelectedOption>();
  readonly displayStateChange = output<{
    mode: 'question' | 'explanation',
    answered: boolean
  }>();
  readonly feedbackApplied = output<number>();
  readonly nextButtonState = output<boolean>();
  readonly questionAndOptionsReady = output<void>();

  readonly data = model<{
    questionText: string,
    explanationText?: string,
    correctAnswersText?: string,
    options: Option[]
  }>(undefined as any);
  readonly questionData = model<QuizQuestion>(undefined as unknown as QuizQuestion);
  readonly options = model<Option[]>(undefined as unknown as Option[]);
  readonly currentQuestion = model<QuizQuestion | null>(null);
  readonly currentQuestion$ = input<Observable<QuizQuestion | null>>(of(null));
  readonly currentQuestionIndex = model<number>(0);
  readonly previousQuestionIndex = model<number>(undefined as unknown as number);
  readonly quizId = model<string | null | undefined>('');
  readonly explanationText = model<string | null>(null);
  readonly isOptionSelected = model<boolean>(false);
  readonly selectionMessage = model<string>(undefined as unknown as string);
  readonly reset = input<boolean>(false);
  readonly questionToDisplay$ = input<Observable<string>>(of(''));
  readonly displayState$ = input<Observable<{ mode: 'question' | 'explanation'; answered: boolean }>>(of({ mode: 'question', answered: false }));
  readonly explanation = input<string>('');
  readonly shouldRenderOptions = model<boolean>(false);
  readonly quiz = signal<Quiz | null>(null);
  readonly questions = signal<QuizQuestion[]>([]);
  readonly questionsArray = signal<QuizQuestion[]>([]);
  override questionForm: FormGroup = new FormGroup({});
  readonly totalQuestions = signal<number>(0);
  readonly fixedQuestionIndex = signal<number>(0);
  lastLoggedIndex = -1;
  lastLoggedQuestionIndex = -1;
  lastProcessedQuestionIndex = -1;
  _clickGate = false;  // same-tick re-entrancy guard
  readonly events = output<QuizQuestionEvent>();
  public selectedIndices = new Set<number>();

  override selectedOption: SelectedOption | null = null;
  selectedOptions: SelectedOption[] = [];
  currentOptions: Option[] | undefined;
  correctAnswers: number[] | undefined;
  optionChecked: { [optionId: number]: boolean } = {};
  answers: any[] = [];
  shuffleOptions = true;
  override showFeedbackForOption: { [optionId: number]: boolean } = {};
  resetFeedbackSubscription!: Subscription;
  resetStateSubscription!: Subscription;
  sharedVisibilitySubscription!: Subscription;
  idxSub!: Subscription;
  isMultipleAnswer!: boolean;
  readonly isLoading = signal<boolean>(true);
  readonly initialized = signal<boolean>(false);
  readonly feedbackText = signal<string>('');
  readonly displayExplanation = signal<boolean>(false);
  override sharedOptionConfig: SharedOptionConfig | null = null;
  shouldRenderFinalOptions = false;
  explanationLocked = false;  // flag to lock explanation
  readonly explanationVisible = signal<boolean>(false);
  displaySubscriptions: Subscription[] = [];
  lastOptionsQuestionSignature: string | null = null;
  readonly shouldDisplayExplanation = signal<boolean>(false);
  
  readonly displayMode = signal<'question' | 'explanation'>('question');
  readonly isAnswered = signal(false);
  
  readonly displayState = computed(() => ({
    mode: this.displayMode(),
    answered: this.isAnswered()
  }));

  readonly forceQuestionDisplay = signal<boolean>(true);
  readonly readyForExplanationDisplay = signal<boolean>(false);
  readonly isExplanationReady = signal<boolean>(false);
  readonly isExplanationLocked = signal<boolean>(true);
  _formattedByIndex = new Map<number, string>();
  handledOnExpiry = new Set<number>();
  lastSerializedOptions = '';

  public readonly finalRenderReady = signal(false); // maybe remove

  _fetEarlyShown = new Set<number>();

  readonly questionPayloadSig = signal<QuestionPayload | null>(null);
  readonly questionPayload$ = toObservable(this.questionPayloadSig);

  readonly renderReady = signal(false);

  waitingForReady = false;
  deferredClick?: { option: SelectedOption | null, index: number, checked: boolean, wasReselected?: boolean };

  _pendingRAF: number | null = null;
  _msgTok = 0;

  readonly questionFresh = signal<boolean>(true);
  public feedbackConfigs: Record<FeedbackKey, FeedbackConfig> = {};
  public lastFeedbackOptionId: FeedbackKey = -1 as const;
  lastResetFor = -1;
  readonly timedOut = signal<boolean>(false);

  // Tracks whether we already stopped for this question
  _timerStoppedForQuestion = false;
  _skipNextAsyncUpdates = false;

  // Last computed "allCorrect" (used across microtasks/finally)
  _lastAllCorrect = false;

  private _abortController: AbortController | null = null;

  _visibilityRestoreInProgress = false;
  _suppressDisplayStateUntil = 0;

  /** Alias so host:any callers (quiz-setup, qqc-orch-lifecycle) still resolve. */
  get quizQuestionLoaderService(): QqcQuestionLoaderService {
    return this.questionLoader;
  }

  // â”€â”€ Pass-through getters for the Qqc* services consumed by orchestrators
  // via `host.<service>`. They delegate to qqcFacade so QQC's constructor
  // stays compact while the established host:any access pattern keeps
  // working unchanged.
  get componentOrchestrator() { return this.qqcFacade.componentOrchestrator; }
  get displayStateManager() { return this.qqcFacade.displayStateManager; }
  get explanationDisplay() { return this.qqcFacade.explanationDisplay; }
  get explanationFlow() { return this.qqcFacade.explanationFlow; }
  get explanationManager() { return this.qqcFacade.explanationManager; }
  get feedbackManager() { return this.qqcFacade.feedbackManager; }
  get initializer() { return this.qqcFacade.initializer; }
  get lifecycle() { return this.qqcFacade.lifecycle; }
  get navigationHandler() { return this.qqcFacade.navigationHandler; }
  get clickOrchestrator() { return this.qqcFacade.clickOrchestrator; }
  get optionSelection() { return this.qqcFacade.optionSelection; }
  get questionLoader() { return this.qqcFacade.questionLoader; }
  get resetManager() { return this.qqcFacade.resetManager; }
  get subscriptionWiring() { return this.qqcFacade.subscriptionWiring; }
  get timerEffect() { return this.qqcFacade.timerEffect; }

  constructor(
    public override quizService: QuizService,
    public override quizStateService: QuizStateService,
    public quizQuestionManagerService: QuizQuestionManagerService,
    public override dynamicComponentService: DynamicComponentService,
    public explanationTextService: ExplanationTextService,
    public override feedbackService: FeedbackService,
    public nextButtonStateService: NextButtonStateService,
    public override selectedOptionService: SelectedOptionService,
    public selectionMessageService: SelectionMessageService,
    public timerService: TimerService,
    public qqcFacade: QuizQuestionFacadeService,
    public activatedRoute: ActivatedRoute,
    protected quizShuffleService: QuizShuffleService,
    public override fb: FormBuilder,
    public override cdRef: ChangeDetectorRef,
    public router: Router,
    public destroyRef: DestroyRef
  ) {
    super(
      fb,
      dynamicComponentService,
      feedbackService,
      quizService,
      quizStateService,
      selectedOptionService,
      cdRef
    );

    effect(() => {
      const value = this.questionIndex();
      if (value === undefined || value === null) return;
      this._abortController?.abort();
      this._abortController = new AbortController();
      const signal = this._abortController.signal;
      this.currentQuestionIndex.set(value);
      this.loadQuestion(signal);
    });

    effect(() => {
      const value = this.questionPayload();
      if (!value) return;
      try {
        this.questionPayloadSig.set(value);
        this.hydrateFromPayload(value);
      } catch {
      }
    });

    // (Removed signalâ†’handleQuestionAndOptionsChange bridge â€” was interfering
    // with init flow. The inline <codelab-question-answer> in the template
    // now drives options directly via signal bindings.)

    setTimeout(() => {
      this.explanationTextService.purgeAndDefer(99);
    }, 500);
  }

  readonly questionIndex = input<number>(undefined as unknown as number);
  readonly questionPayload = input<QuestionPayload | null>(null);

  resetUIForNewQuestion(): void {
    this.timedOut.set(false);
    this._timerStoppedForQuestion = false;
    this.sharedOptionComponent()?.resetUIForNewQuestion();
    this.updateShouldRenderOptions([]);
  }

  override async ngOnInit(): Promise<void> {
    return this.componentOrchestrator.runOnInit(this);
  }

  async ngAfterViewInit(): Promise<void> {
    return this.componentOrchestrator.runAfterViewInit(this);
  }

  override ngOnDestroy(): void {
    super.ngOnDestroy();
    this.componentOrchestrator.runOnDestroy(this);
  }

  @HostListener('window:visibilitychange', [])
  async onVisibilityChange(): Promise<void> {
    return this.componentOrchestrator.runOnVisibilityChange(this);
  }

  applyExplanationTextInZone(text: string): void {
    this.componentOrchestrator.runApplyExplanationTextInZone(this, text);
  }

  applyExplanationFlags(flags: {
    forceQuestionDisplay: boolean;
    readyForExplanationDisplay: boolean;
    isExplanationReady: boolean;
    isExplanationLocked: boolean;
    explanationLocked: boolean;
    explanationVisible: boolean;
    displayExplanation: boolean;
    shouldDisplayExplanation: boolean;
    isExplanationTextDisplayed: boolean;
  }): void {
    this.componentOrchestrator.runApplyExplanationFlags(this, flags);
  }

  applyDisplayState(state: {
    mode: 'question' | 'explanation';
    answered: boolean;
  }): void {
    this.displayMode.set(state.mode);
    this.isAnswered.set(state.answered);
  
    this.displayStateChange.emit(state);
  }

  emitExplanationChange(text: string, show: boolean): void {
    this.explanationToDisplayChange.emit(text);
    this.showExplanationChange.emit(show);
  }

  updateDisplayMode(mode: 'question' | 'explanation'): void {
    this.displayMode.set(mode);
  }

  markRenderReady(): void {
    this.finalRenderReady.set(true);
    this.renderReady.set(true);
    this.cdRef.markForCheck();
  }

  public updateOptionsSafely(newOptions: Option[]): void {
    return this.componentOrchestrator.runUpdateOptionsSafely(this, newOptions);
  }

  private hydrateFromPayload(payload: QuestionPayload): void {
    return this.componentOrchestrator.runHydrateFromPayload(this, payload);
  }

  async initializeQuizDataAndRouting(): Promise<void> {
    return this.componentOrchestrator.runInitializeQuizDataAndRouting(this);
  }

  setupRouteChangeHandler(): void {
    this.componentOrchestrator.runSetupRouteChangeHandler(this);
  }

  async updateExplanationIfAnswered(index: number, question: QuizQuestion): Promise<void> {
    return this.componentOrchestrator.runUpdateExplanationIfAnswered(this, index, question);
  }

  handlePageVisibilityChange(isHidden: boolean): void {
    this.componentOrchestrator.runHandlePageVisibilityChange(this, isHidden);
  }

  public override async loadDynamicComponent(question: QuizQuestion, options: Option[]): Promise<void> {
    return this.componentOrchestrator.runLoadDynamicComponent(this, question, options);
  }

  public async loadQuestion(signal?: AbortSignal): Promise<boolean> {
    return this.componentOrchestrator.runLoadQuestion(this, signal);
  }

  public async generateFeedbackText(question: QuizQuestion): Promise<string> {
    if (!this.optionsToDisplay()?.length) this.populateOptionsToDisplay();
    this.feedbackText.set(this.feedbackManager.generateFeedbackText(question, this.optionsToDisplay()));
    this.feedbackTextChange.emit(this.feedbackText()); return this.feedbackText();
  }

  async initializeQuiz(): Promise<void> {
    return this.componentOrchestrator.runInitializeQuiz(this);
  }

  async isAnyOptionSelected(questionIndex: number): Promise<boolean> {
    return this.componentOrchestrator.runIsAnyOptionSelected(this, questionIndex);
  }

  setQuestionOptions(): void {
    this.componentOrchestrator.runSetQuestionOptions(this);
  }

  public resetState(): void {
    this.componentOrchestrator.runResetState(this);
  }

  public resetFeedback(): void {
    this.componentOrchestrator.runResetFeedback(this);
  }

  // Called when a user clicks an option row
  public override async onOptionClicked(event: { option: SelectedOption | null; index: number; checked: boolean; wasReselected?: boolean; }): Promise<void> {
    return this.componentOrchestrator.runOnOptionClicked(this, event);
  }

  public async onSubmitMultiple(): Promise<void> {
    return this.componentOrchestrator.runOnSubmitMultiple(this);
  }

  onQuestionTimedOut(targetIndex?: number): void {
    this.componentOrchestrator.runOnQuestionTimedOut(this, targetIndex);
  }

  handleTimerStoppedForActiveQuestion(reason: 'timeout' | 'stopped'): void {
    this.componentOrchestrator.runHandleTimerStoppedForActiveQuestion(this, reason);
  }

  updateOptionHighlighting(selectedKeys: Set<string | number>): void {
    this.componentOrchestrator.runUpdateOptionHighlighting(this, selectedKeys);
  }

  refreshFeedbackFor(opt: Option): void {
    this.componentOrchestrator.runRefreshFeedbackFor(this, opt);
  }

  async postClickTasks(opt: SelectedOption, idx: number, checked: boolean, wasPreviouslySelected: boolean, questionIndex?: number): Promise<void> {
    return this.componentOrchestrator.runPostClickTasks(this, opt, idx, checked, wasPreviouslySelected, questionIndex);
  }

  async performInitialSelectionFlow(event: any, option: SelectedOption): Promise<void> {
    return this.componentOrchestrator.runPerformInitialSelectionFlow(this, event, option);
  }

  async applyFeedbackIfNeeded(option: SelectedOption): Promise<void> {
    return this.componentOrchestrator.runApplyFeedbackIfNeeded(this, option);
  }

  public populateOptionsToDisplay(): Option[] {
    return this.componentOrchestrator.runPopulateOptionsToDisplay(this);
  }

  public async applyOptionFeedback(selectedOption: Option): Promise<void> {
    return this.componentOrchestrator.runApplyOptionFeedback(this, selectedOption);
  }

  async finalizeSelection(option: SelectedOption, index: number, wasPreviouslySelected: boolean): Promise<void> {
    return this.componentOrchestrator.runFinalizeSelection(this, option, index, wasPreviouslySelected);
  }

  public async fetchAndProcessCurrentQuestion(): Promise<QuizQuestion | null> {
    return this.componentOrchestrator.runFetchAndProcessCurrentQuestion(this);
  }

  async updateExplanationDisplay(shouldDisplay: boolean): Promise<void> {
    return this.componentOrchestrator.runUpdateExplanationDisplay(this, shouldDisplay);
  }

  public async resetQuestionStateBeforeNavigation(options?: { preserveVisualState?: boolean; preserveExplanation?: boolean }): Promise<void> {
    return this.componentOrchestrator.runResetQuestionStateBeforeNavigation(this, options);
  }

  async updateExplanationText(index: number): Promise<string> {
    return this.componentOrchestrator.runUpdateExplanationText(this, index);
  }

  public async handleOptionSelection(option: SelectedOption, optionIndex: number, currentQuestion: QuizQuestion): Promise<void> {
    return this.componentOrchestrator.runHandleOptionSelection(this, option, optionIndex, currentQuestion);
  }

  initializeForm(): void {
    this.componentOrchestrator.runInitializeForm(this);
  }

  async selectOption(currentQuestion: QuizQuestion, option: SelectedOption, optionIndex: number): Promise<void> {
    return this.componentOrchestrator.runSelectOption(this, currentQuestion, option, optionIndex);
  }

  unselectOption(): void {
    this.componentOrchestrator.runUnselectOption(this);
  }

  resetExplanation(force = false): void {
    this.componentOrchestrator.runResetExplanation(this, force);
  }

  async prepareAndSetExplanationText(questionIndex: number): Promise<string> {
    return this.componentOrchestrator.runPrepareAndSetExplanationText(this, questionIndex);
  }

  public async fetchAndSetExplanationText(questionIndex: number): Promise<void> {
    return this.componentOrchestrator.runFetchAndSetExplanationText(this, questionIndex);
  }

  updateExplanationUI(questionIndex: number, explanationText: string): void {
    this.componentOrchestrator.runUpdateExplanationUI(this, questionIndex, explanationText);
  }

  async onSubmit(): Promise<void> {
    return this.componentOrchestrator.runOnSubmit(this);
  }

  // Per-question next and selections reset done from the child, timer
  public resetPerQuestionState(index: number): void {
    this.componentOrchestrator.runResetPerQuestionState(this, index);
  }


  public resetForQuestion(index: number): void {
    this.componentOrchestrator.runResetForQuestion(this, index);
  }

  // Called when the countdown hits zero
  async onTimerExpiredFor(index: number): Promise<void> {
    return this.componentOrchestrator.runOnTimerExpiredFor(this, index);
  }

  normalizeIndex(idx: number): number { return this.explanationManager.normalizeIndex(idx, this.questions()); }

  async resolveFormatted(index: number, opts: { useCache?: boolean; setCache?: boolean; timeoutMs?: number } = {}): Promise<string> {
    return this.componentOrchestrator.runResolveFormatted(this, index, opts);
  }

  emitPassiveNow(index: number): void {
    this.componentOrchestrator.runEmitPassiveNow(this, index);
  }
  disableAllBindingsAndOptions(): { optionBindings: OptionBindings[]; optionsToDisplay: Option[] } {
    return this.componentOrchestrator.runDisableAllBindingsAndOptions(this);
  }
  forceDisableSharedOption(): void {
    this.sharedOptionComponent()?.forceDisableAllOptions?.();
    this.sharedOptionComponent()?.triggerViewRefresh?.();
  }

  public revealFeedbackForAllOptions(canonicalOpts: Option[]): void {
    this.componentOrchestrator.runRevealFeedbackForAllOptions(this, canonicalOpts);
  }

  updateShouldRenderOptions(options: Option[] | null | undefined): void {
    this.componentOrchestrator.runUpdateShouldRenderOptions(this, options);
  }

  safeSetDisplayState(state: { mode: 'question' | 'explanation', answered: boolean }): void {
    this.componentOrchestrator.runSafeSetDisplayState(this, state);
  }
}