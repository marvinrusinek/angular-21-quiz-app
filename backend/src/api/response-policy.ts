/**
 * Response classification + the recursive key guard.
 *
 * This is DEFENCE IN DEPTH, not the primary control. The primary control is
 * that mappers construct allow-listed literals (quiz.dto.ts). The guard exists
 * to catch the case where someone later returns a private model directly, or
 * widens a mapper without noticing.
 *
 * It inspects PROPERTY NAMES ONLY — never string values. A question legitimately
 * reading "Which answer is correct?" must pass; a property literally named
 * `correct` must not.
 */

export type ResponsePolicyName =
  | 'PUBLIC_METADATA'
  | 'ACTIVE_ASSESSMENT'
  | 'SESSION_CREATED'
  | 'SUBMITTED_REVIEW'
  | 'ERROR';

/**
 * Normalize a property name so naming-convention drift cannot slip past:
 * `is_correct`, `isCorrect`, `IsCorrect` and `is-correct` all collapse to
 * `iscorrect`. Comparison is then exact against the banned set — deliberately
 * NOT a substring match, so `correctOptionIds` stays distinct from `correct`
 * and can be allowed independently.
 */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, '');
}

function banned(...keys: string[]): ReadonlySet<string> {
  return new Set(keys.map(normalizeKey));
}

/** Answer-key material — never legal outside an authorized review response. */
const ANSWER_KEY_FIELDS = [
  'correct',
  'isCorrect',
  'is_correct',
  'correctOptionIds',
  'correct_option_ids',
  'answerKey',
  'answer_key',
  'expectedAnswers',
  'expected_answers',
  'correctAnswers',
  'correct_answers'
];

/** Backend internals that must never be serialized under ANY policy. */
const INTERNAL_FIELDS = [
  'sourceQuestionIndex',
  'source_question_index',
  'sourceOptionIndex',
  'source_option_index',
  'tokenHash',
  'token_hash',
  'sessionToken',
  'session_token',
  'dataPath',
  'data_path',
  'databasePath',
  'database_path',
  'quizDataPath',
  'allowedOrigins',
  // Internal attempt identity. The client is given `sessionId`; `attemptId` is
  // the row-level key the scoring tables join on and must not leave the server.
  'attemptId',
  'attempt_id',
  // Raw SQLite column names. These would each be a whole serialized record —
  // `result_json` in particular is the complete frozen answer key. Banning the
  // column names means a `SELECT *` row handed to res.json fails loudly instead
  // of shipping storage internals.
  'result_json',
  'resultJson',
  'config_json',
  'configJson',
  'questions_json',
  'questionsJson',
  'answers_json',
  'answersJson'
  // NOT listed: `selected_option_ids`. normalizeKey() collapses separators, so
  // it is indistinguishable from `selectedOptionIds` — a field the save and
  // review DTOs legitimately return. Banning it would reject every valid
  // response. The column is kept out of responses by the mappers, which build
  // allow-listed literals and never spread a database row.
];

const POLICIES: Record<ResponsePolicyName, ReadonlySet<string>> = {
  /**
   * Metadata listings. Also bans `questions`/`options` so a metadata route can
   * never grow into a full question dump by accident.
   */
  PUBLIC_METADATA: banned(...ANSWER_KEY_FIELDS, ...INTERNAL_FIELDS, 'explanation', 'questions', 'options'),

  /**
   * Live assessment. Options ARE allowed; correctness, FET and the session
   * token are not — a resume response must never repeat the token.
   */
  ACTIVE_ASSESSMENT: banned(...ANSWER_KEY_FIELDS, ...INTERNAL_FIELDS, 'explanation'),

  /**
   * The session-CREATION response, and the only place a raw `sessionToken` may
   * appear. Identical to ACTIVE_ASSESSMENT in every other respect — the token
   * is exempted for this ONE route rather than removed from the global banned
   * set, so resume, review and metadata all keep rejecting it.
   */
  SESSION_CREATED: banned(
    ...ANSWER_KEY_FIELDS,
    ...INTERNAL_FIELDS.filter((field) => normalizeKey(field) !== normalizeKey('sessionToken')),
    'explanation'
  ),

  /**
   * Post-submission review. A TIGHTLY SCOPED widening, not "anything goes":
   * `correctOptionIds` and `explanation` become legal, while raw per-option
   * correctness (`correct`, `isCorrect`, `is_correct`) and every backend
   * internal stay banned. Review DTOs express correctness as an explicit id
   * list, so the raw flags are never needed.
   */
  SUBMITTED_REVIEW: banned(
    // PER-OPTION correctness stays banned: an option must never carry a boolean
    // answer flag. Correctness is expressed ONLY as `correctOptionIds`.
    'isCorrect',
    'is_correct',
    'answerKey',
    'answer_key',
    'expectedAnswers',
    'expected_answers',
    ...INTERNAL_FIELDS
    // NOTE: bare `correct` is deliberately NOT banned here. In a submitted
    // result it is the AGGREGATE COUNT of correct answers (matching Angular's
    // InterviewResult.correct), not an answer flag — earned data the user is
    // entitled to see. It remains banned under PUBLIC_METADATA and
    // ACTIVE_ASSESSMENT, where any `correct` key would be a genuine leak.
  ),

  /** Error envelopes are `{ error: { code, message } }` — internals still banned. */
  ERROR: banned(...ANSWER_KEY_FIELDS, ...INTERNAL_FIELDS)
};

export interface PolicyViolation {
  /** Dotted path to the offending property, e.g. `quizzes[0].options[1]`. */
  readonly path: string;
  /** The offending property NAME. Never its value. */
  readonly key: string;
  readonly policy: ResponsePolicyName;
}

/**
 * Walk a JSON-compatible body and return the first banned property name found.
 *
 * Recurses through nested objects, arrays, objects inside arrays and arrays
 * inside arrays. Cycles are tracked so a self-referencing body cannot hang the
 * request. Values are never inspected or copied.
 */
export function findPolicyViolation(
  body: unknown,
  policy: ResponsePolicyName
): PolicyViolation | null {
  const bannedKeys = POLICIES[policy];
  const seen = new WeakSet<object>();

  function walk(value: unknown, path: string): PolicyViolation | null {
    if (value === null || typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const found = walk(value[i], `${path}[${i}]`);
        if (found) return found;
      }
      return null;
    }

    for (const key of Object.keys(value)) {
      if (bannedKeys.has(normalizeKey(key))) {
        return { path: path === '' ? key : `${path}.${key}`, key, policy };
      }
      const found = walk((value as Record<string, unknown>)[key], path === '' ? key : `${path}.${key}`);
      if (found) return found;
    }
    return null;
  }

  return walk(body, '');
}

export function isKeyBanned(key: string, policy: ResponsePolicyName): boolean {
  return POLICIES[policy].has(normalizeKey(key));
}
