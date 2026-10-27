import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createApp } from '../src/http.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { html, raw, readBody, sendPage } from '../src/web.js';

const servers = [];
const config = { origin: 'http://localhost' };

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function start(pool, extra = {}) {
  const routes = { ...buildRoutes(pool, () => {}, config), ...extra };
  const server = createApp({ routes, log: () => {}, before: buildBefore(pool, config) }).listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const echo = async (request, response) => {
  const body = await readBody(request);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body instanceof URLSearchParams ? Object.fromEntries(body) : body));
};

describe('html', () => {
  it('escapes interpolated values', () => {
    assert.equal(
      String(html`<p>${'<script>"x"&\'y\'</script>'}</p>`),
      '<p>&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;</p>'
    );
  });

  it('keeps raw fragments and concatenates arrays', () => {
    assert.equal(String(html`<p>${raw('<b>ok</b>')}</p>`), '<p><b>ok</b></p>');
    assert.equal(
      String(html`<ul>${['a', '<b>'].map((x) => html`<li>${x}</li>`)}</ul>`),
      '<ul><li>a</li><li>&lt;b&gt;</li></ul>'
    );
  });
});

describe('request guards', () => {
  it('serves the stylesheet to anonymous visitors', async () => {
    const base = await start(null);
    const response = await fetch(`${base}/static/fdl.css`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8');
  });

  it('sends pages with security headers', async () => {
    const base = await start(null, {
      'GET /connexion': (request, response) => sendPage(response, 200, 'Titre <x>', html`<p>ok</p>`),
    });
    const response = await fetch(`${base}/connexion`);
    const text = await response.text();
    assert.equal(response.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'none'");
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'same-origin');
    assert.match(text, /<html lang="fr">/);
    assert.match(text, /<title>Titre &lt;x&gt;<\/title>/);
  });

  it('rejects POST without or with a foreign Origin', async () => {
    const base = await start(null, { 'POST /connexion': echo });
    for (const headers of [{}, { origin: 'https://evil.example' }]) {
      const response = await fetch(`${base}/connexion`, { method: 'POST', headers, body: 'a=1' });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'bad_origin');
    }
  });

  it('parses form and JSON bodies', async () => {
    const base = await start(null, { 'POST /connexion': echo });
    const form = await fetch(`${base}/connexion`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1&b=%C3%A9',
    });
    assert.deepEqual(await form.json(), { a: '1', b: 'é' });
    const json = await fetch(`${base}/connexion`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    assert.deepEqual(await json.json(), { a: 1 });
  });

  it('answers 413 above 16 KiB and 400 on broken JSON', async () => {
    const base = await start(null, { 'POST /connexion': echo });
    const post = (contentType, body) => fetch(`${base}/connexion`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': contentType },
      body,
    });
    const big = await post('application/x-www-form-urlencoded', 'a=' + 'x'.repeat(17 * 1024));
    assert.equal(big.status, 413);
    assert.equal((await big.json()).error.code, 'payload_too_large');
    const bad = await post('application/json', '{nope');
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'bad_request');
  });

  it('redirects anonymous visitors to /connexion, even for unknown paths', async () => {
    const base = await start(null, { 'GET /prive': echo });
    for (const path of ['/prive', '/nimporte-quoi']) {
      const response = await fetch(`${base}${path}`, { redirect: 'manual' });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/connexion');
    }
  });
});
