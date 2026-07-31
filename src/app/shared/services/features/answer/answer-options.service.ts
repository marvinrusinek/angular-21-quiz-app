import { Service } from '@angular/core';

import { QuestionType } from '../../../../shared/models/question-type.enum';

import { Option } from '../../../../shared/models/Option.model';
import { QuizQuestion } from '../../../../shared/models/QuizQuestion.model';

import { isOptionCorrect } from '../../../../shared/utils/is-option-correct';

@Service()
export class AnswerOptionsService {
  getEffectiveOptionId(option: any, index: number): number {
    return option?.optionId != null && option.optionId !== -1
      ? option.optionId : index;
  }

  isCorrectOptionValue(option: any): boolean {
    return isOptionCorrect(option);
  }

  normalizeOptions(options: Option[]): Option[] {
    return (options ?? []).map((option, index) => ({
      ...option,
      optionId: option.optionId ?? index
    }));
  }

  resolveOptionsSource(
    optionsToDisplay: Option[],
    question: QuizQuestion
  ): Option[] {
    return optionsToDisplay?.length ? optionsToDisplay : question.options;
  }

  isMultipleAnswerQuestion(
    question: QuizQuestion,
    optionsSource: Option[],
    currentType: 'single' | 'multiple'
  ): boolean {
    const correctCount =
      optionsSource?.filter((option: any) =>
        isOptionCorrect(option)
      ).length ?? 0;

    return (
      currentType === 'multiple' ||
      question.type === QuestionType.MultipleAnswer ||
      correctCount > 1
    );
  }

  getQuestionTypeFromOptions(options: Option[]): 'single' | 'multiple' {
    const correctCount =
      options.filter((option: any) =>
        isOptionCorrect(option)
      ).length;

    return correctCount > 1 ? 'multiple' : 'single';
  }
}