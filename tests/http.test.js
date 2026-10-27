import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createApp } from '../src/http.js';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function start(routes) {
  const lines = [];
  const server = createApp({ routes, log: (line) => lines.push(line) }).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, lines };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('createApp', () => {
  for (const [name, handler] of [
    ['throws', () => { throw new Error('secret: hunter2'); }],
    ['rejects', async () => { throw new Error('secret: hunter2'); }],
  ]) {
    it(`returns a stable internal_error when a handler ${name}`, async () => {
      const { base, lines } = await start({ 'GET /boom': handler });
      const response = await fetch(`${base}/boom`);
      const text = await response.text();
      const { error } = JSON.parse(text);

      assert.equal(response.status, 500);
      assert.equal(error.code, 'internal_error');
      assert.equal(error.message, 'Erreur interne. Réessayez plus tard.');
      assert.match(error.requestId, uuid);
      assert.ok(!text.includes('hunter2'));
      assert.equal(lines.length, 1);
      assert.ok(lines[0].includes(error.requestId));
      assert.ok(lines[0].includes('hunter2'));
    });
  }

  it('ignores the query string when matching a route', async () => {
    const { base } = await start({
      'GET /ping': (request, response) => { response.end('pong'); },
    });
    assert.equal(await (await fetch(`${base}/ping?x=1`)).text(), 'pong');
  });

  it('returns the documented 404 for an unknown route', async () => {
    const { base } = await start({});
    const response = await fetch(`${base}/inconnu`);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: 'not_found', message: 'Ressource introuvable.' },
    });
  });
});
