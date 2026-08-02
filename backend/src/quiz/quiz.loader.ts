import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/**
 * Reads the private quiz file from disk.
 *
 * The path comes ONLY from server configuration. No request value ever reaches
 * this module, so there is no traversal surface — and the containment check
 * below means even a mis-set config cannot point the loader at an arbitrary
 * file outside the backend directory.
 *
 * Errors deliberately omit the absolute path: they surface in logs and, in the
 * worst case, an error response, and the location of the answer key is not
 * something to advertise.
 */

export class QuizDataFileError extends Error {
  public override readonly name = 'QuizDataFileError';
}

/** Generous for a ~180 KB bank; small enough that a wrong path fails fast. */
const MAX_BYTES = 8 * 1024 * 1024;

export interface LoadOptions {
  /**
   * Directory the data file must live under. Defaults to the process working
   * directory — the backend package root in every supported run mode
   * (`npm start`, `npm run dev`, `npm test`).
   *
   * Deliberately NOT derived from `__dirname`: that points at `src/quiz` under
   * ts-node but `dist/src/quiz` after a build, so a `__dirname`-relative root
   * silently changes between `npm run dev` and `npm start`.
   */
  readonly rootDir?: string;
  /** Permits a fixture outside rootDir. Test-only; never set in production. */
  readonly allowOutsideRoot?: boolean;
}

function describe(path: string): string {
  // Basename only — never the absolute path.
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? 'quiz data file';
}

export function resolveQuizDataPath(dataPath: string, options: LoadOptions = {}): string {
  if (typeof dataPath !== 'string' || dataPath.trim().length === 0) {
    throw new QuizDataFileError('Quiz data path is not configured');
  }

  const rootDir = resolve(options.rootDir ?? process.cwd());
  const absolute = isAbsolute(dataPath) ? resolve(dataPath) : resolve(rootDir, dataPath);

  if (!options.allowOutsideRoot) {
    const contained = absolute === rootDir || absolute.startsWith(rootDir + sep);
    if (!contained) {
      throw new QuizDataFileError('Quiz data path resolves outside the backend directory');
    }
  }

  return absolute;
}

export function readQuizDataFile(dataPath: string, options: LoadOptions = {}): unknown {
  const absolute = resolveQuizDataPath(dataPath, options);
  const label = describe(absolute);

  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    throw new QuizDataFileError(`Quiz data file not found: ${label}`);
  }

  if (stats.isDirectory()) {
    throw new QuizDataFileError(`Quiz data path is a directory, not a file: ${label}`);
  }
  if (!stats.isFile()) {
    throw new QuizDataFileError(`Quiz data path is not a regular file: ${label}`);
  }
  if (stats.size === 0) {
    throw new QuizDataFileError(`Quiz data file is empty: ${label}`);
  }
  if (stats.size > MAX_BYTES) {
    throw new QuizDataFileError(`Quiz data file exceeds the ${MAX_BYTES} byte limit: ${label}`);
  }

  let contents: string;
  try {
    contents = readFileSync(absolute, 'utf8');
  } catch {
    throw new QuizDataFileError(`Quiz data file could not be read: ${label}`);
  }

  try {
    return JSON.parse(contents) as unknown;
  } catch {
    // The parser message can quote file content — drop it.
    throw new QuizDataFileError(`Quiz data file is not valid JSON: ${label}`);
  }
}
