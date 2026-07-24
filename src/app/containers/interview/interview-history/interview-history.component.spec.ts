import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { InterviewAttemptHistoryEntry, InterviewCompletionReason } from '../../../shared/models/interview-history.model';
import { SK_INTERVIEW_HISTORY } from '../../../shared/constants/session-keys';
import { InterviewReadinessService } from '../../../shared/services/features/interview/interview-readiness.service';
import { InterviewHistoryComponent } from './interview-history.component';

// Stub readiness so the list spec doesn't pull in the QuizDataService chain
// (its own service spec covers readiness). The component only reads `readiness()`.
const readinessStub = { readiness: () => null } as unknown as InterviewReadinessService;

function entry(
  pct: number,
  i: number,
  reason: InterviewCompletionReason = 'submitted'
): InterviewAttemptHistoryEntry {
  return {
    id: `att-${i}`,
    completedAt: `2026-07-${String(10 + i).padStart(2, '0')}T10:00:00.000Z`,
    score: pct,
    totalQuestions: 100,
    percentage: pct,
    completionReason: reason,
    durationSeconds: 1471,
    configuredDifficulty: 'mixed',
    selectedTopicIds: ['forms', 'http'],
    topicPerformance: [
      { topicId: 'forms', topicName: 'Forms', correct: pct, total: 100, percentage: pct },
      { topicId: 'http', topicName: 'HTTP', correct: pct, total: 100, percentage: pct }
    ]
  };
}

function seed(attempts: InterviewAttemptHistoryEntry[]): void {
  localStorage.setItem(SK_INTERVIEW_HISTORY, JSON.stringify({ version: 1, attempts }));
}

function render(): ComponentFixture<InterviewHistoryComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [InterviewHistoryComponent],
    providers: [provideRouter([]), { provide: InterviewReadinessService, useValue: readinessStub }]
  });
  const fixture = TestBed.createComponent(InterviewHistoryComponent);
  fixture.detectChanges();
  return fixture;
}

describe('InterviewHistoryComponent', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('2. shows the empty state when there is no history', () => {
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.interview-history__empty')?.textContent).toContain('No completed interviews yet');
    expect(el.querySelector('.ih-card')).toBeNull();
  });

  it('4/5. lists attempts newest first with chronological numbers', () => {
    seed([entry(70, 1), entry(80, 2), entry(90, 3)]);
    const el = render().nativeElement as HTMLElement;
    const titles = Array.from(el.querySelectorAll('.ih-card__title')).map((n) => n.textContent?.trim());
    expect(titles).toEqual(['Interview #3', 'Interview #2', 'Interview #1']);
    // Newest (90%) card is first.
    expect(el.querySelector('.ih-card__pct')?.textContent).toContain('90%');
  });

  it('11-14. summary metrics reuse the shared trends', () => {
    seed([entry(70, 1), entry(90, 2), entry(84, 3)]);
    const dds = Array.from((render().nativeElement as HTMLElement).querySelectorAll('.ih-summary dd')).map(
      (n) => n.textContent?.trim()
    );
    // Completed / Best / Average / Latest
    expect(dds).toEqual(['3', '90%', '81%', '84%']);
  });

  it('6/7/8. filters by completion reason (client-side)', () => {
    seed([entry(70, 1, 'submitted'), entry(50, 2, 'time-expired'), entry(90, 3, 'submitted')]);
    const fixture = render();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelectorAll('.ih-card')).toHaveLength(3);   // All

    const filters = el.querySelectorAll<HTMLButtonElement>('.ih-filter');
    // filters: [All, Submitted, Time Expired]
    filters[1].click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.ih-card')).toHaveLength(2);   // Submitted

    filters[2].click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.ih-card')).toHaveLength(1);   // Time Expired
    expect(el.querySelector('.ih-card__badge')?.textContent).toContain('Time expired');
  });

  it('9. each card links to that attempt\'s read-only summary', () => {
    seed([entry(70, 1)]);
    const link = (render().nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('.ih-card__actions a');
    expect(link?.textContent).toContain('View Summary');
    expect(link?.getAttribute('href')).toContain('/interview/history/att-1');
  });

  it('shows a direct "Review Answers" shortcut (deep-linked to #review) only when answers were retained', () => {
    const withReview: InterviewAttemptHistoryEntry = {
      ...entry(70, 1),
      review: [
        {
          questionText: 'Q', explanation: '',
          options: [{ optionId: 1, text: 'A', correct: true }],
          selectedOptionIds: [1]
        }
      ]
    };
    seed([withReview, entry(80, 2)]);   // #2 has no review
    const cards = Array.from((render().nativeElement as HTMLElement).querySelectorAll('.ih-card'));
    // Newest first → card[0] is #2 (no review), card[1] is #1 (has review).
    const links = (card: Element) => Array.from(card.querySelectorAll<HTMLAnchorElement>('.ih-card__actions a'));
    const noReview = links(cards[0]).map((a) => a.textContent?.trim());
    const hasReview = links(cards[1]);
    expect(noReview).toEqual(['View Summary']);
    const review = hasReview.find((a) => a.textContent?.includes('Review Answers'));
    expect(review).toBeTruthy();
    expect(review!.getAttribute('href')).toContain('/interview/history/att-1#review');
  });

  it('orders the page summary → interviews → readiness → topic trends', () => {
    seed([entry(70, 1)]);
    const el = render().nativeElement as HTMLElement;
    const nodes = ['.ih-summary', '#interviews', '.interview-history__readiness', '#topic-trends'].map(
      (sel) => el.querySelector(sel)
    );
    nodes.forEach((n) => expect(n).not.toBeNull());
    // The interviews list contains the cards, and each section precedes the next.
    expect(el.querySelector('#interviews .ih-card')).not.toBeNull();
    for (let i = 0; i < nodes.length - 1; i++) {
      const rel = nodes[i]!.compareDocumentPosition(nodes[i + 1]!);
      expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('jumpToInterviews smooth-scrolls the interviews section into view', () => {
    seed([entry(70, 1)]);
    const fixture = render();
    const section = (fixture.nativeElement as HTMLElement).querySelector('#interviews') as HTMLElement;
    const scroll = jest.fn();
    section.scrollIntoView = scroll;
    fixture.componentInstance.jumpToInterviews();
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('16. filters are real buttons and actions are real links (keyboard-operable)', () => {
    seed([entry(70, 1)]);
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('.ih-filter')?.tagName).toBe('BUTTON');
    expect(el.querySelector('.ih-filter')?.getAttribute('aria-pressed')).toBe('true'); // All active by default
    expect(el.querySelector('.ih-card__actions a')?.tagName).toBe('A');
  });

  it('shows "Not recorded" instead of 0s when a duration was never retained', () => {
    const noDuration = entry(70, 1);
    delete noDuration.durationSeconds;
    seed([noDuration]);
    const el = render().nativeElement as HTMLElement;
    const durationDd = Array.from(el.querySelectorAll('.ih-card__stats div')).find((d) =>
      d.querySelector('dt')?.textContent?.includes('Duration')
    );
    expect(durationDd?.querySelector('dd')?.textContent?.trim()).toBe('Not recorded');
  });

  it('numbers cards by persisted attemptNumber when present', () => {
    // Simulate a retained window that starts at attempt #6 (older ones aged out).
    seed([
      { ...entry(70, 1), attemptNumber: 6 },
      { ...entry(80, 2), attemptNumber: 7 }
    ]);
    const titles = Array.from((render().nativeElement as HTMLElement).querySelectorAll('.ih-card__title')).map(
      (n) => n.textContent?.trim()
    );
    expect(titles).toEqual(['Interview #7', 'Interview #6']);
  });

  it('shows a no-match message when a filter excludes everything', () => {
    seed([entry(70, 1, 'submitted')]);
    const fixture = render();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelectorAll<HTMLButtonElement>('.ih-filter')[2].click();  // Time Expired
    fixture.detectChanges();
    expect(el.querySelector('.interview-history__none')?.textContent).toContain('No interviews match');
  });
});
