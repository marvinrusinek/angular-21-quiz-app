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
const { existsSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const TARGETS = [
  { name: 'api', color: '[36m', port: 3000, args: ['run', 'dev'], cwd: path.join(ROOT, 'backend') },
  { name: 'web', color: '[35m', port: 4200, args: ['start'], cwd: ROOT }
];

/**
 * A busy port is the most common way this fails — a leftover server, or a
 * Playwright run that started its own backend. Reporting it plainly beats a
 * twenty-line EADDRINUSE stack trace from whichever process lost the race.
 */
function findPortOwner(port) {
  return new Promise((resolve) => {
    const socket = net
      .connect({ port, host: '127.0.0.1' })
      .setTimeout(700)
      .on('connect', () => { socket.destroy(); resolve(true); })
      .on('timeout', () => { socket.destroy(); resolve(false); })
      .on('error', () => resolve(false));
  });
}

async function assertPortsFree() {
  const busy = [];
  for (const target of TARGETS) {
    if (await findPortOwner(target.port)) busy.push(target);
  }
  if (busy.length === 0) return;

  console.error('\n[dev] Cannot start — already in use:');
  for (const target of busy) {
    console.error(`  :${target.port}  (${target.name})`);
  }
  console.error(
    '\n[dev] Something is already serving it — a previous `npm run dev`, or a\n' +
    '      Playwright run that starts its own backend on :3000. Stop it, or on\n' +
    '      Windows find and end the owner:\n\n' +
    `        Get-NetTCPConnection -LocalPort ${busy[0].port} -State Listen |\n` +
    '          ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n'
  );
  process.exit(1);
}

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

function start(target) {
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

/**
 * The backend is a separate npm project with its own dependencies, and one of
 * them (better-sqlite3) is a NATIVE module. Two failure modes are worth naming
 * rather than leaving as "command not found: ts-node":
 *
 *   * a fresh clone where `npm install` was only run at the root;
 *   * an environment that cannot build native addons at all — StackBlitz's
 *     WebContainer runs a JS-only Node, so the backend cannot run there. Use
 *     `npm start` alone there; it talks to the hosted API.
 */
function assertBackendInstalled() {
  const backendModules = path.join(ROOT, 'backend', 'node_modules', 'ts-node');
  if (existsSync(backendModules)) return;

  console.error(
    '\n[dev] The backend has no dependencies installed.\n\n' +
    '      The backend is a separate npm project:\n\n' +
    '        npm --prefix backend install\n\n' +
    '      If you are on StackBlitz or another WebContainer, the backend cannot\n' +
    '      run there at all — better-sqlite3 is a native module. Run just:\n\n' +
    '        npm start\n\n' +
    '      which uses the hosted API instead of a local one.\n'
  );
  process.exit(1);
}

async function main() {
  assertBackendInstalled();
  await assertPortsFree();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => shutdown('interrupted', 0));
  }

  console.log('[dev] api → http://localhost:3000/api/health');
  console.log('[dev] web → http://localhost:4200');
  console.log('[dev] Ctrl-C stops both.\n');

  for (const target of TARGETS) start(target);
}

main();
