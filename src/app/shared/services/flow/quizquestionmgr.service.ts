import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';

@Injectable({ providedIn: 'root' })
export class QuizQuestionManagerService {
  getNumberOfCorrectAnswersText(
    numberOfCorrectAnswers: number | undefined,
    totalOptions: number | undefined,
  ): string {
    if ((numberOfCorrectAnswers ?? 0) === 0) return 'No correct answers';

    if (!totalOptions || totalOptions <= 0) {
      return numberOfCorrectAnswers === 1
        ? '(1 answer is correct)'
        : `(${numberOfCorrectAnswers} answers are correct)`;
    }

    const pluralSuffix =
      numberOfCorrectAnswers === 1 ? 'answer is' : 'answers are';
    return `(${numberOfCorrectAnswers} ${pluralSuffix} correct)`;
  }

  calculateNumberOfCorrectAnswers(options: Option[]): number {
    const validOptions = options ?? [];
    return validOptions.reduce(
      (count, option) => count + (option.correct ? 1 : 0), 0
    );
  }

  public isMultipleAnswerQuestion(question: QuizQuestion): Observable<boolean> {
    return of(this.isMultipleAnswerQuestionSync(question));
  }

  private isMultipleAnswerQuestionSync(question: QuizQuestion): boolean {
    try {
      if (question && Array.isArray(question.options)) {
        const correctAnswersCount = question.options.filter(
          (option) => option.correct,
        ).length;
        return correctAnswersCount > 1;
      }
      return false;
    } catch (error: any) {
      return false;
    }
  }

  isValidQuestionData(questionData: QuizQuestion): boolean {
    return !!questionData && !!questionData.explanation;
  }
}