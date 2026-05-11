import {
  AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, computed,
  HostListener, OnDestroy, OnInit, signal, viewChild, ViewChild, ViewEncapsulation
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CommonModule, AsyncPipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable, Subject, Subscription } from 'rxjs';
import { debounceTime, shareReplay } from 'rxjs/operators';
import { MatCardModule } from '@angular/material/card';
import { MatTooltip, MatTooltipModule } from '@angular/material/tooltip';

import { QuestionPayload } from '../../shared/models/QuestionPayload.model';
import { Option } from '../../shared/models/Option.model';
import { Quiz } from '../../shared/models/Quiz.model';
import { QuizQuestion } from '../../shared/models/QuizQuestion.model';
import { QuizQuestionEvent } from '../../shared/models/QuizQuestionEvent.type';
import { SelectedOption } from '../../shared/models/SelectedOption.model';
import { QuizService } from '../../shared/services/data/quiz.service';
import { QuizDataService } from '../../shared/services/data/quizdata.service';
import { QuizInitializationService } from '../../shared/services/flow/quiz-initialization.service';
import { QuizNavigationService } from '../../shared/services/flow/quiz-navigation.service';
import { QuizStateService } from '../../shared/services/state/quizstate.service';
import { QqcQuestionLoaderService } from '../../shared/services/features/qqc/qqc-question-loader.service';
import { NextButtonStateService } from '../../shared/services/state/next-button-state.service';
import { SelectedOptionService } from '../../shared/services/state/selectedoption.service';
import { SelectionMessageService } from '../../shared/services/features/selection-message/selection-message.service';
import { TimerService } from '../../shared/services/features/timer/timer.service';
import { QuizDotStatusService } from '../../shared/services/flow/quiz-dot-status.service';
import { QuizResetService } from '../../shared/services/flow/quiz-reset.service';
import { QuizRouteService } from '../../shared/services/flow/quiz-route.service';
import { QuizScoringService } from '../../shared/services/flow/quiz-scoring.service';
import { QuizOptionProcessingService } from '../../shared/services/flow/quiz-option-processing.service';
import { QuizContentLoaderService } from '../../shared/services/flow/quiz-content-loader.service';
import { QuizVisibilityRestoreService } from '../../shared/services/flow/quiz-visibility-restore.service';
import { QuizPersistenceService } from '../../shared/services/state/quiz-persistence.service';
import { QuizSetupService } from '../../shared/services/flow/quiz-setup.service';
import { QuizQuestionComponent } from '../../components/question/quiz-question/quiz-question.component';
import { SharedOptionComponent } from '../../components/question/answer/shared-option-component/shared-option.component';
import { CodelabQuizContentComponent } from './quiz-content/codelab-quiz-content.component';
import { CodelabQuizHeaderComponent } from './quiz-header/quiz-header.component';
import { ScoreboardComponent } from '../scoreboard/scoreboard.component';
import { ThemeToggleComponent } from '../../components/theme-toggle/theme-toggle.component';

import { ChangeRouteAnimation } from '../../animations/animations';

type AnimationState = 'animationStarted' | 'none';

@Component({
  selector: 'codelab-quiz-component',
  standalone: true,
  imports: [
    CommonModule, AsyncPipe, MatCardModule, MatTooltipModule,
    QuizQuestionComponent, CodelabQuizHeaderComponent,
    CodelabQuizContentComponent, ScoreboardComponent,
    ThemeToggleComponent
  ],
  templateUrl: './quiz.component.html',
  styleUrls: ['./quiz.component.scss'],
  animations: [ChangeRouteAnimation.changeRoute],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class QuizComponent implements OnInit, OnDestroy, AfterViewInit {
  readonly quizQuestionComponent = viewChild(QuizQuestionComponent);
  readonly sharedOptionComponent = viewChild(SharedOptionComponent);
  readonly nextButtonTooltip = viewChild<MatTooltip>('nextButton');

  selectedQuiz: Quiz | null = null;
  currentQuestion: QuizQuestion | null = null;
  quiz!: Quiz;
  quizId = '';
  question: QuizQuestion | null = null;
  questions: QuizQuestion[] = [];
  questionsArray: QuizQuestion[] = [];
  questions$: Observable<QuizQuestion[]> = this.quizService.questions$;

  currentQuestion$ = this.quizStateService.currentQuestion$;
  routeSubscription!: Subscription;
  routerSubscription!: Subscription;
  questionAndOptionsSubscription!: Subscription;
  optionSelectedSubscription!: Subscription;
  indexSubscription!: Subscription;
  subscriptions: Subscription = new Subscription();

  answers: Option[] = [];
  readonly selectionMessage = this.selectionMessageService.selectionMessageSig;
  isAnswered = false;
  cardFooterClass = '';
  showScrollIndicator = false;

  combinedQuestionData = signal<QuestionPayload | null>(null);
  combinedQuestionDataView = computed(() => {
    const payload = this.combinedQuestionData();

    // URL-AUTHORITATIVE OVERRIDE: when the user has navigated directly to
    // /question/{quizId}/{N}, the URL is the only source we trust. Any
    // payload whose question doesn't match the URL question is a stale
    // emission (typically Q1 leaking through during the multi-step
    // initialization chain) and must NOT render. We synthesize the
    // payload from the URL-resolved question instead.
    try {
      const m = window.location.pathname.match(/\/question\/[^/]+\/(\d+)/);
      if (m) {
        const urlIdx = Number(m[1]) - 1;
        const urlQ = this.quizService.questions?.[urlIdx];
        if (urlQ?.options?.length) {
          const urlText = (urlQ.questionText ?? '').trim().toLowerCase();
          const payloadText = (payload?.question?.questionText ?? '').trim().toLowerCase();
          if (!payloadText || urlText !== payloadText) {
            return {
              question: urlQ,
              options: urlQ.options,
              explanation: urlQ.explanation ?? ''
            };
          }
        }
      }
    } catch { /* non-browser env */ }

    if (!payload?.question) return payload;

    const shuffled = this.quizService.shuffledQuestions;
    const isShuffleActive = this.quizService.isShuffleEnabled() && shuffled?.length > 0;
    if (isShuffleActive) {
      const idx = this.currentQuestionIndex ?? 0;
      const correctQ = shuffled[idx];
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
  });

  questionIndex = 0;
  currentQuestionIndex = 0;
  lastLoggedIndex = -1;
  totalQuestions = 0;
  progress = 0;
  public answeredQuestionIndices = new Set<number>();

  questionToDisplaySig = signal<string>('');
  // Derive the displayed question text from the URL-authoritative
  // combinedQuestionDataView rather than questionToDisplaySig directly.
  // questionToDisplaySig is written from many code paths (some still
  // emit Q1's text on direct URL nav to /question/.../5), and binding
  // its raw stream caused Q1's question text to render alongside Q5's
  // options. The view computed already enforces the URL question, so
  // routing the text through it makes both pieces consistent.
  // Also re-attaches the "(Select N correct answers)" banner for
  // multi-answer questions — the inline display path would otherwise
  // drop it because we're synthesising from raw URL question data.
  readonly questionToDisplayTextView = computed(() => {
    const view = this.combinedQuestionDataView();
    const baseText = (view?.question?.questionText ?? this.questionToDisplaySig() ?? '').trim();
    if (!baseText) return '';

    const opts = view?.options ?? [];
    const numCorrect = opts.filter(
      (o: any) => o?.correct === true || o?.correct === 1 || String(o?.correct) === 'true'
    ).length;
    if (numCorrect <= 1 || opts.length === 0) return baseText;

    const suffix = numCorrect === 1 ? 'answer is' : 'answers are';
    const banner = `(${numCorrect} ${suffix} correct)`;
    return `${baseText} <span class="correct-count">${banner}</span>`;
  });
  public questionToDisplay$ = toObservable(this.questionToDisplayTextView);

  optionsToDisplay: Option[] = [];
  optionsToDisplaySig = signal<Option[]>([]);
  explanationToDisplay = '';

  isLoading = false;
  isQuizLoaded = false;
  isQuizDataLoaded = false;
  public isQuizRenderReadySig = signal<boolean>(false);
  quizAlreadyInitialized = false;
  public hasOptionsLoaded = false;
  public shouldRenderOptions = false;
  isCurrentQuestionAnswered = false;

  previousIndex: number | null = null;
  isNavigatedByUrl = false;
  navigatingToResults = false;

  readonly nextButtonEnabled = this.nextButtonStateService.isButtonEnabled;
  isButtonEnabled$: Observable<boolean>;
  isAnswered$: Observable<boolean>;
  isNextButtonEnabled = false;
  isContentAvailable$: Observable<boolean>;

  animationStateSig = signal<AnimationState>('none');
  unsubscribe$ = new Subject<void>();
  destroy$ = new Subject<void>();

  displayState$ = this.quizStateService.displayState$;
  qaToDisplay?: { question: QuizQuestion; options: Option[] };

  constructor(
    public quizService: QuizService,
    private quizDataService: QuizDataService,
    private quizInitializationService: QuizInitializationService,
    private quizNavigationService: QuizNavigationService,
    private quizQuestionLoaderService: QqcQuestionLoaderService,
    public quizStateService: QuizStateService,
    private timerService: TimerService,
    private nextButtonStateService: NextButtonStateService,
    private selectionMessageService: SelectionMessageService,
    private selectedOptionService: SelectedOptionService,
    private dotStatusService: QuizDotStatusService,
    private quizPersistence: QuizPersistenceService,
    private quizResetService: QuizResetService,
    private quizRouteService: QuizRouteService,
    private quizScoringService: QuizScoringService,
    private quizOptionProcessingService: QuizOptionProcessingService,
    private quizContentLoaderService: QuizContentLoaderService,
    private quizVisibilityRestoreService: QuizVisibilityRestoreService,
    private quizSetupService: QuizSetupService,
    public activatedRoute: ActivatedRoute,
    private router: Router,
    public cdRef: ChangeDetectorRef
  ) {
    this.isAnswered$ = this.selectedOptionService.isAnswered$;
    this.isButtonEnabled$ = this.selectedOptionService.isOptionSelected$().pipe(debounceTime(300), shareReplay(1));
    this.isContentAvailable$ = this.quizDataService.isContentAvailable$;
    this.quizSetupService.wireConstructor(this);
  }

  public _processingOptionClick = false;
  public _lastClickTime = 0;
  public _lastOptionId = -1;

  @HostListener('window:keydown', ['$event'])
  async onGlobalKey(event: KeyboardEvent): Promise<void> {
    return this.quizSetupService.runOnGlobalKey(this, event);
  }

  @HostListener('window:focus')
  onTabFocus(): void {
    if (!this.isLoading && !this.quizStateService.isLoading()) {
      const idx = this.quizService.getCurrentQuestionIndex();
      if (idx >= 0 && idx < this.totalQuestions) {
        this.quizService.updateBadgeText(idx + 1, this.totalQuestions);
      }
      this.cdRef.markForCheck();
    }
  }

  @HostListener('window:scroll')
  onScroll(): void { this.checkScrollIndicator(); }

  @HostListener('window:resize')
  onResize(): void { this.checkScrollIndicator(); }

  private scrollIndicatorEl: HTMLElement | null = null;

  checkScrollIndicator(): void {
    const quizCard = document.querySelector('.quiz-card');
    if (!quizCard) {
      this.removeScrollIndicator();
      return;
    }
    const cardRect = quizCard.getBoundingClientRect();
    const shouldShow = (cardRect.bottom - window.innerHeight) > 80;
    if (shouldShow && !this.scrollIndicatorEl) {
      this.createScrollIndicator();
    } else if (!shouldShow && this.scrollIndicatorEl) {
      this.removeScrollIndicator();
    }
  }

  private createScrollIndicator(): void {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;bottom:20px;left:0;right:0;margin:0 auto;z-index:9999;width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,0.95);box-shadow:0 4px 12px rgba(0,0,0,0.25);display:flex;justify-content:center;align-items:center;cursor:pointer;animation:scrollBounce 2s infinite;';
    el.innerHTML = '<i class="material-icons" style="font-size:32px;color:#1e90ff;">keyboard_arrow_down</i>';
    el.addEventListener('click', () => this.scrollToBottom());
    document.body.appendChild(el);
    this.scrollIndicatorEl = el;
  }

  private removeScrollIndicator(): void {
    if (this.scrollIndicatorEl) {
      this.scrollIndicatorEl.remove();
      this.scrollIndicatorEl = null;
    }
  }

  scrollToBottom(): void {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }

  async ngOnInit(): Promise<void> {
    return this.quizSetupService.runOnInit(this);
  }

  private async initializeQuizId(): Promise<string | null> {
    let quizId = this.quizService.getCurrentQuizId();
    if (!quizId) {
      const routeQuizId = this.activatedRoute.snapshot.paramMap.get('quizId');
      if (routeQuizId) {
        quizId = routeQuizId;
        this.quizService.setQuizId(routeQuizId);
      }
    }
    if (!quizId) {
      await this.router.navigate(['/select']);
      return null;
    }
    return quizId;
  }

  private initializeQuestionIndex(): void {
    const idx = this.quizRouteService.getRouteQuestionIndex(this.activatedRoute, this.router);
    this.currentQuestionIndex = idx;
    this.quizService.setCurrentQuestionIndex(idx);
    try { localStorage.setItem('savedQuestionIndex', JSON.stringify(idx)); } catch {}
  }

  async ngAfterViewInit(): Promise<void> {
    return this.quizSetupService.runAfterViewInit(this);
  }

  public normalizeQuestionIndex(rawIndex: number | undefined): number {
    if (!Number.isInteger(rawIndex)) return this.currentQuestionIndex;
    const idx = Number(rawIndex);
    const total = this.totalCount;
    if (idx === this.currentQuestionIndex) return idx;
    if (idx === this.currentQuestionIndex + 1) return this.currentQuestionIndex;
    if (total > 0 && idx >= total && idx - 1 >= 0 && idx - 1 < total) return idx - 1;
    return idx;
  }

  public onOptionSelected(option: SelectedOption, isUserAction: boolean = true): Promise<void> {
    return this.quizSetupService.onOptionSelected(this, option, isUserAction);
  }

  private resetQuestionState(): void {
    this.quizResetService.resetQuestionServiceState();
    this.currentQuestion = null;
    this.question = null;
    this.optionsToDisplay = [];
    this.isAnswered = false;
    this.isNextButtonEnabled = false;
    this.quizQuestionComponent()?.resetFeedback?.();
    this.quizQuestionComponent()?.resetState?.();
    this.cdRef.detectChanges();
  }

  ngOnDestroy(): void {
    this.removeScrollIndicator();
    this.quizSetupService.runOnDestroy(this);
  }

  // ── Template getters ──────────────────────────────────────────
  public get showPaging(): boolean {
    return this.isQuizDataLoaded && this.totalQuestions > 0;
  }

  // Read the URL question index — used as a fallback when
  // this.currentQuestionIndex hasn't propagated yet during URL/dot
  // navigation. The button-visibility getters depend on the index
  // matching the URL, otherwise Prev/Restart/Show-Results all
  // disappear on direct URL nav to a non-Q1 question.
  private getEffectiveQuestionIndex(): number {
    try {
      const m = window.location.pathname.match(/\/question\/[^/]+\/(\d+)/);
      if (m) {
        const urlIdx = Number(m[1]) - 1;
        if (urlIdx >= 0) return urlIdx;
      }
    } catch { /* non-browser env */ }
    return this.currentQuestionIndex;
  }

  public get shouldShowPrevButton(): boolean {
    return this.getEffectiveQuestionIndex() > 0;
  }

  public get shouldShowRestartButton(): boolean {
    const idx = this.getEffectiveQuestionIndex();
    const serviceCount = this.quizService.questions?.length || 0;
    const effectiveTotal = Math.max(this.totalQuestions, serviceCount);
    return idx > 0 && idx <= effectiveTotal - 1;
  }

  public get shouldShowNextButton(): boolean {
    const serviceCount = this.quizService.questions?.length || 0;
    const effectiveTotal = Math.max(this.totalQuestions, serviceCount);
    return this.getEffectiveQuestionIndex() < effectiveTotal - 1;
  }

  public get shouldShowResultsButton(): boolean {
    const serviceCount = this.quizService.questions?.length || 0;
    const effectiveTotal = Math.max(this.totalQuestions, serviceCount);
    const idx = this.getEffectiveQuestionIndex();
    const isLast = effectiveTotal > 0 && idx === effectiveTotal - 1;
    if (!isLast) return false;

    const question: QuizQuestion | null =
      (this.question as QuizQuestion | null) ??
      ((this.quizService as any).currentQuestion?.value as QuizQuestion | null) ??
      (this.quizService.questions?.[idx] ?? null) ??
      ((this.quizService as any).shuffledQuestions?.[idx] ?? null);

    if (!question) return false;
    const selected = this.selectedOptionService.getSelectedOptionsForQuestion(idx) ?? [];
    if (selected.length > 0) return true;

    // Also show Results button when timer expired on last question without an answer
    return this.dotStatusService.timerExpiredUnanswered.has(idx);
  }

  public handleQuizQuestionEvent(event: QuizQuestionEvent): void {
    switch (event.type) {
      case 'answer':
        this.quizSetupService.selectedAnswer(this, event.payload);
        break;
      case 'optionSelected':
        if (event.payload && (event.payload as any).option) {
          void this.onOptionSelected((event.payload as any).option);
        } else {
          void this.onOptionSelected(event.payload as any);
        }
        break;
      case 'explanationToDisplayChange':
        this.quizSetupService.onExplanationChanged(this, event.payload, event.index);
        break;
      case 'showExplanationChange':
        if (event.payload) {
          this.quizStateService.setDisplayState({ mode: 'explanation', answered: true });
        }
        break;
    }
  }

  public advanceToNextQuestion(): Promise<void> { 
    return this.quizSetupService.advanceQuestion(this, 'next');
  }
  public advanceToPreviousQuestion(): Promise<void> {
    return this.quizSetupService.advanceQuestion(this, 'previous');
  }
  public advanceToResults(): void {
    if (this.navigatingToResults) return;
    this.navigatingToResults = true;

    // Record elapsed time and stop timer (no navigation from service)
    this.quizNavigationService.recordElapsedAndGoToResults(this.currentQuestionIndex);

    // Navigate to results from the component
    const quizId = this.quizId
      || this.quizService.quizId
      || this.quizService.getCurrentQuizId()
      || this.activatedRoute.snapshot.paramMap.get('quizId')
      || '';
    if (quizId) {
      this.router.navigateByUrl(`/quiz/results/${quizId}`);
    }
  }

  restartQuiz(): void {
    this.quizSetupService.restartQuiz(this);
  }

  // ── Progress / dots ────────────────────────────────────────────
  updateProgressValue(): void {
    const total = this.totalCount;
    if (total <= 0) { this.cdRef.markForCheck(); return; }
    this.progress = Math.round((this.answeredQuestionIndices.size / total) * 100);
    try {
      sessionStorage.setItem('quizProgress', String(this.progress));
      sessionStorage.setItem('quizProgressQuizId', this.quizId);
      sessionStorage.setItem('answeredQuestionIndices', JSON.stringify([...this.answeredQuestionIndices]));
    } catch { }
    this.cdRef.detectChanges();
    this.cdRef.markForCheck();
  }

  /**
   * Marks a question as answered. Always recomputes progress from the
   * authoritative selectedOptionsMap (every entry with selections counts
   * as answered). This bypasses brittle index-passing through several
   * layers — the progress %% no longer depends on `index` matching the
   * caller's understanding of the current question.
   */
  public markQuestionAnswered(index: number): void {
    const liveIdx = (this.quizService as any)?.currentQuestionIndex;
    const effectiveIdx = Number.isFinite(liveIdx) && liveIdx >= 0 ? liveIdx : index;
    if (effectiveIdx >= 0) this.answeredQuestionIndices.add(effectiveIdx);

    // Always merge the live selectedOptionsMap so any question that has
    // had at least one option committed counts toward the progress %%,
    // regardless of which path called us first.
    try {
      const map = this.selectedOptionService?.selectedOptionsMap;
      if (map) {
        for (const [qIdx, selections] of map) {
          if (Array.isArray(selections) && selections.length > 0 && qIdx >= 0) {
            this.answeredQuestionIndices.add(qIdx);
          }
        }
      }
    } catch { /* ignore */ }

    this.updateProgressValue();
  }

  private get totalCount(): number {
    return this.dotStatusService.computeTotalCount(
      this.totalQuestions,
      (this.quizService as any).questions?.length || 0,
      this.quiz?.questions?.length || 0
    );
  }

  private get _dotParams() {
    return {
      quizId: this.quizId,
      currentQuestionIndex: this.currentQuestionIndex,
      optionsToDisplay: this.optionsToDisplay,
      currentQuestion: this.currentQuestion,
      questionsArray: this.questionsArray
    };
  }

  private getSelectionsForQuestion(index: number): SelectedOption[] {
    return this.dotStatusService.getSelectionsForQuestion({ index, ...this._dotParams });
  }

  getQuestionStatus(index: number, options?: { forceRecompute?: boolean }): 'correct' | 'wrong' | 'pending' {
    return this.dotStatusService.getQuestionStatusSimple({ index, ...this._dotParams, options });
  }

  updateDotStatus(index: number): void {
    this.dotStatusService.timerExpiredUnanswered.delete(index);
    let status = this.getQuestionStatus(index, { forceRecompute: true });

    // Override with confirmed click status when it's more authoritative
    const confirmed = this.selectedOptionService.clickConfirmedDotStatus.get(index);
    if (confirmed === 'correct' || confirmed === 'wrong') {
      if (status === 'pending' || (status === 'wrong' && confirmed === 'correct')) {
        status = confirmed;
      }
    }

    this.dotStatusService.dotStatusCache.set(index, status);

    this.cdRef.detectChanges();
    this.cdRef.markForCheck();
  }

  getDotClass(index: number): string {
    return this.dotStatusService.getDotClassSimple({ index, ...this._dotParams });
  }

  navigateToDot(index: number): void {
    if (!this.isDotClickable(index)) return;
    const quizId = this.quizService.quizId || this.quizService.getCurrentQuizId();
    this.dotStatusService.clearForIndex(index);
    this.selectedOptionService.lastClickedCorrectByQuestion.clear();
    this.quizPersistence.clearPersistedDotStatus(this.quizId, index);
    this.selectedOptionService.resetLocksForQuestion(index);
    this.quizService.setCurrentQuestionIndex(index);
    this.router.navigate(['/quiz/question', quizId, index + 1]);
  }

  isDotClickable(index: number): boolean {
    if (index === this.currentQuestionIndex) return true;
    const status = this.getQuestionStatus(index);
    if (status === 'correct' || status === 'wrong') return true;
    return true;
  }
}