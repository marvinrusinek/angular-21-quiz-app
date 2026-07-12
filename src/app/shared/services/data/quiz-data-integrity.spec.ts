/**
 * DATA-INTEGRITY GUARD for the single quiz source.
 *
 * All quiz data now lives in ONE file, `src/assets/data/quiz.json` (`{ quizzes,
 * resources }`) — loaded in main.ts (pristine `quizInitialState`) AND by
 * quiz-data-loader/quizdata (the displayed questions). The former two-file setup
 * (assets/quiz.json + assets/data/quiz.json) was consolidated to remove the sync
 * burden, so this guard now validates the single file's internal integrity
 * instead of cross-file agreement.
 *
 * It still catches the kind of corruption the two-file guards were there for —
 * e.g. a question whose set of correct answers became empty (which would score /
 * play the sound wrong), or malformed question/option structure.
 */
import { readFileSync } from 'fs';

interface RawOption {
  text?: string;
  correct?: unknown;
}
interface RawQuestion {
  questionText?: string;
  options?: RawOption[];
}
interface RawQuiz {
  quizId?: string;
  id?: string;
  questions?: RawQuestion[];
}

const SOURCE_PATH = 'src/assets/data/quiz.json';

function isCorrect(o: RawOption): boolean {
  const c = o?.correct;
  return c === true || c === 'true' || c === 1 || c === '1';
}

function quizId(q: RawQuiz): string {
  return q.quizId ?? q.id ?? '';
}

describe('quiz data integrity (single source: assets/data/quiz.json)', () => {
  let quizzes: RawQuiz[];

  beforeAll(() => {
    expect(() => JSON.parse(readFileSync(SOURCE_PATH, 'utf8'))).not.toThrow();
    const json = JSON.parse(readFileSync(SOURCE_PATH, 'utf8'));
    expect(Array.isArray(json?.quizzes)).toBe(true);
    quizzes = json.quizzes as RawQuiz[];
  });

  it('has at least one quiz, each with a stable id', () => {
    expect(quizzes.length).toBeGreaterThan(0);
    const missingId = quizzes.filter((q) => quizId(q).length === 0);
    expect(missingId).toEqual([]);
  });

  it('every question has non-empty text and at least one option', () => {
    const bad: string[] = [];
    for (const quiz of quizzes) {
      (quiz.questions ?? []).forEach((q, i) => {
        if (!(q.questionText ?? '').trim()) bad.push(`${quizId(quiz)} Q${i + 1}: empty text`);
        if (!Array.isArray(q.options) || q.options.length === 0) {
          bad.push(`${quizId(quiz)} Q${i + 1}: no options`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it('every question has at least one correct option', () => {
    const bad: string[] = [];
    for (const quiz of quizzes) {
      (quiz.questions ?? []).forEach((q, i) => {
        if ((q.options ?? []).filter(isCorrect).length === 0) {
          bad.push(`${quizId(quiz)} Q${i + 1}: no correct option`);
        }
      });
    }
    expect(bad).toEqual([]);
  });

  it('every option has non-empty text', () => {
    const bad: string[] = [];
    for (const quiz of quizzes) {
      (quiz.questions ?? []).forEach((q, i) => {
        (q.options ?? []).forEach((opt, j) => {
          if (!String(opt.text ?? '').trim()) {
            bad.push(`${quizId(quiz)} Q${i + 1} option ${j + 1}: empty text`);
          }
        });
      });
    }
    expect(bad).toEqual([]);
  });
});
