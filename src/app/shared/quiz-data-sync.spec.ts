import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards against the two-quiz-file trap.
 *
 * The app loads quiz data from TWO files that must stay in sync:
 *   - assets/data/quiz.json  — the DISPLAY source (a bare array), fetched by the
 *     quiz-data loaders to render questions.
 *   - assets/quiz.json       — the PRISTINE/CORRECTNESS source ({ quizzes: [...] }),
 *     fetched by the bootstrap APP_INITIALIZER into getQuizData()/quizInitialState,
 *     which the dot/scoring pipeline reads to decide correct vs wrong.
 *
 * A quiz (or a correct-answer change) added to only ONE file will render but score
 * wrong (or vice-versa) — a silent, confusing bug. This test fails the moment the
 * two files diverge on quiz ids, question text, or correct-answer sets, so adding
 * a new quiz is safe: update both files or this test goes red.
 */

const read = (p: string): any =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), p), 'utf8'));

const norm = (s: string): string =>
  (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

const quizMap = (quizzes: any[]): Map<string, any> => {
  const m = new Map<string, any>();
  for (const q of quizzes) m.set(q.quizId ?? q.id, q);
  return m;
};

const correctTexts = (question: any): string[] =>
  (question.options ?? [])
    .filter((o: any) => o?.correct === true)
    .map((o: any) => norm(o.text))
    .sort();

describe('quiz data files stay in sync (assets/quiz.json <-> assets/data/quiz.json)', () => {
  const display: any[] = read('src/assets/data/quiz.json');            // bare array
  const pristine: any[] = read('src/assets/quiz.json').quizzes ?? [];   // { quizzes: [...] }
  const dMap = quizMap(display);
  const pMap = quizMap(pristine);

  it('has the same quiz ids in both files', () => {
    expect([...dMap.keys()].sort()).toEqual([...pMap.keys()].sort());
  });

  it('each quiz has matching questions and correct answers in both files', () => {
    for (const [id, dq] of dMap) {
      const pq = pMap.get(id);
      expect(pq).toBeDefined(); // quiz "id" must exist in assets/quiz.json too

      const dQs: any[] = dq.questions ?? [];
      const pQs: any[] = pq.questions ?? [];
      expect(dQs.length).toBe(pQs.length);

      const pByText = new Map<string, any>(pQs.map((q: any) => [norm(q.questionText), q]));
      for (const dQ of dQs) {
        const pQ = pByText.get(norm(dQ.questionText));
        // Question text present in both, with identical correct-answer sets.
        expect(pQ).toBeDefined();
        expect(correctTexts(dQ)).toEqual(correctTexts(pQ));
      }
    }
  });
});
