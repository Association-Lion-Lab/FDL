import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createTestDatabase } from './helpers/db.js';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
const TIMEOUT = 20000;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function isRefused(port) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
  });
}

function baseEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('PG')) env[key] = value;
  }
  return { FDL_ORIGIN: 'http://localhost', FDL_SECRET_KEY: '0'.repeat(64), ...env, ...extra };
}

// Spawns the server; output is captured, never piped to the test runner.
function start(env) {
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { child, stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { run.stdout += chunk; });
  child.stderr.on('data', (chunk) => { run.stderr += chunk; });
  // Safety net: a regression that hangs is killed, so the test fails instead of hanging.
  const watchdog = setTimeout(() => child.kill(), 15000);
  run.exited = new Promise((resolve) => child.once('exit', (code) => { clearTimeout(watchdog); resolve(code); }));
  return run;
}

async function withDataDir(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'fdl-startup-'));
  try {
    await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('FDL_DATA_DIR manquant : code 1, message nommant la variable, rien n\'écoute', { timeout: TIMEOUT }, async () => {
  const port = await freePort();
  const run = start(baseEnv({ PORT: String(port) }));
  try {
    assert.equal(await run.exited, 1);
    assert.match(run.stderr, /FDL_DATA_DIR/);
    assert.equal(await isRefused(port), true);
  } finally {
    run.child.kill();
  }
});

test('base injoignable : code 1, message sans le mot de passe', { timeout: TIMEOUT }, async () => {
  await withDataDir(async (dataDir) => {
    const port = await freePort();
    const closedPort = await freePort();
    const password = 'secret-ne-pas-afficher';
    const run = start(baseEnv({
      FDL_DATA_DIR: dataDir,
      PORT: String(port),
      PGHOST: '127.0.0.1',
      PGPORT: String(closedPort),
      PGPASSWORD: password,
    }));
    try {
      assert.equal(await run.exited, 1);
      assert.match(run.stderr, /^Base de données injoignable ou refusée : \S+\n$/);
      assert.ok(!run.stderr.includes(password));
      assert.ok(!run.stdout.includes(password));
      assert.equal(await isRefused(port), true);
    } finally {
      run.child.kill();
    }
  });
});

test('configuration valide : /ready répond 200', { timeout: TIMEOUT }, async () => {
  const db = await createTestDatabase();
  try {
    await withDataDir(async (dataDir) => {
      const port = await freePort();
      const run = start(baseEnv({ FDL_DATA_DIR: dataDir, PORT: String(port), PGDATABASE: db.database }));
      try {
        let status = 0;
        const deadline = Date.now() + 10000;
        while (status !== 200 && Date.now() < deadline) {
          try {
            status = (await fetch(`http://127.0.0.1:${port}/ready`)).status;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        assert.equal(status, 200, run.stderr);
        assert.match(run.stdout, /migrations : 0 → 1/);
      } finally {
        run.child.kill();
        await run.exited;
      }
    });
  } finally {
    await db.drop();
  }
});
