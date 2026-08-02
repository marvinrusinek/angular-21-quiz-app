/**
 * Copy migration .sql files into the build output.
 *
 * `tsc` only emits .ts, so without this step the compiled server would start,
 * find no migrations, and fail — exactly the dev-vs-built divergence that bit
 * the quiz data path in Stage 3. A test asserts the files exist after a build.
 */
const { cpSync, existsSync, mkdirSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const from = resolve(root, 'src/db/migrations');
const to = resolve(root, 'dist/src/db/migrations');

if (!existsSync(from)) {
  console.error('[copy-migrations] source directory missing:', 'src/db/migrations');
  process.exit(1);
}

mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });

const copied = readdirSync(to).filter((file) => file.endsWith('.sql'));
if (copied.length === 0) {
  console.error('[copy-migrations] no .sql files were copied');
  process.exit(1);
}
console.log(`[copy-migrations] copied ${copied.length} migration file(s)`);
