import { ComponentFixture, TestBed } from '@angular/core/testing';

import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';
import { InterviewResult } from '../../../shared/models/InterviewResult.model';
import { InterviewReviewComponent } from './interview-review.component';
import {
  countReviewStatuses,
  getCorrectAnswerLabels,
  getReviewOptionLabel,
  getReviewOptionState,
  getReviewQuestionStatus,
  getReviewQuestionType,
  joinWithAnd
} from './interview-review-status';

// Q1 single (A correct), Q2 multi (C+E correct), Q3 true/false (True correct)
const questions: QuizQuestion[] = [
  { questionText: 'Q1', explanation: 'E1', options: [{ text: 'A', correct: true, optionId: 1 }, { text: 'B', optionId: 2 }] },
  { questionText: 'Q2', explanation: 'E2', options: [{ text: 'C', correct: true, optionId: 3 }, { text: 'D', optionId: 4 }, { text: 'E', correct: true, optionId: 5 }] },
  { questionText: 'Q3', explanation: '', options: [{ text: 'True', correct: true, optionId: 6 }, { text: 'False', optionId: 7 }] }
];

// ── pure helpers ──────────────────────────────────────────────────────
describe('interview-review-status helpers', () => {
  const single = questions[0];
  const multi = questions[1];
  const tf = questions[2];

  it('1/2/3. single-answer status: correct / incorrect / unanswered', () => {
    expect(getReviewQuestionStatus(single, [1])).toBe('correct');
    expect(getReviewQuestionStatus(single, [2])).toBe('incorrect');
    expect(getReviewQuestionStatus(single, [])).toBe('unanswered');
  });

  it('4/5/6/7. multi-answer status (exact set, no partial credit)', () => {
    expect(getReviewQuestionStatus(multi, [3, 5])).toBe('correct');       // exact
    expect(getReviewQuestionStatus(multi, [3])).toBe('incorrect');        // partial
    expect(getReviewQuestionStatus(multi, [3, 5, 4])).toBe('incorrect');  // extra wrong
    expect(getReviewQuestionStatus(multi, [])).toBe('unanswered');
  });

  it('8. true/false classified correctly', () => {
    expect(getReviewQuestionStatus(tf, [6])).toBe('correct');
    expect(getReviewQuestionStatus(tf, [7])).toBe('incorrect');
  });

  it('9/10/11/12/13. option state', () => {
    expect(getReviewOptionState(true, true)).toBe('correct-selected');
    expect(getReviewOptionState(false, true)).toBe('incorrect-selected');
    expect(getReviewOptionState(true, false)).toBe('correct-missed');
    expect(getReviewOptionState(false, false)).toBe('neutral');
    // Independent per option (C selected-correct, E correct-missed).
    expect(getReviewOptionState(true, true)).toBe('correct-selected');
    expect(getReviewOptionState(true, false)).toBe('correct-missed');
  });

  it('option labels are descriptive text (not colour-only)', () => {
    expect(getReviewOptionLabel('correct-selected')).toContain('Correct');
    expect(getReviewOptionLabel('incorrect-selected')).toContain('Incorrect');
    expect(getReviewOptionLabel('correct-missed')).toBe('Correct answer');
    expect(getReviewOptionLabel('neutral')).toBe('');
  });

  it('question type labels (from type or inferred)', () => {
    expect(getReviewQuestionType(single)).toBe('Single Answer');
    expect(getReviewQuestionType(multi)).toBe('Multiple Answer');
    expect(getReviewQuestionType(tf)).toBe('True / False');
  });

  it('correct-answer labels + grammatical join', () => {
    expect(getCorrectAnswerLabels(multi.options)).toEqual(['C', 'E']);
    expect(joinWithAnd(['C', 'E'])).toBe('C and E');
    expect(joinWithAnd(['A', 'B', 'C'])).toBe('A, B and C');
    expect(joinWithAnd(['A'])).toBe('A');
  });

  it('14-17. status counts sum to total', () => {
    const c = countReviewStatuses(['correct', 'incorrect', 'unanswered', 'correct']);
    expect(c).toEqual({ correct: 2, incorrect: 1, unanswered: 1, total: 4 });
    expect(c.correct + c.incorrect + c.unanswered).toBe(c.total);
  });
});

// ── component ─────────────────────────────────────────────────────────
describe('InterviewReviewComponent', () => {
  let fixture: ComponentFixture<InterviewReviewComponent>;
  let component: InterviewReviewComponent;

  function result(over: Partial<InterviewResult> = {}): InterviewResult {
    return {
      total: 3, answered: 2, unanswered: 1, correct: 1, incorrect: 1, percentage: 33,
      timeUsedSeconds: 0, timeRemainingSeconds: 0, difficulty: 'mixed', topicIds: [],
      perTopic: [], submittedByExpiry: false, focusChanges: 0, ...over
    };
  }

  function setup(answers: Record<number, number[]> = {}, res: InterviewResult | null = null, flaggingEnabled = false) {
    fixture = TestBed.createComponent(InterviewReviewComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('questions', questions);
    fixture.componentRef.setInput('answersByIndex', answers);
    fixture.componentRef.setInput('result', res);
    fixture.componentRef.setInput('flaggingEnabled', flaggingEnabled);
    fixture.detectChanges();
  }

  const el = () => fixture.nativeElement as HTMLElement;
  const itemEls = () => Array.from(el().querySelectorAll('.rv-item')) as HTMLElement[];
  const chipIds = () =>
    Array.from(el().querySelectorAll('.rv-filter')).map((b) =>
      (b as HTMLElement).getAttribute('aria-label')!.split(',')[0].toLowerCase()
    );

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [InterviewReviewComponent] }).compileComponents();
  });

  // Q1 correct, Q2 answered-wrong (partial), Q3 unanswered
  const MIXED = { 0: [1], 1: [3] };

  it('classifies each question as correct / incorrect / unanswered', () => {
    setup(MIXED);
    expect(component.items().map((i) => i.status)).toEqual(['correct', 'incorrect', 'unanswered']);
  });

  it('31/32/33/34/35/36/37. renders number, topic/type, answer states, missed correct, explanation, unanswered msg, status', () => {
    setup(MIXED, result({ perTopic: [{ quizId: 'q', title: 'Signals', correct: 0, total: 0, percentage: 0 }] as never }));
    // Type labels for each question.
    expect(el().textContent).toContain('Multiple Answer');
    // Q2 (incorrect multi): C selected-correct, E correct-missed, D neutral.
    const q2 = component.items()[1];
    expect(q2.options.find((o) => o.text === 'C')!.state).toBe('correct-selected');
    expect(q2.options.find((o) => o.text === 'E')!.state).toBe('correct-missed');
    expect(q2.options.find((o) => o.text === 'D')!.state).toBe('neutral');
    // Correct-answer summary for the multi-answer question.
    expect(q2.correctSummary).toBe('C and E');
    // Explanation heading + text.
    expect(el().querySelector('.rv-explanation__heading')?.textContent).toContain('Explanation');
    expect(el().textContent).toContain('E2');
    // Unanswered message for Q3.
    expect(el().querySelector('.rv-unanswered')?.textContent).toContain('did not answer');
    // Status badges present as text.
    expect(el().textContent).toContain('Correct');
    expect(el().textContent).toContain('Incorrect');
    expect(el().textContent).toContain('Unanswered');
  });

  it('18. summary uses the submitted result as the source of truth', () => {
    setup(MIXED, result({ correct: 5, incorrect: 4, unanswered: 2, total: 11 }));
    expect(component.summary()).toMatchObject({ correct: 5, incorrect: 4, unanswered: 2, total: 11 });
    const dds = Array.from(el().querySelectorAll('.rv-summary dd')).map((d) => d.textContent?.trim());
    expect(dds).toEqual(['5 / 11', '5', '4', '2']);
  });

  it('summary falls back to the per-question tally when no result is supplied', () => {
    setup(MIXED, null);
    expect(component.summary()).toEqual({ correct: 1, incorrect: 1, unanswered: 1, total: 3 });
  });

  // ── filters ─────────────────────────────────────────────────────────
  it('19-24. filter counts + order (All / Incorrect / Unanswered / Correct)', () => {
    setup(MIXED);
    expect(chipIds()).toEqual(['all', 'incorrect', 'unanswered', 'correct']);
    expect(component.counts()).toEqual({ all: 3, incorrect: 1, unanswered: 1, correct: 1, flagged: 0 });
  });

  it('20/21/22/23. each filter shows only its questions, preserving order', () => {
    setup({ 0: [1], 1: [3], 2: [7] });   // Q1 correct, Q2 incorrect, Q3 incorrect (False)
    component.setFilter('incorrect'); fixture.detectChanges();
    expect(component.filtered().map((i) => i.number)).toEqual([2, 3]);   // original order
    expect(component.filtered().every((i) => i.status === 'incorrect')).toBe(true);
    component.setFilter('correct'); fixture.detectChanges();
    expect(itemEls().length).toBe(1);
  });

  it('24. empty filter result shows a friendly state', () => {
    setup({ 0: [1], 1: [3, 5], 2: [6] });   // all correct → nothing incorrect
    component.setFilter('incorrect'); fixture.detectChanges();
    expect(itemEls().length).toBe(0);
    expect(el().querySelector('.rv-empty')?.textContent).toContain('No incorrect answers.');
  });

  it('30/navigation-equivalent: switching filters never mutates the underlying answers', () => {
    const answers = { 0: [1], 1: [3] };
    setup(answers);
    component.setFilter('incorrect'); fixture.detectChanges();
    component.setFilter('all'); fixture.detectChanges();
    expect(answers).toEqual({ 0: [1], 1: [3] });   // input object untouched
  });

  // ── accessibility ───────────────────────────────────────────────────
  it('38/40. filters use aria-pressed + singular/plural accessible names', () => {
    setup({ 0: [1] });   // Q1 correct, Q2+Q3 unanswered → incorrect count 0, unanswered 2
    const chips = Array.from(el().querySelectorAll('.rv-filter')) as HTMLElement[];
    expect(chips.filter((c) => c.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    expect(chips.find((c) => c.getAttribute('aria-label')?.startsWith('Correct'))!.getAttribute('aria-label'))
      .toBe('Correct, 1 question');   // singular
    expect(chips.find((c) => c.getAttribute('aria-label')?.startsWith('Unanswered'))!.getAttribute('aria-label'))
      .toBe('Unanswered, 2 questions'); // plural
  });

  it('41. read-only options are list items, not buttons/radios/checkboxes', () => {
    setup(MIXED);
    expect(el().querySelector('.rv-option')?.tagName).toBe('LI');
    expect(el().querySelectorAll('.rv-option button, .rv-option input')).toHaveLength(0);
  });

  it('42. decorative marks are hidden from assistive tech', () => {
    setup(MIXED);
    for (const mark of Array.from(el().querySelectorAll('.rv-badge__mark, .rv-option__mark'))) {
      expect(mark.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('hides the Flagged chip until flagging is enabled', () => {
    setup(MIXED);
    expect(chipIds()).toEqual(['all', 'incorrect', 'unanswered', 'correct']);
  });

  it('embedded mode hides the header meta but keeps the review list', () => {
    setup(MIXED, result());
    expect(el().querySelector('.rv-meta')).not.toBeNull();   // shown by default
    fixture.componentRef.setInput('embedded', true);
    fixture.detectChanges();
    expect(el().querySelector('.rv-meta')).toBeNull();       // suppressed when embedded
    expect(itemEls().length).toBeGreaterThan(0);             // list still renders
  });
});
