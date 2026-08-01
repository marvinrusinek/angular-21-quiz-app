import { QuizQuestion } from '../models/QuizQuestion.model';
import {
  canAdvanceFromQuestion,
  computePracticeResult,
  correctOptionIds,
  isMultiAnswerQuestion,
  isQuestionResolved
} from './practice-scoring';

function question(
  text: string,
  options: { id: number; text: string; correct?: boolean }[],
  sourceQuizId = 'rxjs',
  explanation = `Because ${text}`
): QuizQuestion {
  return {
    questionText: text,
    explanation,
    sourceQuizId,
    options: options.map((o) => ({
      optionId: o.id,
      text: o.text,
      correct: o.correct === true
    }))
  } as QuizQuestion;
}

const single = question('Single?', [
  { id: 1, text: 'Wrong A' },
  { id: 2, text: 'Right', correct: true },
  { id: 3, text: 'Wrong B' }
]);

const trueFalse = question('True or false?', [
  { id: 1, text: 'True', correct: true },
  { id: 2, text: 'False' }
]);

const multi = question('Pick two', [
  { id: 1, text: 'Right one', correct: true },
  { id: 2, text: 'Wrong' },
  { id: 3, text: 'Right two', correct: true }
]);

describe('practice-scoring — question shape', () => {
  it('detects multi-answer as MORE THAN ONE correct option', () => {
    expect(isMultiAnswerQuestion(single)).toBe(false);
    expect(isMultiAnswerQuestion(trueFalse)).toBe(false);
    expect(isMultiAnswerQuestion(multi)).toBe(true);
  });

  it('reads correct ids tolerantly of string/boolean data variants', () => {
    const coerced = {
      questionText: 'Coerced',
      explanation: '',
      options: [
        { optionId: 1, text: 'a', correct: 'true' },
        { optionId: 2, text: 'b', correct: false }
      ]
    } as unknown as QuizQuestion;
    expect(correctOptionIds(coerced)).toEqual([1]);
  });

  it('treats a null question as neither resolved nor advanceable', () => {
    expect(isQuestionResolved(null, [1])).toBe(false);
    expect(canAdvanceFromQuestion(null, [1])).toBe(false);
    expect(isMultiAnswerQuestion(null)).toBe(false);
  });
});

describe('practice-scoring — the Next gate (verified topic-quiz behaviour)', () => {
  it('SINGLE: a WRONG selection enables Next', () => {
    expect(canAdvanceFromQuestion(single, [1])).toBe(true);
    expect(isQuestionResolved(single, [1])).toBe(false);   // ...but is not resolved
  });

  it('SINGLE: a correct selection enables Next and resolves', () => {
    expect(canAdvanceFromQuestion(single, [2])).toBe(true);
    expect(isQuestionResolved(single, [2])).toBe(true);
  });

  it('TRUE/FALSE: a wrong selection enables Next but does not resolve', () => {
    expect(canAdvanceFromQuestion(trueFalse, [2])).toBe(true);
    expect(isQuestionResolved(trueFalse, [2])).toBe(false);
    expect(isQuestionResolved(trueFalse, [1])).toBe(true);
  });

  it('MULTI: a PARTIAL selection does NOT enable Next and does not resolve', () => {
    expect(canAdvanceFromQuestion(multi, [1])).toBe(false);
    expect(isQuestionResolved(multi, [1])).toBe(false);
  });

  it('MULTI: a wrong-included selection does NOT enable Next', () => {
    expect(canAdvanceFromQuestion(multi, [1, 2, 3])).toBe(false);
    expect(isQuestionResolved(multi, [1, 2, 3])).toBe(false);
  });

  it('MULTI: only the EXACT correct set enables Next', () => {
    expect(canAdvanceFromQuestion(multi, [1, 3])).toBe(true);
    expect(isQuestionResolved(multi, [3, 1])).toBe(true);   // order-independent
  });

  it('an EMPTY selection never enables Next, for either type', () => {
    expect(canAdvanceFromQuestion(single, [])).toBe(false);
    expect(canAdvanceFromQuestion(multi, [])).toBe(false);
    expect(canAdvanceFromQuestion(single, undefined)).toBe(false);
  });
});

describe('practice-scoring — results (final-state scoring)', () => {
  const questions = [single, trueFalse, multi];
  const topicNameFor = (id: string) => (id === 'rxjs' ? 'RxJS' : id);

  function score(answers: Record<number, number[]>) {
    return computePracticeResult({
      sessionId: 's1',
      questions,
      answersByIndex: answers,
      completedAt: '2026-08-01T10:00:00.000Z',
      topicNameFor
    });
  }

  it('scores single, true/false and multi correctly', () => {
    const r = score({ 0: [2], 1: [1], 2: [1, 3] });
    expect(r.correct).toBe(3);
    expect(r.total).toBe(3);
    expect(r.percentage).toBe(100);
    expect(r.incorrect).toBe(0);
  });

  it('a WRONG single answer scores incorrect', () => {
    const r = score({ 0: [1], 1: [1], 2: [1, 3] });
    expect(r.correct).toBe(2);
    expect(r.percentage).toBe(67);
    expect(r.review[0].isCorrect).toBe(false);
    expect(r.review[0].answered).toBe(true);
  });

  it('a PARTIAL multi answer scores incorrect', () => {
    const r = score({ 0: [2], 1: [1], 2: [1] });
    expect(r.correct).toBe(2);
    expect(r.review[2].isCorrect).toBe(false);
  });

  it('an UNANSWERED question is incorrect and counted as unanswered', () => {
    const r = score({ 0: [2] });
    expect(r.answered).toBe(1);
    expect(r.unanswered).toBe(2);
    expect(r.correct).toBe(1);
    expect(r.review[1].answered).toBe(false);
    expect(r.review[1].isCorrect).toBe(false);
  });

  it('FINAL-STATE: changing a wrong answer to the right one scores CORRECT', () => {
    // The session stores only the final selection, which is exactly the
    // behaviour being pinned — no first-attempt penalty.
    expect(score({ 0: [1] }).correct).toBe(0);
    expect(score({ 0: [2] }).correct).toBe(1);
  });

  it('an all-wrong session scores 0%', () => {
    const r = score({ 0: [1], 1: [2], 2: [2] });
    expect(r.correct).toBe(0);
    expect(r.percentage).toBe(0);
  });

  it('handles an empty question set without dividing by zero', () => {
    const r = computePracticeResult({
      sessionId: 's0',
      questions: [],
      answersByIndex: {},
      completedAt: 'now',
      topicNameFor
    });
    expect(r.total).toBe(0);
    expect(r.percentage).toBe(0);
    expect(r.perTopic).toEqual([]);
  });
});

describe('practice-scoring — per-topic breakdown', () => {
  it('groups by the preserved sourceQuizId, never by wording', () => {
    const questions = [
      question('A', [{ id: 1, text: 'x', correct: true }, { id: 2, text: 'y' }], 'rxjs'),
      question('B', [{ id: 1, text: 'x', correct: true }, { id: 2, text: 'y' }], 'rxjs'),
      question('C', [{ id: 1, text: 'x', correct: true }, { id: 2, text: 'y' }], 'signals')
    ];
    const r = computePracticeResult({
      sessionId: 's2',
      questions,
      answersByIndex: { 0: [1], 1: [2], 2: [1] },
      completedAt: 'now',
      topicNameFor: (id) => (id === 'rxjs' ? 'RxJS' : 'Signals')
    });

    const rxjs = r.perTopic.find((t) => t.topicId === 'rxjs')!;
    const signals = r.perTopic.find((t) => t.topicId === 'signals')!;
    expect(rxjs).toEqual({ topicId: 'rxjs', topicName: 'RxJS', correct: 1, total: 2, percentage: 50 });
    expect(signals).toEqual({
      topicId: 'signals', topicName: 'Signals', correct: 1, total: 1, percentage: 100
    });
  });

  it('falls back to "unknown" when a question carries no source topic', () => {
    const orphan = { ...question('Orphan', [{ id: 1, text: 'x', correct: true }]) };
    delete (orphan as { sourceQuizId?: string }).sourceQuizId;

    const r = computePracticeResult({
      sessionId: 's3',
      questions: [orphan],
      answersByIndex: { 0: [1] },
      completedAt: 'now',
      topicNameFor: (id) => id
    });
    expect(r.perTopic[0].topicId).toBe('unknown');
  });
});

describe('practice-scoring — Answer Review payload', () => {
  it('carries question, topic, selection, full correct set and explanation', () => {
    const r = computePracticeResult({
      sessionId: 's4',
      questions: [multi],
      answersByIndex: { 0: [1] },          // partial
      completedAt: 'now',
      topicNameFor: () => 'RxJS'
    });

    expect(r.review[0]).toEqual({
      index: 0,
      questionText: 'Pick two',
      topicId: 'rxjs',
      topicName: 'RxJS',
      selectedTexts: ['Right one'],
      correctTexts: ['Right one', 'Right two'],   // the COMPLETE set, so partial reads as partial
      answered: true,
      isCorrect: false,
      explanation: 'Because Pick two'
    });
  });

  it('exposes the explanation for INCORRECT answers — the FET withheld during play', () => {
    const r = computePracticeResult({
      sessionId: 's5',
      questions: [single],
      answersByIndex: { 0: [1] },
      completedAt: 'now',
      topicNameFor: () => 'RxJS'
    });
    expect(r.review[0].isCorrect).toBe(false);
    expect(r.review[0].explanation).toBe('Because Single?');
  });

  it('reports an empty selection list for a skipped question', () => {
    const r = computePracticeResult({
      sessionId: 's6',
      questions: [single],
      answersByIndex: {},
      completedAt: 'now',
      topicNameFor: () => 'RxJS'
    });
    expect(r.review[0].selectedTexts).toEqual([]);
    expect(r.review[0].correctTexts).toEqual(['Right']);
  });
});
