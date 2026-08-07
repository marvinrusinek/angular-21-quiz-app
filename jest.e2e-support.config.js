/**
 * Unit tests for E2E SUPPORT code — not for the Angular app, and not Playwright.
 *
 * `e2e/support/` holds plain Node modules the Playwright harness runs before and
 * around a suite: creating the throwaway database, seeding it, tearing it down.
 * Some of that logic is worth testing directly rather than only observing
 * through a 30-minute browser run — most of all the seed-target guard, whose
 * whole job is to refuse to touch the developer's real database.
 *
 * ── Why a separate config ──────────────────────────────────────────
 *
 * The Angular config ignores `<rootDir>/e2e/` entirely and must keep doing so:
 * the Playwright specs there import `@playwright/test`, expect a browser, and
 * would fail immediately under jsdom. Widening the Angular roots to reach one
 * file would put every future Playwright spec one glob away from being dragged
 * into the wrong environment.
 *
 * So this config is deliberately narrow:
 *   - `node` environment, because the code under test is a Node module
 *   - rooted at `e2e/support` only, never `e2e/`
 *   - matches `*.spec.ts` there, so a `*.test.ts` or a Playwright spec at
 *     `e2e/*.spec.ts` is out of scope by construction
 *
 * Run via `npm run test:e2e-support`, and as part of `npm test`.
 */

/** @type {import('jest').Config} */
module.exports = {
  displayName: 'e2e-support',
  preset: 'ts-jest',
  testEnvironment: 'node',
  // NOT '<rootDir>/e2e' — the Playwright specs live one level up from here.
  roots: ['<rootDir>/e2e/support'],
  testMatch: ['<rootDir>/e2e/support/**/*.spec.ts'],
  testPathIgnorePatterns: ['<rootDir>/node_modules/'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      // The support modules are CommonJS by design: `ensure-e2e-database.js`
      // runs under bare `node` in front of the backend, with no transpiler in
      // the chain, so it cannot use ESM syntax.
      tsconfig: {
        module: 'commonjs',
        target: 'es2022',
        esModuleInterop: true,
        allowJs: true,
        strict: true,
        types: ['node', 'jest']
      }
    }]
  }
};
