/** Centralized storage key prefixes/names used with sessionStorage and localStorage. */

// ── per-question prefixes (appended with question index) ─────────
export const SK_SEL_Q = 'sel_Q';
export const SK_DOT_CONFIRMED = 'dot_confirmed_';
export const SK_MULTI_PERFECT = 'multi_perfect_';
export const SK_DISPLAY_MODE = 'displayMode_';

// ── global keys ──────────────────────────────────────────────────
export const SK_COMPLETED_QUIZ_IDS = 'completedQuizIds';
export const SK_CORRECT_ANSWERS_COUNT = 'correctAnswersCount';
export const SK_IS_ANSWERED = 'isAnswered';
export const SK_SAVED_QUESTION_INDEX = 'savedQuestionIndex';
export const SK_SELECTED_OPTIONS_MAP = 'selectedOptionsMap';
export const SK_SHUFFLED_QUESTIONS = 'shuffledQuestions';
export const SK_SHUFFLED_QUESTIONS_QUIZ_ID = 'shuffledQuestionsQuizId';
export const SK_STARTED_QUIZ_IDS = 'startedQuizIds';
export const SK_USER_ANSWERS = 'userAnswers';

// ── durable preferences (localStorage) ───────────────────────────
export const SK_QUIZ_SORT_DIFFICULTY = 'quizSortDifficulty';
export const SK_QUIZ_SORT_ALPHA = 'quizSortAlpha';
export const SK_QUIZ_BEST_SCORES = 'quizBestScores';
export const SK_QUIZ_ACHIEVEMENTS = 'quizAchievements';

// ── per-session state (sessionStorage) ───────────────────────────
export const SK_QUIZ_SEARCH_TERM = 'quizSearchTerm';

// Active Interview Mode session, persisted so a mid-assessment refresh resumes
// the SAME assessment/answers/position with the correct remaining time. Only an
// 'active' session is stored; cleared on submit or abandon.
export const SK_INTERVIEW_SESSION = 'interviewSession';

// Assessment Integrity Mode state (focus-loss count / pending warning) for an
// active Interview session. Its OWN key — kept separate from the interview
// session payload and NEVER mixed into topic-quiz progress/achievements/scores.
export const SK_ASSESSMENT_INTEGRITY = 'assessmentIntegrity';

// Interview Mode performance history — a durable, versioned localStorage store of
// the latest completed assessments (compact analytics only; NEVER full questions/
// answers). Powers the Performance Trends chart. The ':v1' suffix is deliberate:
// it is long-term analytics data whose schema is versioned independently, and it
// is kept fully separate from topic-quiz progress/best-score/achievement stores.
export const SK_INTERVIEW_HISTORY = 'interviewAttemptHistory:v1';

// Angular Interview Master Certificate — a durable localStorage record of the
// ONE issued certificate (unlocked flag, issue date, stable certificate id, and
// an optional user-entered recipient name). Eligibility is NOT persisted here —
// it is recomputed from the reused Achievements / Readiness / History sources, so
// this store never duplicates achievement, readiness, or interview-history state.
export const SK_INTERVIEW_CERTIFICATE = 'interviewCertificate:v1';
