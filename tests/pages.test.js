import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/http.js';
import { LEGAL_PATHS } from '../src/routes/pages.js';
import { buildBefore, buildRoutes } from '../src/server.js';

const config = { origin: 'http://localhost' };
let server;
let base;

before(async () => {
  server = createApp({ routes: buildRoutes(null, () => {}, config), before: buildBefore(null, config), log: () => {} }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

describe('legal pages', () => {
  it('are reachable without a session and linked from every page footer', async () => {
    assert.deepEqual(LEGAL_PATHS, ['/mentions-legales', '/confidentialite', '/conditions', '/faq']);
    for (const path of LEGAL_PATHS) {
      const response = await fetch(base + path, { redirect: 'manual' });
      assert.equal(response.status, 200, path);
      const body = await response.text();
      assert.match(body, /<h1>/, path);
      for (const link of LEGAL_PATHS) assert.ok(body.includes(`href="${link}"`), `${path} -> ${link}`);
    }
  });

  it('do not open the rest of the site', async () => {
    const response = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/connexion');
  });
});
