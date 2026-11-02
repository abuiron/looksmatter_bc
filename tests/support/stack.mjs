// Starts and stops the three services as child processes for the end-to-end tests.
//
// Each service gets a complete, explicit environment. Every variable its code reads is
// set here (empty when unused), so a developer's real .env file can never leak into a
// test run: dotenv does not override variables that are already set.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const LOG_DIR = path.join(tmpdir(), 'looksmatter-e2e-logs');

const DIRS = {
  gateway: path.join(ROOT, 'gateway'),
  'core-service': path.join(ROOT, 'services/core-service'),
  'order-service': path.join(ROOT, 'services/order-service'),
};

/** Every `process.env.NAME` a service's code reads (src/ and scripts/). */
export function envVarsReadBy(service) {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.js')) {
        for (const [, name] of readFileSync(full, 'utf8').matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(name);
      }
    }
  };
  for (const sub of ['src', 'scripts']) {
    try { walk(path.join(DIRS[service], sub)); } catch { /* folder absent */ }
  }
  return [...names];
}

// Only what Node needs to run; nothing else from the developer's shell. (On Windows,
// process.env is case-insensitive, so PATH also finds "Path".)
const baseEnv = () =>
  Object.fromEntries(
    ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]])
  );

function assertCompleteEnv(service, env) {
  const missing = envVarsReadBy(service).filter((name) => !(name in env));
  if (missing.length) {
    throw new Error(`Test env for ${service} doesn't set ${missing.join(', ')}; a real .env value could leak in.`);
  }
}

const running = new Map();

export async function startService(service, env, { healthPath = '/health', port } = {}) {
  assertCompleteEnv(service, env);
  mkdirSync(LOG_DIR, { recursive: true });
  const log = createWriteStream(path.join(LOG_DIR, `${service}.log`), { flags: 'a' });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: DIRS[service],
    env: { ...baseEnv(), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  running.set(service, child);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${service} exited early (code ${child.exitCode}); see ${LOG_DIR}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}${healthPath}`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return child;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${service} did not become healthy on port ${port}; see ${LOG_DIR}`);
}

export async function stopService(service) {
  const child = running.get(service);
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
  running.delete(service);
}

export async function stopAll() {
  for (const service of [...running.keys()]) await stopService(service);
}

/** Run a service's script (e.g. the migration) to completion and return its output. */
export function runScript(service, script, args, env) {
  assertCompleteEnv(service, env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: DIRS[service],
      env: { ...baseEnv(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, output }));
  });
}
