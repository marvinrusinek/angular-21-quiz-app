import { Signal } from '@angular/core';

export interface QuizMetadata {
  totalQuestions: number;
  totalQuestionsAttempted: number;
  percentage: number;
  correctAnswersCount: Signal<number>;
  completionTime: number;
}
