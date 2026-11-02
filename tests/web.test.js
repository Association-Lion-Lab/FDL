import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createApp } from '../src/http.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { html, raw, readBody, readForm, sendPage } from '../src/web.js';

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

  it('accepts a larger body when the route raises max', async () => {
    const big = async (request, response) => {
      const body = await readBody(request, { max: 256 * 1024 });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ size: body.get('a').length }));
    };
    const base = await start(null, { 'POST /connexion': big });
    const response = await fetch(`${base}/connexion`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=' + 'x'.repeat(100 * 1024),
    });
    assert.equal((await response.json()).size, 100 * 1024);
  });

  it('answers 400 on a NUL byte, which PostgreSQL text refuses', async () => {
    const base = await start(null, { 'POST /connexion': echo });
    const post = (contentType, body) => fetch(`${base}/connexion`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': contentType },
      body,
    });
    for (const [type, body] of [
      ['application/x-www-form-urlencoded', 'email=a%00b'],
      ['application/x-www-form-urlencoded', 'a%00=1'],
      ['application/json', '{"name":"a\\u0000b"}'],
      ['application/json', '{"a\\u0000":1}'],
    ]) {
      const response = await post(type, body);
      assert.equal(response.status, 400, body);
      assert.equal((await response.json()).error.code, 'bad_request', body);
    }
  });

  describe('readForm', () => {
    const form = async (request, response) => {
      const { body, files } = await readForm(request, { max: 64 * 1024 });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ title: body.get('title'), sizes: [...files].map(([k, v]) => [k, v.length]) }));
    };
    const send = async (data, headers = {}) => {
      const base = await start(null, { 'POST /connexion': form });
      return fetch(`${base}/connexion`, { method: 'POST', headers: { origin: 'http://localhost', ...headers }, body: data });
    };

    it('reads text fields and a file from multipart', async () => {
      const data = new FormData();
      data.append('title', 'Pâtes');
      data.append('photo', new Blob([Buffer.from([1, 2, 3, 4])]), 'a.jpg');
      const result = await (await send(data)).json();
      assert.equal(result.title, 'Pâtes');
      assert.deepEqual(result.sizes, [['photo', 4]]);
    });

    it('drops an empty file input and still reads urlencoded', async () => {
      const data = new FormData();
      data.append('photo', new Blob([]), '');
      assert.deepEqual((await (await send(data)).json()).sizes, []);
      const plain = await send('title=x', { 'content-type': 'application/x-www-form-urlencoded' });
      assert.equal((await plain.json()).title, 'x');
    });

    it('answers 400 on unreadable multipart, a wrong type and a NUL, 413 above max', async () => {
      const bad = await send("n'importe quoi", { 'content-type': 'multipart/form-data; boundary=x' });
      assert.equal(bad.status, 400);
      assert.equal((await send('{}', { 'content-type': 'application/json' })).status, 400);
      const nul = new FormData();
      nul.append('title', 'a\0b');
      assert.equal((await send(nul)).status, 400);
      const big = new FormData();
      big.append('photo', new Blob([Buffer.alloc(65 * 1024)]), 'a.jpg');
      assert.equal((await send(big)).status, 413);
    });
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
