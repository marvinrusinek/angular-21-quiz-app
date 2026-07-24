import { computed, inject, Injectable, signal } from '@angular/core';

import { InterviewResult } from '../../../models/InterviewResult.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { QuestionType } from '../../../models/question-type.enum';
import {
  INTERVIEW_HISTORY_MAX,
  INTERVIEW_HISTORY_VERSION,
  InterviewAttemptHistoryEntry,
  InterviewAttemptHistoryStore,
  InterviewCompletionReason,
  InterviewReviewOptionSnapshot,
  InterviewReviewQuestionSnapshot,
  InterviewTopicHistoryEntry,
  InterviewTrendDirection,
  InterviewTrendPoint,
  InterviewTrends
} from '../../../models/interview-history.model';
import { SK_INTERVIEW_HISTORY } from '../../../constants/session-keys';
import { readLocalJson, removeLocalKey, writeLocalJson } from '../../../utils/local-storage';

import { InterviewAnalyticsService } from './interview-analytics.service';

// A change of ±5 percentage points is the threshold for a directional claim; the
// dead band between is "holding steady". Kept factual — never exaggerated.
const TREND_THRESHOLD = 5;

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clampPct = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

/** The live questions + answers needed to snapshot a per-question review at
 *  submission. Passed straight from the session; never stored raw. */
export interface InterviewReviewSource {
  questions: readonly QuizQuestion[];
  answersByIndex: Record<number, number[]>;
}

/**
 * Owns Interview Mode performance history end-to-end: reading + validating the
 * persisted store, adding a completed attempt exactly once, enforcing the
 * latest-20 retention window, and exposing the history + derived trends as
 * signals. Storage and trend math live here so the Results component stays
 * presentation-only. Topic Performance is NOT recomputed — it reuses
 * InterviewAnalyticsService's output.
 *
 * Kept entirely separate from topic-quiz progress/best-score/achievement stores.
 */
@Injectable({ providedIn: 'root' })
export class InterviewHistoryService {
  private readonly analytics = inject(InterviewAnalyticsService);

  private readonly _history = signal<InterviewAttemptHistoryEntry[]>(this.load());

  /** Retained attempts, chronological (oldest → latest). */
  readonly history = this._history.asReadonly();

  /** Everything the Performance Trends UI needs, derived from `history`. */
  readonly trends = computed<InterviewTrends>(() => summarizeTrends(this._history()));

  // Dedup anchor: the exact result object last recorded. A finalized interview
  // produces one result object; recording it a second time (e.g. a stray
  // re-invocation) is a no-op, while two genuinely-distinct interviews always
  // yield distinct objects and are both saved.
  private lastRecorded: InterviewResult | null = null;
  private seq = 0;

  /**
   * Persist a completed interview. Call this ONCE, at the submission chokepoint
   * (InterviewSessionService.submit), which is already idempotent — so a manual
   * submit racing a timer-expiry submit yields one record. Safe to call with a
   * null/undefined result (no-op) and re-entrant on the same result object.
   *
   * `attemptId` (from the session, stable per attempt) gives DURABLE idempotency:
   * if an entry with that id is already persisted it is not written again — this
   * survives service recreation / reloads / a freshly reconstructed result
   * object, not just repeated calls with the same in-memory object.
   */
  record(
    result: InterviewResult | null | undefined,
    attemptId?: string,
    reviewSource?: InterviewReviewSource
  ): void {
    if (!result) return;
    if (result === this.lastRecorded) return;   // same in-memory result → no-op
    // Durable guard: this attempt is already in the persisted history.
    if (attemptId && this._history().some((e) => e.id === attemptId)) {
      this.lastRecorded = result;
      return;
    }
    this.lastRecorded = result;

    const entry = this.toEntry(result, attemptId, reviewSource);
    // Append + keep only the latest N (drops the oldest, preserves order).
    const attempts = [...this._history(), entry].slice(-INTERVIEW_HISTORY_MAX);
    this._history.set(attempts);
    this.save(attempts);
  }

  /**
   * Clear all Interview Mode history. Exposed for a future global "clear all
   * progress" action — it is NOT wired to any destructive UI here, and is never
   * triggered by a refresh, a new interview, returning to the builder, or
   * clearing the active session.
   */
  clear(): void {
    this.lastRecorded = null;
    this._history.set([]);
    removeLocalKey(SK_INTERVIEW_HISTORY);
  }

  // ── internals ───────────────────────────────────────────────────
  private toEntry(
    result: InterviewResult,
    attemptId?: string,
    reviewSource?: InterviewReviewSource
  ): InterviewAttemptHistoryEntry {
    // Reuse Topic Performance analytics rather than re-deriving topic tallies.
    const topicPerformance: InterviewTopicHistoryEntry[] = this.analytics
      .analyze(result)
      .topics.map((t) => ({
        topicId: t.topicId,
        topicName: t.topicName,
        correct: t.correct,
        total: t.total,
        percentage: t.percentage
      }));

    const total = Math.max(0, result.total);
    const score = Math.max(0, Math.min(result.correct, total));   // never exceed total

    // Optional per-question snapshot — only when the live source was supplied.
    // Undefined otherwise (JSON.stringify omits it), so the entry stays compact.
    const review = reviewSource
      ? buildReviewSnapshot(reviewSource.questions, reviewSource.answersByIndex)
      : undefined;

    return {
      id: attemptId && attemptId.length > 0 ? attemptId : this.nextId(),
      attemptNumber: this.nextAttemptNumber(),
      completedAt: new Date().toISOString(),
      score,
      totalQuestions: total,
      percentage: clampPct(result.percentage),
      completionReason: result.submittedByExpiry ? 'time-expired' : 'submitted',
      durationSeconds: Math.max(0, Math.floor(result.timeUsedSeconds ?? 0)),
      configuredDifficulty: result.difficulty,
      selectedTopicIds: [...(result.topicIds ?? [])],
      topicPerformance,
      review
    };
  }

  private nextId(): string {
    this.seq += 1;
    // Timestamp + monotonic sequence → unique even for back-to-back saves.
    return `att_${Date.now().toString(36)}_${this.seq}`;
  }

  // The next lifetime attempt number. Derived from the retained max: the newest
  // retained entry always holds the highest number, so this keeps increasing even
  // as older attempts age out of the window.
  private nextAttemptNumber(): number {
    const maxSoFar = this._history().reduce((m, e) => Math.max(m, e.attemptNumber ?? 0), 0);
    return maxSoFar + 1;
  }

  private load(): InterviewAttemptHistoryEntry[] {
    // readLocalJson already returns null on missing/invalid JSON; validation
    // then rejects unsupported versions / malformed entries and de-dupes by id.
    const validated = validateHistoryStore(readLocalJson<unknown>(SK_INTERVIEW_HISTORY, null));
    // One-time migration: legacy records predate attemptNumber. Assign numbers by
    // chronological position and persist, so numbering is stable from here on.
    if (validated.some((e) => e.attemptNumber == null)) {
      const migrated = validated.map((e, i) => ({ ...e, attemptNumber: i + 1 }));
      if (migrated.length > 0) this.save(migrated);
      return migrated;
    }
    return validated;
  }

  private save(attempts: InterviewAttemptHistoryEntry[]): void {
    const store: InterviewAttemptHistoryStore = {
      version: INTERVIEW_HISTORY_VERSION,
      attempts
    };
    writeLocalJson(SK_INTERVIEW_HISTORY, store);
  }
}

// ── filtering (client-side, pure) ─────────────────────────────────────

/** Interview History filter — matches the completion reason (or all). */
export type InterviewHistoryFilter = 'all' | 'submitted' | 'time-expired';

/** Filter attempts by completion reason, preserving order. */
export function filterAttempts(
  attempts: readonly InterviewAttemptHistoryEntry[],
  filter: InterviewHistoryFilter
): InterviewAttemptHistoryEntry[] {
  if (filter === 'all') return [...attempts];
  return attempts.filter((a) => a.completionReason === filter);
}

// ── pure helpers (exported for tests) ─────────────────────────────────

/**
 * Validate an untrusted persisted store into a clean attempts array. Returns []
 * on anything malformed — wrong version, non-array attempts, invalid JSON
 * (already collapsed to null upstream) — and drops individual bad entries rather
 * than discarding the whole history. Never throws.
 */
export function validateHistoryStore(raw: unknown): InterviewAttemptHistoryEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const store = raw as Partial<InterviewAttemptHistoryStore>;
  if (store.version !== INTERVIEW_HISTORY_VERSION) return [];
  if (!Array.isArray(store.attempts)) return [];

  const clean = store.attempts
    .map(validateAttemptEntry)
    .filter((e): e is InterviewAttemptHistoryEntry => e !== null);

  // De-duplicate by id (keep the first occurrence) — the id is the attempt's
  // dedup anchor and duplicates would corrupt numbering / trend counts.
  const seen = new Set<string>();
  const deduped = clean.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));

  // Defensive: enforce chronological (oldest → latest) order. This is a no-op for
  // our own writes (always appended in order) but protects trend/direction logic
  // from a manually-edited or out-of-order store. Array.prototype.sort is stable,
  // so equal timestamps keep their original relative order. Then apply retention.
  const ordered = deduped.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  return ordered.slice(-INTERVIEW_HISTORY_MAX);
}

/**
 * Validate a single attempt entry; returns a normalised copy or null. Beyond
 * basic type/range checks this rejects internally-inconsistent records rather
 * than storing nonsense: score must not exceed totalQuestions, completedAt must
 * be a parseable date, and a negative duration is treated as "not recorded".
 */
export function validateAttemptEntry(raw: unknown): InterviewAttemptHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;

  if (typeof e['id'] !== 'string' || e['id'].length === 0) return null;
  if (typeof e['completedAt'] !== 'string' || Number.isNaN(Date.parse(e['completedAt']))) return null;
  if (!isFiniteNum(e['score']) || e['score'] < 0) return null;
  if (!isFiniteNum(e['totalQuestions']) || e['totalQuestions'] <= 0) return null;
  if (!isFiniteNum(e['percentage'])) return null;

  const totalQuestions = Math.round(e['totalQuestions']);
  const score = Math.round(e['score']);
  if (score > totalQuestions) return null;   // internally inconsistent

  const reason: InterviewCompletionReason =
    e['completionReason'] === 'time-expired' ? 'time-expired' : 'submitted';

  // A finite, non-negative attempt number survives; anything else is dropped and
  // re-derived by the load-time migration.
  const attemptNumber =
    isFiniteNum(e['attemptNumber']) && e['attemptNumber'] > 0
      ? Math.round(e['attemptNumber'])
      : undefined;

  // Duration must be >= 0; a negative/invalid value means "not recorded".
  const durationSeconds =
    isFiniteNum(e['durationSeconds']) && e['durationSeconds'] >= 0
      ? Math.floor(e['durationSeconds'])
      : undefined;

  const selectedTopicIds = Array.isArray(e['selectedTopicIds'])
    ? e['selectedTopicIds'].filter((t): t is string => typeof t === 'string')
    : [];

  const topicPerformance = Array.isArray(e['topicPerformance'])
    ? e['topicPerformance']
        .map(validateTopicEntry)
        .filter((t): t is InterviewTopicHistoryEntry => t !== null)
    : [];

  // Optional per-question review snapshot — undefined for legacy entries.
  const review = validateReviewSnapshots(e['review']);

  return {
    id: e['id'],
    attemptNumber,
    completedAt: e['completedAt'],
    score,
    totalQuestions,
    percentage: clampPct(e['percentage']),   // clamp impossible percentages
    completionReason: reason,
    durationSeconds,
    configuredDifficulty:
      typeof e['configuredDifficulty'] === 'string' ? e['configuredDifficulty'] : undefined,
    selectedTopicIds,
    topicPerformance,
    review
  };
}

// ── per-question review snapshot (build + validate) ───────────────────

const QUESTION_TYPES: readonly QuestionType[] = [
  QuestionType.SingleAnswer,
  QuestionType.MultipleAnswer,
  QuestionType.TrueFalse
];
const isQuestionType = (v: unknown): v is QuestionType =>
  typeof v === 'string' && (QUESTION_TYPES as readonly string[]).includes(v);

/**
 * Build a compact, plain-data review snapshot from the live questions + answers
 * at submission. Keeps only what the read-only Review Answers list needs
 * (question/explanation text, each option's id/text/correctness, topic + type,
 * the user's selection) — never live Option/QuizQuestion behaviour. Pure.
 */
export function buildReviewSnapshot(
  questions: readonly QuizQuestion[],
  answersByIndex: Record<number, number[]>
): InterviewReviewQuestionSnapshot[] {
  return (questions ?? []).map((q, i) => {
    const options: InterviewReviewOptionSnapshot[] = (q.options ?? [])
      .filter((o) => o.optionId != null)
      .map((o) => ({
        optionId: o.optionId as number,
        text: o.text ?? '',
        correct: o.correct === true
      }));
    const selectedOptionIds = (answersByIndex?.[i] ?? []).filter(
      (id): id is number => id != null
    );
    return {
      questionText: q.questionText ?? '',
      explanation: q.explanation ?? '',
      type: q.type,
      sourceQuizId: q.sourceQuizId,
      options,
      selectedOptionIds
    };
  });
}

/**
 * Validate an untrusted persisted review payload. Returns a clean array, or
 * `undefined` when absent/empty/malformed (so the detail page falls back to the
 * "not retained" note rather than rendering a broken review). Never throws.
 */
export function validateReviewSnapshots(
  raw: unknown
): InterviewReviewQuestionSnapshot[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const clean = raw
    .map(validateReviewQuestion)
    .filter((q): q is InterviewReviewQuestionSnapshot => q !== null);
  return clean.length > 0 ? clean : undefined;
}

function validateReviewQuestion(raw: unknown): InterviewReviewQuestionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;

  const options = Array.isArray(q['options'])
    ? q['options']
        .map(validateReviewOption)
        .filter((o): o is InterviewReviewOptionSnapshot => o !== null)
    : [];
  if (options.length === 0) return null;   // a question with no options is unusable

  // Selection must reference real option ids from THIS question.
  const validIds = new Set(options.map((o) => o.optionId));
  const selectedOptionIds = Array.isArray(q['selectedOptionIds'])
    ? q['selectedOptionIds'].filter(
        (id): id is number => isFiniteNum(id) && validIds.has(Math.round(id))
      ).map((id) => Math.round(id as number))
    : [];

  return {
    questionText: typeof q['questionText'] === 'string' ? q['questionText'] : '',
    explanation: typeof q['explanation'] === 'string' ? q['explanation'] : '',
    type: isQuestionType(q['type']) ? q['type'] : undefined,
    sourceQuizId: typeof q['sourceQuizId'] === 'string' ? q['sourceQuizId'] : undefined,
    options,
    selectedOptionIds
  };
}

function validateReviewOption(raw: unknown): InterviewReviewOptionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isFiniteNum(o['optionId'])) return null;
  return {
    optionId: Math.round(o['optionId']),
    text: typeof o['text'] === 'string' ? o['text'] : '',
    correct: o['correct'] === true
  };
}

function validateTopicEntry(raw: unknown): InterviewTopicHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t['topicId'] !== 'string' || t['topicId'].length === 0) return null;
  if (!isFiniteNum(t['correct']) || !isFiniteNum(t['total']) || !isFiniteNum(t['percentage'])) {
    return null;
  }
  const total = Math.round(t['total']);
  const correct = Math.round(t['correct']);
  // A topic must have a positive total and a correct count within [0, total].
  if (total <= 0 || correct < 0 || correct > total) return null;
  return {
    topicId: t['topicId'],
    topicName: typeof t['topicName'] === 'string' ? t['topicName'] : t['topicId'],
    correct,
    total,
    percentage: clampPct(t['percentage'])
  };
}

/**
 * Derive the trend summary from retained attempts (chronological in → out).
 * Pure: latest/best/average/change + an encouraging, factual interpretation.
 * Makes NO directional claim with fewer than two attempts.
 */
export function summarizeTrends(
  attempts: readonly InterviewAttemptHistoryEntry[]
): InterviewTrends {
  const n = attempts.length;
  const points: InterviewTrendPoint[] = attempts.map((a, i) => ({
    id: a.id,
    index: i + 1,
    completedAt: a.completedAt,
    score: a.score,
    totalQuestions: a.totalQuestions,
    percentage: a.percentage,
    completionReason: a.completionReason,
    isLatest: i === n - 1
  }));

  if (n === 0) {
    return {
      points, count: 0, latest: null, best: null, average: null,
      change: null, direction: 'none', interpretation: '', isPersonalBest: false
    };
  }

  const pcts = attempts.map((a) => a.percentage);
  const latest = pcts[n - 1];
  const best = Math.max(...pcts);
  const average = Math.round(pcts.reduce((s, p) => s + p, 0) / n);
  const change = n >= 2 ? latest - pcts[n - 2] : null;

  // New personal best: the latest attempt STRICTLY beats every previous one.
  // Requires ≥ 2 attempts (a first attempt is never a "best" to celebrate) and
  // excludes ties — matching a prior best doesn't earn the badge.
  const isPersonalBest = n >= 2 && latest > Math.max(...pcts.slice(0, n - 1));

  let direction: InterviewTrendDirection = 'none';
  let interpretation = '';
  if (change !== null) {
    if (change >= TREND_THRESHOLD) {
      direction = 'improving';
      interpretation = 'Your interview performance is improving.';
    } else if (change <= -TREND_THRESHOLD) {
      direction = 'declining';
      interpretation = 'Your latest score was lower. Review the topics that need attention and try again.';
    } else {
      direction = 'steady';
      interpretation = 'Your recent performance is holding steady.';
    }
  }

  return { points, count: n, latest, best, average, change, direction, interpretation, isPersonalBest };
}
