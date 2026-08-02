/**
 * The ONLY Interview state the browser persists.
 *
 * Everything else — questions, option order, saved answers, status, expiry,
 * remaining time — is re-fetched from the backend on resume, which is what
 * makes the answer key unavailable to the client between page loads.
 *
 * `focusChanges` is deliberately ABSENT: AssessmentIntegrityService already
 * owns that count in its own `assessmentIntegrity` key and restores it on
 * construction. Duplicating it here would create two sources of truth for the
 * same number.
 */
export const INTERVIEW_SESSION_REFERENCE_VERSION = 2 as const;

/** New key. The v1 key held a full generated assessment and is purged. */
export const SK_INTERVIEW_SESSION_REF = 'interviewSessionRef:v2';

export interface PersistedInterviewSessionReference {
  readonly version: typeof INTERVIEW_SESSION_REFERENCE_VERSION;
  readonly sessionId: string;
  /** Bearer token. sessionStorage ONLY — never localStorage. */
  readonly sessionToken: string;
  /** Pure UI position. Clamped on read; never authoritative for anything else. */
  readonly currentIndex: number;
}

/**
 * Field names that must NEVER appear in the persisted reference. Storage is
 * validated against this list so a future edit cannot quietly reintroduce
 * answer-bearing data.
 */
export const FORBIDDEN_REFERENCE_FIELDS: readonly string[] = [
  'questions',
  'options',
  'answers',
  'answersByIndex',
  'selectedOptionIds',
  'correct',
  'isCorrect',
  'correctOptionIds',
  'explanation',
  'assessment',
  'result',
  'review',
  'score',
  'percentage',
  'expiresAt',
  'remainingSeconds'
];

/**
 * Parse an untrusted stored value. Returns null for anything malformed — the
 * caller then removes the key rather than attempting a repair.
 */
export function parseSessionReference(raw: unknown): PersistedInterviewSessionReference | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const candidate = raw as Record<string, unknown>;
  if (candidate['version'] !== INTERVIEW_SESSION_REFERENCE_VERSION) return null;

  // A stored object carrying answer-bearing fields is rejected outright, even
  // if the required fields happen to be present.
  for (const field of FORBIDDEN_REFERENCE_FIELDS) {
    if (field in candidate) return null;
  }

  const sessionId = candidate['sessionId'];
  const sessionToken = candidate['sessionToken'];
  const currentIndex = candidate['currentIndex'];

  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return null;
  if (typeof sessionToken !== 'string' || sessionToken.trim().length === 0) return null;
  if (typeof currentIndex !== 'number' || !Number.isInteger(currentIndex) || currentIndex < 0) {
    return null;
  }

  return {
    version: INTERVIEW_SESSION_REFERENCE_VERSION,
    sessionId,
    sessionToken,
    currentIndex
  };
}
