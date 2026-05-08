import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { Option } from '../../models/Option.model';
import { QuizQuestion } from '../../models/QuizQuestion.model';
import { QuizService } from '../data/quiz.service';
import { ExplanationTextService } from '../features/explanation/explanation-text.service';
import { QuizQuestionManagerService } from './quizquestionmgr.service';

export interface NewQuestionResult {
  currentQuestion: QuizQuestion;
  options: Option[];
  currentQuestionType: string | null;
}

/**
 * Manages the "correct answers" text pipeline:
 * determining if a question has multiple answers,
 * computing the "N of M" banner text, and handling
 * new-question transitions for correct-answers display.
 *
 * Extracted from QuizComponent to reduce its size.
 */
@Injectable({ providedIn: 'root' })
export class QuizCorrectAnswersService {

  constructor(
    private quizQuestionManagerService: QuizQuestionManagerService,
    private quizService: QuizService,
    private explanationTextService: ExplanationTextService
  ) {}

  async isMultipleAnswer(question: QuizQuestion): Promise<boolean> {
    return await firstValueFrom(
      this.quizQuestionManagerService.isMultipleAnswerQuestion(question)
    );
  }

  getCorrectAnswersText(options: Option[]): string {
    const numCorrectAnswers =
      this.quizQuestionManagerService.calculateNumberOfCorrectAnswers(options);
    const totalOptions = Array.isArray(options) ? options.length : 0;

    return this.quizQuestionManagerService.getNumberOfCorrectAnswersText(
      numCorrectAnswers,
      totalOptions
    );
  }

  async updateCorrectAnswersText(
    question: QuizQuestion,
    options: Option[]
  ): Promise<string> {
    try {
      const [multipleAnswers] = await Promise.all([
        this.isMultipleAnswer(question),
        this.explanationTextService.isExplanationTextDisplayedSig()
      ]);

      const correctAnswersText = multipleAnswers
        ? this.getCorrectAnswersText(options) : '';

      this.quizService.updateCorrectAnswersText('');
      return correctAnswersText;
    } catch (error: any) {
      this.quizService.updateCorrectAnswersText('');
      return '';
    }
  }

  async handleNewQuestion(question: QuizQuestion): Promise<NewQuestionResult> {
    const options = question.options || [];
    const currentQuestionType = question.type ?? null;
    await this.updateCorrectAnswersText(question, options);
    return { currentQuestion: question, options, currentQuestionType };
  }

  resetCurrentQuestionState(): void {
    this.quizService.updateCorrectAnswersText('');
  }
}