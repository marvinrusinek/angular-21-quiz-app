const {
  assertSafeSeedTarget,
  databaseNameOf,
  SeedTargetError,
  E2E_PREFIX
} = require('./seed-target-guard');

/**
 * The E2E seed guard.
 *
 * Seeding runs the quiz-bank import, which DELETES and reinserts every
 * question. Pointed at the developer's own database it would silently rewrite
 * real data with no warning, so "it starts with e2e_" is not a strong enough
 * reason to proceed — the guard has to be provably unable to target anything
 * else.
 *
 * These tests exercise the SAME function the harness calls; there is no copy.
 * Pure and offline: no database, no network, no Playwright.
 */

/** The developer's real connection string shape — the thing to never touch. */
const DEV_URL =
  'postgresql://neondb_owner:npg_placeholder@ep-example-1234-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require';

const RUN = 'e2e_msj3s9od_26880_jb9ouv';
const RUN_URL =
  `postgresql://neondb_owner:npg_placeholder@ep-example-1234.us-west-2.aws.neon.tech/${RUN}?sslmode=require`;

describe('databaseNameOf', () => {
  it('reads the database name from the PATH, not anywhere else', () => {
    expect(databaseNameOf(DEV_URL)).toBe('neondb');
    expect(databaseNameOf(RUN_URL)).toBe(RUN);
    expect(databaseNameOf('postgres://u:p@host:5432/mydb')).toBe('mydb');
  });

  it('returns null for anything it cannot understand', () => {
    for (const bad of [
      '', '   ', 'not a url', 'mysql://u:p@host/db', 'http://example.com/db',
      'postgres://u:p@host', 'postgres://u:p@host/', 'postgres://u:p@host/a/b',
      null, undefined, 42, {}
    ]) {
      expect(databaseNameOf(bad as never)).toBeNull();
    }
  });
});

describe('assertSafeSeedTarget REFUSES', () => {
  it('the developer\'s real database, outright', () => {
    expect(() => assertSafeSeedTarget(DEV_URL, RUN)).toThrow(SeedTargetError);
    expect(() => assertSafeSeedTarget(DEV_URL, RUN)).toThrow(/not a e2e_\* throwaway database/);
  });

  /**
   * THE HOLE THE OLD CHECK LEFT OPEN.
   *
   * The first version tested `databaseUrl.includes(name)`. Every URL below
   * CONTAINS the expected name — in the host, the username, the password or a
   * query parameter — while pointing at `neondb`. A substring check would have
   * let each of them through and rewritten the developer's data.
   */
  it.each([
    ['name in the HOST', `postgresql://u:p@${RUN}.aws.neon.tech/neondb`],
    ['name in the USERNAME', `postgresql://${RUN}:p@host.neon.tech/neondb`],
    ['name in the PASSWORD', `postgresql://u:${RUN}@host.neon.tech/neondb`],
    ['name in a QUERY PARAM', `postgresql://u:p@host.neon.tech/neondb?application_name=${RUN}`],
    ['name in a PATH SEGMENT that is not the database', `postgresql://u:p@host/${RUN}/neondb`]
  ])('a URL that merely CONTAINS the expected name — %s', (_label, url) => {
    expect(() => assertSafeSeedTarget(url, RUN)).toThrow(SeedTargetError);
  });

  it('a database whose name only STARTS WITH the expected one', () => {
    // `e2e_..._jb9ouv` vs `e2e_..._jb9ouv_evil` — a prefix match is not identity.
    const url = `postgresql://u:p@host/${RUN}_evil`;
    expect(() => assertSafeSeedTarget(url, RUN)).toThrow(/is not this run's database/);
  });

  it('a DIFFERENT throwaway database from another concurrent run', () => {
    const other = 'e2e_zzzzzzzz_9999_aaaaaa';
    expect(() => assertSafeSeedTarget(`postgresql://u:p@host/${other}`, RUN))
      .toThrow(/is not this run's database/);
  });

  it('any database not carrying the e2e_ prefix', () => {
    for (const database of ['neondb', 'postgres', 'production', 'quiz', 'e2', 'E2E_upper']) {
      expect(() => assertSafeSeedTarget(`postgresql://u:p@host/${database}`, RUN))
        .toThrow(SeedTargetError);
    }
  });

  it('a missing, blank or malformed connection string', () => {
    for (const url of ['', '   ', 'garbage', 'mysql://u:p@host/e2e_x', null, undefined]) {
      expect(() => assertSafeSeedTarget(url as never, RUN))
        .toThrow(/missing or not a postgres:\/\/ URL/);
    }
  });

  it('an EXPECTED NAME that is not itself a throwaway database', () => {
    // Redundant with the target check by design: if a bug ever made the
    // expected name the developer's database, this still refuses.
    for (const expected of ['neondb', 'postgres', '', 'production', null, undefined]) {
      expect(() => assertSafeSeedTarget(RUN_URL, expected as never))
        .toThrow(/expected database name is not e2e_\*/);
    }
  });

  it('the dev URL even when the expected name is ALSO wrong', () => {
    // Both guards fail; it must still refuse rather than let two wrongs pass.
    expect(() => assertSafeSeedTarget(DEV_URL, 'neondb')).toThrow(SeedTargetError);
  });
});

describe('assertSafeSeedTarget ACCEPTS', () => {
  it('exactly this run\'s throwaway database', () => {
    expect(() => assertSafeSeedTarget(RUN_URL, RUN)).not.toThrow();
  });

  it('the same database without query parameters or credentials', () => {
    expect(() => assertSafeSeedTarget(`postgres://host/${RUN}`, RUN)).not.toThrow();
    expect(() => assertSafeSeedTarget(`postgresql://u:p@host:5432/${RUN}`, RUN)).not.toThrow();
  });

  it('surrounding whitespace', () => {
    expect(() => assertSafeSeedTarget(`  ${RUN_URL}  `, RUN)).not.toThrow();
  });
});

describe('the prefix is what the harness actually generates', () => {
  it('matches the name format ensure-e2e-database.js creates', () => {
    expect(E2E_PREFIX).toBe('e2e_');
    expect(RUN.startsWith(E2E_PREFIX)).toBe(true);
  });
});
