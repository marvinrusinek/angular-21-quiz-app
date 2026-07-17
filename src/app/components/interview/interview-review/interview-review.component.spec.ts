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

  function setup(answers: Record<number, number[]> = {}) {
    fixture = TestBed.createComponent(InterviewReviewComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('questions', questions);
    fixture.componentRef.setInput('answersByIndex', answers);
    fixture.detectChanges();
  }

  const itemEls = () => Array.from(fixture.nativeElement.querySelectorAll('.rv-item')) as HTMLElement[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [InterviewReviewComponent] }).compileComponents();
  });

  it('classifies each question as correct / incorrect / unanswered', () => {
    setup({ 0: [1], 1: [4] });   // Q1 correct, Q2 wrong, Q3 unanswered
    const statuses = component.items().map((i) => i.status);
    expect(statuses).toEqual(['correct', 'incorrect', 'unanswered']);
    expect(component.correctCount()).toBe(1);
    expect(component.incorrectCount()).toBe(2);   // incorrect + unanswered
  });

  it('shows the correct answer, the user answer, and the explanation', () => {
    setup({ 1: [4] });   // Q2 answered wrong
    const q2 = component.items()[1];
    const correctOpt = q2.options.find((o) => o.text === 'C')!;
    const wrongPick = q2.options.find((o) => o.text === 'D')!;
    expect(component.optionClass(correctOpt)).toBe('rv-correct');
    expect(component.optionLabel(correctOpt)).toBe('Correct answer');
    expect(component.optionClass(wrongPick)).toBe('rv-wrong');
    expect(component.optionLabel(wrongPick)).toBe('Your answer ✗');
    expect(fixture.nativeElement.textContent).toContain('E2');   // explanation shown
  });

  it('labels a correct pick as the user answer', () => {
    setup({ 0: [1] });
    const picked = component.items()[0].options.find((o) => o.text === 'A')!;
    expect(component.optionLabel(picked)).toBe('Your answer ✓');
  });

  it('filters by all / correct / incorrect', () => {
    setup({ 0: [1], 1: [4] });
    expect(itemEls().length).toBe(3);

    component.setFilter('correct');
    fixture.detectChanges();
    expect(itemEls().length).toBe(1);

    component.setFilter('incorrect');
    fixture.detectChanges();
    expect(itemEls().length).toBe(2);   // wrong + unanswered

    component.setFilter('all');
    fixture.detectChanges();
    expect(itemEls().length).toBe(3);
  });
});
