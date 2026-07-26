export interface ScoreAnalysisItem {
  questionIndex: number;
  questionText: string;
  wasCorrect: boolean;
  selectedOptionIds: string[];
  correctOptionIds: string[];
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