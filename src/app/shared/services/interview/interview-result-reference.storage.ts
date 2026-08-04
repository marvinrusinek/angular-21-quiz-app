import { Service } from '@angular/core';

import { INTERVIEW_HISTORY_MAX } from '../../models/interview-history.model';
import { readLocalJson, removeLocalKey, writeLocalJson } from '../../utils/local-storage';

/**
 * Durable pointers to SUBMITTED interviews, so Review Answers can be reopened
 * from Interview History after the tab that took the assessment is gone.
 *
 * WHAT THIS IS NOT: the v1 answer key. No question text, option text,
 * correctness or explanation is stored — only the id and token needed to ask
 * the SERVER for them. The review itself never touches disk.
 *
 * Why a token on disk is acceptable HERE, when the active-session token is
 * deliberately sessionStorage-only:
 *
 *   * Only SUBMITTED sessions are recorded. An in-flight assessment's token
 *     still lives in sessionStorage and still dies with the tab, so this
 *     cannot be used to resume, alter or re-submit an assessment.
 *   * After submission the backend makes the token READ-ONLY: saveAnswer and
 *     submit both return CONFLICT, and only getResult succeeds.
 *   * It grants access to one completed result belonging to this browser. There
 *     are no accounts and no personal data behind it.
 *
 * The residual risk is real and worth naming: an XSS could read these tokens
 * and fetch those results. That is a strictly smaller prize than v1, where the
 * answer key was already sitting in localStorage for the taking.
 */

export const SK_INTERVIEW_RESULT_REFS = 'interviewResultRefs:v1';

export const INTERVIEW_RESULT_REFS_VERSION = 1 as const;

/**
 * Pointers are useless once the backend drops the session, and a stale token
 * should not linger indefinitely. Entries older than this are discarded on
 * read, independently of the retention cap.
 */
export const RESULT_REFERENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

export interface PersistedResultReference {
  readonly sessionId: string;
  /** Read-only post-submission. See the note above. */
  readonly sessionToken: string;
  /** Epoch ms, for expiry. */
  readonly savedAtMs: number;
}

interface ResultReferenceStore {
  readonly version: typeof INTERVIEW_RESULT_REFS_VERSION;
  readonly refs: readonly PersistedResultReference[];
}

/** Field names that must NEVER appear here — the v1 mistake, encoded. */
export const FORBIDDEN_RESULT_REFERENCE_FIELDS: readonly string[] = [
  'review', 'questions', 'options', 'selectedOptionIds', 'correctOptionIds',
  'explanation', 'questionText', 'answerKey', 'result', 'score', 'percentage'
];

function isUsable(raw: unknown, now: number): raw is PersistedResultReference {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const candidate = raw as Record<string, unknown>;

  // A stored entry carrying answer-bearing fields is rejected outright, even if
  // the required fields happen to be present.
  for (const field of FORBIDDEN_RESULT_REFERENCE_FIELDS) {
    if (field in candidate) return false;
  }

  const { sessionId, sessionToken, savedAtMs } = candidate;
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return false;
  if (typeof sessionToken !== 'string' || sessionToken.trim().length === 0) return false;
  if (typeof savedAtMs !== 'number' || !Number.isFinite(savedAtMs)) return false;

  return now - savedAtMs < RESULT_REFERENCE_TTL_MS;
}

@Service()
export class InterviewResultReferenceStorage {
  /** Live entries, newest last. Expired and malformed ones are dropped. */
  read(now: number = Date.now()): PersistedResultReference[] {
    const raw = readLocalJson<unknown>(SK_INTERVIEW_RESULT_REFS, null);
    if (!raw || typeof raw !== 'object') return [];

    const store = raw as Partial<ResultReferenceStore>;
    if (store.version !== INTERVIEW_RESULT_REFS_VERSION) return [];
    if (!Array.isArray(store.refs)) return [];

    return store.refs.filter((ref): ref is PersistedResultReference => isUsable(ref, now));
  }

  find(sessionId: string, now: number = Date.now()): PersistedResultReference | null {
    return this.read(now).find((ref) => ref.sessionId === sessionId) ?? null;
  }

  /**
   * Record a submitted attempt. Idempotent per session, and capped to the same
   * window Interview History keeps so the two cannot drift.
   */
  remember(sessionId: string, sessionToken: string, now: number = Date.now()): void {
    if (!sessionId || !sessionToken) return;

    const kept = this.read(now).filter((ref) => ref.sessionId !== sessionId);
    const refs = [...kept, { sessionId, sessionToken, savedAtMs: now }]
      .slice(-INTERVIEW_HISTORY_MAX);

    writeLocalJson(SK_INTERVIEW_RESULT_REFS, {
      version: INTERVIEW_RESULT_REFS_VERSION,
      refs
    } satisfies ResultReferenceStore);
  }

  clear(): void {
    removeLocalKey(SK_INTERVIEW_RESULT_REFS);
  }
}
