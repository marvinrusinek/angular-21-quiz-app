import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InterviewPaginatorComponent } from './interview-paginator.component';

describe('InterviewPaginatorComponent', () => {
  let fixture: ComponentFixture<InterviewPaginatorComponent>;
  let component: InterviewPaginatorComponent;

  function setup(total: number, current: number, answered: ReadonlySet<number> = new Set()) {
    fixture = TestBed.createComponent(InterviewPaginatorComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('total', total);
    fixture.componentRef.setInput('currentIndex', current);
    fixture.componentRef.setInput('answered', answered);
    fixture.detectChanges();
  }

  const pageButtons = () =>
    Array.from(fixture.nativeElement.querySelectorAll('.pg-page')) as HTMLButtonElement[];
  const pageNumbers = () => pageButtons().map((b) => Number(b.textContent!.trim()));

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [InterviewPaginatorComponent] }).compileComponents();
  });

  it('renders numeric page buttons on desktop', () => {
    setup(20, 7);
    expect(pageButtons().length).toBeGreaterThan(0);
  });

  it('always represents the current question', () => {
    setup(20, 7);
    const current = fixture.nativeElement.querySelector('.pg-page.current') as HTMLButtonElement;
    expect(current).toBeTruthy();
    expect(Number(current.textContent!.trim())).toBe(8);   // 0-based 7 → shown "8"
    expect(current.getAttribute('aria-current')).toBe('true');
  });

  it('shows the first and last question', () => {
    setup(20, 7);
    const nums = pageNumbers();
    expect(nums).toContain(1);
    expect(nums).toContain(20);
  });

  it('shows ellipses for omitted ranges', () => {
    setup(20, 7);
    const ellipses = fixture.nativeElement.querySelectorAll('.pg-ellipsis');
    expect(ellipses.length).toBe(2);   // 1 … 6 7 8 9 10 … 20
  });

  it('does not render ellipses when everything fits', () => {
    setup(5, 2);
    expect(fixture.nativeElement.querySelectorAll('.pg-ellipsis').length).toBe(0);
    expect(pageNumbers()).toEqual([1, 2, 3, 4, 5]);
  });

  it('emits the target index when a page is clicked', () => {
    setup(20, 7);
    const emitted: number[] = [];
    component.select.subscribe((i) => emitted.push(i));
    const last = pageButtons().find((b) => b.textContent!.trim() === '20')!;
    last.click();
    expect(emitted).toEqual([19]);   // "20" → 0-based 19
  });

  it('ellipses are not interactive (rendered as non-button list items)', () => {
    setup(30, 15);
    const ellipsis = fixture.nativeElement.querySelector('.pg-ellipsis') as HTMLElement;
    expect(ellipsis.tagName.toLowerCase()).toBe('li');
    expect(ellipsis.querySelector('button')).toBeNull();
    expect(ellipsis.getAttribute('aria-hidden')).toBe('true');
  });

  it('conveys answered state without color (underline class + accessible label)', () => {
    setup(10, 3, new Set([2]));   // current Q4; Q3 answered; window covers Q1–Q6 + Q10
    const q3 = pageButtons().find((b) => b.textContent!.trim() === '3')!;
    expect(q3.classList.contains('answered')).toBe(true);
    expect(q3.getAttribute('aria-label')).toBe('Go to question 3, answered');

    const q5 = pageButtons().find((b) => b.textContent!.trim() === '5')!;
    expect(q5.classList.contains('answered')).toBe(false);
    expect(q5.getAttribute('aria-label')).toBe('Go to question 5, not answered');
  });

  it('never exposes correctness on any page', () => {
    setup(10, 0, new Set([1, 2]));
    for (const b of pageButtons()) {
      expect(b.className).not.toMatch(/correct|incorrect|wrong|right/i);
      expect(b.getAttribute('aria-label')).not.toMatch(/correct|incorrect|wrong/i);
    }
  });

  it('disables Prev at the first question and Next at the last', () => {
    setup(20, 0);
    const prev = fixture.nativeElement.querySelector('.pg-prev') as HTMLButtonElement;
    const next = fixture.nativeElement.querySelector('.pg-next') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    setup(20, 19);
    const prev2 = fixture.nativeElement.querySelector('.pg-prev') as HTMLButtonElement;
    const next2 = fixture.nativeElement.querySelector('.pg-next') as HTMLButtonElement;
    expect(prev2.disabled).toBe(false);
    expect(next2.disabled).toBe(true);
  });

  it('renders the compact "Question X of Y" indicator for mobile', () => {
    setup(20, 7);
    const compact = fixture.nativeElement.querySelector('.pg-compact') as HTMLElement;
    expect(compact.textContent!.replace(/\s+/g, ' ').trim()).toBe('Question 8 of 20');
  });
});
