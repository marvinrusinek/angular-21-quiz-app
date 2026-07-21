import { ComponentFixture, TestBed } from '@angular/core/testing';

import { QuizQuestion } from '../../../shared/models/QuizQuestion.model';
import { InterviewReviewComponent } from './interview-review.component';

const questions: QuizQuestion[] = [
  { questionText: 'Q1', explanation: 'E1', options: [{ text: 'A', correct: true, optionId: 1 }, { text: 'B', optionId: 2 }] },
  { questionText: 'Q2', explanation: 'E2', options: [{ text: 'C', correct: true, optionId: 3 }, { text: 'D', optionId: 4 }] },
  { questionText: 'Q3', explanation: 'E3', options: [{ text: 'E', correct: true, optionId: 5 }, { text: 'F', optionId: 6 }] }
];

describe('InterviewReviewComponent', () => {
  let fixture: ComponentFixture<InterviewReviewComponent>;
  let component: InterviewReviewComponent;

  function setup(answers: Record<number, number[]> = {}, flaggingEnabled = false) {
    fixture = TestBed.createComponent(InterviewReviewComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('questions', questions);
    fixture.componentRef.setInput('answersByIndex', answers);
    fixture.componentRef.setInput('flaggingEnabled', flaggingEnabled);
    fixture.detectChanges();
  }

  const itemEls = () => Array.from(fixture.nativeElement.querySelectorAll('.rv-item')) as HTMLElement[];
  const chipIds = () =>
    Array.from(fixture.nativeElement.querySelectorAll('.rv-filter')).map((b) =>
      (b as HTMLElement).getAttribute('aria-label')!.split(',')[0].toLowerCase()
    );

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [InterviewReviewComponent] }).compileComponents();
  });

  // Q1 correct, Q2 answered-wrong, Q3 skipped
  const MIXED = { 0: [1], 1: [4] };

  it('classifies each question as correct / incorrect / unanswered', () => {
    setup(MIXED);
    expect(component.items().map((i) => i.status)).toEqual(['correct', 'incorrect', 'unanswered']);
  });

  it('shows the correct answer, the user answer, and the explanation', () => {
    setup({ 1: [4] });
    const q2 = component.items()[1];
    const correctOpt = q2.options.find((o) => o.text === 'C')!;
    const wrongPick = q2.options.find((o) => o.text === 'D')!;
    expect(component.optionClass(correctOpt)).toBe('rv-correct');
    expect(component.optionLabel(correctOpt)).toBe('Correct answer');
    expect(component.optionClass(wrongPick)).toBe('rv-wrong');
    expect(component.optionLabel(wrongPick)).toBe('Your answer ✗');
    expect(fixture.nativeElement.textContent).toContain('E2');
  });

  it('labels a correct pick as the user answer', () => {
    setup({ 0: [1] });
    const picked = component.items()[0].options.find((o) => o.text === 'A')!;
    expect(component.optionLabel(picked)).toBe('Your answer ✓');
  });

  // ── filter counts ──────────────────────────────────────────────────
  it('counts questions per filter from the same predicates', () => {
    setup(MIXED);
    expect(component.counts()).toEqual({ all: 3, incorrect: 1, correct: 1, skipped: 1, flagged: 0 });
  });

  it('updates counts automatically as answers change', () => {
    setup({ 0: [1] });                       // Q1 correct, Q2 + Q3 skipped
    expect(component.counts()).toEqual({ all: 3, incorrect: 0, correct: 1, skipped: 2, flagged: 0 });
    fixture.componentRef.setInput('answersByIndex', MIXED);
    fixture.detectChanges();
    expect(component.counts()).toEqual({ all: 3, incorrect: 1, correct: 1, skipped: 1, flagged: 0 });
  });

  // ── filtering ──────────────────────────────────────────────────────
  it('All shows every question', () => {
    setup(MIXED);
    expect(itemEls().length).toBe(3);
  });

  it('Correct shows only correctly answered questions', () => {
    setup(MIXED);
    component.setFilter('correct');
    fixture.detectChanges();
    expect(itemEls().length).toBe(1);
    expect(component.filtered().every((i) => i.status === 'correct')).toBe(true);
  });

  it('Incorrect shows only answered-wrong questions (NOT skipped)', () => {
    setup(MIXED);
    component.setFilter('incorrect');
    fixture.detectChanges();
    expect(itemEls().length).toBe(1);
    expect(component.filtered().every((i) => i.status === 'incorrect')).toBe(true);
  });

  it('Skipped shows only questions with no answer', () => {
    setup(MIXED);
    component.setFilter('skipped');
    fixture.detectChanges();
    expect(itemEls().length).toBe(1);
    expect(component.filtered().every((i) => i.status === 'unanswered')).toBe(true);
  });

  it('switching filters re-filters the list', () => {
    setup(MIXED);
    component.setFilter('correct'); fixture.detectChanges();
    expect(itemEls().length).toBe(1);
    component.setFilter('skipped'); fixture.detectChanges();
    expect(itemEls().length).toBe(1);
    component.setFilter('all'); fixture.detectChanges();
    expect(itemEls().length).toBe(3);
  });

  // ── empty states ───────────────────────────────────────────────────
  it('shows a friendly empty state (not a blank page) when a filter matches nothing', () => {
    setup({ 0: [1], 1: [3], 2: [5] });       // all correct → nothing incorrect
    component.setFilter('incorrect');
    fixture.detectChanges();
    expect(itemEls().length).toBe(0);
    const empty = fixture.nativeElement.querySelector('.rv-empty');
    expect(empty).toBeTruthy();
    expect(empty.textContent).toContain('Great job!');
    expect(empty.textContent).toContain('No incorrect answers.');
  });

  it('shows the skipped empty message when nothing was skipped', () => {
    setup({ 0: [1], 1: [3], 2: [5] });       // all answered
    component.setFilter('skipped');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.rv-empty').textContent).toContain('No skipped questions.');
  });

  // ── future flagging compatibility ──────────────────────────────────
  it('hides the Flagged chip until flagging is enabled', () => {
    setup(MIXED);
    expect(chipIds()).toEqual(['all', 'incorrect', 'correct', 'skipped']);   // no flagged
    expect(component.visibleFilters().some((f) => f.id === 'flagged')).toBe(false);
  });

  it('reveals the Flagged chip when flagging is enabled, and filters by it', () => {
    setup(MIXED, /* flaggingEnabled */ true);
    expect(chipIds()).toContain('flagged');
    // Nothing is flagged yet → the Flagged filter yields a friendly empty state.
    component.setFilter('flagged');
    fixture.detectChanges();
    expect(itemEls().length).toBe(0);
    expect(fixture.nativeElement.querySelector('.rv-empty').textContent).toContain('No flagged questions.');
    // The predicate is already wired for the future: a flagged item would match.
    expect(component.counts().flagged).toBe(0);
  });

  // ── accessibility ──────────────────────────────────────────────────
  it('marks exactly one chip as aria-pressed and gives each an accessible name', () => {
    setup(MIXED);
    const chips = Array.from(fixture.nativeElement.querySelectorAll('.rv-filter')) as HTMLElement[];
    expect(chips.filter((c) => c.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    expect(chips[0].getAttribute('aria-pressed')).toBe('true');   // All active by default
    expect(chips.find((c) => c.getAttribute('aria-label')?.startsWith('Incorrect'))!.getAttribute('aria-label'))
      .toBe('Incorrect, 1 questions');
  });
});
