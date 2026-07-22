/** Performance band for a topic — drives the (theme-aware) colour indicator. */
export type PerformanceBand = 'strong' | 'moderate' | 'weak';

/** Per-topic performance within an interview. Mirrors InterviewTopicScore, plus
 *  a derived band. topicId/topicName map to the source quiz. */
export interface TopicPerformance {
  topicId: string;
  topicName: string;
  correct: number;
  total: number;
  percentage: number;
  band: PerformanceBand;
}

/**
 * Immutable analytics derived from an InterviewResult's per-topic scores. The
 * `topics` list is sorted best→worst; `strongestTopics`/`weakestTopics` are the
 * two ends (disjoint). `weakestTopics` is the reuse point for any recommendation
 * feature — the analytics never duplicates recommendation logic itself.
 */
export interface InterviewAnalytics {
  topics: readonly TopicPerformance[];
  strongestTopics: readonly TopicPerformance[];
  weakestTopics: readonly TopicPerformance[];
}
