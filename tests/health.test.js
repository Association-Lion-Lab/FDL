import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';

import { parsePort } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
import { buildRoutes } from '../src/server.js';
import { createTestDatabase } from './helpers/db.js';

const servers = [];
const routes = buildRoutes(null, () => {}, { origin: 'http://localhost' });

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('GET /health', () => {
  it('returns a minimal status without private data', async () => {
    const server = createApp({ routes, log: () => {} }).listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));

    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/health`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await response.json(), { status: 'ok' });
  });

  it('returns the documented error shape for an unknown route', async () => {
    const server = createApp({ routes, log: () => {} }).listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));

    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/unknown`);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: 'not_found', message: 'Ressource introuvable.' },
    });
  });
});

describe('GET /ready', () => {
  const notReady = {
    error: { code: 'not_ready', message: 'Service momentanément indisponible.' },
  };

  async function get(pool, path, logs = []) {
    const server = createApp({ routes: buildRoutes(pool, (line) => logs.push(line), { origin: 'http://localhost' }), log: () => {} }).listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { response, text: await response.text() };
  }

  it('returns 200 when the schema is at the latest version', async () => {
    const testDb = await createTestDatabase();
    try {
      await migrate(testDb.pool);
      const { response, text } = await get(testDb.pool, '/ready');
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(text), { status: 'ok' });
    } finally {
      await testDb.drop();
    }
  });

  it('returns 503 not_ready when the database is not migrated', async () => {
    const testDb = await createTestDatabase();
    try {
      const logs = [];
      const { response, text } = await get(testDb.pool, '/ready', logs);
      assert.equal(response.status, 503);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /^ready: schema 0 attendu \d+$/);
      assert.deepEqual(JSON.parse(text), notReady);
    } finally {
      await testDb.drop();
    }
  });

  it('returns 503 without leaking details when the database is unreachable', async () => {
    const database = `fdl_missing_${randomBytes(8).toString('hex')}`;
    const pool = createPool({ database });
    try {
      const logs = [];
      const { response, text } = await get(pool, '/ready', logs);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /^ready: /);
      assert.equal(response.status, 503);
      assert.deepEqual(JSON.parse(text), notReady);
      assert.ok(!text.includes(database));
      assert.ok(process.env.PGHOST);
      assert.ok(!text.includes(process.env.PGHOST));
      assert.ok(!/does not exist|ECONNREFUSED|password/i.test(text));
    } finally {
      await pool.end();
    }
  });
});

describe('createPool', () => {
  it('bounds the connection time', async () => {
    const pool = createPool();
    try {
      assert.equal(pool.options.connectionTimeoutMillis, 2000);
    } finally {
      await pool.end();
    }
  });
});

describe('parsePort', () => {
  it('uses port 3000 when no value is configured', () => {
    assert.equal(parsePort(undefined), 3000);
  });

  it('rejects an invalid port', () => {
    assert.throws(() => parsePort('not-a-port'), /PORT/);
    assert.throws(() => parsePort('0'), /PORT/);
    assert.throws(() => parsePort('65536'), /PORT/);
  });
});
