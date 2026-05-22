import { inject, Injectable } from '@angular/core';

import { QuestionType } from '../../../../shared/models/question-type.enum';

import { Option } from '../../../../shared/models/Option.model';
import { OptionClickedPayload } from '../../../../shared/models/OptionClickedPayload.model';
import { QuizQuestion } from '../../../../shared/models/QuizQuestion.model';
import { SelectedOption } from '../../../../shared/models/SelectedOption.model';

import { QuizService } from '../../../../shared/services/data/quiz.service';
import { QuizStateService } from '../../../../shared/services/state/quizstate.service';
import { SelectedOptionService } from '../../../../shared/services/state/selectedoption.service';
import { AnswerOptionsService } from './answer-options.service';

@Injectable({ providedIn: 'root' })
export class AnswerSelectionService {
  // ── injects ─────────────────────────────────────────────────────
  private readonly answerOptionsService = inject(AnswerOptionsService);
  private readonly quizService = inject(QuizService);
  private readonly quizStateService = inject(QuizStateService);
  private readonly selectedOptionService = inject(SelectedOptionService);

  buildEnrichedSelectedOption(
    payload: OptionClickedPayload,
    activeQuestionIndex: number,
    optionsToDisplay: Option[]
  ): SelectedOption {
    const rawOption = payload.option;
    const wasChecked = payload.checked ?? true;

    const targetKey = this.answerOptionsService.getEffectiveOptionId(
      rawOption,
      payload.index
    );

    const canonical =
      optionsToDisplay?.find((option: Option, index: number) =>
        this.answerOptionsService.getEffectiveOptionId(option, index) === targetKey
      ) ?? rawOption;

    return {
      ...canonical,
      optionId: targetKey,
      text: canonical.text,
      correct: this.answerOptionsService.isCorrectOptionValue(canonical),
      questionIndex: activeQuestionIndex,
      displayIndex: payload.index,
      selected: wasChecked,
      highlight: wasChecked,
      showIcon: wasChecked
    } as any;
  }

  updateSelectedOptionsArray(
    selectedOptions: SelectedOption[],
    enrichedOption: SelectedOption,
    type: 'single' | 'multiple'
  ): SelectedOption[] {
    if (type === 'single') return [enrichedOption];

    const nextSelections = [...(selectedOptions ?? [])];

    const existingIndex = nextSelections.findIndex((option: any) => {
      const optionIndex = option.displayIndex ?? option.index;

      return (
        this.answerOptionsService.getEffectiveOptionId(option, optionIndex) ===
        enrichedOption.optionId
      );
    });

    if (enrichedOption.selected) {
      if (existingIndex === -1) {
        nextSelections.push(enrichedOption);
      } else {
        nextSelections[existingIndex] = enrichedOption;
      }

      return nextSelections;
    }

    if (existingIndex !== -1) nextSelections.splice(existingIndex, 1);

    return nextSelections;
  }

  syncSelectedOptionService(
    activeQuestionIndex: number,
    enrichedOption: SelectedOption,
    isMultiAnswer: boolean
  ): void {
    this.selectedOptionService.currentQuestionType = !isMultiAnswer
      ? QuestionType.SingleAnswer : QuestionType.MultipleAnswer;

    if (!isMultiAnswer) {
      this.selectedOptionService.setSelectedOptionsForQuestion(
        activeQuestionIndex,
        [enrichedOption]
      );

      return;
    }

    this.selectedOptionService.addOption(activeQuestionIndex, enrichedOption);
  }

  updateQuestionCompletionState(
    questionIndex: number | null,
    question: QuizQuestion
  ): boolean {
    if (questionIndex == null) return false;

    const allSelected =
      this.selectedOptionService.getSelectedOptionsForQuestion(questionIndex);

    return this.selectedOptionService.isQuestionComplete(question, allSelected);
  }

  updateScoringAndAnswerSelectedState(
    activeQuestionIndex: number,
    optionsSource: Option[],
    selectedOptions: SelectedOption[],
    isMultiAnswer: boolean,
    complete: boolean
  ): void {
    if (isMultiAnswer && selectedOptions?.length > 0) {
      const totalCorrectInQuestion =
        optionsSource.filter(option =>
          this.answerOptionsService.isCorrectOptionValue(option)
        ).length;

      const correctSelectedCount =
        selectedOptions.filter(option =>
          this.answerOptionsService.isCorrectOptionValue(option)
        ).length;

      if (
        correctSelectedCount === totalCorrectInQuestion &&
        totalCorrectInQuestion > 0
      ) {
        this.quizService.scoreDirectly(activeQuestionIndex, true, true);
        this.quizStateService.setAnswerSelected(true);
        return;
      }

      this.quizStateService.setAnswerSelected(complete);
      return;
    }

    this.quizStateService.setAnswerSelected(complete);
  }

  updateDotStatus(
    activeQuestionIndex: number,
    enrichedOption: SelectedOption
  ): void {
    if (enrichedOption.selected !== true || activeQuestionIndex == null) return;

    const dotStatus = enrichedOption.correct ? 'correct' : 'wrong';

    this.selectedOptionService.clickConfirmedDotStatus.set(
      activeQuestionIndex,
      dotStatus
    );

    this.selectedOptionService.lastClickedCorrectByQuestion.set(
      activeQuestionIndex,
      !!enrichedOption.correct
    );

    try {
      sessionStorage.setItem('dot_confirmed_' + activeQuestionIndex, dotStatus);
    } catch {}
  }
}