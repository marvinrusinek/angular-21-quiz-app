export interface ScoreAnalysisItem {
  questionIndex: number;
  questionText: string;
  wasCorrect: boolean;
  selectedOptionIds: string[];
  correctOptionIds: string[];
  /**
   * AUTHORIZED terminal data, from the verdict history.
   *
   * Text-based because that is the public contract: the reveal a user earned is
   * a set of option strings and an explanation, never ids. The `*OptionIds`
   * fields above are retained so snapshots persisted by earlier builds still
   * render, but new consumers should read these.
   *
   * Optional because a question that never reached a terminal state has no
   * authorized reveal — the honest representation of that is absence, not an
   * empty array filled in from the local bank.
   */
  selectedOptionTexts?: string[];
  correctOptionTexts?: string[];
  explanation?: string | null;
}
  
export interface FinalResult {
  quizId: string;
  correct: number;
  total: number;
  percentage: number;
  analysis: ScoreAnalysisItem[];
  completedAt: number;
  /** Total elapsed time (seconds) captured at completion. Persisted so the
   *  Results page shows real elapsed time on revisit, when the live timer has
   *  been reset. Optional for backward compatibility with older snapshots. */
  completionTime?: number;
}