import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';

import { ProgressPanelComponent } from './progress-panel.component';
import { ProgressSummary } from '../../shared/models/progress.model';
import { QuizCardProgressState } from '../quiz-card-progress/quiz-card-progress.component';

function summary(overrides: Partial<ProgressSummary> = {}): ProgressSummary {
  return {
    completedCount: 3,
    totalCount: 15,
    completionPercentage: 20,
    byDifficulty: [
      { difficulty: 'beginner', completed: 2, total: 4 },
      { difficulty: 'intermediate', completed: 1, total: 6 }
    ],
    strongestQuiz: { quizId: 'di', milestone: 'Dependency Injection', bestScore: 100 },
    weakestQuiz: { quizId: 'rx', milestone: 'RxJS', bestScore: 60 },
    averageScore: 80,
    perfectScores: 1,
    questionsCompleted: 30,
    ...overrides
  };
}

describe('ProgressPanelComponent', () => {
  let fixture: ComponentFixture<ProgressPanelComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ProgressPanelComponent, NoopAnimationsModule]
    });
    fixture = TestBed.createComponent(ProgressPanelComponent);
  });

  const set = (states: QuizCardProgressState[], s: ProgressSummary | null = summary()): void => {
    fixture.componentRef.setInput('cardStates', states);
    fixture.componentRef.setInput('summary', s);
    fixture.detectChanges();
  };
  const panel = (): HTMLElement | null => fixture.nativeElement.querySelector('mat-expansion-panel');
  const header = (): HTMLElement | null => fixture.nativeElement.querySelector('mat-expansion-panel-header');
  const details = (): HTMLElement | null => fixture.nativeElement.querySelector('.progress-summary');

  // 1
  it('is hidden when no quiz has been started or completed', () => {
    set(['not-started', 'not-started', 'not-started']);
    expect(panel()).toBeNull();
  });

  // 2
  it('appears when at least one quiz is In Progress', () => {
    set(['not-started', 'in-progress', 'not-started']);
    expect(panel()).toBeTruthy();
  });

  // 3
  it('appears when at least one quiz is Completed', () => {
    set(['completed', 'not-started']);
    expect(panel()).toBeTruthy();
  });

  // 4
  it('is collapsed by default', () => {
    set(['completed']);
    // The Material header carries aria-expanded="false" until toggled.
    const button = header()?.querySelector('[role="button"]') ?? header();
    expect(button?.getAttribute('aria-expanded')).toBe('false');
  });

  // 5
  it('header shows the completed count and percentage', () => {
    set(['completed'], summary({ completedCount: 3, totalCount: 15, completionPercentage: 20 }));
    const text = (header()?.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(text).toContain('Your Progress');
    expect(text).toContain('3 of 15 completed');
    expect(text).toContain('20%');
  });

  // 6
  it('reveals the detailed breakdown after expanding', () => {
    set(['completed']);
    header()?.click();
    fixture.detectChanges();
    const text = (details()?.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(text).toContain('Overall Progress');        // overall bar
    expect(text).toContain('Beginner');                // difficulty bar
    expect(text).toContain('Dependency Injection');    // strongest
    expect(text).toContain('RxJS');                    // needs review
  });

  it('does not render for a null summary even with activity', () => {
    set(['completed'], null);
    expect(panel()).toBeNull();
  });
});
