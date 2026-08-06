-- The quiz bank (PostgreSQL becomes authoritative).
--
-- Replaces `data/quiz.json` as the source of the questions, options,
-- explanations and answer key. The JSON files remain on disk until the API
-- path is complete; this migration only creates the destination.
--
-- ── PUBLIC CONTRACT vs INTERNAL IDENTITY ───────────────────────────
--
-- The ONLY public identifier is `quizzes.quiz_id` ('rxjs'). Questions and
-- options are addressed publicly by their exact TEXT, scoped to the quiz.
-- The surrogate `id` columns below are internal: they exist for relational
-- integrity and joins, and MUST NOT appear in any Angular-facing DTO.
--
-- This replaces the previous positional scheme (`<quizId>:q:<index>` and
-- `(qIdx+1)*100+(oIdx+1)`), where identity was derived from a question's
-- position in the JSON file — so inserting a question renumbered everything
-- after it. Those values are retained in `legacy_*` columns as PROVENANCE
-- ONLY: never a lookup key, never public.
--
-- Interview Mode still derives its existing ids from `display_order` at
-- assessment-build time, so its API contract is unchanged by this migration.
--
-- ── WHY TEXT IS A SAFE KEY ─────────────────────────────────────────
--
-- Audited against the real bank (20 quizzes / 185 questions / 710 options):
-- question text is unique within every quiz and option text is unique within
-- every question, under exact, trimmed, whitespace-collapsed, NFC and
-- case-insensitive normalization — zero collisions at every level. The UNIQUE
-- constraints below make that property permanent: a future colliding question
-- becomes impossible to insert rather than a silent lookup ambiguity.
--
-- Unicode NFC is applied by the importer and at the API boundary, in Node.
-- Every string in the bank is already NFC and JSON preserves it, so the
-- normalization here covers only case and whitespace.

CREATE TABLE IF NOT EXISTS quizzes (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- INTERNAL

  -- The one public identifier. Unchanged from the JSON bank, because progress,
  -- history, achievements and high-score records already key on it.
  quiz_id       TEXT    NOT NULL UNIQUE
                        CHECK (length(btrim(quiz_id)) > 0),

  -- `milestone` is the quiz's display title in this domain, not `title`.
  milestone     TEXT    NOT NULL CHECK (length(btrim(milestone)) > 0),
  summary       TEXT    NOT NULL DEFAULT '',
  image         TEXT    NOT NULL DEFAULT '',

  -- Difficulty is a QUIZ-level property, not a per-question one — the
  -- assessment builder filters eligible questions by their quiz's difficulty.
  -- Nullable because the private model types it `string | null`, even though
  -- all 20 quizzes currently set it.
  -- `IS NULL OR` is explicit rather than relying on NULL IN (...) evaluating to
  -- NULL and passing the CHECK by omission. It states the intent, and it also
  -- behaves identically on real Postgres and on the pg-mem test double, which
  -- treats NULL IN (...) as false.
  difficulty    TEXT    CHECK (difficulty IS NULL
                               OR difficulty IN ('beginner', 'intermediate', 'advanced')),

  -- Display-only trivia shown by QuizFactComponent and the Results page.
  -- Stored as a JSON array of strings, matching the existing convention for
  -- `config_json` / `result_json` in the session schema. Held here so the data
  -- is not lost when the Angular asset is removed.
  facts_json    TEXT    NOT NULL DEFAULT '[]',

  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  status        TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'retired'))
);

CREATE TABLE IF NOT EXISTS questions (
  id            BIGINT  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- INTERNAL
  quiz_pk       BIGINT  NOT NULL REFERENCES quizzes (id) ON DELETE CASCADE,

  question_text TEXT    NOT NULL CHECK (length(btrim(question_text)) > 0),

  -- Normalized lookup key, GENERATED so it can never drift from the text it
  -- indexes. Case-insensitive and whitespace-collapsed: the audit proved that
  -- is collision-free, so the most forgiving safe normalization is used.
  question_key  TEXT    GENERATED ALWAYS AS
                        (lower(regexp_replace(btrim(question_text), '\s+', ' ', 'g'))) STORED,

  -- DERIVED at import by deriveQuestionType() — the source JSON has no `type`
  -- field. Storing it makes PostgreSQL authoritative rather than re-deriving
  -- the same rule in two places.
  question_type TEXT    NOT NULL
                        CHECK (question_type IN ('single', 'multiple', 'trueFalse')),

  -- PRIVATE. Released only by the per-question reveal endpoint, never in the
  -- initial question payload.
  explanation   TEXT    NOT NULL CHECK (length(btrim(explanation)) > 0),

  display_order INTEGER NOT NULL CHECK (display_order >= 0),

  -- Provenance only: the pre-migration `<quizId>:q:<index>` value. Never used
  -- for lookup, never public, deliberately NOT unique.
  legacy_question_id TEXT,

  UNIQUE (quiz_pk, question_key),
  UNIQUE (quiz_pk, display_order)
);

CREATE TABLE IF NOT EXISTS options (
  id            BIGINT   GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- INTERNAL
  question_pk   BIGINT   NOT NULL REFERENCES questions (id) ON DELETE CASCADE,

  option_text   TEXT     NOT NULL CHECK (length(btrim(option_text)) > 0),
  option_key    TEXT     GENERATED ALWAYS AS
                         (lower(regexp_replace(btrim(option_text), '\s+', ' ', 'g'))) STORED,

  display_order INTEGER  NOT NULL CHECK (display_order >= 0),

  -- PRIVATE. This column is the answer key. It is never mapped into a DTO by
  -- any route except the per-question reveal, and the response guard enforces
  -- that independently.
  --
  -- NOTE ON THE SOURCE DATA: quiz.json omits the `correct` key entirely on
  -- incorrect options — there is no `correct: false`. The importer therefore
  -- writes an explicit 0, so absence can never be mistaken for unknown.
  is_correct    SMALLINT NOT NULL CHECK (is_correct IN (0, 1)),

  -- Provenance only: the pre-migration (qIdx+1)*100+(oIdx+1) value.
  legacy_option_id INTEGER,

  UNIQUE (question_pk, option_key),
  UNIQUE (question_pk, display_order)
);

-- Listing a quiz's questions in order — the read path for GET /questions and
-- for loading the bank at startup.
CREATE INDEX IF NOT EXISTS idx_questions_quiz
  ON questions (quiz_pk, display_order);

CREATE INDEX IF NOT EXISTS idx_options_question
  ON options (question_pk, display_order);
