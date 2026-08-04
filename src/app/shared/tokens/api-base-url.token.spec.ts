import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';

import {
  API_BASE_URL,
  DEV_API_BASE_URL,
  isApiConfigured,
  normalizeBaseUrl,
  PROD_API_BASE_URL,
  provideApiBaseUrl,
  resolveApiBaseUrl
} from './api-base-url.token';
import { InterviewApiService } from '../services/api/interview-api.service';

/**
 * REGRESSION: `resolveApiBaseUrl` used to THROW when production had no
 * configured origin. It runs inside an injection factory, so anything that
 * injected InterviewApiService — Build Your Interview, the result guard —
 * failed to construct, and the whole /interview route rendered nothing on
 * GitHub Pages instead of showing the intended "not configured" message.
 *
 * The rule now: resolution never throws; the CALL SITE fails closed.
 */
describe('resolveApiBaseUrl never throws', () => {
  it('returns the dev URL in development', () => {
    expect(resolveApiBaseUrl(true)).toBe(DEV_API_BASE_URL);
  });

  it('returns the configured value (or empty) in production, without throwing', () => {
    expect(() => resolveApiBaseUrl(false)).not.toThrow();
    expect(resolveApiBaseUrl(false)).toBe(PROD_API_BASE_URL);
  });

  it('the injection factory resolves in an unconfigured production build', () => {
    // The exact path that broke the live site.
    expect(() => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [provideApiBaseUrl(resolveApiBaseUrl(false))] });
      TestBed.inject(API_BASE_URL);
    }).not.toThrow();
  });
});

describe('isApiConfigured', () => {
  it('is always true in development', () => {
    expect(isApiConfigured(true)).toBe(true);
  });

  it('follows PROD_API_BASE_URL in production', () => {
    expect(isApiConfigured(false)).toBe(PROD_API_BASE_URL.trim().length > 0);
  });
});

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes so callers can append a segment', () => {
    expect(normalizeBaseUrl('https://api.example.com/')).toBe('https://api.example.com');
    expect(normalizeBaseUrl('https://api.example.com///')).toBe('https://api.example.com');
    expect(normalizeBaseUrl('')).toBe('');
  });
});

describe('InterviewApiService with NO configured origin', () => {
  let api: InterviewApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideApiBaseUrl(''),
        InterviewApiService
      ]
    });
    api = TestBed.inject(InterviewApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('constructs fine — the component tree must not die', () => {
    expect(api).toBeTruthy();
  });

  /**
   * An empty base URL would make every URL RELATIVE, so the request would hit
   * the static site host and be answered with its index.html — an HTML body
   * parsed as a session. Failing is strictly better.
   */
  it.each([
    ['createSession', () => api.createSession({
      mode: 'custom', difficulty: 'beginner', topicIds: ['a'], questionCount: 10
    })],
    ['resumeSession', () => api.resumeSession('is_1', 't')],
    ['saveAnswer', () => api.saveAnswer('is_1', 't', 'q', [1])],
    ['submitSession', () => api.submitSession('is_1', 't')],
    ['getResult', () => api.getResult('is_1', 't')]
  ])('%s issues NO request and errors as unreachable', (_name, call) => {
    let code = '';
    (call() as { subscribe: (o: { error: (e: { code: string }) => void }) => void })
      .subscribe({ error: (err) => { code = err.code; } });

    expect(code).toBe('BACKEND_UNAVAILABLE');
    http.expectNone(() => true);   // nothing left the app
  });
});

/**
 * Which API a build talks to depends on WHERE THE PAGE IS SERVED FROM, not on
 * the build mode alone.
 *
 * StackBlitz serves a dev build from its own domain. Choosing on `isDevMode()`
 * alone sent it to http://localhost:3000 — the VIEWER's machine, where no
 * backend runs — so Interview Mode reported the service unreachable no matter
 * what was deployed.
 */
describe('API selection follows the serving origin', () => {
  it.each([
    ['localhost', 'localhost'],
    ['loopback IPv4', '127.0.0.1'],
    ['loopback IPv6', '[::1]']
  ])('a dev build on %s uses the LOCAL backend', (_label, hostname) => {
    expect(resolveApiBaseUrl(true, hostname)).toBe(DEV_API_BASE_URL);
  });

  it.each([
    ['StackBlitz webcontainer', 'abc123.local-credentialless.webcontainer-api.io'],
    ['StackBlitz project', 'angular-quiz.stackblitz.io'],
    ['GitHub Pages', 'marvinrusinek.github.io']
  ])('a dev build served from %s uses the HOSTED API', (_label, hostname) => {
    expect(resolveApiBaseUrl(true, hostname)).toBe(PROD_API_BASE_URL);
  });

  it('a production build always uses the hosted API, even on localhost', () => {
    expect(resolveApiBaseUrl(false, 'localhost')).toBe(PROD_API_BASE_URL);
    expect(resolveApiBaseUrl(false, 'marvinrusinek.github.io')).toBe(PROD_API_BASE_URL);
  });

  it('isApiConfigured agrees with whatever was resolved', () => {
    for (const [devMode, hostname] of [
      [true, 'localhost'], [true, 'x.stackblitz.io'], [false, 'marvinrusinek.github.io']
    ] as Array<[boolean, string]>) {
      expect(isApiConfigured(devMode, hostname))
        .toBe(resolveApiBaseUrl(devMode, hostname).trim().length > 0);
    }
  });

  it('an unknown hostname does not fall back to localhost', () => {
    // Guards the failure mode directly: never send a non-local page to a
    // backend that only exists on someone else's machine.
    //
    // Passing `undefined` is NOT the same test — an explicit undefined invokes
    // the default parameter, which reads globalThis.location. The real
    // no-location case (a worker, SSR) yields an undefined hostname through
    // that default and is covered by the isLocalHost check itself.
    expect(resolveApiBaseUrl(true, '')).toBe(PROD_API_BASE_URL);
    expect(resolveApiBaseUrl(true, 'example.com')).toBe(PROD_API_BASE_URL);
  });
});
