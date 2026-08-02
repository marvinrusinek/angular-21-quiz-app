import { InjectionToken, isDevMode, type Provider } from '@angular/core';

/**
 * Base URL for the private quiz API.
 *
 * ONE centralized definition — no service or component may hard-code a host.
 * This app has no `src/environments` directory and resolves build-time
 * differences with `isDevMode()` (see main.ts), so the same convention is used
 * here rather than introducing a fileReplacements surface just for one value.
 *
 * The URL is PUBLIC configuration, not a secret. No token or credential is
 * ever stored alongside it.
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL');

/** Local backend during `ng serve`. */
export const DEV_API_BASE_URL = 'http://localhost:3000/api';

/**
 * Production backend origin. Deliberately EMPTY until the backend is hosted:
 * a placeholder domain would silently ship a broken build that looks
 * configured. `resolveApiBaseUrl` throws on an empty production value, so the
 * mistake surfaces immediately instead of as failed requests at runtime.
 *
 * When the host is chosen, set this AND add the origin to the CSP
 * `connect-src` directive in index.html.
 */
export const PROD_API_BASE_URL = '';

/**
 * Whether the API is configured for the current build.
 *
 * Lets a caller FAIL CLOSED with a safe message instead of throwing: in
 * production with no configured origin, Interview Mode must refuse to create a
 * session rather than attempt a request or fall back to local generation.
 */
export function isApiConfigured(devMode: boolean = isDevMode()): boolean {
  return devMode || PROD_API_BASE_URL.trim().length > 0;
}

export function resolveApiBaseUrl(devMode: boolean = isDevMode()): string {
  if (devMode) return DEV_API_BASE_URL;

  if (PROD_API_BASE_URL.trim().length === 0) {
    throw new Error(
      'API_BASE_URL is not configured for production. Set PROD_API_BASE_URL and add the ' +
        'origin to the CSP connect-src directive.'
    );
  }
  return PROD_API_BASE_URL;
}

/** Normalize away a trailing slash so callers can always append `/segment`. */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Provider for bootstrap. Tests override it with a literal value instead of
 * depending on build mode.
 */
export function provideApiBaseUrl(url?: string): Provider {
  return {
    provide: API_BASE_URL,
    useFactory: () => normalizeBaseUrl(url ?? resolveApiBaseUrl())
  };
}
