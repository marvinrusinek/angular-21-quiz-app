/** Stable string identifiers for the achievements (never numeric IDs). */
export type AchievementId =
  | 'perfect-score'
  | 'angular-explorer'
  | 'beginner-complete'
  | 'intermediate-complete'
  | 'advanced-complete'
  | 'interview-master';

/** UI + evaluation metadata for a single achievement. */
export interface AchievementDefinition {
  id: AchievementId;
  name: string;
  description: string;
  /** Decorative emoji icon (presentation only; the name still carries meaning). */
  icon?: string;
}

/** The minimal durable record persisted when an achievement is earned. */
export interface EarnedAchievement {
  id: AchievementId;
  earnedAt: string;  // ISO 8601 timestamp
}

/** A definition paired with the user's earned/locked state — for catalog display. */
export interface AchievementView extends AchievementDefinition {
  earned: boolean;
}
