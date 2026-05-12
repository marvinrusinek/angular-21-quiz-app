import {
  AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, effect,
  input, model, OnInit, output, QueryList, ViewContainerRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { Option } from '../../../../shared/models/Option.model';
import { OptionBindings } from '../../../../shared/models/OptionBindings.model';
import { OptionClickedPayload } from '../../../../shared/models/OptionClickedPayload.model';
import { QuizQuestion } from '../../../../shared/models/QuizQuestion.model';
import { SelectedOption } from '../../../../shared/models/SelectedOption.model';
import { SharedOptionConfig } from '../../../../shared/models/SharedOptionConfig.model';
import { AnswerOptionsService } from '../../../../shared/services/features/answer/answer-options.service';
import { AnswerSelectionService } from '../../../../shared/services/features/answer/answer-selection.service';
import { AnswerBindingsService } from '../../../../shared/services/features/answer/answer-bindings.service';
import { DynamicComponentService } from '../../../../shared/services/ui/dynamic-component.service';
import { FeedbackService } from '../../../../shared/services/features/feedback/feedback.service';
import { QuizService } from '../../../../shared/services/data/quiz.service';
import { QqcQuestionLoaderService } from '../../../../shared/services/features/qqc/qqc-question-loader.service';
import { QuizQuestionManagerService } from '../../../../shared/services/flow/quizquestionmgr.service';
import { QuizStateService } from '../../../../shared/services/state/quizstate.service';
import { SelectedOptionService } from '../../../../shared/services/state/selectedoption.service';
import { SharedOptionComponent } from '../shared-option-component/shared-option.component';
import { BaseQuestion } from '../../base/base-question';

@Component({
  selector: 'codelab-question-answer',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, SharedOptionComponent],
  templateUrl: './answer.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AnswerComponent extends BaseQuestion<OptionClickedPayload>
  implements OnInit, AfterViewInit {

  viewContainerRefs!: QueryList<ViewContainerRef>;
  viewContainerRef!: ViewContainerRef;

  readonly componentLoaded = output<any>();
  readonly optionSelected = output<{
    option: SelectedOption,
    index: number,
    checked: boolean
  }>();
  readonly questionData = model<QuizQuestion>(undefined as unknown as QuizQuestion);
  readonly isNavigatingBackwards = input<boolean>(false);
  readonly currentQuestionIndex = model<number>(undefined as unknown as number);
  readonly quizId = input<string>(undefined as unknown as string);
  readonly form = input<FormGroup>(undefined as unknown as FormGroup);
  private optionBindingsSource: Option[] = [];
  override showFeedbackForOption: { [optionId: number]: boolean } = {};
  override selectedOption: SelectedOption | null = null;
  selectedOptions: SelectedOption[] = [];
  incomingOptions: Option[] = [];
  override sharedOptionConfig!: SharedOptionConfig;
  hasComponentLoaded = false;

  override selectedOptionIndex = -1;
  renderReady = false;

  readonly quizQuestionComponentLoaded = output<void>();

  private destroy$ = new Subject<void>();

  readonly questionIndex = input<number | null>(null);

  constructor(
    protected quizQuestionLoaderService: QqcQuestionLoaderService,
    protected quizQuestionManagerService: QuizQuestionManagerService,
    public override dynamicComponentService: DynamicComponentService,
    public override feedbackService: FeedbackService,
    public override quizService: QuizService,
    public override quizStateService: QuizStateService,
    public override selectedOptionService: SelectedOptionService,
    private answerOptionsService: AnswerOptionsService,
    private answerSelectionService: AnswerSelectionService,
    private answerBindingsService: AnswerBindingsService,
    public override fb: FormBuilder,
    public override cdRef: ChangeDetectorRef
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

    // React to signal-input updates from the dynamic loader (replaces ngOnChanges)
    effect(() => {
      const q = this.questionData();
      if (q) {
        const correctCount = q.options?.filter((o: Option) => o.correct).length ?? 0;
        this.type.set(correctCount > 1 ? 'multiple' : 'single');
      }
      this.cdRef.markForCheck();
    });

    effect(() => {
      const next = this.optionsToDisplay();
      if (Array.isArray(next) && next.length) {
        // Skip rebuild if the option set is the same as the current bindings
        // (e.g. parent re-emit after a click). Rebuilding here would wipe
        // the highlight state we just set in onOptionClicked.
        const currentBindings = this.optionBindings();
        const sameSet =
          currentBindings?.length === next.length &&
          currentBindings.every((b, i) => {
            const a = b.option;
            const n = next[i];
            return !!a?.text && a.text === n?.text;
          });
        if (sameSet) {
          this.cdRef.markForCheck();
          return;
        }
        this.optionBindingsSource = next.map((o: Option) => ({
          ...o,
          selected: false,
          highlight: false,
          showIcon: false,
          feedback: undefined
        }));
        this.optionBindings.set(this.rebuildOptionBindings(this.optionBindingsSource));
        this.renderReady = true;
        this.syncOptionsWithSelections();
        this.cdRef.markForCheck();
      } else {
        this.optionBindingsSource = [];
        this.optionBindings.set([]);
      }
    });
  }

  override async ngOnInit(): Promise<void> {
    await this.initializeAnswerConfig();
    await this.initializeSharedOptionConfig();

    // Guard against the first render missing its options because the
    // options stream may not have emitted yet when the template binds.
    if (this.optionsToDisplay()?.length) {
      this.applyIncomingOptions(this.optionsToDisplay());
    }

    this.quizService.getCurrentQuestion(this.quizService.currentQuestionIndex)
      .pipe(takeUntil(this.destroy$))
      .subscribe((currentQuestion: QuizQuestion | null) => {
        if (!currentQuestion) return;

        // ROBUST MULTI-ANSWER CHECK
        const opts = currentQuestion.options || [];
        const correctCount = opts.filter(o =>
          o.correct === true || (o as any).correct === 'true' || (o as any).correct === 1
        ).length;

        this.type.set(correctCount > 1 ? 'multiple' : 'single');

        if (!this.hasComponentLoaded) {
          this.hasComponentLoaded = true;
          this.syncOptionsWithSelections();
          this.quizQuestionComponentLoaded.emit();
        }
        this.cdRef.markForCheck();
      });

    // Displays the unique options to the UI
    this.quizQuestionLoaderService.optionsStream$
      .pipe(takeUntil(this.destroy$))
      .subscribe((opts: Option[]) => {
        // Skip empty arrays to prevent BehaviorSubject initial emission
        // from clearing valid options that may have arrived via @Input
        if (!opts?.length) return;

        // Sync currentQuestionIndex + questionData with quizService on every
        // Q->Q emission. Without this, the dynamic AnswerComponent's
        // currentQuestionIndex stays at its init value (0) and questionData
        // stays at Q1's value (set once in configureDynamicInstance during
        // dynamic load). SOC mirrors questionData -> currentQuestion, so a
        // stale questionData makes pristine lookups (by questionText) target
        // Q1's data while the bindings are Q2's, returning the wrong
        // correctIndices and flipping the 2nd-correct click to sad.
        const svcIdx = this.quizService.currentQuestionIndex;
        if (typeof svcIdx === 'number' && Number.isFinite(svcIdx)) {
          this.currentQuestionIndex.set(svcIdx);
        }
        const liveQ = this.quizService.questions?.[svcIdx];
        if (liveQ) {
          this.questionData.set({ ...liveQ, options: opts });
          this.question.set({ ...liveQ });
        }

        this.incomingOptions = this.answerOptionsService.normalizeOptions(
          structuredClone(opts)
        );

        //  Clear prior icons and bindings (clean slate)
        this.optionBindings.set([]);
        this.renderReady = false;

        // Apply options synchronously (removed Promise.resolve to fix StackBlitz timing)
        this.applyIncomingOptions(this.incomingOptions, {
          resetSelection: false
        });
      });
  }

  ngAfterViewInit(): void {
    if (this.viewContainerRefs) {
      this.viewContainerRefs?.changes.subscribe(() => {
        this.handleViewContainerRef();
      });
    } else {
      // viewContainerRefs not initialized
    }

    this.cdRef.detectChanges();  // ensure change detection runs
  }

  override ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private resetSelectionState(): void {
    this.selectedOption = null;
    this.selectedOptions = [];
    this.selectedOptionIndex = -1;
    this.showFeedbackForOption = {};
  }

  private applyIncomingOptions(
    options: Option[],
    config: { resetSelection?: boolean } = {}
  ): void {
    const normalized = this.answerOptionsService.normalizeOptions(options);
    const nextOptions = normalized.map((option: Option) => ({
      ...option,
      selected: false,
      highlight: false,
      showIcon: false,
      feedback: undefined
    }));

    if (config.resetSelection ?? true) this.resetSelectionState();

    // Recalculate type from the incoming options' correct flags.
    // Without this, navigating from a multi-answer question (e.g. Q4) to a
    // single-answer question (e.g. Q5) would leave type='multiple', causing
    // SOC to render checkboxes and use multi-answer interaction logic.
    const correctCount =
      nextOptions.filter(o =>
        o.correct === true || (o as any).correct === 'true' || (o as any).correct === 1
    ).length;
    this.type.set(correctCount > 1 ? 'multiple' : 'single');

    this.optionsToDisplay.set(nextOptions);
    this.optionBindingsSource =
      nextOptions.map((option) => ({ ...option }));

    if (this.sharedOptionConfig) {
      this.sharedOptionConfig = {
        ...this.sharedOptionConfig,
        type: this.type(),
        optionsToDisplay: nextOptions.map((option: Option) => ({ ...option }))
      };
    }

    this.optionBindings.set(this.rebuildOptionBindings(this.optionBindingsSource));
    this.renderReady = true;
    this.syncOptionsWithSelections();
    this.cdRef.markForCheck();
  }

  /**
   * Hydrates the local 'optionsToDisplay' or Input options with state 
   * from the SelectedOptionService.
   */
  private syncOptionsWithSelections(): void {
    const index = this.currentQuestionIndex();
  
    if (index === null || index === undefined || index < 0) return;
  
    const savedSelections =
      this.selectedOptionService.getSelectedOptionsForQuestion(index) ?? [];
  
    if (!savedSelections.length || !this.optionsToDisplay()?.length) return;
  
    const isMulti = this.type() === 'multiple';
  
    for (const option of this.optionsToDisplay()) {
      if (isMulti) {
        option.selected = false;
        continue;
      }
  
      const savedIds = new Set(savedSelections.map(selection => String(selection.optionId)));
  
      const savedTexts = new Set(
        savedSelections.map(selection =>
          (selection.text || '').trim().toLowerCase(),
        )
      );
  
      const idMatch =
        option.optionId != null && savedIds.has(String(option.optionId));
  
      const textMatch =
        !!(option.text && savedTexts.has(option.text.trim().toLowerCase()));
  
      option.selected = idMatch || textMatch;
    }
  
    const updatedBindings =
      this.answerBindingsService.hydrateBindingsFromSavedSelections(
        this.optionBindings(),
        savedSelections,
        isMulti
      );
  
    this.optionBindings.set(updatedBindings);
  
    if (this.type() === 'single' && this.form()) {
      const selectedId = savedSelections[0]?.optionId;
  
      if (selectedId != null) {
        this.form().patchValue(
          { selectedOptionId: selectedId },
          { emitEvent: false }
        );
      }
    }
  }

  private handleViewContainerRef(): void {
    if (this.hasComponentLoaded) return;

    if (this.viewContainerRefs && this.viewContainerRefs.length > 0) {
      // Assign the first available ViewContainerRef
      this.viewContainerRef = this.viewContainerRefs.first;
      this.loadQuizQuestionComponent();
      this.hasComponentLoaded = true;  // prevent further attempts to load
    }
  }

  private loadQuizQuestionComponent(): void {
    if (this.hasComponentLoaded) return;

    // Ensure that the current component container is cleared before loading a new one
    if (this.viewContainerRef) {
      this.viewContainerRef.clear();
    } else {
      return;
    }

    // Get the current question and determine the component to load
    this.quizService.getCurrentQuestion(this.quizService.currentQuestionIndex)
      .subscribe((currentQuestion: QuizQuestion | null) => {
        if (!currentQuestion) return;
        const isMultipleAnswer =
          this.quizQuestionManagerService.isMultipleAnswerQuestion(currentQuestion);

        if (isMultipleAnswer) {
          this.type.set(isMultipleAnswer ? 'multiple' : 'single');
          this.hasComponentLoaded = true;  // prevent further attempts to load
          this.quizQuestionComponentLoaded.emit();  // notify listeners that component is loaded
          this.cdRef.markForCheck();
        } else {
          // could not determine whether question is multiple answer
        }
      });
  }

  private async initializeAnswerConfig(): Promise<void> {
    if (!this.sharedOptionConfig) await this.initializeSharedOptionConfig();

    if (this.sharedOptionConfig) {
      this.sharedOptionConfig.type = this.type();
    } else {
      // failed to initialize sharedOptionConfig
    }
  }

  public override async initializeSharedOptionConfig(): Promise<void> {
    await super.initializeSharedOptionConfig();
    if (this.sharedOptionConfig) {
      this.sharedOptionConfig.type = this.type();
    }
  }

  public override async onOptionClicked(
    payload: OptionClickedPayload,
  ): Promise<void> {
    if (!payload || !payload.option) return;
  
    const activeQuestionIndex = this.getActiveQuestionIndex();
  
    const enrichedOption =
      this.answerSelectionService.buildEnrichedSelectedOption(
        payload,
        activeQuestionIndex,
        this.optionsToDisplay()
      );
  
    this.selectedOption = enrichedOption;
  
    this.selectedOptions =
      this.answerSelectionService.updateSelectedOptionsArray(
        this.selectedOptions,
        enrichedOption,
        this.type()
      );
  
    const question = this.resolveQuestion(activeQuestionIndex);
  
    if (!question) return;
  
    const optionsSource =
      this.answerOptionsService.resolveOptionsSource(
        this.optionsToDisplay(),
        question
      );
  
    const isMultiAnswer =
      this.answerOptionsService.isMultipleAnswerQuestion(
        question,
        optionsSource,
        this.type()
      );
  
    this.answerSelectionService.syncSelectedOptionService(
      activeQuestionIndex,
      enrichedOption,
      isMultiAnswer
    );
  
    const complete =
      this.answerSelectionService.updateQuestionCompletionState(
        this.questionIndex(),
        question
      );
  
    this.answerSelectionService.updateScoringAndAnswerSelectedState(
      activeQuestionIndex,
      optionsSource,
      this.selectedOptions,
      isMultiAnswer,
      complete
    );
  
    const updatedBindings =
      this.answerBindingsService.updateVisualBindings(
        this.optionBindings(),
        enrichedOption,
        this.type()
      );
  
    this.optionBindings.set(updatedBindings);
    this.cdRef.markForCheck();
  
    this.answerSelectionService.updateDotStatus(
      activeQuestionIndex,
      enrichedOption
    );
  
    this.emitCleanOptionClickedPayload(payload, enrichedOption);
  }

  private getActiveQuestionIndex(): number {
    return typeof this.currentQuestionIndex() === 'number'
      ? this.currentQuestionIndex()
      : 0;
  }
  
  private resolveQuestion(activeQuestionIndex: number): QuizQuestion | undefined {
    const serviceQuestion = this.quizService.questions?.[activeQuestionIndex];
    const question = serviceQuestion ?? this.questionData();
  
    if (!question) {
      console.warn(
        '[AnswerComponent] No question available for active index:',
        activeQuestionIndex
      );
  
      return undefined;
    }
  
    if (!serviceQuestion) {
      console.warn(
        '[AnswerComponent] Falling back to questionData() because quizService.questions did not contain question at index:',
        activeQuestionIndex
      );
    }
  
    return question;
  }

  private emitCleanOptionClickedPayload(
    originalPayload: OptionClickedPayload,
    enrichedOption: SelectedOption,
  ): void {
    const cleanPayload: OptionClickedPayload = {
      option: enrichedOption,
      index: originalPayload.index,
      checked: enrichedOption.selected === true,
      wasReselected: originalPayload.wasReselected ?? false
    };
  
    this.optionClicked.emit(cleanPayload);
  }


  // Rebuild optionBindings from the latest optionsToDisplay.
  private rebuildOptionBindings(options: Option[]): OptionBindings[] {
    const rebuilt = this.answerBindingsService.rebuildOptionBindings(options);
  
    this.optionBindings.set(rebuilt);
    this.renderReady = true;
  
    requestAnimationFrame(() => {
      this.cdRef.markForCheck();
    });
  
    return rebuilt;
  }

  override async loadDynamicComponent(
    _question: QuizQuestion,
    _options: Option[],
    _questionIndex: number
  ): Promise<void> {
    // AnswerComponent doesn't load dynamic children, so we
    // simply fulfill the contract and return a resolved promise.
    return;
    // If the base implementation does something essential, call:
    // return super.loadDynamicComponent(_question, _options, _questionIndex);
  }
}