#!/usr/bin/env node
/**
 * Run the Angular app and the Interview backend together.
 *
 * Interview Mode is backend-driven: the app on :4200 creates and scores every
 * assessment through the API on :3000, so `ng serve` alone leaves Interview
 * Mode reporting "Cannot reach the interview service". Topic Quizzes and Weak
 * Areas Practice still work without it.
 *
 * Deliberately dependency-free (no concurrently / npm-run-all) — it spawns two
 * child processes, prefixes their output so you can tell them apart, and makes
 * sure Ctrl-C or either one dying takes the other down instead of leaving an
 * orphan holding a port.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const TARGETS = [
  { name: 'api', color: '[36m', args: ['run', 'dev'], cwd: path.join(ROOT, 'backend') },
  { name: 'web', color: '[35m', args: ['start'], cwd: ROOT }
];

const RESET = '[0m';
const children = [];
let shuttingDown = false;

function shutdown(reason, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.log(`\n[dev] ${reason} — stopping both.`);

  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      // On Windows, SIGTERM does not reliably reach a grandchild (npm → ng),
      // so kill the whole process tree by pid.
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    }
  }
  setTimeout(() => process.exit(code ?? 0), 500);
}

for (const target of TARGETS) {
  // Windows needs a shell to launch npm.cmd — Node refuses to spawn .cmd
  // directly (EINVAL) since the 2024 command-injection hardening.
  const child = spawn(npm, target.args, {
    cwd: target.cwd,
    shell: process.platform === 'win32'
  });
  children.push(child);

  const prefix = `${target.color}[${target.name}]${RESET} `;
  const pipe = (stream) => {
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) console.log(prefix + line);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  child.on('exit', (code) => shutdown(`${target.name} exited (${code})`, code ?? 0));
  child.on('error', (err) => shutdown(`${target.name} failed to start: ${err.message}`, 1));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown('interrupted', 0));
}

console.log('[dev] api → http://localhost:3000/api/health');
console.log('[dev] web → http://localhost:4200');
console.log('[dev] Ctrl-C stops both.\n');
