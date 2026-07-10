import { QuizQuestion } from './QuizQuestion.model';

export type QuizDifficulty = 'beginner' | 'intermediate' | 'advanced';

export interface Quiz {
  quizId: string;
  milestone: string;
  summary: string;
  image: string;
  difficulty?: QuizDifficulty;
  facts?: string[];
  questions?: QuizQuestion[];
  shuffleOptions?: boolean;
  status?: string;
}
