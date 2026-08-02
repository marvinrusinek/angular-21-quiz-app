import { readQuizDataFile, type LoadOptions } from './quiz.loader';
import { validateAndNormalize } from './quiz.validation';
import type {
  PrivateOption,
  PrivateQuestion,
  PrivateQuiz,
  QuizBankStats,
  QuizMetadata
} from './quiz.types';

/**
 * The ONLY module that reads the answer key.
 *
 * Built by a factory rather than a singleton so tests construct isolated
 * instances with fixtures and no global state leaks between them. The bank is
 * parsed and validated ONCE at construction; nothing rereads the file per
 * request.
 *
 * Everything returned is deeply frozen, so a consumer cannot mutate the master
 * bank — a shuffle or an answer-state reset in a later stage operates on its
 * own copies.
 */

export interface QuizRepository {
  readonly stats: QuizBankStats;
  getQuizMetadata(): readonly QuizMetadata[];
  getQuizById(quizId: string): PrivateQuiz | undefined;
  getQuestionById(questionId: string): PrivateQuestion | undefined;
  /**
   * Resolve an option WITHIN a question. The only supported lookup: option ids
   * are not globally unique, so an option must never be resolved on its own.
   */
  getOptionForQuestion(questionId: string, optionId: number): PrivateOption | undefined;
  getEligibleQuestions(filter?: EligibilityFilter): readonly PrivateQuestion[];
}

export interface EligibilityFilter {
  /** Source quiz ids to draw from. Omitted/empty means every topic. */
  readonly topicIds?: readonly string[];
  /** 'mixed' (or omitted) means every difficulty. */
  readonly difficulty?: string | null;
}

export interface RepositoryOptions extends LoadOptions {
  /** Path to the private file. Ignored when `source` is supplied. */
  readonly dataPath?: string;
  /** Pre-parsed data for tests, so no file is touched. */
  readonly source?: unknown;
}

/** Recursive freeze — the bank must be immutable after load. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function createQuizRepository(options: RepositoryOptions = {}): QuizRepository {
  const raw =
    options.source !== undefined
      ? options.source
      : readQuizDataFile(options.dataPath ?? './data/quiz.json', options);

  // Throws QuizDataError on any problem — an invalid bank must not start.
  const { quizzes } = validateAndNormalize(raw);
  const frozenQuizzes = deepFreeze(quizzes) as readonly PrivateQuiz[];

  const quizById = new Map<string, PrivateQuiz>();
  const questionById = new Map<string, PrivateQuestion>();
  const allQuestions: PrivateQuestion[] = [];
  let optionCount = 0;

  for (const quiz of frozenQuizzes) {
    quizById.set(quiz.quizId, quiz);
    for (const question of quiz.questions) {
      questionById.set(question.questionId, question);
      allQuestions.push(question);
      optionCount += question.options.length;
    }
  }

  const metadata: readonly QuizMetadata[] = deepFreeze(
    frozenQuizzes.map((quiz) => ({
      quizId: quiz.quizId,
      milestone: quiz.milestone,
      summary: quiz.summary,
      image: quiz.image,
      difficulty: quiz.difficulty,
      questionCount: quiz.questions.length
    }))
  );

  const stats: QuizBankStats = deepFreeze({
    quizCount: frozenQuizzes.length,
    questionCount: allQuestions.length,
    optionCount
  });

  const frozenAll = deepFreeze(allQuestions) as readonly PrivateQuestion[];

  return {
    stats,

    getQuizMetadata: () => metadata,

    getQuizById: (quizId) => quizById.get(quizId),

    getQuestionById: (questionId) => questionById.get(questionId),

    getOptionForQuestion(questionId, optionId) {
      const question = questionById.get(questionId);
      if (!question) return undefined;
      return question.options.find((option) => option.optionId === optionId);
    },

    getEligibleQuestions(filter: EligibilityFilter = {}) {
      const topicIds = filter.topicIds;
      const difficulty = filter.difficulty;
      const wantAllTopics = !topicIds || topicIds.length === 0;
      const wantAllDifficulties =
        difficulty === undefined || difficulty === null || difficulty === 'mixed';

      if (wantAllTopics && wantAllDifficulties) return frozenAll;

      const topics = wantAllTopics ? null : new Set(topicIds);

      return frozenAll.filter((question) => {
        if (topics && !topics.has(question.sourceQuizId)) return false;
        if (wantAllDifficulties) return true;
        return quizById.get(question.sourceQuizId)?.difficulty === difficulty;
      });
    }
  };
}

/**
 * Startup summary. Counts ONLY — never questions, options, correctness or
 * explanations, so a log file can never become an answer key.
 */
export function describeBank(stats: QuizBankStats): string {
  return `Loaded ${stats.quizCount} quizzes, ${stats.questionCount} questions, ${stats.optionCount} options`;
}
