-- Interview session persistence (PostgreSQL).
--
-- Sessions store a FROZEN SNAPSHOT of their own questions and options — the
-- text, the ordering and the answer key — rather than referring back to the
-- quiz bank. Editing or redeploying quiz.json must never change the wording,
-- the option order or the scoring of an assessment already in progress or
-- already completed.
--
-- `is_correct` and `explanation` live here because scoring happens server-side.
-- They are never mapped into an active-session DTO; see api/response-policy.ts.
--
-- PORTED FROM SQLITE. Two differences matter:
--
--   * Timestamps are epoch MILLISECONDS and must be BIGINT. Postgres INTEGER is
--     32-bit and overflows at ~2.1e9, while an epoch-ms value is ~1.7e12, so
--     INTEGER here would reject every write. SQLite's INTEGER is 64-bit, which
--     is why this was invisible before.
--   * Booleans stay 0/1 SMALLINTs rather than becoming BOOLEAN, so the
--     repository's reads and these CHECK constraints port unchanged.

CREATE TABLE IF NOT EXISTS interview_sessions (
  id                  TEXT     PRIMARY KEY
                               CHECK (length(trim(id)) > 0),
  token_hash          TEXT     NOT NULL
                               CHECK (length(trim(token_hash)) > 0),
  status              TEXT     NOT NULL
                               CHECK (status IN ('active', 'submitted', 'expired')),
  config_json         TEXT     NOT NULL
                               CHECK (length(trim(config_json)) > 0),
  duration_seconds    INTEGER  NOT NULL
                               CHECK (duration_seconds > 0),
  created_at          BIGINT   NOT NULL
                               CHECK (created_at > 0),
  expires_at          BIGINT   NOT NULL
                               CHECK (expires_at > created_at),
  submitted_at        BIGINT,
  submitted_by_expiry SMALLINT NOT NULL DEFAULT 0
                               CHECK (submitted_by_expiry IN (0, 1)),
  result_json         TEXT,
  attempt_id          TEXT     NOT NULL UNIQUE
                               CHECK (length(trim(attempt_id)) > 0),

  -- A submitted session must record WHEN it was submitted; an active one must
  -- not carry a frozen result. This keeps the lifecycle honest at the storage
  -- layer rather than trusting every future caller to be careful.
  CHECK (status <> 'submitted' OR submitted_at IS NOT NULL),
  CHECK (status <> 'active'    OR result_json  IS NULL)
);

CREATE TABLE IF NOT EXISTS session_questions (
  session_id     TEXT    NOT NULL,
  position       INTEGER NOT NULL
                         CHECK (position >= 0),
  question_id    TEXT    NOT NULL
                         CHECK (length(trim(question_id)) > 0),
  source_quiz_id TEXT    NOT NULL
                         CHECK (length(trim(source_quiz_id)) > 0),
  question_text  TEXT    NOT NULL
                         CHECK (length(trim(question_text)) > 0),
  question_type  TEXT    NOT NULL
                         CHECK (question_type IN ('single', 'multiple', 'trueFalse')),
  -- Every question in the current bank has one, and the app always renders it.
  explanation    TEXT    NOT NULL
                         CHECK (length(trim(explanation)) > 0),

  PRIMARY KEY (session_id, position),
  UNIQUE (session_id, question_id),
  FOREIGN KEY (session_id)
    REFERENCES interview_sessions (id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_options (
  session_id        TEXT     NOT NULL,
  question_position INTEGER  NOT NULL,
  option_id         INTEGER  NOT NULL,
  option_text       TEXT     NOT NULL
                             CHECK (length(trim(option_text)) > 0),
  display_order     INTEGER  NOT NULL
                             CHECK (display_order >= 0),
  is_correct        SMALLINT NOT NULL
                             CHECK (is_correct IN (0, 1)),

  -- Scoped by (session, question): option ids are unique WITHIN a question and
  -- deliberately NOT globally. Question 3 of two different source quizzes both
  -- legitimately own option 401, so a global unique index on option_id would be
  -- wrong. There is intentionally no such index.
  PRIMARY KEY (session_id, question_position, option_id),
  UNIQUE (session_id, question_position, display_order),

  FOREIGN KEY (session_id, question_position)
    REFERENCES session_questions (session_id, position)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_answers (
  session_id          TEXT    NOT NULL,
  question_position   INTEGER NOT NULL,
  -- JSON array of option ids. Parsed AND revalidated on every read; never
  -- trusted merely because this process wrote it.
  selected_option_ids TEXT    NOT NULL
                              CHECK (length(trim(selected_option_ids)) > 0),
  updated_at          BIGINT  NOT NULL
                              CHECK (updated_at > 0),

  PRIMARY KEY (session_id, question_position),
  FOREIGN KEY (session_id, question_position)
    REFERENCES session_questions (session_id, position)
    ON DELETE CASCADE
);

-- Supports the expiry sweep without scanning finished sessions.
CREATE INDEX IF NOT EXISTS idx_interview_sessions_expires
  ON interview_sessions (expires_at)
  WHERE status = 'active';
