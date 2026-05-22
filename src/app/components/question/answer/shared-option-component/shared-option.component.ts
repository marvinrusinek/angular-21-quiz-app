import {
  AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef,
  DoCheck, effect, HostListener, inject, input, OnDestroy, OnInit, output, signal
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule, MatCheckboxChange } from '@angular/material/checkbox';
import { MatRadioModule, MatRadioChange } from '@angular/material/radio';
import { FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Observable } from 'rxjs';

import { FeedbackProps } from '../../../../shared/models/FeedbackProps.model';
import { Option } from '../../../../shared/models/Option.model';
import { OptionBindings } from '../../../../shared/models/OptionBindings.model';
import { OptionClickedPayload } from '../../../../shared/models/OptionClickedPayload.model';
import { QuizQuestion } from '../../../../shared/models/QuizQuestion.model';
import { SelectedOption } from '../../../../shared/models/SelectedOption.model';
import { SharedOptionConfig } from '../../../../shared/models/SharedOptionConfig.model';

import { QuizService } from '../../../../shared/services/data/quiz.service';
import { SharedOptionExplanationService } from '../../../../shared/services/features/shared-option/shared-option-explanation.service';
import { SharedOptionFeedbackService, FeedbackContext } from '../../../../shared/services/features/shared-option/shared-option-feedback.service';
import { SharedOptionOrchestratorService } from '../../../../shared/services/features/shared-option/shared-option-orchestrator.service';
import { TimerService } from '../../../../shared/services/features/timer/timer.service';
import { OptionClickHandlerService } from '../../../../shared/services/options/engine/option-click-handler.service';
import { OptionSelectionUiService } from '../../../../shared/services/options/engine/option-selection-ui.service';
import { OptionUiContextBuilderService } from '../../../../shared/services/options/engine/option-ui-context-builder.service';
import { OptionUiSyncContext } from '../../../../shared/services/options/engine/option-ui-sync.service';
import { SharedOptionBindingService } from '../../../../shared/services/options/engine/shared-option-binding.service';
import { SharedOptionClickService } from '../../../../shared/services/options/engine/shared-option-click.service';
import { SharedOptionInitService } from '../../../../shared/services/options/engine/shared-option-init.service';
import { OptionLockService } from '../../../../shared/services/options/policy/option-lock.service';
import { OptionService } from '../../../../shared/services/options/view/option.service';
import { SelectedOptionService } from '../../../../shared/services/state/selectedoption.service';
import { SharedOptionStateAdapterService, SharedOptionUiState } from '../../../../shared/services/state/shared-option-state-adapter.service';
import { SoundService } from '../../../../shared/services/ui/sound.service';

import { FeedbackComponent } from '../feedback/feedback.component';
import { OptionItemComponent } from './option-item/option-item.component';
import type { OptionUIEvent } from './option-item/option-item.component';

import { correctAnswerAnim } from '../../../../animations/animations';
import { SharedOptionConfigDirective } from '../../../../directives/shared-option-config.directive';

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
  // ── injects ─────────────────────────────────────────────────────
  private readonly bindingService = inject(SharedOptionBindingService);
  public readonly clickHandler = inject(OptionClickHandlerService);
  public readonly clickService = inject(SharedOptionClickService);
  public readonly explanationHandler = inject(SharedOptionExplanationService);
  public readonly feedbackManager = inject(SharedOptionFeedbackService);
  private readonly initService = inject(SharedOptionInitService);
  private readonly optionLockService = inject(OptionLockService);
  public readonly optionSelectionUiService = inject(OptionSelectionUiService);
  public readonly optionService = inject(OptionService);
  private readonly optionUiContextBuilder = inject(OptionUiContextBuilderService);
  private readonly orchestrator = inject(SharedOptionOrchestratorService);
  public readonly quizService = inject(QuizService);
  private readonly selectedOptionService = inject(SelectedOptionService);
  private readonly sharedOptionStateAdapterService = inject(SharedOptionStateAdapterService);
  public readonly soundService = inject(SoundService);
  private readonly timerService = inject(TimerService);
  public readonly cdRef = inject(ChangeDetectorRef);
  public readonly destroyRef = inject(DestroyRef);
  private readonly fb = inject(FormBuilder);

  // ── outputs ─────────────────────────────────────────────────────
  readonly optionClicked = output<OptionClickedPayload>();
  readonly optionEvent = output<OptionUIEvent>();
  readonly reselectionDetected = output<boolean>();
  readonly explanationUpdate = output<number>();
  readonly renderReadyChange = output<boolean>();
  readonly showExplanationChange = output<boolean>();
  readonly explanationToDisplayChange = output<string>();

  // ── inputs ──────────────────────────────────────────────────────
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
  readonly finalRenderReady$ = input<Observable<boolean> | null>(null);
  readonly questionVersion = input<number>(0);  // increments every time questionIndex changes
  readonly sharedOptionConfig = input<SharedOptionConfig>(undefined as unknown as SharedOptionConfig);

  // ── remaining variables ─────────────────────────────────────────
  // Mutable backing fields (mirrored from inputs and freely written by services)
  readonly currentQuestion = signal<QuizQuestion | null>(null);
  public currentQuestionIndex!: number;
  public optionsToDisplay!: Option[];
  public type: 'single' | 'multiple' = 'single';
  readonly selectedOption = signal<Option | null>(null);
  public showFeedbackForOption!: { [key: string | number]: boolean };
  readonly correctMessage = signal<string>('');
  readonly showFeedback = signal<boolean>(false);
  readonly shouldResetBackground = signal<boolean>(false);
  readonly optionBindings = signal<OptionBindings[]>([]);
  readonly selectedOptionIndex = signal<number | null>(null);
  readonly isNavigatingBackwards = signal<boolean>(false);
  public selectedOptionMap = new Map<number | string, boolean>();
  public perQuestionHistory = new Set<number | string>();
  public ui!: SharedOptionUiState;
  readonly isSelected = signal<boolean>(false);
  feedbackBindings: FeedbackProps[] = [];
  currentFeedbackConfig!: FeedbackProps;
  feedbackConfigs: { [key: string]: FeedbackProps } = {};
  readonly activeFeedbackConfig = signal<FeedbackProps | null>(null);
  // Simple, bulletproof feedback tracker: set synchronously at the end of runOptionContentClick.
  // Bypasses complex service pipeline; cleared on question change.
  // Must be public for template access.
  public _feedbackDisplay: { idx: number; config: FeedbackProps } | null = null;
  selectedOptions: Set<number | string> = new Set();
  clickedOptionIds: Set<number | string> = new Set();
  selectedOptionHistory: (number | string)[] = [];
  // Track CORRECT option clicks per question for timer stop logic
  public correctClicksPerQuestion: Map<number, Set<number>> = new Map();
  // Track DISABLED option IDs per question - persists across binding recreations
  public disabledOptionsPerQuestion: Map<number, Set<number>> = new Map();
  lastFeedbackQuestionIndex = -1;
  lastFeedbackOptionId: number | string = -1;
  lastSelectedOptionId: number | string = -1;
  lastClickedOptionId: number | string | null = null;
  lastClickTimestamp: number | null = null;
  readonly hasUserClicked = signal<boolean>(false);
  readonly freezeOptionBindings = signal<boolean>(false);
  highlightedOptionIds: Set<number | string> = new Set();

  // Counter to force OnPush re-render when disabled state changes
  disableRenderTrigger = 0;

  readonly showOptions = signal<boolean>(false);
  form!: FormGroup;

  readonly renderReady = signal(false);

  // Include disableRenderTrigger to force re-render when disabled state changes
  trackByOptionId = (b: OptionBindings, idx: number) => {
    const idPart = (b.option?.optionId != null && b.option.optionId !== -1) ? b.option.optionId : `idx-${idx}`;
    const questionPart = this.getActiveQuestionIndex();
    return `q${questionPart}_${idPart}_${idx}`;
  };

  public flashDisabledSet = new Set<number>();
  lockedIncorrectOptionIds = new Set<number>();
  readonly forceDisableAll = signal<boolean>(false);
  readonly timerExpiredForQuestion = signal<boolean>(false);  // track timer expiration
  timeoutCorrectOptionKeys = new Set<string>();
  resolvedQuestionIndex: number | null = null;

  _isMultiModeCache: boolean | null = null;
  public _lastHandledIndex: number | null = null;
  public _lastHandledTime: number | null = null;

  // BULLETPROOF feedback tracker: set synchronously in handleOptionClick,
  // NEVER cleared by ngOnChanges/generateOptionBindings/rebuild cycles.
  // Only cleared on question change.
  public _lastClickFeedback: { index: number; config: FeedbackProps; questionIdx: number } | null = null;

  // DURABLE multi-answer selection tracker. Survives binding regeneration.
  // Maps question index → Set of selected display indices.
  // Only cleared on question change (resetStateForNewQuestion / ngOnChanges).
  _multiSelectByQuestion = new Map<number, Set<number>>();
  _correctIndicesByQuestion = new Map<number, number[]>();

  // Flag to prevent the timer-expiry effect from firing more than once per question
  public _timerExpiryHandled = false;

  // Runtime-mutated state used by the orchestrator service. Declared here so
  // the Host type (SharedOptionComponent) sees them; values default to falsy
  // until the orchestrator writes on init.
  readonly viewReady = signal<boolean>(false);
  selectionSub?: import('rxjs').Subscription;
  finalRenderReadySub?: import('rxjs').Subscription;
  lastProcessedQuestionIndex = -1;
  readonly optionBindingsInitialized = signal<boolean>(false);

  _pendingHighlightRAF: number | null = null;

  public _lastRunClickIndex: number | null = null;
  public _lastRunClickTime: number | null = null;

  constructor() {
    this.ui = this.sharedOptionStateAdapterService.createInitialUiState();
    this.form = this.fb.group({
      selectedOptionId: [null, Validators.required]
    });

    // Mirror signal inputs into mutable backing fields. Services elsewhere
    // freely reassign these fields via `host as any`, so we cannot expose
    // the readonly signals directly under those names.
    effect(() => {
      const v = this.currentQuestionInput();
      if (v !== undefined) this.currentQuestion.set(v);
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
          this.timerExpiredForQuestion.set(false);
          this._timerExpiryHandled = false;
          for (const b of this.optionBindings() ?? []) {
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
          // Clear durable per-question click history for the INCOMING
          // question so a 2nd visit doesn't see "all incorrects already
          // clicked" and trigger autoreveal on the very first new click.
          this._multiSelectByQuestion?.delete(v);
          this.selectedOptionHistory = [];
          this.lastFeedbackOptionId = -1;
          this.lastFeedbackQuestionIndex = v;
          this.feedbackConfigs = {};
          this.showFeedbackForOption = {};
          this.showFeedback.set(false);
          this.highlightedOptionIds.clear();
          this.flashDisabledSet.clear();
          this.lockedIncorrectOptionIds.clear();
          this.forceDisableAll.set(false);
          this._feedbackDisplay = null;
          this._lastClickFeedback = null;
          this.activeFeedbackConfig.set(null);
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

          // Narrow microtask scrub — ONLY on actual Q→Q transition (inside
          // this if-block), not on every effect re-fire. Without this gate,
          // the click pipeline's signal writes re-trigger the effect and
          // the scrub wipes the just-clicked option.selected back to false.
          const _perfectMap = (this.quizService as any)?._multiAnswerPerfect as Map<number, boolean> | undefined;
          const _isResolved = this.selectedOptionService.isQuestionLocked?.(v) === true
                              || _perfectMap?.get(v) === true;
          if (!_isResolved) {
            queueMicrotask(() => {
              this._multiSelectByQuestion?.delete(v);
              const current = this.optionBindings() ?? [];
              for (const b of current) {
                if (!b) continue;
                delete (b as any)._timerExpiredStamped;
                delete (b as any)._timerExpiredStampedForIndex;
                delete (b as any)._autoRevealedCorrect;
                // Also clear binding-level cssClasses that drive
                // ngClass — without this the `correct-option` / `selected`
                // classes persist via DOM reuse + OnPush staleness.
                if (b.cssClasses) {
                  delete b.cssClasses['correct-option'];
                  delete b.cssClasses['incorrect-option'];
                }
                b.isSelected = false;
                if (b.option) {
                  delete (b.option as any)._autoRevealedCorrect;
                  // Reset option-level state that persists on shared refs
                  // across navigations — without this, prior-visit clicks
                  // make preserveOptionHighlighting re-render them as
                  // highlighted on revisit.
                  (b.option as any).selected = false;
                  (b.option as any).highlight = false;
                  (b.option as any).showIcon = false;
                }
              }
              // Replace EACH binding object with a fresh spread (not just
              // the array reference) so OnPush option-items see their
              // individual input ref change and re-render. Without this,
              // in-place mutations are invisible to change detection and
              // leftover inline styles + cssClasses persist on DOM-reused
              // elements (mat-checkbox keeps mat-mdc-checkbox-checked, etc.).
              this.optionBindings.set(current.map((b: any) => b ? { ...b } : b));
              this.cdRef.markForCheck();
            });
          }
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
      if (v !== undefined) this.optionBindings.set(v);
    });
    // Auto-show options when bindings are populated. Without this, paths
    // that populate optionBindings without explicitly calling
    // showOptions.set(true) (e.g. dynamic component creation) leave the
    // template gated and options never render.
    effect(() => {
      if (this.optionBindings().length > 0) this.showOptions.set(true);
    });
    effect(() => {
      this.isNavigatingBackwards.set(this.isNavigatingBackwardsInput());
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
      if (!this.optionBindings() || this.optionBindings().length === 0) return;

      const nrm = (t: any) => String(t ?? '').trim().toLowerCase();
      const bindingTexts = this.optionBindings()
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
          if (pqOpts.length !== this.optionBindings().length) continue;
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
      const next = this.optionBindings().map((b: any) => {
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
        this.optionBindings.set(next);
        this.cdRef.markForCheck();
      }
    });

    // Independent timer-expiry watcher: triggers when the timer service
    // authoritatively reports the CURRENT question as expired. Updates
    // bindings via cssClasses so Angular's ngClass paints correctly —
    // no direct DOM manipulation (which bypassed reactive cleanup and
    // left .correct-option leaked on revisited questions).
    effect(() => {
      // Track BOTH signals so the effect re-fires when either changes —
      // but gate on the authoritative expired-index check below.
      const elapsed = this.timerService.elapsedTimeSig();
      const expiredForIdx = this.timerService.expiredForQuestionIndexSig();
      const duration = this.timerService.timePerQuestion;
      const qIdx = this.currentQuestionIndex ?? this.quizService.currentQuestionIndex ?? 0;
      // Authoritative gate: only fire when the timer service explicitly
      // marks THIS question as expired. The old `elapsed >= duration`
      // check could fire on stale elapsed reads during Q→Q transitions,
      // stamping the next question's bindings as expired.
      if (expiredForIdx !== qIdx) return;
      if (!(elapsed > 0 && elapsed >= duration)) return;
      if (this._timerExpiryHandled) return;

      this._timerExpiryHandled = true;
      this.timerExpiredForQuestion.set(true);

      // Get correct answer texts from canonical question data
      const question = this.quizService.questions?.[qIdx] ?? this.currentQuestion();
      const displayOpts = this.optionsToDisplay?.length
        ? this.optionsToDisplay
        : question?.options ?? [];
      const correctTexts = new Set<string>();
      for (const opt of displayOpts) {
        if (opt?.correct === true || String(opt?.correct) === 'true') {
          correctTexts.add(((opt.text as string) || '').trim().toLowerCase());
        }
      }

      // Stamp bindings via cssClasses + new ref so OnPush option-items
      // re-render. ngClass will apply correct-option/incorrect-option
      // classes through the normal Angular pipeline.
      const updated = (this.optionBindings() ?? []).map((b: any) => {
        if (!b) return b;
        const optText = ((b.option?.text as string) || '').trim().toLowerCase();
        const isCorrect = correctTexts.has(optText);
        return {
          ...b,
          cssClasses: {
            ...(b.cssClasses || {}),
            'correct-option': isCorrect,
            'incorrect-option': !isCorrect && !!b.isSelected
          },
          _timerExpiredStamped: true,
          _timerExpiredStampedForIndex: qIdx,
          disabled: true
        };
      });
      this.optionBindings.set(updated);
      this.cdRef.markForCheck();
    });
  }

  ngOnInit(): void {
    this.orchestrator.runOnInit(this);
  }

  ngAfterViewInit(): void {
    this.orchestrator.runAfterViewInit(this);
  }

  ngOnDestroy(): void {
    this.orchestrator.runOnDestroy(this);
  }

  ngDoCheck(): void {
    this.updateBindingSnapshots();
  }

  get isMultiMode(): boolean {
    return this.orchestrator.runIsMultiMode(this);
  }

  @HostListener('window:visibilitychange', [])
  onVisibilityChange(): void {
    this.orchestrator.runOnVisibilityChange(this);
  }

  initializeQuestionIndex(): void {
    this.orchestrator.runInitializeQuestionIndex(this);
  }

  resetStateForNewQuestion(): void {
    this.initService.resetStateForNewQuestion(this as any);
  }

  subscribeToTimerExpiration(): void {
    this.initService.subscribeToTimerExpiration(this as any);
  }

  setupFallbackRendering(): void {
    this.initService.setupFallbackRendering(this as any);
  }

  initializeConfiguration(): void {
    this.initService.initializeConfiguration(this as any);
  }

  initializeOptionDisplayWithFeedback(): void {
    this.initService.initializeOptionDisplayWithFeedback(this as any);
  }

  setupSubscriptions(): void {
    this.initService.setupSubscriptions(this as any);
  }

  subscribeToSelectionChanges(): void {
    this.initService.subscribeToSelectionChanges(this as any);
  }

  public rehydrateUiFromState(reason: string): void {
    this.bindingService.rehydrateUiFromState(this, reason);
  }

  setupRehydrateTriggers(): void {
    this.initService.setupRehydrateTriggers(this as any);
  }

  rebuildShowFeedbackMapFromBindings(): void {
    this.orchestrator.runRebuildShowFeedbackMapFromBindings(this);
  }

  public updateSelections(rawSelectedId: number | string): void {
    this.orchestrator.runUpdateSelections(this, rawSelectedId);
  }

  ensureOptionsToDisplay(): void {
    this.clickService.ensureOptionsToDisplay(this);
  }

  public synchronizeOptionBindings(): void {
    this.bindingService.synchronizeOptionBindings(this);
  }

  buildSharedOptionConfig(b: OptionBindings, i: number): SharedOptionConfig {
    return this.bindingService.buildSharedOptionConfig(this, b, i);
  }

  public getSharedOptionConfig(
      b: OptionBindings,
      i: number
  ): SharedOptionConfig {
    return this.buildSharedOptionConfig(b, i);
  }

  preserveOptionHighlighting(): void {
    this.clickService.preserveOptionHighlighting(this);
  }

  initializeFromConfig(): void {
    this.initService.initializeFromConfig(this as any);
  }

  public setOptionBindingsIfChanged(newOptions: Option[]): void {
    this.bindingService.setOptionBindingsIfChanged(this, newOptions);
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
      binding, index, this.isDisabled(binding, index), this.timerExpiredForQuestion()
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
    this.clickService.updateOptionAndUI(this, optionBinding, index, event, existingCtx);
  }

  updateHighlighting(): void {
    // Moved to OptionItemComponent
  }

  public resolveInteractionType(): 'single' | 'multiple' {
    return this.isMultiMode ? 'multiple' : 'single';
  }

  buildFeedbackContext(): FeedbackContext {
    return this.orchestrator.runBuildFeedbackContext(this);
  }

  public buildOptionUiSyncContext(): OptionUiSyncContext {
    return this.optionUiContextBuilder.fromSharedOptionComponent(this);
  }

  public emitExplanation(questionIndex: number, skipGuard = false): void {
    this.orchestrator.runEmitExplanation(this, questionIndex, skipGuard);
  }

  public resolveDisplayIndex(questionIndex: number): number {
    return this.explanationHandler.resolveDisplayIndex(
        questionIndex,
        () => this.getActiveQuestionIndex(),
        this.currentQuestionIndex,
        this.resolvedQuestionIndex
    );
  }

  public deferHighlightUpdate(callback: () => void): void {
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
    this.clickService.handleBackwardNavigationOptionClick(this, option, index);
  }

  public resetUIForNewQuestion(): void {
    this.orchestrator.runResetUIForNewQuestion(this);
  }

  getOptionBindings(option: Option, idx: number, isSelected: boolean = false): OptionBindings {
    return this.bindingService.getOptionBindings(this, option, idx, isSelected);
  }

  public generateOptionBindings(): void {
    this.bindingService.generateOptionBindings(this);
  }

  public hydrateOptionsFromSelectionState(): void {
    this.bindingService.hydrateOptionsFromSelectionState(this);
  }

  getFeedbackBindings(option: Option, idx: number): FeedbackProps {
    return this.feedbackManager.getFeedbackBindings(option, idx, this.buildFeedbackContext());
  }

  initializeOptionBindings(): void {
    this.orchestrator.runInitializeOptionBindings(this);
  }

  initializeFeedbackBindings(): void {
    this.feedbackBindings = this.feedbackManager.initializeFeedbackBindings(
      this.optionBindings(), this.buildFeedbackContext()
    );
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

  public regenerateFeedback(idx: number): void {
    this.orchestrator.runRegenerateFeedback(this, idx);
  }

  // Determine relative component logic for Q-type
  determineQuestionType(input: QuizQuestion): 'single' | 'multiple' {
    return this.clickHandler.determineQuestionType(input);
  }

  public finalizeOptionPopulation(): void {
    this.orchestrator.runFinalizeOptionPopulation(this);
  }

  public forceDisableAllOptions(): void {
    this.bindingService.forceDisableAllOptions(this);
  }

  public clearForceDisableAllOptions(): void {
    this.bindingService.clearForceDisableAllOptions(this);
  }

  public applySelectionsUI(selectedOptions: SelectedOption[]): void {
    this.clickService.applySelectionsUI(this, selectedOptions);
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
    if (this.timerExpiredForQuestion()) {
      const key = this.keyOf(b.option, i);
      return !!this.feedbackConfigs[key]?.showFeedback;
    }
    return false;
  }

  public getInlineFeedbackConfig(b: OptionBindings, i: number): FeedbackProps | null {
    return this.bindingService.getInlineFeedbackConfig(this, b, i);
  }

  public resolveCurrentQuestionIndex(): number {
    return this.orchestrator.runResolveCurrentQuestionIndex(this);
  }

  getQuestionAtDisplayIndex(displayIndex: number): QuizQuestion | null {
    return this.orchestrator.runGetQuestionAtDisplayIndex(this, displayIndex);
  }

  canShowOptions(): boolean {
    return this.orchestrator.runCanShowOptions(this);
  }

  normalizeQuestionIndex(candidate: unknown): number | null {
    return this.orchestrator.runNormalizeQuestionIndex(this, candidate);
  }

  updateResolvedQuestionIndex(candidate: unknown): void {
    this.orchestrator.runUpdateResolvedQuestionIndex(this, candidate);
  }

  public getActiveQuestionIndex(): number {
    return this.orchestrator.runGetActiveQuestionIndex(this);
  }

  public onOptionUI(ev: OptionUIEvent): void {
    this.clickService.onOptionUI(this, ev);
  }

  public findBindingByOptionId(optionId: number): { b: OptionBindings; i: number } | null {
    return this.orchestrator.runFindBindingByOptionId(this, optionId);
  }

  runOptionContentClick(binding: OptionBindings, index: number, event: any): void {
    this.clickService.runOptionContentClick(this, binding, index, event);
  }

  public triggerViewRefresh(): void {
    this.cdRef.markForCheck();
  }

  private updateBindingSnapshots(): void {
    this.clickService.updateBindingSnapshots(this);
  }
}
