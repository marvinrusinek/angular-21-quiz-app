import { TestBed } from '@angular/core/testing';

import {
  InterviewResultReferenceStorage,
  RESULT_REFERENCE_TTL_MS,
  SK_INTERVIEW_RESULT_REFS
} from './interview-result-reference.storage';
import { INTERVIEW_HISTORY_MAX } from '../../models/interview-history.model';

/**
 * Durable POINTERS to submitted interviews — the id and read-only token needed
 * to ask the SERVER for a past review. This is what lets Interview History
 * reopen Review Answers in a later tab without putting the answer key back on
 * disk, which is what v1 did and what the migration removed.
 */
const TOKEN = 'a'.repeat(43);

let store: InterviewResultReferenceStorage;

beforeEach(() => {
  localStorage.clear();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [InterviewResultReferenceStorage] });
  store = TestBed.inject(InterviewResultReferenceStorage);
});
afterEach(() => localStorage.clear());

describe('remembering a submitted attempt', () => {
  it('stores the pointer and finds it again', () => {
    store.remember('is_1', TOKEN);
    expect(store.find('is_1')?.sessionToken).toBe(TOKEN);
    expect(store.find('is_other')).toBeNull();
  });

  it('stores ONLY the pointer — never anything answer-bearing', () => {
    store.remember('is_1', TOKEN);
    const raw = localStorage.getItem(SK_INTERVIEW_RESULT_REFS) ?? '';

    for (const banned of [
      'review', 'questions', 'options', 'selectedOptionIds',
      'correctOptionIds', 'explanation', 'questionText', 'score', 'percentage'
    ]) {
      expect(raw).not.toContain(banned);
    }
    expect(Object.keys(store.read()[0]!).sort())
      .toEqual(['savedAtMs', 'sessionId', 'sessionToken']);
  });

  it('is idempotent per session', () => {
    store.remember('is_1', TOKEN);
    store.remember('is_1', TOKEN);
    store.remember('is_1', TOKEN);
    expect(store.read()).toHaveLength(1);
  });

  it('keeps the same window as Interview History', () => {
    for (let i = 0; i < INTERVIEW_HISTORY_MAX + 5; i++) store.remember(`is_${i}`, TOKEN);
    expect(store.read()).toHaveLength(INTERVIEW_HISTORY_MAX);
    // Oldest aged out, newest kept.
    expect(store.find('is_0')).toBeNull();
    expect(store.find(`is_${INTERVIEW_HISTORY_MAX + 4}`)).not.toBeNull();
  });
});

describe('expiry and hostile input', () => {
  it('drops pointers past the TTL', () => {
    const now = Date.now();
    store.remember('is_old', TOKEN, now - RESULT_REFERENCE_TTL_MS - 1);
    store.remember('is_new', TOKEN, now);

    expect(store.find('is_old', now)).toBeNull();
    expect(store.find('is_new', now)).not.toBeNull();
  });

  it('rejects an entry carrying answer-bearing fields', () => {
    localStorage.setItem(SK_INTERVIEW_RESULT_REFS, JSON.stringify({
      version: 1,
      refs: [
        { sessionId: 'is_1', sessionToken: TOKEN, savedAtMs: Date.now(), explanation: 'leaked' }
      ]
    }));
    expect(store.read()).toEqual([]);
  });

  it('survives malformed storage without throwing', () => {
    for (const bad of ['null', '[]', '"str"', '{"version":99,"refs":[]}', '{"version":1}']) {
      localStorage.setItem(SK_INTERVIEW_RESULT_REFS, bad);
      expect(() => store.read()).not.toThrow();
      expect(store.read()).toEqual([]);
    }
  });

  it('clear() removes everything', () => {
    store.remember('is_1', TOKEN);
    store.clear();
    expect(store.read()).toEqual([]);
    expect(localStorage.getItem(SK_INTERVIEW_RESULT_REFS)).toBeNull();
  });
});
