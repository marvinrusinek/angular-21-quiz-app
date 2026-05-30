import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  computed,
  DestroyRef,
  inject,
  OnDestroy,
  OnInit,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable, Subscription } from 'rxjs';
import { MatCardModule } from '@angular/material/card';
import { MatTooltip, MatTooltipModule } from '@angular/material/tooltip';

import { SK_SAVED_QUESTION_INDEX } from '../../shared/constants/session-keys';

import { Option } from '../../shared/models/Option.model';
import { QuestionPayload } from '../../shared/models/QuestionPayload.model';
import { Quiz } from '../../shared/models/Quiz.model';
import { QuizQuestion } from '../../shared/models/QuizQuestion.model';
import { QuizQuestionEvent } from '../../shared/models/QuizQuestionEvent.type';
import { SelectedOption } from '../../shared/models/SelectedOption.model';

import { NextButtonStateService } from '../../shared/services/state/next-button-state.service';
import { QqcQuestionLoaderService } from '../../shared/services/features/qqc/qqc-question-loader.service';
import { QuizDataService } from '../../shared/services/data/quizdata.service';
import { QuizDotStatusService } from '../../shared/services/flow/quiz-dot-status.service';
import { QuizInitializationService } from '../../shared/services/flow/quiz-initialization.service';
import { QuizNavigationService } from '../../shared/services/flow/quiz-navigation.service';
import { QuizPersistenceService } from '../../shared/services/state/quiz-persistence.service';
import { QuizResetService } from '../../shared/services/flow/quiz-reset.service';
import { QuizRouteService } from '../../shared/services/flow/quiz-route.service';
import { QuizService } from '../../shared/services/data/quiz.service';
import { QuizSetupService } from '../../shared/services/flow/quiz-setup.service';
import { QuizStateService } from '../../shared/services/state/quizstate.service';
import { SelectedOptionService } from '../../shared/services/state/selectedoption.service';
import { SelectionMessageService } from '../../shared/services/features/selection-message/selection-message.service';

import { CodelabQuizContentComponent } from './quiz-content/codelab-quiz-content.component';
import { CodelabQuizHeaderComponent } from './quiz-header/quiz-header.component';
import { QuizQuestionComponent } from '../../components/question/quiz-question/quiz-question.component';
import { ScoreboardComponent } from '../scoreboard/scoreboard.component';
import { SharedOptionComponent } from '../../components/question/answer/shared-option-component/shared-option.component';
import { ThemeToggleComponent } from '../../components/theme-toggle/theme-toggle.component';

import { QUESTION_ROUTE_REGEX } from '../../shared/constants/route-patterns';

import { ChangeRouteAnimation } from '../../animations/animations';
import { isOptionCorrect } from '../../shared/utils/is-option-correct';
import { norm } from '../../shared/utils/text-norm';

const INFO_ICON_COLOR = '#1e90ff';

type AnimationState = 'animationStarted' | 'none';

@Component({
  selector: 'codelab-quiz-component',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatTooltipModule,
    QuizQuestionComponent,
    CodelabQuizHeaderComponent,
    CodelabQuizContentComponent,
    ScoreboardComponent,
    ThemeToggleComponent,
  ],
  templateUrl: './quiz.component.html',
  styleUrls: ['./quiz.component.scss'],
  animations: [ChangeRouteAnimation.changeRoute],
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:keydown)': 'onGlobalKey($event)',
    '(window:focus)': 'onTabFocus()',
    '(window:scroll)': 'onScroll()',
    '(window:resize)': 'onResize()'
  }
})
export class QuizComponent implements OnInit, OnDestroy, AfterViewInit {
  // ── injects ─────────────────────────────────────────────────────
  private readonly dotStatusService = inject(QuizDotStatusService);
  private readonly nextButtonStateService = inject(NextButtonStateService);
  private readonly quizDataService = inject(QuizDataService);
  public readonly quizInitializationService = inject(QuizInitializationService);
  private readonly quizNavigationService = inject(QuizNavigationService);
  private readonly quizPersistence = inject(QuizPersistenceService);
  public readonly quizQuestionLoaderService = inject(QqcQuestionLoaderService);
  private readonly quizResetService = inject(QuizResetService);
  private readonly quizRouteService = inject(QuizRouteService);
  public readonly quizService = inject(QuizService);
  private readonly quizSetupService = inject(QuizSetupService);
  public readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly selectionMessageService = inject(SelectionMessageService);
  public readonly activatedRoute = inject(ActivatedRoute);
  public readonly cdRef = inject(ChangeDetectorRef);
  public readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);

  // ── viewChilds ──────────────────────────────────────────────────
  readonly quizQuestionComponent = viewChild(QuizQuestionComponent);
  readonly sharedOptionComponent = viewChild(SharedOptionComponent);
  readonly nextButtonTooltip = viewChild<MatTooltip>('nextButton');

  // ── remaining variables ─────────────────────────────────────────
  readonly selectedQuiz = signal<Quiz | null>(null);
  readonly currentQuestion = signal<QuizQuestion | null>(null);
  readonly quiz = signal<Quiz | null>(null);
  readonly quizId = signal<string>('');
  readonly question = signal<QuizQuestion | null>(null);
  readonly questions = signal<QuizQuestion[]>([]);
  readonly questionsArray = signal<QuizQuestion[]>([]);
  readonly questionsList = this.quizService.questionsSig;
  readonly answers = signal<Option[]>([]);
  readonly selectionMessage = this.selectionMessageService.selectionMessageSig;
  combinedQuestionData = signal<QuestionPayload | null>(null);
  readonly questionIndex = signal<number>(0);
  readonly currentQuestionIndex = signal<number>(0);
  readonly totalQuestions = signal<number>(0);
  readonly progressSig = signal<number>(0);
  questionToDisplaySig = signal<string>('');
  readonly optionsToDisplaySig = signal<Option[]>([]);
  readonly explanationToDisplay = signal<string>('');
  readonly isQuizLoaded = signal<boolean>(false);
  readonly isQuizDataLoaded = signal<boolean>(false);
  public isQuizRenderReadySig = signal<boolean>(false);
  readonly quizAlreadyInitialized = signal<boolean>(false);
  readonly hasOptionsLoaded = signal<boolean>(false);
  public readonly shouldRenderOptions = signal<boolean>(false);
  readonly previousIndex = signal<number | null>(null);
  readonly isNavigatedByUrl = signal<boolean>(false);
  readonly navigatingToResults = signal<boolean>(false);
  readonly nextButtonEnabled = this.nextButtonStateService.isButtonEnabled;
  animationStateSig = signal<AnimationState>('none');

  combinedQuestionDataView = computed(() => {
    const payload = this.combinedQuestionData();

    // URL-AUTHORITATIVE OVERRIDE: when the user has navigated directly to
    // /question/{quizId}/{N}, the URL is the only source we trust. Any
    // payload whose question doesn't match the URL question is a stale
    // emission (typically Q1 leaking through during the multi-step
    // initialization chain) and must NOT render. We synthesize the
    // payload from the URL-resolved question instead.
    try {
      const m = window.location.pathname.match(QUESTION_ROUTE_REGEX);
      if (m) {
        const urlIdx = Number(m[1]) - 1;
        const urlQ = this.quizService.questions?.[urlIdx];
        if (urlQ?.options?.length) {
          const urlText = norm(urlQ.questionText);
          const payloadText = norm(payload?.question?.questionText);
          if (!payloadText || urlText !== payloadText) {
            return {
              question: urlQ,
              options: urlQ.options,
              explanation: urlQ.explanation ?? '',
            };
          }
        }
      }
    } catch {
      /* non-browser env */
    }

    if (!payload?.question) return payload;

    const shuffled = this.quizService.shuffledQuestions;
    const isShuffleActive = this.quizService.isShuffleEnabled() && shuffled?.length > 0;
    if (isShuffleActive) {
      const idx = this.currentQuestionIndex() ?? 0;
      const correctQ = shuffled[idx];
      if (correctQ) {
        // ALWAYS use shuffled data when shuffle is active
        return {
          question: correctQ,
          options: correctQ.options ?? [],
          explanation: correctQ.explanation ?? '',
        };
      }
    }
    return payload;
  });

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
      (o: any) => isOptionCorrect(o)
    ).length;
    if (numCorrect <= 1 || opts.length === 0) return baseText;

    const suffix = numCorrect === 1 ? 'answer is' : 'answers are';
    const banner = `(${numCorrect} ${suffix} correct)`;
    return `${baseText} <span class="correct-count">${banner}</span>`;
  });

  // ── Template getters ──────────────────────────────────────────
  readonly showPaging = computed(() => this.isQuizDataLoaded() && this.totalQuestions() > 0);

  readonly shouldShowPrevButton = computed(() => this.getEffectiveQuestionIndex() > 0);

  readonly shouldShowRestartButton = computed(() => {
    const idx = this.getEffectiveQuestionIndex();
    const serviceCount = this.quizService.questions?.length || 0;
    const effectiveTotal = Math.max(this.totalQuestions(), serviceCount);
    return idx > 0 && idx <= effectiveTotal - 1;
  });

  readonly shouldShowNextButton = computed(() => {
    const serviceCount = this.quizService.questions?.length || 0;
    const effectiveTotal = Math.max(this.totalQuestions(), serviceCount);
    return this.getEffectiveQuestionIndex() < effectiveTotal - 1;
  });

  questions$: Observable<QuizQuestion[]> = this.quizService.questions$;
  currentQuestion$ = this.quizStateService.currentQuestion$;
  subscriptions: Subscription = new Subscription();
  public questionToDisplay$ = toObservable(this.questionToDisplayTextView);
  displayState$ = this.quizStateService.displayState$;
  lastLoggedIndex = -1;
  public answeredQuestionIndices = new Set<number>();
  public _processingOptionClick = false;
  public _lastClickTime = 0;
  public _lastOptionId = -1;
  private scrollIndicatorEl: HTMLElement | null = null;

  constructor() {
    this.quizSetupService.wireConstructor(this);
  }

  async ngOnInit(): Promise<void> {
    return this.quizSetupService.runOnInit(this);
  }

  async ngAfterViewInit(): Promise<void> {
    return this.quizSetupService.runAfterViewInit(this);
  }

  ngOnDestroy(): void {
    this.removeScrollIndicator();
    this.quizSetupService.runOnDestroy(this);
  }

  async onGlobalKey(event: KeyboardEvent): Promise<void> {
    return this.quizSetupService.runOnGlobalKey(this, event);
  }

  onTabFocus(): void {
    if (!this.quizStateService.isLoading()) {
      const idx = this.quizService.getCurrentQuestionIndex();
      const total = this.totalQuestions();
      if (idx >= 0 && idx < total) {
        this.quizService.updateBadgeText(idx + 1, total);
      }
      this.cdRef.markForCheck();
    }
  }

  onScroll(): void {
    this.checkScrollIndicator();
  }

  onResize(): void {
    this.checkScrollIndicator();
  }

  checkScrollIndicator(): void {
    const quizCard = document.querySelector('.quiz-card');
    if (!quizCard) {
      this.removeScrollIndicator();
      return;
    }
    const cardRect = quizCard.getBoundingClientRect();
    const shouldShow = cardRect.bottom - window.innerHeight > 80;
    if (shouldShow && !this.scrollIndicatorEl) {
      this.createScrollIndicator();
    } else if (!shouldShow && this.scrollIndicatorEl) {
      this.removeScrollIndicator();
    }
  }

  scrollToBottom(): void {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  }

  async initializeQuizId(): Promise<string | null> {
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

  initializeQuestionIndex(): void {
    const idx = this.quizRouteService.getRouteQuestionIndex(this.activatedRoute, this.router);
    this.currentQuestionIndex.set(idx);
    this.quizService.setCurrentQuestionIndex(idx);
    try {
      localStorage.setItem(SK_SAVED_QUESTION_INDEX, JSON.stringify(idx));
    } catch (e) {
      console.error('Failed to persist question index to localStorage:', e);
    }
  }

  public normalizeQuestionIndex(rawIndex: number | undefined): number {
    const current = this.currentQuestionIndex();
    if (!Number.isInteger(rawIndex)) return current;
    const idx = Number(rawIndex);
    const total = this.totalCount;
    if (idx === current) return idx;
    if (idx === current + 1) return current;
    if (total > 0 && idx >= total && idx - 1 >= 0 && idx - 1 < total) return idx - 1;
    return idx;
  }

  public onOptionSelected(option: SelectedOption, isUserAction: boolean = true): Promise<void> {
    return this.quizSetupService.onOptionSelected(this, option, isUserAction);
  }

  resetQuestionState(): void {
    this.quizResetService.resetQuestionServiceState();
    this.currentQuestion.set(null);
    this.question.set(null);
    this.optionsToDisplaySig.set([]);
    this.quizQuestionComponent()?.resetFeedback?.();
    this.quizQuestionComponent()?.resetState?.();
    this.cdRef.markForCheck();
  }

  public get shouldShowResultsButton(): boolean {
    const serviceCount = this.quizService.questions?.length || 0;
    const effectiveTotal = Math.max(this.totalQuestions(), serviceCount);
    const idx = this.getEffectiveQuestionIndex();
    const isLast = effectiveTotal > 0 && idx === effectiveTotal - 1;
    if (!isLast) return false;

    const question: QuizQuestion | null =
      this.question() ??
      ((this.quizService as any).currentQuestion?.value as QuizQuestion | null) ??
      this.quizService.questions?.[idx] ??
      this.quizService.shuffledQuestions?.[idx] ??
      null;

    if (!question) return false;
    const selected = this.selectedOptionService.getSelectedOptionsForQuestion(idx) ?? [];
    if (selected.length > 0) return true;

    // Authoritative in-session answered probe — same source as the selection
    // message logic. External maps leak across sessions / collide in shuffled
    // mode, so we don't consult them.
    if (this.selectionMessageService.isCompletedInSession(idx)) return true;

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
    if (this.navigatingToResults()) return;
    this.navigatingToResults.set(true);

    // Record elapsed time and stop timer (no navigation from service)
    this.quizNavigationService.recordElapsedAndGoToResults(this.currentQuestionIndex());

    // Navigate to results from the component
    const quizId =
      this.quizId() ||
      this.quizService.quizId ||
      this.quizService.getCurrentQuizId() ||
      this.activatedRoute.snapshot.paramMap.get('quizId') ||
      '';
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
    if (total <= 0) {
      this.cdRef.markForCheck();
      return;
    }
    this.progressSig.set(Math.round((this.answeredQuestionIndices.size / total) * 100));
    try {
      sessionStorage.setItem('quizProgress', String(this.progressSig()));
      sessionStorage.setItem('quizProgressQuizId', this.quizId());
      sessionStorage.setItem(
        'answeredQuestionIndices',
        JSON.stringify([...this.answeredQuestionIndices])
      );
    } catch (e) {
      console.error('Failed to persist quiz progress to sessionStorage:', e);
    }
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
    const liveIdx = this.quizService?.currentQuestionIndex;
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
    } catch {
      /* ignore */
    }

    this.updateProgressValue();
  }

  getSelectionsForQuestion(index: number): SelectedOption[] {
    return this.dotStatusService.getSelectionsForQuestion({ index, ...this._dotParams });
  }

  getQuestionStatus(
    index: number,
    options?: { forceRecompute?: boolean }
  ): 'correct' | 'wrong' | 'pending' {
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
    this.quizPersistence.clearPersistedDotStatus(this.quizId(), index);
    this.selectedOptionService.resetLocksForQuestion(index);
    this.quizService.setCurrentQuestionIndex(index);
    this.router.navigate(['/quiz/question', quizId, index + 1]);
  }

  isDotClickable(index: number): boolean {
    if (index === this.currentQuestionIndex()) return true;
    const status = this.getQuestionStatus(index);
    if (status === 'correct' || status === 'wrong') return true;
    return true;
  }

  // Read the URL question index — used as a fallback when
  // this.currentQuestionIndex hasn't propagated yet during URL/dot
  // navigation. The button-visibility getters depend on the index
  // matching the URL, otherwise Prev/Restart/Show-Results all
  // disappear on direct URL nav to a non-Q1 question.
  private getEffectiveQuestionIndex(): number {
    return this.currentQuestionIndex();
  }

  private createScrollIndicator(): void {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;bottom:20px;left:0;right:0;margin:0 auto;z-index:9999;width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,0.95);box-shadow:0 4px 12px rgba(0,0,0,0.25);display:flex;justify-content:center;align-items:center;cursor:pointer;animation:scrollBounce 2s infinite;';
    el.innerHTML =
      `<i class="material-icons" style="font-size:32px;color:${INFO_ICON_COLOR};">keyboard_arrow_down</i>`;
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

  private get totalCount(): number {
    return this.dotStatusService.computeTotalCount(
      this.totalQuestions(),
      this.quizService.questions?.length || 0,
      this.quiz()?.questions?.length || 0
    );
  }

  private get _dotParams() {
    return {
      quizId: this.quizId(),
      currentQuestionIndex: this.currentQuestionIndex(),
      optionsToDisplay: this.optionsToDisplaySig(),
      currentQuestion: this.currentQuestion(),
      questionsArray: this.questionsArray(),
    };
  }
}
