/**
 * The completed Weak Areas Practice result.
 *
 * Deliberately its own model rather than InterviewResult: practice is untimed
 * (no timeUsed/timeRemaining/expiry), has no difficulty or preset, and carries a
 * per-question Review payload that the interview result never stores. Sharing
 * the interview model would mean stuffing it with fields that are meaningless
 * here and would blur the interview-only analytics boundary.
 *
 * Correctness itself is NOT redefined here — it comes from the shared
 * `isAnswerCorrect()` used by topic-quiz-shaped scoring and Review alike.
 */

/** One topic's raw counts. Feeds BOTH the Results breakdown and the recording. */
export interface PracticeTopicScore {
  topicId: string;
  topicName: string;
  correct: number;
  total: number;
  percentage: number;
}

/** One question's Review row. Everything shown is derived, never re-judged. */
export interface PracticeReviewEntry {
  index: number;
  questionText: string;
  topicId: string;
  topicName: string;
  /** The option texts the user ended on. Empty when never answered. */
  selectedTexts: string[];
  /** The full correct set, so a partial multi-answer is visibly incomplete. */
  correctTexts: string[];
  answered: boolean;
  isCorrect: boolean;
  /** The FET. Always available in Review, including for incorrect answers. */
  explanation: string;
}

export interface PracticeResult {
  /** Stable id minted once at generation; `practice:{sessionId}` records it. */
  sessionId: string;
  completedAt: string;
  total: number;
  answered: number;
  unanswered: number;
  correct: number;
  incorrect: number;
  percentage: number;
  perTopic: PracticeTopicScore[];
  review: PracticeReviewEntry[];
}
