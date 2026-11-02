import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { migrate } from '../src/db.js';
import { createCode, exchangeCode, listLinks, loadToken, parseAuthorization, revokeLink } from '../src/oauth.js';
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
      { redirect_uri: '/r' }, { client_id: '' },
    ]) assert.deepEqual(parseAuthorization(query(fields)).redirectUri, null, JSON.stringify(fields));
  });
  it('redirects the other errors with state', () => {
    assert.deepEqual(parseAuthorization(query({ response_type: 'token' })), { ok: false, redirectUri: `${client}/fdl/retour`, error: 'unsupported_response_type', state: 'xyz' });
    for (const fields of [{ code_challenge_method: 'plain' }, { code_challenge: 'court' }, { state: 's'.repeat(501) }]) {
      assert.equal(parseAuthorization(query(fields)).error, 'invalid_request');
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
  });
});
