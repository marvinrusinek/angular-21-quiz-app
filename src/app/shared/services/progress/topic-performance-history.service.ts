import { computed, Service, signal } from '@angular/core';

import {
  TOPIC_PERFORMANCE_HISTORY_MAX,
  TOPIC_PERFORMANCE_HISTORY_VERSION,
  TopicPerformanceRecord,
  TopicPerformanceSource,
  validateTopicPerformanceRecord
} from '../../models/topic-performance-history.model';
import { SK_TOPIC_PERFORMANCE_HISTORY } from '../../constants/session-keys';
import { readLocalJson, writeLocalJson } from '../../utils/local-storage';
import { TopicAttemptLike } from '../../utils/weak-areas';

/**
 * Sole owner of `topicPerformanceHistory:v1` — reliable RAW topic performance
 * from normal topic quizzes and Weak Areas Practice.
 *
 * It NEVER touches Interview History, best scores, achievements or completion
 * state. Interview History remains interview-only, so certificate qualification
 * and interview-only analytics are unaffected by anything written here.
 */
@Service()
export class TopicPerformanceHistoryService {
  private readonly _records = signal<TopicPerformanceRecord[]>(this.load());

  /** All retained records, oldest → newest. */
  readonly records = this._records.asReadonly();

  /**
   * The records shaped as attempts for the shared aggregation helper. Each
   * record becomes a single-topic attempt, so `aggregateTopicPercentages()` sums
   * them exactly as it sums interview attempts — one accuracy formula, a broader
   * dataset.
   */
  readonly asAttempts = computed<TopicAttemptLike[]>(() =>
    this._records().map((r) => ({
      completedAt: r.completedAt,
      topicPerformance: [
        {
          topicId: r.topicId,
          topicName: r.topicName,
          correct: r.correct,
          total: r.total,
          percentage: r.total > 0 ? (r.correct / r.total) * 100 : 0
        }
      ]
    }))
  );

  /**
   * Record one completed attempt's per-topic raw counts, EXACTLY ONCE.
   *
   * Dedup is by `attemptId`: a Results remount, a refresh, or revisiting a
   * completed result re-enters this method and is a durable no-op, because the
   * check runs against persisted state rather than an in-memory flag.
   */
  record(
    attemptId: string,
    source: TopicPerformanceSource,
    topics: readonly { topicId: string; topicName?: string; correct: number; total: number }[]
  ): void {
    if (!attemptId || topics.length === 0) return;

    const existing = this._records();
    if (existing.some((r) => r.attemptId === attemptId)) return;   // already recorded

    const completedAt = new Date().toISOString();
    const incoming: TopicPerformanceRecord[] = [];
    for (const topic of topics) {
      if (!topic?.topicId || !(topic.total > 0)) continue;   // skip empty samples
      const candidate = validateTopicPerformanceRecord({
        attemptId,
        source,
        completedAt,
        topicId: topic.topicId,
        topicName: topic.topicName ?? topic.topicId,
        correct: topic.correct,
        total: topic.total
      });
      if (candidate) incoming.push(candidate);
    }
    if (incoming.length === 0) return;

    // Append, then keep the NEWEST records. Older valid entries are never
    // rewritten or dropped except by this bounded retention.
    const next = [...existing, ...incoming].slice(-TOPIC_PERFORMANCE_HISTORY_MAX);
    this._records.set(next);
    this.save(next);
  }

  /** True when this attempt has already been recorded (durable, not in-memory). */
  hasRecorded(attemptId: string): boolean {
    return !!attemptId && this._records().some((r) => r.attemptId === attemptId);
  }

  // ── internals ───────────────────────────────────────────────────
  private load(): TopicPerformanceRecord[] {
    const raw = readLocalJson<unknown>(SK_TOPIC_PERFORMANCE_HISTORY, null);
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { records?: unknown })?.records)
        ? (raw as { records: unknown[] }).records
        : [];

    // Validate EACH record independently so one malformed entry cannot discard the
    // rest, and de-duplicate defensively in case storage was hand-edited.
    const seen = new Set<string>();
    const out: TopicPerformanceRecord[] = [];
    for (const entry of list) {
      const record = validateTopicPerformanceRecord(entry);
      if (!record) continue;
      const key = `${record.attemptId}::${record.topicId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(record);
    }
    return out.slice(-TOPIC_PERFORMANCE_HISTORY_MAX);
  }

  private save(records: TopicPerformanceRecord[]): void {
    writeLocalJson(SK_TOPIC_PERFORMANCE_HISTORY, {
      version: TOPIC_PERFORMANCE_HISTORY_VERSION,
      records
    });
  }
}
