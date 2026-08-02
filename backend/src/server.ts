import { createApp } from './app';
import { ConfigError, loadConfig, type AppConfig } from './config';
import { createQuizRepository, describeBank, type QuizRepository } from './quiz/quiz.repository';
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
function main(): void {
  const config = loadConfigOrExit();
  const quizRepository = loadQuizRepositoryOrExit(config);
  console.log(`[quiz] ${describeBank(quizRepository.stats)}`);

  const database = openDatabaseOrExit(config);
  runMigrationsOrExit(database, config);

  // Constructed here so route code never touches database lifecycle.
  const sessionRepository = createSessionRepository(database.db);
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

function loadQuizRepositoryOrExit(config: AppConfig): QuizRepository {
  try {
    return createQuizRepository({ dataPath: config.quizDataPath });
  } catch (err: unknown) {
    console.error(safeStartupMessage('quiz', 'quiz data failed to load', err, config));
    process.exit(1);
  }
}

function openDatabaseOrExit(config: AppConfig): DatabaseHandle {
  try {
    return openDatabase({ databasePath: config.databasePath });
  } catch (err: unknown) {
    console.error(safeStartupMessage('db', 'database could not be opened', err, config));
    process.exit(1);
  }
}

function runMigrationsOrExit(database: DatabaseHandle, config: AppConfig): void {
  try {
    const applied = migrate(database.db);
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
