import { QuizDifficulty } from './Quiz.model';

// Interview Mode layers a 'mixed' selection on top of the real per-quiz
// difficulty values ('beginner' | 'intermediate' | 'advanced'). 'mixed' is an
// Interview-only concept — it is NOT a value present in quiz.json.
export type InterviewDifficulty = QuizDifficulty | 'mixed';

// The allowed question counts. Duration is derived, never chosen (see
// DURATION_SECONDS_BY_COUNT), so v1 exposes no timer-duration selector.
export type AssessmentQuestionCount = 10 | 20 | 30;

// A reusable, UI-agnostic description of the assessment to build. The
// AssessmentBuilder answers "given this config, which questions?" — nothing
// about how the interview behaves lives here.
export interface AssessmentConfig {
  difficulty: InterviewDifficulty;
  topicIds: string[];                     // source quizIds (topics)
  questionCount: AssessmentQuestionCount;
}

// question count → total interview seconds (10→15m, 20→30m, 30→45m).
export const DURATION_SECONDS_BY_COUNT: Record<AssessmentQuestionCount, number> = {
  10: 15 * 60,
  20: 30 * 60,
  30: 45 * 60
};
