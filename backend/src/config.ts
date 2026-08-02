/**
 * Typed, validated configuration.
 *
 * `loadConfig` is a PURE function of an env-like record so tests can exercise
 * every branch without mutating `process.env`. It fails fast: a misconfigured
 * server that starts is worse than one that refuses to, because this process
 * holds the answer key.
 */

export type NodeEnv = 'development' | 'test' | 'production';

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly isProduction: boolean;
  readonly port: number;
  /** Exact origins allowed to call the API. Never a wildcard in production. */
  readonly allowedOrigins: readonly string[];
  /** Private quiz bank. MUST NOT live under any statically served directory. */
  readonly quizDataPath: string;
  /** SQLite file for assessment sessions (used from Stage 4). */
  readonly databasePath: string;
}

export class ConfigError extends Error {
  public override readonly name = 'ConfigError';
}

const VALID_ENVS: readonly NodeEnv[] = ['development', 'test', 'production'];

const DEFAULT_DEV_ORIGINS: readonly string[] = [
  'http://localhost:4200',
  'http://127.0.0.1:4200'
];

function parseNodeEnv(raw: string | undefined): NodeEnv {
  const value = (raw ?? 'development').trim();
  if (!VALID_ENVS.includes(value as NodeEnv)) {
    throw new ConfigError(
      `NODE_ENV must be one of ${VALID_ENVS.join(', ')} — received "${value}"`
    );
  }
  return value as NodeEnv;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer 1-65535 — received "${raw}"`);
  }
  return port;
}

/**
 * Origins are an explicit allow-list. A wildcard is rejected outright rather
 * than downgraded with a warning: the frontend is hosted on a known origin, so
 * a wildcard here is always a mistake, and silently accepting one would defeat
 * the point of restricting the API at all.
 */
function parseAllowedOrigins(raw: string | undefined, isProduction: boolean): readonly string[] {
  const entries = (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (entries.includes('*')) {
    throw new ConfigError('ALLOWED_ORIGINS must not contain "*" — list exact origins');
  }

  if (entries.length === 0) {
    if (isProduction) {
      throw new ConfigError('ALLOWED_ORIGINS is required in production');
    }
    return DEFAULT_DEV_ORIGINS;
  }

  for (const origin of entries) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigError(`ALLOWED_ORIGINS entry is not a valid URL: "${origin}"`);
    }
    // An Origin header is scheme + host + port only; a path would never match.
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw new ConfigError(
        `ALLOWED_ORIGINS entry must be scheme://host[:port] with no path: "${origin}"`
      );
    }
    if (isProduction && parsed.protocol !== 'https:') {
      throw new ConfigError(`ALLOWED_ORIGINS must use https in production: "${origin}"`);
    }
  }

  return entries;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = parseNodeEnv(env['NODE_ENV']);
  const isProduction = nodeEnv === 'production';

  return {
    nodeEnv,
    isProduction,
    port: parsePort(env['PORT']),
    allowedOrigins: parseAllowedOrigins(env['ALLOWED_ORIGINS'], isProduction),
    quizDataPath: (env['QUIZ_DATA_PATH'] ?? './data/quiz.json').trim(),
    databasePath: (env['DATABASE_PATH'] ?? './data/sessions.db').trim()
  };
}
