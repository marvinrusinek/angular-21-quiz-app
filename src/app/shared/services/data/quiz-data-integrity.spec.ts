/**
 * DATA-INTEGRITY GUARD for the two quiz sources.
 *
 * The app reads quiz data from TWO files that must stay in sync:
 *   - assets/quiz.json       → loaded in main.ts → pristine `quizInitialState`
 *                              (the source of truth for correctness: scoring,
 *                              feedback "Option N" labels, and the answer SOUND).
 *   - assets/data/quiz.json  → loaded by quiz-data-loader/quizdata → the
 *                              DISPLAYED questions/options the user clicks.
 *
 * Nothing at runtime keeps them aligned, so a divergence is invisible until a
 * user notices wrong behavior. On 2026-06-20 a stray `", "correct` appended to
 * component-tree Q2's correct option text in assets/quiz.json made the pristine
 * text-match fail, so the correct answer played the INCORRECT sound. This guard
 * would have caught that at test time: both files must parse and agree on every
 * question's text and its set of correct-answer texts.
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

// Relative to the jest working directory (the project root). readFileSync
// resolves these against cwd at runtime, so no node `process`/`path` types needed.
const PRISTINE_PATH = 'src/assets/quiz.json';
const DISPLAYED_PATH = 'src/assets/data/quiz.json';

// LIGHT normalization for comparing the two data FILES: collapse whitespace,
// trim, lowercase. Deliberately does NOT strip HTML tags — several options are
// literal HTML code shown as text (e.g. '<button [style.color]="blue">'), and
// tag-stripping would erase them. The goal here is "do the two files hold the
// same text", which raw comparison answers directly (and still catches the kind
// of corruption that appended `", "correct` to an option text this session).
function norm(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isCorrect(o: RawOption): boolean {
  const c = o?.correct;
  return c === true || c === 'true' || c === 1 || c === '1';
}

function parseQuizzes(path: string): { json: unknown; quizzes: RawQuiz[] } {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const quizzes = Array.isArray(json) ? json : ((json as any)?.quizzes ?? []);
  return { json, quizzes };
}

function quizKey(q: RawQuiz): string {
  return q.quizId ?? q.id ?? '';
}

function byId(quizzes: RawQuiz[]): Map<string, RawQuiz> {
  const map = new Map<string, RawQuiz>();
  for (const q of quizzes) map.set(quizKey(q), q);
  return map;
}

function correctTextSet(question: RawQuestion): string[] {
  return (question.options ?? [])
    .filter(isCorrect)
    .map((o) => norm(o.text))
    .filter((t) => !!t)
    .sort();
}

describe('quiz data integrity (assets/quiz.json ↔ assets/data/quiz.json)', () => {
  let pristine: RawQuiz[];
  let displayed: RawQuiz[];

  beforeAll(() => {
    expect(() => parseQuizzes(PRISTINE_PATH)).not.toThrow();
    expect(() => parseQuizzes(DISPLAYED_PATH)).not.toThrow();
    pristine = parseQuizzes(PRISTINE_PATH).quizzes;
    displayed = parseQuizzes(DISPLAYED_PATH).quizzes;
  });

  it('both files contain the same set of quiz ids', () => {
    const pIds = [...byId(pristine).keys()].sort();
    const dIds = [...byId(displayed).keys()].sort();
    expect(pIds).toEqual(dIds);
  });

  it('each quiz has the same number of questions in both files', () => {
    const p = byId(pristine);
    const d = byId(displayed);
    for (const [id, pq] of p) {
      const dq = d.get(id);
      expect(dq).toBeDefined();
      expect((pq.questions ?? []).length).toBe((dq!.questions ?? []).length);
    }
  });

  it('every question text matches between the two sources', () => {
    const p = byId(pristine);
    const d = byId(displayed);
    const mismatches: string[] = [];
    for (const [id, pq] of p) {
      const dq = d.get(id);
      const pQs = pq.questions ?? [];
      const dQs = dq?.questions ?? [];
      const n = Math.min(pQs.length, dQs.length);
      for (let i = 0; i < n; i++) {
        if (norm(pQs[i].questionText) !== norm(dQs[i].questionText)) {
          mismatches.push(`${id} Q${i + 1}: "${pQs[i].questionText}" vs "${dQs[i].questionText}"`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every question has the SAME set of correct-answer texts in both sources', () => {
    const p = byId(pristine);
    const d = byId(displayed);
    const mismatches: string[] = [];
    for (const [id, pq] of p) {
      const dq = d.get(id);
      const pQs = pq.questions ?? [];
      const dQs = dq?.questions ?? [];
      const n = Math.min(pQs.length, dQs.length);
      for (let i = 0; i < n; i++) {
        const pc = correctTextSet(pQs[i]);
        const dc = correctTextSet(dQs[i]);
        if (JSON.stringify(pc) !== JSON.stringify(dc)) {
          mismatches.push(`${id} Q${i + 1}: pristine=${JSON.stringify(pc)} displayed=${JSON.stringify(dc)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every question has at least one correct answer in both sources', () => {
    const offenders: string[] = [];
    for (const quizzes of [pristine, displayed]) {
      for (const quiz of quizzes) {
        (quiz.questions ?? []).forEach((q, i) => {
          const correctCount = (q.options ?? []).filter(isCorrect).length;
          if (correctCount === 0) {
            offenders.push(`${quizKey(quiz)} Q${i + 1}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
