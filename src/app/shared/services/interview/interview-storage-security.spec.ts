import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { BackendInterviewResultService } from './backend-interview-result.service';
import { BackendInterviewSessionService } from './backend-interview-session.service';
import { InterviewSessionReferenceStorage } from './interview-session-reference.storage';
import { InterviewApiService } from '../api/interview-api.service';
import { InterviewHistoryService } from '../features/interview/interview-history.service';
import type { InterviewResultViewModel } from '../../models/interview/interview-view-models';

/**
 * End-state storage contract for a COMPLETED interview.
 *
 * The point of the backend migration is that the browser stops holding an
 * answer key. These tests walk the PARSED structure of every storage entry —
 * not just the raw string — so a nested field cannot slip through under a
 * different name or inside an array.
 */
const TOKEN = 'a'.repeat(43);

/** Key names that must never appear anywhere in persisted state. */
const FORBIDDEN_KEYS = [
  'questions', 'options', 'selectedOptionIds', 'correctOptionIds',
  'explanation', 'review', 'answerKey', 'answers', 'isCorrect', 'is_correct',
  'assessment', 'result'
];

/** Distinctive VALUES from the answer key, to catch renamed fields. */
const FORBIDDEN_VALUES = [
  'switchMap cancels', 'Which operator flattens', 'A reactive primitive'
];

function result(): InterviewResultViewModel {
  return {
    sessionId: 'is_1',
    submittedAtMs: Date.parse('2026-08-01T12:00:00.000Z'),
    submittedByExpiry: false,
    total: 2, answered: 2, unanswered: 0, correct: 1, incorrect: 1, percentage: 50,
    durationSeconds: 900, timeUsedSeconds: 400,
    config: { mode: 'custom', difficulty: 'beginner', topicIds: ['rxjs'], questionCount: 2 },
    byTopic: [
      { topicId: 'rxjs', title: 'RxJS', correct: 1, incorrect: 1, unanswered: 0, total: 2, percentage: 50 }
    ],
    review: [
      {
        questionId: 'rxjs:q:0', sourceQuizId: 'rxjs',
        questionText: 'Which operator flattens?', type: 'single',
        options: [{ optionId: 1, text: 'switchMap' }, { optionId: 2, text: 'tap' }],
        selectedOptionIds: [1], correctOptionIds: [1],
        explanation: 'switchMap cancels the previous inner observable.',
        isCorrect: true, isAnswered: true
      },
      {
        questionId: 'signals:q:0', sourceQuizId: 'signals',
        questionText: 'What is a signal?', type: 'single',
        options: [{ optionId: 3, text: 'A reactive primitive' }, { optionId: 4, text: 'A pipe' }],
        selectedOptionIds: [4], correctOptionIds: [3],
        explanation: 'A reactive primitive that notifies consumers.',
        isCorrect: false, isAnswered: true
      }
    ]
  };
}

/** Every key name found anywhere in a parsed structure. */
function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  for (const [key, nested] of Object.entries(value)) {
    out.add(key);
    collectKeys(nested, out);
  }
  return out;
}

function parsedEntries(store: Storage): Array<{ key: string; value: unknown }> {
  const entries: Array<{ key: string; value: unknown }> = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i)!;
    const raw = store.getItem(key) ?? '';
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // A plain string value — inspected as-is.
    }
    entries.push({ key, value });
  }
  return entries;
}

let service: BackendInterviewResultService;
let api: { getResult: jest.Mock; submitSession: jest.Mock; resumeSession: jest.Mock; saveAnswer: jest.Mock };

beforeEach(async () => {
  sessionStorage.clear();
  localStorage.clear();
  api = { getResult: jest.fn(), submitSession: jest.fn(), resumeSession: jest.fn(), saveAnswer: jest.fn() };

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      BackendInterviewResultService,
      BackendInterviewSessionService,
      InterviewSessionReferenceStorage,
      InterviewHistoryService,
      { provide: InterviewApiService, useValue: api }
    ]
  });

  service = TestBed.inject(BackendInterviewResultService);
  TestBed.inject(InterviewSessionReferenceStorage).write('is_1', TOKEN, 0);
  api.getResult.mockReturnValue(of(result()));
  await service.load('is_1');
});
afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('after a completed interview', () => {
  it('sessionStorage holds ONLY the minimal session reference', () => {
    const keys = parsedEntries(sessionStorage).map((e) => e.key);
    // assessmentIntegrity is written lazily by its own service; it is allowed
    // but not required here.
    expect(keys.filter((k) => k !== 'assessmentIntegrity')).toEqual(['interviewSessionRef:v2']);

    const reference = JSON.parse(sessionStorage.getItem('interviewSessionRef:v2')!);
    expect(Object.keys(reference).sort())
      .toEqual(['currentIndex', 'sessionId', 'sessionToken', 'version']);
  });

  it('localStorage holds the sanitized history and no answer key', () => {
    const history = JSON.parse(localStorage.getItem('interviewAttemptHistory:v2')!);
    expect(history.version).toBe(2);
    expect(history.attempts).toHaveLength(1);
  });

  it('NO forbidden key name appears anywhere in either store (recursively)', () => {
    for (const store of [localStorage, sessionStorage]) {
      for (const { key, value } of parsedEntries(store)) {
        const found = [...collectKeys(value)].filter((k) => FORBIDDEN_KEYS.includes(k));
        expect({ key, found }).toEqual({ key, found: [] });
      }
    }
  });

  it('NO answer-key VALUE appears anywhere in either store', () => {
    for (const store of [localStorage, sessionStorage]) {
      const serialized = JSON.stringify(parsedEntries(store));
      for (const value of FORBIDDEN_VALUES) {
        expect(serialized).not.toContain(value);
      }
    }
  });

  it('the session TOKEN never reaches localStorage', () => {
    expect(JSON.stringify(parsedEntries(localStorage))).not.toContain(TOKEN);
    expect(JSON.stringify(parsedEntries(localStorage))).not.toContain('sessionToken');
    // ...and remains available in sessionStorage for the current session only.
    expect(sessionStorage.getItem('interviewSessionRef:v2')).toContain(TOKEN);
  });

  it('the complete review stays in MEMORY and is re-fetchable, not persisted', () => {
    expect(service.result()!.review).toHaveLength(2);

    // A fresh service (a refresh) has nothing until it asks the backend again.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        BackendInterviewResultService,
        BackendInterviewSessionService,
        InterviewSessionReferenceStorage,
        InterviewHistoryService,
        { provide: InterviewApiService, useValue: api }
      ]
    });
    expect(TestBed.inject(BackendInterviewResultService).result()).toBeNull();
  });

  it('the legacy answer-bearing session key is not present', () => {
    expect(sessionStorage.getItem('interviewSession')).toBeNull();
    expect(localStorage.getItem('interviewSession')).toBeNull();
    expect(localStorage.getItem('interviewAttemptHistory:v1')).toBeNull();
  });
});
