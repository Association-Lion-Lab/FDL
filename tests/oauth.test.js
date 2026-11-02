import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { hashPassword } from '../src/accounts.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
import { createCode, exchangeCode, listLinks, loadToken, parseAuthorization, revokeLink } from '../src/oauth.js';
import { createLimiter } from '../src/ratelimit.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { openSession } from '../src/sessions.js';
import { landing } from '../src/web.js';
import { createTestDatabase } from './helpers/db.js';

let testDb;
let pool;
let me;

const client = 'https://manger.exemple.fr';
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const query = (fields) => new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: `${client}/fdl/retour`, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', ...fields });

beforeEach(async () => {
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
  const { rows } = await pool.query(
    "INSERT INTO accounts (email, display_name, password_hash, role) VALUES ('me@example.org', 'Membre', 'h', 'member') RETURNING id"
  );
  me = rows[0].id;
});

afterEach(async () => {
  await testDb.drop();
});

describe('parseAuthorization', () => {
  it('accepts a well-formed request, http included', () => {
    assert.deepEqual(parseAuthorization(query()), { ok: true, clientId: client, redirectUri: `${client}/fdl/retour`, challenge, state: 'xyz' });
    assert.equal(parseAuthorization(query({ client_id: 'http://192.168.1.10:3000', redirect_uri: 'http://192.168.1.10:3000/r' })).ok, true);
  });
  it('never redirects on a bad client or redirect_uri', () => {
    for (const fields of [
      { client_id: 'https://manger.exemple.fr/' }, { client_id: 'https://manger.exemple.fr/x' }, { client_id: 'ftp://a.b' },
      { client_id: 'nimporte' }, { redirect_uri: 'https://evil.example/r' }, { redirect_uri: `${client}/r#f` },
      { redirect_uri: '/r' }, { client_id: '' }, { redirect_uri: `${client}/r#` },
      { redirect_uri: ` ${client}/r` }, { redirect_uri: `${client}/r\n` },
    ]) assert.deepEqual(parseAuthorization(query(fields)).redirectUri, null, JSON.stringify(fields));
  });
  it('redirects the other errors with state', () => {
    assert.deepEqual(parseAuthorization(query({ response_type: 'token' })), { ok: false, redirectUri: `${client}/fdl/retour`, error: 'unsupported_response_type', state: 'xyz' });
    for (const fields of [{ code_challenge_method: 'plain' }, { code_challenge: 'court' }, { state: 's'.repeat(501) }]) {
      assert.equal(parseAuthorization(query(fields)).error, 'invalid_request');
    }
  });
});

describe('HTTP', () => {
  const config = { origin: 'http://localhost', rpID: 'localhost', secretKey: Buffer.alloc(32, 7) };
  let server;
  let base;
  let cookie;

  const start = async (options) => {
    const app = createApp({ routes: buildRoutes(pool, () => {}, config, {}), log: () => {}, before: buildBefore(pool, config, options) })
      .listen(0, '127.0.0.1');
    await new Promise((resolve) => app.once('listening', resolve));
    return [app, `http://127.0.0.1:${app.address().port}`];
  };
  const get = (path, withCookie = cookie) => fetch(`${base}${path}`, { redirect: 'manual', headers: withCookie ? { cookie: withCookie } : {} });
  const post = (path, fields) => fetch(`${base}${path}`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams(fields),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', cookie },
  });
  const tokenCall = (fields) => fetch(`${base}/oauth/jeton`, {
    method: 'POST', body: new URLSearchParams(fields),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://manger.exemple.fr' },
  });

  beforeEach(async () => {
    [server, base] = await start();
    cookie = `fdl_session=${await openSession(pool, me, { mfaOk: true })}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  it('links an instance end to end, then the token reads the API', async () => {
    const page = await get(`/oauth/autoriser?${query()}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /https:\/\/manger\.exemple\.fr/);
    assert.match(page.headers.get('set-cookie'), /^fdl_suite=; .*Max-Age=0/);
    const answer = await post('/oauth/autoriser', { ...Object.fromEntries(query()), decision: 'autoriser' });
    assert.equal(answer.status, 303);
    const back = new URL(answer.headers.get('location'));
    assert.equal(back.origin + back.pathname, `${client}/fdl/retour`);
    assert.equal(back.searchParams.get('state'), 'xyz');
    const token = await tokenCall({ grant_type: 'authorization_code', code: back.searchParams.get('code'), client_id: client, redirect_uri: `${client}/fdl/retour`, code_verifier: verifier });
    assert.equal(token.status, 200);
    assert.equal(token.headers.get('cache-control'), 'no-store');
    const { access_token, token_type } = await token.json();
    assert.equal(token_type, 'Bearer');
    const mine = await fetch(`${base}/api/v1/mes-recettes`, { headers: { authorization: `Bearer ${access_token}` } });
    assert.equal(mine.status, 200);
    const site = await fetch(`${base}/compte/securite`, { redirect: 'manual', headers: { authorization: `Bearer ${access_token}` } });
    assert.equal(site.status, 303);
  });

  it('shows an error page instead of redirecting to a foreign origin', async () => {
    const response = await get(`/oauth/autoriser?${query({ redirect_uri: 'https://evil.example/r' })}`);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null);
  });

  it('never redirects a GET error, even to a self-declared origin, and clears fdl_suite', async () => {
    const evil = 'https://evil.example';
    for (const fields of [{ client_id: evil, redirect_uri: `${evil}/x`, response_type: 'token' }, { code_challenge_method: 'plain' }, { state: 's'.repeat(501) }]) {
      const response = await get(`/oauth/autoriser?${query(fields)}`);
      assert.equal(response.status, 400, JSON.stringify(fields));
      assert.equal(response.headers.get('location'), null);
      assert.match(response.headers.get('set-cookie'), /^fdl_suite=; .*Max-Age=0/);
    }
  });

  it('redirects a POST error to the declared address only after the form', async () => {
    const answer = await post('/oauth/autoriser', { ...Object.fromEntries(query({ response_type: 'token' })), decision: 'autoriser' });
    assert.equal(new URL(answer.headers.get('location')).searchParams.get('error'), 'unsupported_response_type');
  });

  it('keeps a Bearer out of the site and refuses a banned account', async () => {
    const code = await createCode(pool, { accountId: me, clientId: client, redirectUri: `${client}/fdl/retour`, challenge });
    const token = await exchangeCode(pool, { code, clientId: client, redirectUri: `${client}/fdl/retour`, verifier });
    for (const path of ['/', '/compte/securite']) {
      const response = await fetch(`${base}${path}`, { redirect: 'manual', headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 303, path);
      assert.equal(response.headers.get('location'), '/connexion', path);
    }
    await pool.query('UPDATE accounts SET banned_at = now() WHERE id = $1', [me]);
    assert.equal((await fetch(`${base}/api/v1/mes-recettes`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  });

  it('redirects a refusal with access_denied', async () => {
    const answer = await post('/oauth/autoriser', { ...Object.fromEntries(query()), decision: 'refuser' });
    assert.equal(new URL(answer.headers.get('location')).searchParams.get('error'), 'access_denied');
  });

  it('answers RFC errors on /oauth/jeton without an Origin check', async () => {
    assert.equal((await (await tokenCall({ grant_type: 'password' })).json()).error, 'unsupported_grant_type');
    assert.equal((await (await tokenCall({ grant_type: 'authorization_code' })).json()).error, 'invalid_request');
    const bad = await tokenCall({ grant_type: 'authorization_code', code: 'x', client_id: client, redirect_uri: `${client}/fdl/retour`, code_verifier: verifier });
    assert.equal(bad.status, 400);
    const body = await bad.json();
    assert.equal(body.error, 'invalid_grant');
    assert.ok(typeof body.error_description === 'string' && body.error_description);
  });

  it('refuses an unknown token with 401 and www-authenticate', async () => {
    const response = await fetch(`${base}/api/v1/mes-recettes`, { headers: { authorization: 'Bearer inconnu' } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  });

  it('remembers the authorization page for an anonymous visitor', async () => {
    const response = await get(`/oauth/autoriser?${query()}`, null);
    assert.equal(response.headers.get('location'), '/connexion');
    assert.match(response.headers.get('set-cookie'), /^fdl_suite=%2Foauth%2Fautoriser%3F/);
  });

  it('sends a password sign-in back to the authorization page', async () => {
    await pool.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [me, await hashPassword('un mot de passe solide')]);
    const suite = `/oauth/autoriser?${query()}`;
    const signIn = (headers) => fetch(`${base}/connexion`, {
      method: 'POST', redirect: 'manual', body: new URLSearchParams({ email: 'me@example.org', password: 'un mot de passe solide' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', ...headers },
    });
    const response = await signIn({ cookie: `fdl_suite=${encodeURIComponent(suite)}` });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), suite);
    assert.equal((await signIn({})).headers.get('location'), '/');
  });

  it('lists and revokes a linked instance from /compte/securite', async () => {
    const code = await createCode(pool, { accountId: me, clientId: client, redirectUri: `${client}/fdl/retour`, challenge });
    const token = await exchangeCode(pool, { code, clientId: client, redirectUri: `${client}/fdl/retour`, verifier });
    const page = await (await get('/compte/securite')).text();
    assert.match(page, /https:\/\/manger\.exemple\.fr/);
    assert.match(page, /Retirer l'accès/);
    const answer = await post('/compte/securite/manger/retrait', { client_id: client });
    assert.equal(answer.status, 200);
    const after = await answer.text();
    assert.match(after, /Accès retiré\./);
    assert.match(after, /Aucune instance reliée\./);
    const api = await fetch(`${base}/api/v1/mes-recettes`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(api.status, 401);
  });

  it('limits by address and by instance', async () => {
    await new Promise((resolve) => server.close(resolve));
    [server, base] = await start({ limiter: createLimiter({ max: 2 }) });
    const call = (ip, headers = {}) => fetch(`${base}/api/v1/mes-recettes`, { headers: { 'x-forwarded-for': ip, ...headers } });
    assert.equal((await call('1.1.1.1')).status, 401);
    assert.equal((await call('1.1.1.1')).status, 401);
    const limited = await call('1.1.1.1');
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'rate_limited');

    await new Promise((resolve) => server.close(resolve));
    [server, base] = await start({ limiter: createLimiter({ max: 2 }) });
    const other = (await pool.query("INSERT INTO accounts (email, display_name, password_hash, role) VALUES ('o@example.org', 'Autre', 'h', 'member') RETURNING id")).rows[0].id;
    const tokens = [];
    for (const accountId of [me, other]) {
      const code = await createCode(pool, { accountId, clientId: client, redirectUri: `${client}/fdl/retour`, challenge });
      tokens.push(await exchangeCode(pool, { code, clientId: client, redirectUri: `${client}/fdl/retour`, verifier }));
    }
    const bearer = (i, ip) => call(ip, { authorization: `Bearer ${tokens[i]}` });
    assert.equal((await bearer(0, '2.2.2.2')).status, 200);
    assert.equal((await bearer(1, '3.3.3.3')).status, 200);
    assert.equal((await bearer(0, '4.4.4.4')).status, 429);
    assert.equal((await fetch(`${base}/api/v1/mes-recettes`, { headers: { authorization: `bearer ${tokens[1]}`, 'x-forwarded-for': '5.5.5.5' } })).status, 429);

    await new Promise((resolve) => server.close(resolve));
    [server, base] = await start({ limiter: createLimiter({ max: 0 }) });
    const jeton = await tokenCall({ grant_type: 'password' });
    assert.equal(jeton.status, 429);
    assert.equal(jeton.headers.get('cache-control'), 'no-store');
  });
});

describe('landing', () => {
  it('lands on the authorization page after signing in, never elsewhere', () => {
    const req = (cookie) => ({ headers: { cookie } });
    assert.equal(landing(req(`fdl_suite=${encodeURIComponent('/oauth/autoriser?client_id=x')}`)), '/oauth/autoriser?client_id=x');
    for (const cookie of [undefined, 'fdl_suite=%2Fadmin', `fdl_suite=${encodeURIComponent('https://evil.example/oauth/autoriser?')}`, 'fdl_suite=%E0%A4%A', 'fdl_suite=%2Foauth%2Fautoriser%3F%0D%0Ax']) {
      assert.equal(landing(req(cookie)), '/', cookie);
    }
  });
});

describe('exchangeCode', () => {
  const grant = (code, fields = {}) => exchangeCode(pool, { code, clientId: client, redirectUri: `${client}/fdl/retour`, verifier, ...fields });
  const code = () => createCode(pool, { accountId: me, clientId: client, redirectUri: `${client}/fdl/retour`, challenge });

  it('gives a token once, which loads the account', async () => {
    const c = await code();
    const token = await grant(c);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(await grant(c), null);
    assert.deepEqual(await loadToken(pool, token), { accountId: me, role: 'member', displayName: 'Membre', mfaOk: true, clientId: client });
  });
  it('refuses and burns the code on a wrong verifier, client, redirect_uri or expiry', async () => {
    for (const fields of [{ verifier: 'w'.repeat(43) }, { clientId: 'https://autre.fr' }, { redirectUri: `${client}/autre` }]) {
      const c = await code();
      assert.equal(await grant(c, fields), null);
      assert.equal(await grant(c), null);
    }
    const old = await code();
    await pool.query("UPDATE oauth_codes SET expires_at = now() - interval '1 second'");
    assert.equal(await grant(old), null);
  });
  it('replaces the token of a relinked instance and lists, revokes, cuts banned accounts', async () => {
    const first = await grant(await code());
    const second = await grant(await code());
    assert.equal(await loadToken(pool, first), null);
    assert.deepEqual((await listLinks(pool, me)).map((l) => l.clientId), [client]);
    await pool.query('UPDATE accounts SET banned_at = now() WHERE id = $1', [me]);
    assert.equal(await loadToken(pool, second), null);
    await pool.query('UPDATE accounts SET banned_at = NULL WHERE id = $1', [me]);
    await revokeLink(pool, me, client);
    assert.equal(await loadToken(pool, second), null);
    assert.deepEqual(await listLinks(pool, me), []);
    assert.equal(await loadToken(pool, ''), null);
    const pending = await code();
    await revokeLink(pool, me, client);
    assert.equal(await grant(pending), null);
  });
});
