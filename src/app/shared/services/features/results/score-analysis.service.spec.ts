import { TestBed } from '@angular/core/testing';

import { QuizQuestion } from '../../../models/QuizQuestion.model';
import { SelectedOptionService } from '../../state/selectedoption.service';
import { ScoreAnalysisService } from './score-analysis.service';

// Minimal stub exposing only the two selection maps buildAnalysis() reads.
class SelectedOptionStub {
  rawSelectionsMap = new Map<number, { optionId?: number; text?: string }[]>();
  selectedOptionsMap = new Map<number, { optionId?: number; text?: string }[]>();
}

function q(questionText: string, opts: { text: string; correct?: boolean; optionId?: number }[]): QuizQuestion {
  return {
    questionText,
    options: opts.map((o, i) => ({
      optionId: o.optionId ?? i,
      text: o.text,
      correct: o.correct === true
    }))
  } as unknown as QuizQuestion;
}

describe('ScoreAnalysisService', () => {
  let service: ScoreAnalysisService;
  let selection: SelectedOptionStub;

  beforeEach(() => {
    selection = new SelectedOptionStub();
    TestBed.configureTestingModule({
      providers: [{ provide: SelectedOptionService, useValue: selection }]
    });
    service = TestBed.inject(ScoreAnalysisService);
  });

  it('marks a single-answer question correct when the correct option is selected', () => {
    const questions = [q('Q1?', [{ text: 'A', correct: true }, { text: 'B' }])];
    selection.rawSelectionsMap.set(0, [{ optionId: 0, text: 'A' }]);

    const [item] = service.buildAnalysis(questions);
    expect(item.wasCorrect).toBe(true);
    expect(item.questionText).toBe('Q1?');
    expect(item.questionIndex).toBe(0);
  });

  it('marks a single-answer question incorrect when the wrong option is selected', () => {
    const questions = [q('Q1?', [{ text: 'A', correct: true }, { text: 'B' }])];
    selection.rawSelectionsMap.set(0, [{ optionId: 1, text: 'B' }]);

    expect(service.buildAnalysis(questions)[0].wasCorrect).toBe(false);
  });

  it('requires ALL correct options for a multi-answer question', () => {
    const questions = [
      q('Q?', [{ text: 'A', correct: true }, { text: 'B', correct: true }, { text: 'C' }])
    ];
    // Only one of the two correct answers selected.
    selection.rawSelectionsMap.set(0, [{ optionId: 0, text: 'A' }]);
    expect(service.buildAnalysis(questions)[0].wasCorrect).toBe(false);

    // Both correct answers selected.
    selection.rawSelectionsMap.set(0, [{ optionId: 0, text: 'A' }, { optionId: 1, text: 'B' }]);
    expect(service.buildAnalysis(questions)[0].wasCorrect).toBe(true);
  });

  it('matches selections by TEXT when option ids differ (shuffle-safe)', () => {
    const questions = [q('Q?', [{ text: 'Right', correct: true, optionId: 42 }, { text: 'Wrong', optionId: 7 }])];
    // Stored selection has a stale id but the right text.
    selection.rawSelectionsMap.set(0, [{ optionId: 999, text: 'Right' }]);
    expect(service.buildAnalysis(questions)[0].wasCorrect).toBe(true);
  });

  it('falls back to selectedOptionsMap when rawSelectionsMap has no entry', () => {
    const questions = [q('Q?', [{ text: 'A', correct: true }, { text: 'B' }])];
    selection.selectedOptionsMap.set(0, [{ optionId: 0, text: 'A' }]);
    expect(service.buildAnalysis(questions)[0].wasCorrect).toBe(true);
  });

  it('captures selected + correct option ids', () => {
    const questions = [q('Q?', [{ text: 'A', correct: true, optionId: 5 }, { text: 'B', optionId: 6 }])];
    selection.rawSelectionsMap.set(0, [{ optionId: 5, text: 'A' }]);

    const [item] = service.buildAnalysis(questions);
    expect(item.selectedOptionIds).toEqual(['5']);
    expect(item.correctOptionIds).toEqual(['5']);
  });

  it('handles empty / missing input safely', () => {
    expect(service.buildAnalysis([])).toEqual([]);
    expect(service.buildAnalysis(undefined as unknown as QuizQuestion[])).toEqual([]);
  });
});
