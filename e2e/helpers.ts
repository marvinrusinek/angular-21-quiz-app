import * as fs from 'fs';
import * as path from 'path';

/** Shared helpers for the e2e specs: quiz data lookup + common selectors. */

export const quizData = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'src/assets/data/quiz.json'), 'utf8')
);

export const tsQuiz = quizData.find((q: any) => (q.quizId || q.id) === 'typescript');
export const formsQuiz = quizData.find((q: any) => (q.quizId || q.id) === 'forms');

export const HEADING = 'codelab-quiz-content h3';
export const FEEDBACK = 'codelab-quiz-feedback';
export const NEXT_BTN = '.nav-btn[aria-label="Next Question"]';
export const PREV_BTN = '.nav-btn[aria-label="Previous Question"]';
export const RESULTS_BTN = '.show-results-btn';

export const norm = (s: string) =>
  (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// The question heading is rendered via innerHTML, so any `<...>` in the
// text (e.g. "Array<number>") is parsed as an HTML tag and dropped by the
// browser. Strip tag-like sequences from both sides before comparing.
const stripTags = (s: string) => (s || '').replace(/<[^>]*>/g, ' ');

export function isCorrect(o: any): boolean {
  return o?.correct === true || o?.correct === 'true' || o?.correct === 1;
}

export function correctIndices(q: any): number[] {
  return (q?.options ?? [])
    .map((o: any, i: number) => (isCorrect(o) ? i : -1))
    .filter((i: number) => i >= 0);
}

/** Resolve the quiz question whose text the heading begins with. */
export function findTsQuestion(headingText: string): any {
  const qt = norm(stripTags(headingText));
  return tsQuiz.questions.find((qq: any) =>
    qt.startsWith(norm(stripTags(qq.questionText)))
  );
}

/** The single correct option index for the question shown in the heading. */
export function correctIndexForHeading(headingText: string): number {
  const q = findTsQuestion(headingText);
  return q ? correctIndices(q)[0] ?? -1 : -1;
}
