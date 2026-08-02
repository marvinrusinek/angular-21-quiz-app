import { createQuizRepository, type QuizRepository } from '../../src/quiz/quiz.repository';
import type { AppDependencies } from '../../src/dependencies';

/**
 * A tiny in-memory bank. Health/CORS/error tests use this so they never depend
 * on the real private data file.
 */
export const FIXTURE_SOURCE = {
  quizzes: [
    {
      quizId: 'rxjs',
      milestone: 'RxJS',
      // Deliberately contains the WORDS "correct", "answer" and "explanation"
      // in free text — the guard inspects property NAMES, never values.
      summary: 'Learn which answer is correct and read the explanation.',
      image: 'rxjs.svg',
      difficulty: 'intermediate',
      questions: [
        {
          questionText: 'Which answer is correct?',
          explanation: 'PRIVATE-EXPLANATION-RXJS',
          options: [
            { text: 'A multicast observable', correct: true },
            { text: 'A pipe' },
            { text: 'A directive' }
          ]
        },
        {
          questionText: 'Select all reactive operators',
          explanation: 'PRIVATE-EXPLANATION-MULTI',
          options: [
            { text: 'map', correct: true },
            { text: 'filter', correct: true },
            { text: 'ngIf' }
          ]
        }
      ]
    },
    {
      quizId: 'signals',
      milestone: 'Signals',
      summary: 'Signals basics',
      image: 'signals.svg',
      difficulty: 'beginner',
      questions: [
        {
          questionText: 'True or False: signals are reactive.',
          explanation: 'PRIVATE-EXPLANATION-TF',
          options: [{ text: 'True', correct: true }, { text: 'False' }]
        }
      ]
    }
  ],
  resources: []
};

export function fixtureRepository(): QuizRepository {
  return createQuizRepository({ source: FIXTURE_SOURCE });
}

export function realRepository(): QuizRepository {
  return createQuizRepository({ dataPath: './data/quiz.json' });
}

export function fixtureDependencies(): AppDependencies {
  return { quizRepository: fixtureRepository() };
}
