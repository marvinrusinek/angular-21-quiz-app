import { AssessmentConfig } from './AssessmentConfig.model';
import { QuizQuestion } from './QuizQuestion.model';

// A temporary, in-memory assessment produced by the AssessmentBuilder. It is
// NEVER written back into the topic-quiz catalog and its `id` is synthetic
// (e.g. 'interview-1') — never a catalog quizId. Each question is a deep clone
// with its answer state reset and its `sourceQuizId` stamped.
export interface GeneratedAssessment {
  id: string;
  title: string;
  questions: QuizQuestion[];
  config: AssessmentConfig;
  durationSeconds: number;
}
