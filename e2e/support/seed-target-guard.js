/**
 * The guard that decides whether a connection string may be seeded.
 *
 * Extracted as a PURE function so it can be tested exhaustively without a
 * database, a network, or Playwright. The E2E harness imports the same function
 * it is tested against — a copy would be worse than no test.
 *
 * ── Why this needs to be more than a naming convention ─────────────
 *
 * Seeding runs the quiz-bank import, which DELETES and reinserts every
 * question. Pointed at the developer's own database it would silently rewrite
 * real data. The first version checked `databaseUrl.includes(name)`, which is
 * far too weak: a substring can match the HOST, the USERNAME, the PASSWORD or a
 * query parameter, none of which say anything about which database is targeted.
 *
 * This parses the URL and compares the DATABASE NAME — the path — exactly.
 */

/** Every throwaway database the harness generates starts with this. */
const E2E_PREFIX = 'e2e_';

class SeedTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeedTargetError';
  }
}

/**
 * Extract the database name from a connection string.
 *
 * Returns null when the URL is unusable, so callers fail closed rather than
 * proceeding with a half-understood target.
 */
function databaseNameOf(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) return null;

  let parsed;
  try {
    parsed = new URL(databaseUrl.trim());
  } catch {
    return null;
  }

  if (!/^postgres(ql)?:$/i.test(parsed.protocol)) return null;

  // '/neondb' -> 'neondb'. A path with extra segments is not a database name.
  const name = parsed.pathname.replace(/^\//, '');
  if (name.length === 0 || name.includes('/')) return null;

  return decodeURIComponent(name);
}

/**
 * Throw unless `databaseUrl` targets exactly the expected throwaway database.
 *
 * Three independent conditions, all required:
 *   1. the URL parses as a postgres connection string
 *   2. its DATABASE NAME equals `expectedName` exactly — not a prefix, not a
 *      substring, and not a match anywhere else in the URL
 *   3. that name is one this harness generates (`e2e_` prefixed)
 *
 * Condition 3 is deliberately redundant with 2. If a bug ever let the expected
 * name become the developer's database, 3 still refuses.
 */
function assertSafeSeedTarget(databaseUrl, expectedName) {
  if (typeof expectedName !== 'string' || !expectedName.startsWith(E2E_PREFIX)) {
    throw new SeedTargetError(
      `refusing to seed: expected database name is not ${E2E_PREFIX}* (got "${expectedName}")`
    );
  }

  const actual = databaseNameOf(databaseUrl);
  if (actual === null) {
    throw new SeedTargetError('refusing to seed: DATABASE_URL is missing or not a postgres:// URL');
  }

  if (!actual.startsWith(E2E_PREFIX)) {
    throw new SeedTargetError(
      `refusing to seed: target database "${actual}" is not a ${E2E_PREFIX}* throwaway database`
    );
  }

  if (actual !== expectedName) {
    throw new SeedTargetError(
      `refusing to seed: target database "${actual}" is not this run's database "${expectedName}"`
    );
  }
}

module.exports = { assertSafeSeedTarget, databaseNameOf, SeedTargetError, E2E_PREFIX };
