import {
  AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, DoCheck, effect,
  HostListener, input, OnDestroy, OnInit, output, signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule, MatCheckboxChange } from '@angular/material/checkbox';
import { MatRadioModule, MatRadioChange } from '@angular/material/radio';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Observable, Subject } from 'rxjs';

import { FeedbackProps } from '../../../../shared/models/FeedbackProps.model';
import { Option } from '../../../../shared/models/Option.model';
import { OptionClickedPayload } from '../../../../shared/models/OptionClickedPayload.model';
import { OptionBindings } from '../../../../shared/models/OptionBindings.model';
import { QuizQuestion } from '../../../../shared/models/QuizQuestion.model';
import { SelectedOption } from '../../../../shared/models/SelectedOption.model';
import { SharedOptionConfig } from '../../../../shared/models/SharedOptionConfig.model';
import { FeedbackComponent } from '../feedback/feedback.component';
import { QuizService } from '../../../../shared/services/data/quiz.service';
import { QuizStateService } from '../../../../shared/services/state/quizstate.service';
import { SelectedOptionService } from '../../../../shared/services/state/selectedoption.service';
import { SoundService } from '../../../../shared/services/ui/sound.service';
import { SharedOptionConfigDirective } from '../../../../directives/shared-option-config.directive';
import { correctAnswerAnim } from '../../../../animations/animations';
import { OptionItemComponent } from './option-item/option-item.component';
import type { OptionUIEvent } from './option-item/option-item.component';
import { OptionService } from '../../../../shared/services/options/view/option.service';
import { SharedOptionStateAdapterService, SharedOptionUiState } from '../../../../shared/services/state/shared-option-state-adapter.service';
import { OptionUiContextBuilderService } from '../../../../shared/services/options/engine/option-ui-context-builder.service';
import { OptionUiSyncContext } from '../../../../shared/services/options/engine/option-ui-sync.service';
import { OptionLockService } from '../../../../shared/services/options/policy/option-lock.service';
import { OptionSelectionUiService } from '../../../../shared/services/options/engine/option-selection-ui.service';
import { SharedOptionExplanationService } from '../../../../shared/services/features/shared-option/shared-option-explanation.service';
import { OptionClickHandlerService } from '../../../../shared/services/options/engine/option-click-handler.service';
import { SharedOptionFeedbackService, FeedbackContext } from '../../../../shared/services/features/shared-option/shared-option-feedback.service';
import { SharedOptionInitService } from '../../../../shared/services/options/engine/shared-option-init.service';
import { SharedOptionBindingService } from '../../../../shared/services/options/engine/shared-option-binding.service';
import { SharedOptionClickService } from '../../../../shared/services/options/engine/shared-option-click.service';
import { SharedOptionOrchestratorService } from '../../../../shared/services/features/shared-option/shared-option-orchestrator.service';
import { TimerService } from '../../../../shared/services/features/timer/timer.service';

@Component({
  selector: 'app-shared-option',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatIconModule,
    MatRadioModule,
    MatCheckboxModule,
    SharedOptionConfigDirective,
    FeedbackComponent,
    OptionItemComponent
  ],
  templateUrl: './shared-option.component.html',
  styleUrls: [
    '../../quiz-question/quiz-question.component.scss',
    './shared-option.component.scss'
  ],
  animations: [correctAnswerAnim],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SharedOptionComponent
    implements OnInit, DoCheck, OnDestroy, AfterViewInit {
  readonly optionClicked = output<OptionClickedPayload>();
  readonly optionEvent = output<OptionUIEvent>();
  readonly reselectionDetected = output<boolean>();
  readonly explanationUpdate = output<number>();
  readonly renderReadyChange = output<boolean>();
  readonly showExplanationChange = output<boolean>();
  readonly explanationToDisplayChange = output<string>();

  // Signal inputs (parent-bound). Internal mutable backing fields with the same
  // logical names are kept below, since multiple services write to them via
  // `host as any`. Effects in the constructor mirror input → backing field.
  readonly currentQuestionInput = input<QuizQuestion | null>(null);
  readonly currentQuestionIndexInput = input<number>(undefined as unknown as number);
  readonly questionIndex = input<number | null>(null);
  readonly optionsToDisplayInput = input<Option[]>(undefined as unknown as Option[]);
  readonly quizId = input<string>(undefined as unknown as string);
  readonly typeInput = input<'single' | 'multiple'>('single');
  readonly config = input<SharedOptionConfig>(undefined as unknown as SharedOptionConfig);
  readonly highlightCorrectAfterIncorrect = input<boolean>(false);
  readonly quizQuestionComponentOnOptionClicked = input<(option: SelectedOption, index: number) => void>(undefined as unknown as (option: SelectedOption, index: number) => void);
  readonly optionBindingsInput = input<OptionBindings[]>([]);
  readonly selectedOptionId = input<number | null>(null);
  readonly isNavigatingBackwardsInput = input<boolean>(false);
  readonly renderReadyInput = input<boolean>(false);

  // Mutable backing fields (mirrored from inputs and freely written by services)
  public currentQuestion: QuizQuestion | null = null;
  public currentQuestionIndex!: number;
  public optionsToDisplay!: Option[];
  public type: 'single' | 'multiple' = 'single';
  public selectedOption: Option | null = null;
  public showFeedbackForOption!: { [key: string | number]: boolean };
  public correctMessage = '';
  public showFeedback = false;
  public shouldResetBackground = false;
  public optionBindings: OptionBindings[] = [];
  public selectedOptionIndex: number | null = null;
  public isNavigatingBackwards = false;
  readonly finalRenderReady$ = input<Observable<boolean> | null>(null);
  readonly questionVersion = input<number>(0);  // increments every time questionIndex changes
  readonly sharedOptionConfig = input<SharedOptionConfig>(undefined as unknown as SharedOptionConfig);
  public selectedOptionMap = new Map<number | string, boolean>();
  public perQuestionHistory = new Set<number | string>();
  public ui!: SharedOptionUiState;
  public isSelected = false;
  feedbackBindings: FeedbackProps[] = [];
  currentFeedbackConfig!: FeedbackProps;
  feedbackConfigs: { [key: string]: FeedbackProps } = {};
  activeFeedbackConfig: FeedbackProps | null = null;
  // Simple, bulletproof feedback tracker: set synchronously at the end of runOptionContentClick.
  // Bypasses complex service pipeline; cleared on question change.
  // Must be public for template access.
  public _feedbackDisplay: { idx: number; config: FeedbackProps } | null = null;
  selectedOptions: Set<number | string> = new Set();
  clickedOptionIds: Set<number | string> = new Set();
  selectedOptionHistory: (number | string)[] = [];
  // Track CORRECT option clicks per question for timer stop logic
  private correctClicksPerQuestion: Map<number, Set<number>> = new Map();
  // Track DISABLED option IDs per question - persists across binding recreations
  public disabledOptionsPerQuestion: Map<number, Set<number>> = new Map();
  private lastFeedbackQuestionIndex = -1;
  lastFeedbackOptionId: number | string = -1;
  lastSelectedOptionId: number | string = -1;
  lastClickedOptionId: number | string | null = null;
  lastClickTimestamp: number | null = null;
  hasUserClicked = false;
  freezeOptionBindings = false;
  highlightedOptionIds: Set<number | string> = new Set();

  // Counter to force OnPush re-render when disabled state changes
  disableRenderTrigger = 0;

  showOptions = false;
  form!: FormGroup;

  readonly renderReady = signal(false);

  // Include disableRenderTrigger to force re-render when disabled state changes
  trackByOptionId = (b: OptionBindings, idx: number) => {
    const idPart = (b.option?.optionId != null && b.option.optionId !== -1) ? b.option.optionId : `idx-${idx}`;
    const questionPart = this.getActiveQuestionIndex();
    return `q${questionPart}_${idPart}_${idx}`;
  };

  public flashDisabledSet = new Set<number>();
  private lockedIncorrectOptionIds = new Set<number>();
  public forceDisableAll = false;
  public timerExpiredForQuestion = false;  // track timer expiration
  timeoutCorrectOptionKeys = new Set<string>();
  private resolvedQuestionIndex: number | null = null;

  private _isMultiModeCache: boolean | null = null;
  private _lastHandledIndex: number | null = null;
  private _lastHandledTime: number | null = null;

  // BULLETPROOF feedback tracker: set synchronously in handleOptionClick,
  // NEVER cleared by ngOnChanges/generateOptionBindings/rebuild cycles.
  // Only cleared on question change.
  private _lastClickFeedback: { index: number; config: FeedbackProps; questionIdx: number } | null = null;

  // DURABLE multi-answer selection tracker. Survives binding regeneration.
  // Maps question index → Set of selected display indices.
  // Only cleared on question change (resetStateForNewQuestion / ngOnChanges).
  private _multiSelectByQuestion = new Map<number, Set<number>>();
  private _correctIndicesByQuestion = new Map<number, number[]>();

  destroy$ = new Subject<void>();
  // Flag to prevent the timer-expiry effect from firing more than once per question
  public _timerExpiryHandled = false;

  constructor(
    private quizService: QuizService,
    private quizStateService: QuizStateService,
    private selectedOptionService: SelectedOptionService,
    public soundService: SoundService,
    private optionService: OptionService,
    private optionUiContextBuilder: OptionUiContextBuilderService,
    private optionLockService: OptionLockService,
    private optionSelectionUiService: OptionSelectionUiService,
    private sharedOptionStateAdapterService: SharedOptionStateAdapterService,
    private explanationHandler: SharedOptionExplanationService,
    private clickHandler: OptionClickHandlerService,
    private feedbackManager: SharedOptionFeedbackService,
    private initService: SharedOptionInitService,
    private bindingService: SharedOptionBindingService,
    private clickService: SharedOptionClickService,
    private orchestrator: SharedOptionOrchestratorService,
    private timerService: TimerService,
    public cdRef: ChangeDetectorRef,
    private fb: FormBuilder
  ) {
    this.ui = this.sharedOptionStateAdapterService.createInitialUiState();
    this.form = this.fb.group({
      selectedOptionId: [null, Validators.required]
    });

    // Mirror signal inputs into mutable backing fields. Services elsewhere
    // freely reassign these fields via `host as any`, so we cannot expose
    // the readonly signals directly under those names.
    effect(() => {
      const v = this.currentQuestionInput();
      if (v !== undefined) this.currentQuestion = v;
    });
    let _lastQIdxForStampCleanup: number | undefined;
    effect(() => {
      const v = this.currentQuestionIndexInput();
      if (v !== undefined) {
        // Q→Q transition cleanup: strip any timer-expiry stamps left over
        // from the previous question. Angular reuses .option-row DOM nodes
        // across the @for binding rebuild, so inline pointer-events:none
        // and the 'correct-option' class persist into the new question.
        // Per-binding _timerExpiredStamped flags can also stick when the
        // binding objects are mutated in place.
        if (_lastQIdxForStampCleanup !== undefined && _lastQIdxForStampCleanup !== v) {
          this.timerExpiredForQuestion = false;
          this._timerExpiryHandled = false;
          for (const b of this.optionBindings ?? []) {
            if (!b) continue;
            delete (b as any)._timerExpiredStamped;
            delete (b as any)._timerExpiredStampedForIndex;
            delete (b as any)._autoRevealedCorrect;
            if (b.cssClasses) {
              delete b.cssClasses['correct-option'];
              delete b.cssClasses['incorrect-option'];
            }
            b.isSelected = false;
            b.disabled = false;
            b.highlight = false;
            b.showFeedback = false;
            b.highlightCorrect = false;
            b.highlightIncorrect = false;
            if (b.option) {
              b.option.selected = false;
              b.option.highlight = false;
              b.option.showIcon = false;
              b.option.active = true;
              delete (b.option as any)._autoRevealedCorrect;
              delete (b.option as any).feedback;
            }
          }
          this.selectedOptionMap.clear();
          this.perQuestionHistory.clear();
          this.selectedOptionHistory = [];
          this.lastFeedbackOptionId = -1;
          this.lastFeedbackQuestionIndex = v;
          this.feedbackConfigs = {};
          this.showFeedbackForOption = {};
          this.showFeedback = false;
          this.highlightedOptionIds.clear();
          this.flashDisabledSet.clear();
          this.lockedIncorrectOptionIds.clear();
          this.forceDisableAll = false;
          this._feedbackDisplay = null;
          this._lastClickFeedback = null;
          this.activeFeedbackConfig = null;
          // Reset the radio-group form value so Q3's index-3 click ("All of
          // the above") doesn't carry over and auto-check Q5's NgModule
          // (also at displayIndex 3). The pre-checked state suppresses
          // mat-radio-button's (change) event on subsequent clicks.
          try {
            this.form?.get('selectedOptionId')?.setValue(null, { emitEvent: false });
          } catch { /* ignore */ }
          try {
            for (const el of Array.from(document.querySelectorAll('.option-row'))) {
              const html = el as HTMLElement;
              html.style.pointerEvents = '';
              el.classList.remove('correct-option');
              el.classList.remove('incorrect-option');
            }
          } catch { /* ignore — non-browser env */ }
        }
        _lastQIdxForStampCleanup = v;
        this.currentQuestionIndex = v;
      }
    });
    effect(() => {
      let v = this.optionsToDisplayInput();
      if (v !== undefined) {
        // SHUFFLE GUARD: ensure options belong to the shuffled question for this index.
        // Compare the SET of option texts — if the incoming options have texts that
        // don't match the shuffled question's options, replace them.
        const qs = this.quizService;
        if (qs.isShuffleEnabled() && qs.shuffledQuestions?.length > 0) {
          const idx = this.currentQuestionIndex ?? qs.currentQuestionIndex ?? 0;
          const correctQ = qs.shuffledQuestions[idx];
          if (correctQ?.options?.length > 0 && v.length > 0) {
            const correctTexts = new Set(correctQ.options.map((o: any) => (o?.text ?? '').trim().toLowerCase()));
            const actualTexts = new Set(v.map((o: any) => (o?.text ?? '').trim().toLowerCase()));
            const match = correctTexts.size === actualTexts.size && [...correctTexts].every(t => actualTexts.has(t));
            if (!match) {
              v = correctQ.options.map((o: any) => ({ ...o }));
            }
          }
        }
        this.optionsToDisplay = v;
      }
    });
    effect(() => {
      const v = this.typeInput();
      if (v !== undefined) this.type = v;
    });
    effect(() => {
      const v = this.optionBindingsInput();
      if (v !== undefined) this.optionBindings = v;
    });
    effect(() => {
      this.isNavigatingBackwards = this.isNavigatingBackwardsInput();
    });
    effect(() => {
      this.renderReady.set(this.renderReadyInput());
    });

    // Multi-answer auto-disable. Reactively watches the selections signal
    // and rebuilds optionBindings with fresh refs the moment every pristine-
    // correct option for THIS rendered question is selected. Pure Angular
    // reactivity — OnPush option-item children pick up new `b` refs via
    // ngOnChanges, no DOM, no detectChanges hacks.
    //
    // Identifies the rendered question by option-text fingerprint
    // (matching the bindings against pristine quizInitialState) instead
    // of trusting currentQuestionIndex, which can lag during click flow.
    effect(() => {
      const selectionsMap = this.selectedOptionService.selectedOptionsMapSig();
      if (!this.optionBindings || this.optionBindings.length === 0) return;

      const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
      const bindingTexts = this.optionBindings
        .map((b: any) => nrm(b?.option?.text))
        .filter((t: string) => !!t);
      if (bindingTexts.length === 0) return;

      // Find pristine question whose options exactly match this binding set.
      const bundle: any[] = (this.quizService as any)?.quizInitialState ?? [];
      let pristineCorrectTexts: Set<string> | null = null;
      const bindingTextSet = new Set(bindingTexts);
      outer: for (const quiz of bundle) {
        for (const pq of (quiz?.questions ?? [])) {
          const pqOpts = pq?.options ?? [];
          if (pqOpts.length !== this.optionBindings.length) continue;
          const pqTexts = pqOpts.map((o: any) => nrm(o?.text));
          if (!pqTexts.every((t: string) => bindingTextSet.has(t))) continue;
          pristineCorrectTexts = new Set(
            pqOpts
              .filter((o: any) =>
                o?.correct === true || String(o?.correct) === 'true' ||
                o?.correct === 1 || o?.correct === '1'
              )
              .map((o: any) => nrm(o?.text))
              .filter((t: string) => !!t)
          );
          break outer;
        }
      }
      if (!pristineCorrectTexts || pristineCorrectTexts.size < 2) return;

      // Find selections (across any question slot) whose texts cover every
      // pristine correct text. Avoids dependence on currentQuestionIndex.
      let allCorrectSelected = false;
      for (const sels of selectionsMap.values()) {
        const selectedTexts = new Set(
          (sels ?? []).map((s: any) => nrm(s?.text)).filter((t: string) => !!t)
        );
        if ([...pristineCorrectTexts].every(t => selectedTexts.has(t))) {
          allCorrectSelected = true;
          break;
        }
      }
      if (!allCorrectSelected) return;

      // Rebuild every binding with fresh refs so OnPush option-items pick
      // up the new disabled state via ngOnChanges.
      const correctTexts = pristineCorrectTexts;
      let mutated = false;
      const next = this.optionBindings.map((b: any) => {
        const myText = nrm(b?.option?.text);
        const isCorrect = correctTexts.has(myText);
        const targetDisabled = !isCorrect;
        if (b.disabled !== targetDisabled) mutated = true;
        return {
          ...b,
          disabled: targetDisabled,
          isCorrect,
          option: b.option ? {
            ...b.option,
            active: isCorrect
          } : b.option
        };
      });
      if (mutated) {
        this.optionBindings = next;
        this.cdRef.markForCheck();
      }
    });

    // Independent timer-expiry watcher: uses the elapsed time signal
    // directly, bypassing expired$ and all orchestrator chains.
    // When elapsed time reaches the time-per-question, apply correct
    // answer highlighting via direct DOM manipulation.
    effect(() => {
      const elapsed = this.timerService.elapsedTimeSig();
      const duration = this.timerService.timePerQuestion;
      if (elapsed > 0 && elapsed >= duration && !this._timerExpiryHandled) {
        this._timerExpiryHandled = true;
        this.timerExpiredForQuestion = true;

        // Get correct answer texts from canonical question data
        const qIdx = this.currentQuestionIndex ?? this.quizService.currentQuestionIndex ?? 0;
        const question = this.quizService.questions?.[qIdx] ?? this.currentQuestion;
        const displayOpts = this.optionsToDisplay?.length
          ? this.optionsToDisplay
          : question?.options ?? [];
        const correctTexts = new Set<string>();
        for (const opt of displayOpts) {
          if (opt?.correct === true || String(opt?.correct) === 'true') {
            correctTexts.add(((opt.text as string) || '').trim().toLowerCase());
          }
        }

        // Stamp bindings, scoped to this question index so navigating to
        // the next question does NOT inherit the disabled/highlight stamps.
        for (const b of (this.optionBindings ?? [])) {
          if (!b) continue;
          const optText = ((b.option?.text as string) || '').trim().toLowerCase();
          const isCorrect = correctTexts.has(optText);
          if (!b.cssClasses) b.cssClasses = {};
          b.cssClasses!['correct-option'] = isCorrect;
          b.cssClasses!['incorrect-option'] = !isCorrect && !!b.isSelected;
          (b as any)._timerExpiredStamped = true;
          (b as any)._timerExpiredStampedForIndex = qIdx;
          b.disabled = true;
        }

        this.cdRef.markForCheck();
        this.cdRef.detectChanges();

        // DOM fallback: directly add CSS classes after Angular renders.
        // Bail out if the user has already navigated away — without this
        // guard, the deferred timeout fires after Q2 has rendered and
        // re-applies pointer-events:none + correct-option to Q2's rows,
        // making them appear disabled/highlighted on the new question.
        const stampedForIdx = qIdx;
        setTimeout(() => {
          const liveIdx =
            this.currentQuestionIndex ?? this.quizService.currentQuestionIndex ?? 0;
          if (liveIdx !== stampedForIdx) return;

          for (const el of Array.from(document.querySelectorAll('.option-row'))) {
            const textEl = el.querySelector('.option-text');
            const text = ((textEl?.textContent as string) || '').trim().toLowerCase();
            if (correctTexts.has(text)) {
              el.classList.add('correct-option');
            }
            (el as HTMLElement).style.pointerEvents = 'none';
          }
        }, 50);
      }
    });
  }

  get isMultiMode(): boolean {
    return this.orchestrator.runIsMultiMode(this);
  }

  ngOnInit(): void {
    this.orchestrator.runOnInit(this);
  }

  private initializeQuestionIndex(): void {
    this.orchestrator.runInitializeQuestionIndex(this);
  }

  private resetStateForNewQuestion(): void {
    this.initService.resetStateForNewQuestion(this as any);
  }

  private subscribeToTimerExpiration(): void {
    this.initService.subscribeToTimerExpiration(this as any);
  }

  private setupFallbackRendering(): void {
    this.initService.setupFallbackRendering(this as any);
  }

  private initializeConfiguration(): void {
    this.initService.initializeConfiguration(this as any);
  }

  private initializeOptionDisplayWithFeedback(): void {
    this.initService.initializeOptionDisplayWithFeedback(this as any);
  }

  private setupSubscriptions(): void {
    this.initService.setupSubscriptions(this as any);
  }

  private subscribeToSelectionChanges(): void {
    this.initService.subscribeToSelectionChanges(this as any);
  }

  ngAfterViewInit(): void {
    this.orchestrator.runAfterViewInit(this);
  }

  ngOnDestroy(): void {
    this.orchestrator.runOnDestroy(this);
  }

  @HostListener('window:visibilitychange', [])
  onVisibilityChange(): void {
    this.orchestrator.runOnVisibilityChange(this);
  }

  private rehydrateUiFromState(reason: string): void {
    this.bindingService.rehydrateUiFromState(this as any, reason);
  }

  private setupRehydrateTriggers(): void {
    this.initService.setupRehydrateTriggers(this as any);
  }

  private rebuildShowFeedbackMapFromBindings(): void {
    this.orchestrator.runRebuildShowFeedbackMapFromBindings(this);
  }

  private updateSelections(rawSelectedId: number | string): void {
    this.orchestrator.runUpdateSelections(this, rawSelectedId);
  }

  private ensureOptionsToDisplay(): void {
    this.clickService.ensureOptionsToDisplay(this as any);
  }

  private synchronizeOptionBindings(): void {
    this.bindingService.synchronizeOptionBindings(this as any);
  }

  ngDoCheck(): void {
    this.updateBindingSnapshots();
  }

  buildSharedOptionConfig(b: OptionBindings, i: number): SharedOptionConfig {
    return this.bindingService.buildSharedOptionConfig(this as any, b, i);
  }

  public getSharedOptionConfig(
      b: OptionBindings,
      i: number
  ): SharedOptionConfig {
    return this.buildSharedOptionConfig(b, i);
  }

  preserveOptionHighlighting(): void {
    this.clickService.preserveOptionHighlighting(this as any);
  }

  initializeFromConfig(): void {
    this.initService.initializeFromConfig(this as any);
  }

  private setOptionBindingsIfChanged(newOptions: Option[]): void {
    this.bindingService.setOptionBindingsIfChanged(this as any, newOptions);
  }

  getOptionDisplayText(option: Option, idx: number): string {
    return this.optionService.getOptionDisplayText(option, idx);
  }

  public getOptionIcon(binding: OptionBindings, i: number): string {
    return this.optionService.getOptionIcon(binding, i);
  }

  public getOptionClasses(binding: OptionBindings): { [key: string]: boolean } {
    return this.orchestrator.runGetOptionClasses(this, binding);
  }

  // Returns cursor style for option - 'not-allowed' for disabled/incorrect
  // options or when timer expired
  public getOptionCursor(binding: OptionBindings, index: number): string {
    return this.optionService.getOptionCursor(
      binding, index, this.isDisabled(binding, index), this.timerExpiredForQuestion
    );
  }

  // Decide if an option should be disabled, only checks disabledOptionsPerQuestion
  // Map. All actual disabling decisions are made in onOptionContentClick
  public shouldDisableOption(binding: OptionBindings): boolean {
    return this.orchestrator.runShouldDisableOption(this, binding);
  }

  public computeDisabledState(option: Option, index: number): boolean {
    return this.orchestrator.runComputeDisabledState(this, option, index);
  }

  // Wrapper for template compatibility or legacy calls
  public isDisabled(binding: OptionBindings, index: number): boolean {
    // Return the pre-computed state from the binding snapshot if available/trusted,
    // otherwise re-compute for robust click guarding.
    return this.computeDisabledState(binding.option, index);
  }

  public onOptionInteraction(binding: OptionBindings, index: number, event: MouseEvent): void {
    this.orchestrator.runOnOptionInteraction(this, binding, index, event);
  }

  public onOptionChanged(
      binding: OptionBindings,
      index: number,
      event: MatCheckboxChange | MatRadioChange
  ): void {
    this.updateOptionAndUI(binding, index, event);
  }

  public updateOptionAndUI(
      optionBinding: OptionBindings,
      index: number,
      event: MatCheckboxChange | MatRadioChange,
      existingCtx?: OptionUiSyncContext
  ): void {
    this.clickService.updateOptionAndUI(this as any, optionBinding, index, event, existingCtx);
  }

  private enforceSingleSelection(selectedBinding: OptionBindings): void {
    this.clickService.enforceSingleSelection(this as any, selectedBinding);
  }

  updateHighlighting(): void {
    // Moved to OptionItemComponent
  }

  private resolveInteractionType(): 'single' | 'multiple' {
    return this.isMultiMode ? 'multiple' : 'single';
  }

  private buildFeedbackContext(): FeedbackContext {
    return this.orchestrator.runBuildFeedbackContext(this);
  }

  private buildOptionUiSyncContext(): OptionUiSyncContext {
    return this.optionUiContextBuilder.fromSharedOptionComponent(this);
  }

  public emitExplanation(questionIndex: number, skipGuard = false): void {
    this.orchestrator.runEmitExplanation(this, questionIndex, skipGuard);
  }

  private resolveDisplayIndex(questionIndex: number): number {
    return this.explanationHandler.resolveDisplayIndex(
        questionIndex,
        () => this.getActiveQuestionIndex(),
        this.currentQuestionIndex,
        this.resolvedQuestionIndex
    );
  }

  private _pendingHighlightRAF: number | null = null;

  private deferHighlightUpdate(callback: () => void): void {
    this.orchestrator.runDeferHighlightUpdate(this, callback);
  }


  public async handleOptionClick(
      option: SelectedOption | undefined,
      index: number
  ): Promise<void> {
    if (!option) return;

    // Redirect to the unified UI flow which handles synchronization and services
    this.onOptionUI({
      optionId: option.optionId ?? -1,
      displayIndex: index,
      kind: 'interaction',
      inputType: this.isMultiMode ? 'checkbox' : 'radio',
      nativeEvent: new MouseEvent('click')
    });
  }

  private handleSelection(option: SelectedOption, index: number, optionId: number): void {
    this.clickService.handleSelection(this as any, option, index, optionId);
  }

  displayFeedbackForOption(
    option: SelectedOption,
    index: number,
    optionId: number
  ): void {
    this.orchestrator.runDisplayFeedbackForOption(this, option, index, optionId);
  }

  generateFeedbackConfig(
    option: SelectedOption,
    selectedIndex: number
  ): FeedbackProps {
    return this.feedbackManager.generateFeedbackConfig(option, selectedIndex, this.buildFeedbackContext());
  }

  handleBackwardNavigationOptionClick(option: Option, index: number): void {
    this.clickService.handleBackwardNavigationOptionClick(this as any, option, index);
  }

  public resetUIForNewQuestion(): void {
    this.orchestrator.runResetUIForNewQuestion(this);
  }

  getOptionBindings(option: Option, idx: number, isSelected: boolean = false): OptionBindings {
    return this.bindingService.getOptionBindings(this as any, option, idx, isSelected);
  }

  public generateOptionBindings(): void {
    this.bindingService.generateOptionBindings(this as any);
  }

  public hydrateOptionsFromSelectionState(): void {
    this.bindingService.hydrateOptionsFromSelectionState(this as any);
  }

  getFeedbackBindings(option: Option, idx: number): FeedbackProps {
    return this.feedbackManager.getFeedbackBindings(option, idx, this.buildFeedbackContext());
  }

  private processOptionBindings(): void {
    this.bindingService.processOptionBindings(this as any);
  }

  initializeOptionBindings(): void {
    this.orchestrator.runInitializeOptionBindings(this);
  }

  initializeFeedbackBindings(): void {
    this.feedbackBindings = this.feedbackManager.initializeFeedbackBindings(
      this.optionBindings, this.buildFeedbackContext()
    );
  }

  private getDefaultFeedbackProps(idx: number): FeedbackProps {
    return this.feedbackManager.getDefaultFeedbackProps(idx, this.buildFeedbackContext());
  }

  isSelectedOption(option: Option): boolean {
    return this.selectedOptionId() === option.optionId;
  }

  ensureOptionIds(): void {
    this.orchestrator.runEnsureOptionIds(this);
  }

  public shouldShowIcon(option: Option, i: number): boolean {
    return this.orchestrator.runShouldShowIcon(this, option, i);
  }

  shouldShowFeedbackFor(b: OptionBindings): boolean {
    const id = b.option.optionId;
    return (
      id === this.lastFeedbackOptionId &&
      !!this.feedbackConfigs[id]?.showFeedback
    );
  }

  public canDisplayOptions(): boolean {
    return this.orchestrator.runCanDisplayOptions(this);
  }

  public markRenderReady(reason: string = ''): void {
    this.orchestrator.runMarkRenderReady(this, reason);
  }

  private regenerateFeedback(idx: number): void {
    this.orchestrator.runRegenerateFeedback(this, idx);
  }

  // Determine relative component logic for Q-type
  private determineQuestionType(input: QuizQuestion): 'single' | 'multiple' {
    return this.clickHandler.determineQuestionType(input);
  }

  private finalizeOptionPopulation(): void {
    this.orchestrator.runFinalizeOptionPopulation(this);
  }

  public forceDisableAllOptions(): void {
    this.bindingService.forceDisableAllOptions(this as any);
  }

  public clearForceDisableAllOptions(): void {
    this.bindingService.clearForceDisableAllOptions(this as any);
  }

  private updateBindingSnapshots(): void {
    this.clickService.updateBindingSnapshots(this as any);
  }


  private syncSelectedFlags(): void {
    this.bindingService.syncSelectedFlags(this as any);
  }

  public applySelectionsUI(selectedOptions: SelectedOption[]): void {
    this.clickService.applySelectionsUI(this as any, selectedOptions);
  }

  isLocked(b: OptionBindings, i: number): boolean {
    return this.optionLockService.isLocked(b, i, this.resolveCurrentQuestionIndex());
  }

  // Single place to decide disabled


  // Use the same key shape everywhere (STRING so we don't lose non-numeric ids)
  // Stable per-row key: prefer numeric optionId; fallback to stableKey + index
  public keyOf(o: Option, i: number): string {
    return this.optionService.keyOf(o, i);
  }

  public shouldShowFeedbackAfter(b: OptionBindings, i: number): boolean {
    if (this._feedbackDisplay !== null && this._feedbackDisplay.idx === i) {
      return true;
    }
    if (this.timerExpiredForQuestion) {
      const key = this.keyOf(b.option, i);
      return !!this.feedbackConfigs[key]?.showFeedback;
    }
    return false;
  }

  public getInlineFeedbackConfig(b: OptionBindings, i: number): FeedbackProps | null {
    return this.bindingService.getInlineFeedbackConfig(this as any, b, i);
  }

  private resolveCurrentQuestionIndex(): number {
    return this.orchestrator.runResolveCurrentQuestionIndex(this);
  }

  private resolveExplanationQuestionIndex(questionIndex: number): number {
    return this.explanationHandler.resolveExplanationQuestionIndex(
        questionIndex, this.getActiveQuestionIndex()
    );
  }

  private getQuestionAtDisplayIndex(displayIndex: number): QuizQuestion | null {
    return this.orchestrator.runGetQuestionAtDisplayIndex(this, displayIndex);
  }

  canShowOptions(): boolean {
    return this.orchestrator.runCanShowOptions(this);
  }

  private normalizeQuestionIndex(candidate: unknown): number | null {
    return this.orchestrator.runNormalizeQuestionIndex(this, candidate);
  }

  private updateResolvedQuestionIndex(candidate: unknown): void {
    this.orchestrator.runUpdateResolvedQuestionIndex(this, candidate);
  }

  public getActiveQuestionIndex(): number {
    return this.orchestrator.runGetActiveQuestionIndex(this);
  }

  public onOptionUI(ev: OptionUIEvent): void {
    this.clickService.onOptionUI(this as any, ev);
  }

  private findBindingByOptionId(optionId: number): { b: OptionBindings; i: number } | null {
    return this.orchestrator.runFindBindingByOptionId(this, optionId);
  }

  private _lastRunClickIndex: number | null = null;
  private _lastRunClickTime: number | null = null;

  private runOptionContentClick(binding: OptionBindings, index: number, event: any): void {
    this.clickService.runOptionContentClick(this as any, binding, index, event);
  }

  public triggerViewRefresh(): void {
    this.cdRef.markForCheck();
  }
}