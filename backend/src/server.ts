import { createApp } from './app';
import { ConfigError, loadConfig, type AppConfig } from './config';
import { createQuizRepositoryFromDatabase, describeBank, type QuizRepository } from './quiz/quiz.repository';
import { openDatabase, type DatabaseHandle } from './db/database';
import { migrate } from './db/migrate';
import { createSessionRepository } from './interview/session.repository';
import { InterviewSessionService } from './interview/session.service';

/**
 * Process entry point. Kept separate from `createApp` so tests never bind a
 * port and never open a real database.
 *
 * Startup order is deliberate:
 *   1. configuration
 *   2. private quiz bank (validated)
 *   3. database opened + PRAGMAs
 *   4. migrations
 *   5. dependencies
 *   6. app
 *   7. listen
 *
 * Any failure exits BEFORE listening. A server that accepts requests it cannot
 * serve is worse than one that never started, and this process holds the
 * answer key.
 */
async function main(): Promise<void> {
  const config = loadConfigOrExit();

  // ORDER MATTERS: the quiz bank now lives in PostgreSQL, so the database must
  // be open and migrated before the bank can be read. It is no longer loaded
  // from a file, and there is no fallback to one.
  const database = openDatabaseOrExit(config);
  await runMigrationsOrExit(database, config);

  const quizRepository = await loadQuizRepositoryOrExit(database, config);
  console.log(`[quiz] ${describeBank(quizRepository.stats)}`);

  // Constructed here so route code never touches database lifecycle.
  const sessionRepository = createSessionRepository(database);
  const interviewSessionService = new InterviewSessionService({
    quizRepository,
    sessionRepository,
    now: () => Date.now()
  });

  const app = createApp(config, { quizRepository, sessionRepository, interviewSessionService });

  const server = app.listen(config.port, () => {
    console.log(`[server] listening on :${config.port} (${config.nodeEnv})`);
    console.log(`[server] allowed origins: ${config.allowedOrigins.join(', ')}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;   // a second signal must not double-close
    shuttingDown = true;
    console.log(`[server] ${signal} received, closing`);
    server.close(() => {
      database.close();   // idempotent
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig(process.env);
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      console.error(`[config] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Load the bank from PostgreSQL. FAILS CLOSED.
 *
 * An empty or unreadable bank exits before listening. There is no fallback to
 * `data/quiz.json`: a server that silently served a stale file would defeat the
 * point of making the database authoritative, and in production that file is
 * not supposed to exist at all.
 */
async function loadQuizRepositoryOrExit(
  database: DatabaseHandle,
  config: AppConfig
): Promise<QuizRepository> {
  try {
    return await createQuizRepositoryFromDatabase(database);
  } catch (err: unknown) {
    await database.close();
    console.error(safeStartupMessage('quiz', 'quiz data failed to load', err, config));
    process.exit(1);
  }
}

function openDatabaseOrExit(config: AppConfig): DatabaseHandle {
  try {
    return openDatabase({ databaseUrl: config.databaseUrl });
  } catch (err: unknown) {
    console.error(safeStartupMessage('db', 'database could not be opened', err, config));
    process.exit(1);
  }
}

async function runMigrationsOrExit(database: DatabaseHandle, config: AppConfig): Promise<void> {
  try {
    const applied = await migrate(database);
    console.log(
      applied.length === 0
        ? '[db] schema up to date'
        : `[db] applied migration(s): ${applied.join(', ')}`
    );
  } catch (err: unknown) {
    // The database is already open — close it before exiting.
    database.close();
    console.error(safeStartupMessage('db', 'migrations failed', err, config));
    process.exit(1);
  }
}

/**
 * Local runs get the detail; production gets a fixed line. Loader, migration
 * and database messages are already path-free, but production output is kept
 * deliberately blunt rather than relying on that.
 */
function safeStartupMessage(
  scope: string,
  summary: string,
  err: unknown,
  config: AppConfig
): string {
  if (config.isProduction) return `[${scope}] ${summary} — refusing to start`;
  const detail = err instanceof Error ? err.message : String(err);
  return `[${scope}] ${detail}`;
}

main();
