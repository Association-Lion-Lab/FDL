import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createApp, parsePort } from '../src/server.js';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('GET /health', () => {
  it('returns a minimal status without private data', async () => {
    const server = createApp().listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));

    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/health`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await response.json(), { status: 'ok' });
  });

  it('returns the documented error shape for an unknown route', async () => {
    const server = createApp().listen(0, '127.0.0.1');
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
