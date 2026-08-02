import type { QuizRepository } from './quiz/quiz.repository';
import type { SessionRepository } from './interview/session.repository';
import type { InterviewSessionService } from './interview/session.service';

/**
 * Everything the HTTP layer needs, passed in explicitly.
 *
 * No module-global singleton: the repository holds the answer key, and hidden
 * global state is both hard to isolate in tests and easy to reach from code
 * that has no business touching it. Tests build an app with a fixture
 * repository; production builds one from the private file before listening.
 */
export interface AppDependencies {
  readonly quizRepository: QuizRepository;
  /** Wired in server.ts so database lifecycle never leaks into route code. */
  readonly sessionRepository?: SessionRepository;
  /** Absent in tests that only exercise metadata/health routes. */
  readonly interviewSessionService?: InterviewSessionService;
}
