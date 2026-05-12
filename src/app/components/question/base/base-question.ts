import { ChangeDetectorRef, Directive, input, model, OnDestroy,
  OnInit, output } from '@angular/core';
import { FormBuilder, FormControl, FormGroup } from '@angular/forms';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';

import { Option } from '../../../shared/models/Option.model';
import { OptionBindings } from '../../../shared/models/OptionBindings.model';
import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';
import { SelectedOption } from '../../../shared/models/SelectedOption.model';
import { SharedOptionConfig } from '../../../shared/models/SharedOptionConfig.model';
import { DynamicComponentService } from '../../../shared/services/ui/dynamic-component.service';
import { FeedbackService } from '../../../shared/services/features/feedback/feedback.service';
import { QuizService } from '../../../shared/services/data/quiz.service';
import { QuizStateService } from '../../../shared/services/state/quizstate.service';
import { SelectedOptionService } from '../../../shared/services/state/selectedoption.service';

/** Event payload emitted when an option is clicked */
export interface OptionClickEvent {
  option: SelectedOption | null,
  index: number,
  checked?: boolean
}

@Directive()
export abstract class BaseQuestion<T extends OptionClickEvent =
  OptionClickEvent> implements OnInit, OnDestroy
{
  readonly optionClicked = output<T>();
  readonly questionChange = output<QuizQuestion>();
  readonly explanationToDisplayChange = output<any>();
  readonly correctMessageChange = output<string>();

  readonly quizQuestionComponentOnOptionClicked = input<(option: SelectedOption, index: number) => void>(undefined as unknown as (option: SelectedOption, index: number) => void);
  readonly question = model<QuizQuestion | null>(null);
  readonly optionsToDisplay = model<Option[]>([]);
  readonly correctMessage = model<string>('');
  readonly feedback = input<string>('');
  readonly showFeedback = model<boolean>(false);
  readonly shouldResetBackground = input<boolean>(false);
  readonly type = model<'single' | 'multiple'>('single');
  readonly config = input<SharedOptionConfig>(undefined as unknown as SharedOptionConfig);
  sharedOptionConfig: SharedOptionConfig | null = null;
  currentQuestionSubscription!: Subscription;
  readonly explanationToDisplay = model<string | null>(null);
  questionForm!: FormGroup;
  selectedOption: SelectedOption | null = null;
  selectedOptionId: number | null = null;
  selectedOptionIndex: number | null = null;
  showFeedbackForOption: { [optionId: number]: boolean } = {};
  readonly optionBindings = model<OptionBindings[]>([]);
  optionsInitialized = false;
  containerInitialized = false;

  protected constructor(
    public fb: FormBuilder,
    public dynamicComponentService: DynamicComponentService,
    public feedbackService: FeedbackService,
    public quizService: QuizService,
    public quizStateService: QuizStateService,
    public selectedOptionService: SelectedOptionService,
    public cdRef: ChangeDetectorRef
  ) {}

  async ngOnInit(): Promise<void> {
    this.initializeQuestionIfAvailable();
    await this.initializeSharedOptionConfig();
    this.subscribeToQuestionChanges();
  }

  ngOnDestroy(): void {
    this.currentQuestionSubscription?.unsubscribe();
  }

  private updateSelectedOption(index: number): void {
    this.selectedOptionIndex = index;
    this.showFeedback.set(true);
  }

  protected initializeQuestion(): void {
    try {
      const qqc = (this as any).quizQuestionComponent ??
        (this as any)._quizQuestionComponent;
      qqc?._fetEarlyShown?.clear();
    } catch (err: any) {
    }

    if (this.question() && Array.isArray(this.question()!.options) && this.question()!.options.length > 0) {
      this.initializeOptions();
      this.optionsInitialized = true;
      this.questionChange.emit(this.question()!);
    } else {
      // question input is invalid or missing options
    }
  }

  private initializeQuestionIfAvailable(): void {
    if (this.question() && Array.isArray(this.question()!.options) &&
      this.question()!.options.length > 0) {
      this.setCurrentQuestion(this.question()!);
      this.initializeQuestion();
    }
  }

  protected initializeOptions(): void {
    if (!this.question()?.options?.length) return;

    // Only initialize form if not yet created
    if (!this.questionForm) {
      this.questionForm = new FormGroup({});
      for (const option of this.question()!.options) {
        const controlName = `option_${option.optionId}`;  // stable and unique
        if (!this.questionForm.contains(controlName)) {
          this.questionForm.addControl(controlName, new FormControl(false));
        }
      }
    }

    // Don't overwrite optionsToDisplay if it's already populated from @Input()
    // The parent passes the correct shuffled options via [optionsToDisplay] binding.
    // Overwriting with this.question().options could use unshuffled data from a different source.
    if (!this.optionsToDisplay() || this.optionsToDisplay().length === 0) {
      this.optionsToDisplay.set([...this.question()!.options]);
    }
  }

  public async initializeSharedOptionConfig(options?: Option[]): Promise<void> {
    if (
      !this.question() ||
      !Array.isArray(this.question()!.options) ||
      this.question()!.options.length === 0
    ) return;

    const clonedOptions = (options ?? this.question()!.options ?? []).map((opt, idx) => ({
      ...opt,
      optionId: opt.optionId ?? idx,
      correct: opt.correct ?? false,
      feedback: opt.feedback
    }));

    this.sharedOptionConfig = {
      ...this.getDefaultSharedOptionConfig(),
      type: this.type(), // use the actual type (which might be 'multiple') to configure Option behavior
      optionsToDisplay: clonedOptions,
      currentQuestion: { ...this.question()! } as QuizQuestion,
      shouldResetBackground: this.shouldResetBackground() || false,
      selectedOption: this.selectedOption || null,
      showFeedbackForOption: { ...this.showFeedbackForOption },
      showFeedback: this.showFeedback() || false,
      correctMessage: this.correctMessage() || '',
      isOptionSelected: false,
      selectedOptionIndex: -1,
      isAnswerCorrect: false,
      feedback: this.feedback() || '',
      highlightCorrectAfterIncorrect: false
    };
  }

  getDefaultSharedOptionConfig(): SharedOptionConfig {
    return {
      option: null as unknown as Option,
      optionsToDisplay: [],
      type: 'single',
      shouldResetBackground: false,
      selectedOption: null,
      showFeedbackForOption: {},
      currentQuestion: {} as QuizQuestion,
      showFeedback: false,
      correctMessage: '',
      isOptionSelected: false,
      selectedOptionIndex: -1,
      isAnswerCorrect: false,
      feedback: '',
      highlightCorrectAfterIncorrect: false,
      showCorrectMessage: false,
      explanationText: '',
      showExplanation: false,
      idx: 0
    };
  }

  protected subscribeToQuestionChanges(): void {
    if (!this.quizStateService) return;

    const currentQuestion$ = this.quizStateService.currentQuestion$;
    if (!currentQuestion$) return;

    // Subscribe to `currentQuestion$` with filtering to skip undefined values
    this.currentQuestionSubscription = currentQuestion$
      .pipe(
        // Filter out undefined or option-less emissions
        filter((quizQuestion): quizQuestion is QuizQuestion => {
          // Guard against undefined values
          if (!quizQuestion) return false;

          // Guard against questions that don’t yet have options
          const hasOptions = !!quizQuestion.options?.length;
          return hasOptions;
        })
      )
      .subscribe({
        next: (quizQuestion: QuizQuestion) => {
          this.question.set(quizQuestion);
          this.initializeOptions();
        },
        error: () => { }
      });
  }

  protected abstract loadDynamicComponent(
    question: QuizQuestion,
    options: Option[],
    questionIndex: number
  ): Promise<void>;

  public async onOptionClicked(event: {
    option: SelectedOption;
    index: number;
    checked: boolean;
  }): Promise<void> {
    const { option, index, checked } = event;

    // Ensure the selected option is updated
    this.updateSelectedOption(index);

    if (!this.sharedOptionConfig) await this.initializeSharedOptionConfig();
    if (!this.sharedOptionConfig) return;

    try {
      // Always show feedback when an option is clicked
      this.showFeedback.set(true);

      // For single-selection type questions
      if (this.type() === 'single') {
        // Deselect all other options
        for (const opt of this.optionsToDisplay()) {
          opt.selected = opt === option;
          if (opt.optionId) this.showFeedbackForOption[opt.optionId] = false;
        }
      } else {
        // For multiple-selection type questions, toggle the clicked option
        option.selected = checked;
      }

      this.sharedOptionConfig.selectedOption = option;

      // Ensure showFeedbackForOption is initialized and cleared (mutate)
      if (!this.showFeedbackForOption) this.showFeedbackForOption = {};
      for (const k of Object.keys(this.showFeedbackForOption)) {
        delete (this.showFeedbackForOption as any)[k];
      }

      if (option.optionId != null) {
        this.showFeedbackForOption[option.optionId] = true;
      }

      this.selectedOption = option;

      // Update the correct message for the question
      this.updateCorrectMessageForQuestion();

      // Trigger change detection to update the UI
      this.cdRef.detectChanges();
    } catch (error: any) {
      // error handled silently
    }
  }

  updateCorrectMessageForQuestion(): void {
    this.correctMessage.set(
      this.feedbackService.setCorrectMessage(this.optionsToDisplay())
    );
    this.correctMessageChange.emit(this.correctMessage());
    this.cdRef.detectChanges();
  }

  protected setCurrentQuestion(question: QuizQuestion): void {
    if (this.quizStateService) this.quizService.setCurrentQuestion(question);
  }

}