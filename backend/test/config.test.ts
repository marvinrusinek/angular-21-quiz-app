import { ConfigError, loadConfig } from '../src/config';

/** Minimal env; each test overrides only what it exercises. */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...overrides } as NodeJS.ProcessEnv;
}

describe('loadConfig — defaults', () => {
  it('defaults port, paths and dev origins', () => {
    const config = loadConfig(env());
    expect(config.nodeEnv).toBe('test');
    expect(config.isProduction).toBe(false);
    expect(config.port).toBe(3000);
    expect(config.quizDataPath).toBe('./data/quiz.json');
    expect(config.databasePath).toBe('./data/sessions.db');
    expect(config.allowedOrigins).toEqual([
      'http://localhost:4200',
      'http://127.0.0.1:4200'
    ]);
  });

  it('defaults NODE_ENV to development when unset', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).nodeEnv).toBe('development');
  });

  it('rejects an unknown NODE_ENV rather than guessing', () => {
    expect(() => loadConfig(env({ NODE_ENV: 'staging' }))).toThrow(ConfigError);
  });
});

describe('loadConfig — port', () => {
  it('parses a valid port', () => {
    expect(loadConfig(env({ PORT: '8080' })).port).toBe(8080);
  });

  it.each(['0', '65536', '-1', 'abc', '3000.5'])('rejects invalid port %s', (port) => {
    expect(() => loadConfig(env({ PORT: port }))).toThrow(ConfigError);
  });

  it('treats an empty PORT as unset', () => {
    expect(loadConfig(env({ PORT: '   ' })).port).toBe(3000);
  });
});

describe('loadConfig — allowed origins', () => {
  it('parses and trims a comma-separated list', () => {
    const config = loadConfig(
      env({ ALLOWED_ORIGINS: 'http://localhost:4200 , https://example.github.io' })
    );
    expect(config.allowedOrigins).toEqual([
      'http://localhost:4200',
      'https://example.github.io'
    ]);
  });

  it('REJECTS a wildcard outright', () => {
    expect(() => loadConfig(env({ ALLOWED_ORIGINS: '*' }))).toThrow(/must not contain/i);
    expect(() => loadConfig(env({ ALLOWED_ORIGINS: 'http://localhost:4200,*' })))
      .toThrow(/must not contain/i);
  });

  it('rejects a malformed origin', () => {
    expect(() => loadConfig(env({ ALLOWED_ORIGINS: 'not-a-url' }))).toThrow(ConfigError);
  });

  it('rejects an origin carrying a path, query or fragment', () => {
    expect(() => loadConfig(env({ ALLOWED_ORIGINS: 'https://x.io/app' }))).toThrow(/no path/i);
    expect(() => loadConfig(env({ ALLOWED_ORIGINS: 'https://x.io/?a=1' }))).toThrow(/no path/i);
  });

  it('REQUIRES origins in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv))
      .toThrow(/required in production/i);
  });

  it('requires https origins in production', () => {
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'http://example.io' }))
    ).toThrow(/https/i);

    const config = loadConfig(
      env({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://example.github.io' })
    );
    expect(config.isProduction).toBe(true);
    expect(config.allowedOrigins).toEqual(['https://example.github.io']);
  });

  it('does NOT fall back to dev origins in production', () => {
    expect(() =>
      loadConfig(env({ NODE_ENV: 'production', ALLOWED_ORIGINS: '  ,  ' }))
    ).toThrow(/required in production/i);
  });
});

describe('loadConfig — data paths', () => {
  it('accepts overrides for the private quiz bank and database', () => {
    const config = loadConfig(
      env({ QUIZ_DATA_PATH: '/srv/private/quiz.json', DATABASE_PATH: '/srv/private/s.db' })
    );
    expect(config.quizDataPath).toBe('/srv/private/quiz.json');
    expect(config.databasePath).toBe('/srv/private/s.db');
  });
});
