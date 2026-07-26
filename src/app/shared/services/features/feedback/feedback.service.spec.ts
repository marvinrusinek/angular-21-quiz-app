/**
 * Regression coverage for the multi-answer feedback rules fixed this session
 * (2026-06-20):
 *   - The win ("You're right! ...") fires ONLY when every correct option is
 *     selected AND no incorrect option is selected. Picking any wrong option —
 *     even alongside all the correct ones — must yield "Not this one, try again!".
 *   - A partial-but-correct pick reports how many correct answers remain.
 *   - The feedback resolves correctness through the DISPLAYED question
 *     (getDisplayedQuestion), so "Option N" labels follow the shuffled order.
 *
 * The service reads window.location for its URL-authoritative short-circuit;
 * jsdom's default path ("/") does not match QUESTION_ROUTE_REGEX, so most tests
 * exercise the main path. The shuffle test opts in via history.pushState.
 */
import { TestBed } from '@angular/core/testing';

import { QuestionType } from '../../../models/question-type.enum';
import { Option } from '../../../models/Option.model';
import { QuizQuestion } from '../../../models/QuizQuestion.model';

import { ExplanationTextService } from '../explanation/explanation-text.service';
import { FeedbackService } from './feedback.service';
import { QuizService } from '../../data/quiz.service';
import { SelectedOptionService } from '../../state/selectedoption.service';

function opt(optionId: number, text: string, correct: boolean, selected = false): Option {
  return { optionId, text, correct, selected, value: optionId } as unknown as Option;
}

function multiQuestion(options: Option[]): QuizQuestion {
  return {
    questionText: 'Select the correct statements',
    options,
    type: QuestionType.MultipleAnswer,
    explanation: ''
  } as unknown as QuizQuestion;
}

describe('FeedbackService.buildFeedbackMessage — multi-answer win condition', () => {
  let service: FeedbackService;
  let quizService: any;

  beforeEach(() => {
    quizService = {
      currentQuestionIndex: 0,
      getCurrentQuestionIndex: () => 0,
      questions: [] as QuizQuestion[],
      getDisplayedQuestion: (_i: number) => undefined as QuizQuestion | undefined,
      getPristineCorrectTextsForQuestion: (_t: string) => new Set<string>()
    };

    TestBed.configureTestingModule({
      providers: [
        FeedbackService,
        { provide: QuizService, useValue: quizService },
        { provide: ExplanationTextService, useValue: { latestExplanationIndex: -1, getCorrectOptionIndices: () => [] } },
        { provide: SelectedOptionService, useValue: { getSelectedOptionsForQuestion: (_i: number) => [] } }
      ]
    });
    service = TestBed.inject(FeedbackService);
  });

  afterEach(() => {
    // Reset the URL in case a test opted into the /question/ short-circuit.
    window.history.pushState({}, '', '/');
  });

  // options: Alpha(correct), Bravo(incorrect), Charlie(correct), Delta(incorrect)
  function scenario(selectedFlags: boolean[], targetIdx: number): string {
    const options = [
      opt(1, 'Alpha', true),
      opt(2, 'Bravo', false),
      opt(3, 'Charlie', true),
      opt(4, 'Delta', false)
    ];
    for (const [i, o] of options.entries()) o.selected = selectedFlags[i];
    const selected = options.filter((_, i) => selectedFlags[i]);
    const question = multiQuestion(options);
    return service.buildFeedbackMessage(question, selected, false, false, 0, options, options[targetIdx]);
  }

  it('one of two correct → reports how many correct answers remain', () => {
    // Alpha selected only (target Alpha).
    const msg = scenario([true, false, false, false], 0);
    expect(msg).toBe("That's correct! Please select 1 more correct answer.");
  });

  it('all correct selected, none incorrect → declares the win with displayed option numbers', () => {
    // Alpha + Charlie selected (target Charlie).
    const msg = scenario([true, false, true, false], 2);
    expect(msg).toBe("You're right! The correct answers are Options 1 and 3.");
  });

  it('correct then incorrect → "Not this one, try again!" (no premature win)', () => {
    // Alpha (correct) + Bravo (incorrect); just clicked Bravo.
    const msg = scenario([true, true, false, false], 1);
    expect(msg).toBe('Not this one, try again!');
  });

  it('ALL correct PLUS an incorrect → still blocked: any wrong pick prevents the win', () => {
    // Alpha + Charlie (both correct) + Bravo (incorrect); just clicked Bravo.
    // Pre-fix this declared the win because the correct count was met.
    const msg = scenario([true, true, true, false], 1);
    expect(msg).toBe('Not this one, try again!');
  });

  it('shuffle-aware: option numbers follow the DISPLAYED order (getDisplayedQuestion)', () => {
    // Displayed order puts the correct options at positions 2 and 4.
    const displayed = [
      opt(2, 'Bravo', false),
      opt(1, 'Alpha', true),
      opt(4, 'Delta', false),
      opt(3, 'Charlie', true)
    ];
    // Prove it uses the displayed question, not the raw questions[] array.
    quizService.questions = [multiQuestion([
      opt(1, 'Alpha', true), opt(2, 'Bravo', false), opt(3, 'Charlie', true), opt(4, 'Delta', false)
    ])];
    quizService.getDisplayedQuestion = (i: number) => (i === 0 ? multiQuestion(displayed) : undefined);
    window.history.pushState({}, '', '/question/demo/1');

    const options = displayed.map((o) => ({ ...o }));
    options[1].selected = true; // Alpha (displayed pos 2)
    options[3].selected = true; // Charlie (displayed pos 4)
    const selected = [options[1], options[3]];

    const msg = service.buildFeedbackMessage(
      multiQuestion(options), selected, false, false, 0, options, options[3]
    );
    expect(msg).toBe("You're right! The correct answers are Options 2 and 4.");
  });
});

describe('FeedbackService.buildFeedbackMessage — single-answer', () => {
  let service: FeedbackService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        FeedbackService,
        { provide: QuizService, useValue: { currentQuestionIndex: 0, getCurrentQuestionIndex: () => 0, questions: [], getDisplayedQuestion: () => undefined, getPristineCorrectTextsForQuestion: () => new Set<string>() } },
        { provide: ExplanationTextService, useValue: { latestExplanationIndex: -1, getCorrectOptionIndices: () => [] } },
        { provide: SelectedOptionService, useValue: { getSelectedOptionsForQuestion: () => [] } }
      ]
    });
    service = TestBed.inject(FeedbackService);
  });

  afterEach(() => window.history.pushState({}, '', '/'));

  function singleQuestion(): QuizQuestion {
    return {
      questionText: 'Pick the one correct answer',
      options: [opt(1, 'Right', true), opt(2, 'Wrong', false)],
      type: QuestionType.SingleAnswer,
      explanation: ''
    } as unknown as QuizQuestion;
  }

  it('correct pick → win', () => {
    const q = singleQuestion();
    const right = q.options![0];
    right.selected = true;
    const msg = service.buildFeedbackMessage(q, [right], false, false, 0, q.options, right);
    expect(msg).toBe("You're right! The correct answer is Option 1.");
  });

  it('incorrect pick → "Not this one, try again!"', () => {
    const q = singleQuestion();
    const wrong = q.options![1];
    wrong.selected = true;
    const msg = service.buildFeedbackMessage(q, [wrong], false, false, 0, q.options, wrong);
    expect(msg).toBe('Not this one, try again!');
  });
});
