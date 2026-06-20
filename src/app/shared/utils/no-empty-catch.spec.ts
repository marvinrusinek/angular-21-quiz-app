/**
 * ERROR-VISIBILITY TRIPWIRE (CODE_REVIEW P0 — error swallowing).
 *
 * The project has no eslint, so this test is the guard: it pins the directories
 * that the error-logging rollout already cleaned to ZERO silent catches, and
 * fails if a new empty `catch {}` / `catch { /* ignore *​/ }` is introduced
 * there. New code in these dirs must route caught errors through the shared
 * helpers instead — `reportError(context, err)` for failures that matter in
 * production, or `swallow(context, err)` for the dev-only long tail.
 *
 * The fragile pipelines (services/features, services/options, the FET watchdog,
 * feedback component, option-item) and the logger's own must-not-throw catches
 * are deliberately OUT of scope here — their remaining silent catches are
 * memory-protected and wait on an e2e net before being touched.
 */
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Directories proven clean (0 silent catches) by the prior rollout. Keep them so.
const GUARDED_DIRS = [
  'src/app/containers',
  'src/app/shared/services/data',
  'src/app/shared/services/state',
  'src/app/shared/services/flow',
  'src/app/shared/services/ui',
  'src/app/shared/directives',
  'src/app/shared/pipes'
];

// Matches `catch (e?) { }` whose body is ONLY whitespace and/or comments.
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\r?\n\s*)*\}/g;

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...tsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

function emptyCatchCount(source: string): number {
  const matches = source.match(EMPTY_CATCH);
  return matches ? matches.length : 0;
}

describe('error visibility — no new silent catches in already-clean dirs', () => {
  it('self-check: the regex detects an empty catch and ignores a handled one', () => {
    expect(emptyCatchCount('try { x(); } catch {}')).toBe(1);
    expect(emptyCatchCount('try { x(); } catch (e) { /* ignore */ }')).toBe(1);
    expect(emptyCatchCount('try { x(); } catch {\n  // nope\n}')).toBe(1);
    expect(emptyCatchCount("try { x(); } catch (e) { swallow('ctx', e); }")).toBe(0);
    expect(emptyCatchCount("try { x(); } catch (e) { reportError('ctx', e); }")).toBe(0);
  });

  it('the guarded directories contain zero silent catch blocks', () => {
    const offenders: string[] = [];
    for (const dir of GUARDED_DIRS) {
      for (const file of tsFiles(dir)) {
        const n = emptyCatchCount(readFileSync(file, 'utf8'));
        if (n > 0) offenders.push(`${file.replace(/\\/g, '/')}: ${n}`);
      }
    }
    // If this fails, route the new catch through reportError()/swallow()
    // instead of leaving it empty (see src/app/shared/utils/error-logging.ts).
    expect(offenders).toEqual([]);
  });
});
