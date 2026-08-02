/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-preset-angular',
  setupFilesAfterEnv: ['<rootDir>/setup-jest.ts'],
  testEnvironment: 'jsdom',
  // `backend/` is a SEPARATE project with its own jest config, tsconfig and
  // node environment (better-sqlite3, Express, supertest). Without this, the
  // Angular run picks up backend/test/*.test.ts and fails them under jsdom.
  // Run backend tests with `npm test` inside backend/.
  testPathIgnorePatterns: [
    '<rootDir>/node_modules/',
    '<rootDir>/dist/',
    '<rootDir>/e2e/',
    '<rootDir>/backend/'
  ],
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
};
