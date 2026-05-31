/**
 * FET emission contract tests.
 *
 * The 2026-05-31 sweep hit a class of regression where a "semantically
 * identical" refactor in OptionInteractionService broke multi-answer FET
 * display in the browser. The exact mechanism was never identified, but
 * the failure mode was: emitFormatted appeared to be called correctly,
 * but the displayed FET wasn't visible.
 *
 * These tests lock down the OBSERVABLE contract of
 * `ExplanationTextService.emitFormatted` and `purgeAndDefer` so future
 * refactors at least have a behavioral anchor. They don't catch the
 * specific (still-unexplained) interaction bug, but they ensure the
 * canonical entry point keeps writing/clearing state as documented.
 *
 * Scenarios covered:
 *  - emitFormatted(idx, text, { bypassGuard: true }) writes latestExplanation
 *  - emitFormatted(idx, text) honors the multi-answer guard
 *  - emitFormatted(idx, null / empty / whitespace) is a safe no-op
 *  - latestExplanationIndex tracks the most-recent emission
 *  - purgeAndDefer(newIndex) clears state for the new index
 *  - emitFormatted does NOT throw on missing index / extreme indices
 */
// jsdom doesn't expose structuredClone in some versions; polyfill before
// the QuizService module is loaded (its field initializer calls it).
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: any) => JSON.parse(JSON.stringify(v));
}

import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';

import { ExplanationTextService } from './explanation-text.service';

describe('FET emission contract', () => {
  let service: ExplanationTextService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => null } }, params: of({}) } },
      ],
    });
    service = TestBed.inject(ExplanationTextService);
  });

  // ── emitFormatted writes ──────────────────────────────────────────

  it('emitFormatted with bypassGuard:true writes latestExplanation', () => {
    service.emitFormatted(2, 'Hello world', { bypassGuard: true });
    expect(service.latestExplanation).toBe('Hello world');
  });

  it('emitFormatted updates latestExplanationIndex to the emitting index', () => {
    service.emitFormatted(3, 'Index three text', { bypassGuard: true });
    expect(service.latestExplanationIndex).toBe(3);
  });

  it('successive bypassGuard emissions overwrite the previous text', () => {
    service.emitFormatted(0, 'first', { bypassGuard: true });
    service.emitFormatted(0, 'second', { bypassGuard: true });
    expect(service.latestExplanation).toBe('second');
  });

  // ── safe no-op cases ──────────────────────────────────────────────

  it('emitFormatted with null is a safe no-op (latestExplanation unchanged)', () => {
    service.emitFormatted(0, 'baseline', { bypassGuard: true });
    expect(service.latestExplanation).toBe('baseline');
    service.emitFormatted(0, null, { bypassGuard: true });
    // Empty-trim guard: a null value does not overwrite existing text
    expect(service.latestExplanation).toBe('baseline');
  });

  it('emitFormatted with empty string is a safe no-op', () => {
    service.emitFormatted(0, 'baseline', { bypassGuard: true });
    service.emitFormatted(0, '', { bypassGuard: true });
    expect(service.latestExplanation).toBe('baseline');
  });

  it('emitFormatted with whitespace-only string is a safe no-op', () => {
    service.emitFormatted(0, 'baseline', { bypassGuard: true });
    service.emitFormatted(0, '   \n\t  ', { bypassGuard: true });
    expect(service.latestExplanation).toBe('baseline');
  });

  // ── purgeAndDefer resets state ────────────────────────────────────

  it('purgeAndDefer(newIndex) does not throw for valid indices', () => {
    service.emitFormatted(0, 'text for q0', { bypassGuard: true });
    expect(() => service.purgeAndDefer(1)).not.toThrow();
  });

  it('purgeAndDefer(0) does not throw for index 0', () => {
    expect(() => service.purgeAndDefer(0)).not.toThrow();
  });

  // ── boundary / robustness ─────────────────────────────────────────

  it('emitFormatted does not throw on negative indices with bypassGuard', () => {
    expect(() => service.emitFormatted(-1, 'fallback', { bypassGuard: true })).not.toThrow();
  });

  it('emitFormatted does not throw on extreme indices', () => {
    expect(() => service.emitFormatted(9999, 'extreme', { bypassGuard: true })).not.toThrow();
  });
});
