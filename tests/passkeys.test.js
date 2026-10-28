import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { hashPassword } from '../src/accounts.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { openSession } from '../src/sessions.js';
import { createTestDatabase } from './helpers/db.js';

const config = { origin: 'http://localhost', rpID: 'localhost' };
let verified = true;
const lib = {
  generateRegistrationOptions: async () => ({ challenge: 'reg-challenge' }),
  verifyRegistrationResponse: async () => ({
    verified,
    registrationInfo: { credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['usb'] } },
  }),
  generateAuthenticationOptions: async () => ({ challenge: 'auth-challenge' }),
  verifyAuthenticationResponse: async () => ({ verified, authenticationInfo: { newCounter: 5 } }),
};
let testDb;
let pool;
let server;
let base;

beforeEach(async () => {
  verified = true;
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
  server = createApp({ routes: buildRoutes(pool, () => {}, config, lib), log: () => {}, before: buildBefore(pool, config) })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.drop();
});

const post = (path, body, cookie) => fetch(`${base}${path}`, {
  method: 'POST',
  redirect: 'manual',
  headers: { origin: config.origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body ?? {}),
});

async function account(email, role = 'member') {
  const { rows } = await pool.query(
    'INSERT INTO accounts (email, display_name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
    [email, 'Léa', await hashPassword('un mot de passe solide'), role]
  );
  return rows[0].id;
}

async function session(id, mfaOk) {
  return `fdl_session=${await openSession(pool, id, { mfaOk })}`;
}

const challengeOf = async (id) => (await pool.query('SELECT challenge FROM sessions WHERE account_id = $1', [id])).rows[0].challenge;

describe('passkey registration', () => {
  it('refuses options without a session', async () => {
    assert.equal((await post('/cles/inscription/options')).status, 303);
  });

  it('stores the challenge, then refuses a failed verification', async () => {
    const id = await account('lea@example.org');
    const cookie = await session(id, true);
    const options = await post('/cles/inscription/options', {}, cookie);
    assert.equal((await options.json()).challenge, 'reg-challenge');
    assert.equal(await challengeOf(id), 'reg-challenge');
    verified = false;
    const response = await post('/cles/inscription/verification', { name: 'Clé', response: {} }, cookie);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'passkey_failed');
    assert.equal((await pool.query('SELECT 1 FROM passkeys')).rowCount, 0);
    assert.equal(await challengeOf(id), null);
  });

  it('saves the key, returns recovery codes once, and consumes the challenge', async () => {
    const id = await account('lea@example.org');
    const cookie = await session(id, true);
    await post('/cles/inscription/options', {}, cookie);
    const response = await post('/cles/inscription/verification', { name: 'Ma clé', response: {} }, cookie);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).recoveryCodes.length, 10);
    const { rows } = await pool.query('SELECT id, name, counter FROM passkeys');
    assert.deepEqual(rows.map((r) => [r.id, r.name, r.counter]), [['cred-1', 'Ma clé', '0']]);
    assert.equal(await challengeOf(id), null);
    const again = await post('/cles/inscription/verification', { name: 'Ma clé', response: {} }, cookie);
    assert.equal(again.status, 400);
  });

  it('refuses a name longer than 40 characters', async () => {
    const id = await account('lea@example.org');
    const cookie = await session(id, true);
    await post('/cles/inscription/options', {}, cookie);
    assert.equal((await post('/cles/inscription/verification', { name: 'x'.repeat(41), response: {} }, cookie)).status, 400);
    assert.equal((await pool.query('SELECT 1 FROM passkeys')).rowCount, 0);
  });
});

describe('passkey sign-in', () => {
  const addKey = (accountId, id) => pool.query(
    "INSERT INTO passkeys (id, account_id, public_key, counter, name) VALUES ($1, $2, '\\x010203', 0, 'k')",
    [id, accountId]
  );

  it('promotes a half session to a new full one and updates the counter', async () => {
    const id = await account('lea@example.org');
    await addKey(id, 'cred-1');
    const cookie = await session(id, false);
    await post('/cles/connexion/options', {}, cookie);
    const response = await post('/cles/connexion/verification', { response: { id: 'cred-1' } }, cookie);
    assert.equal(response.status, 200);
    const fresh = response.headers.get('set-cookie').split(';')[0];
    assert.notEqual(fresh, cookie);
    assert.equal((await fetch(`${base}/`, { headers: { cookie: fresh } })).status, 200);
    assert.equal((await pool.query('SELECT counter FROM passkeys')).rows[0].counter, '5');
    assert.equal((await fetch(`${base}/`, { redirect: 'manual', headers: { cookie } })).status, 303);
  });

  it('refuses a credential that belongs to another account', async () => {
    const lea = await account('lea@example.org');
    const other = await account('autre@example.org');
    await addKey(other, 'cred-other');
    const cookie = await session(lea, false);
    await post('/cles/connexion/options', {}, cookie);
    const response = await post('/cles/connexion/verification', { response: { id: 'cred-other' } }, cookie);
    assert.equal(response.status, 400);
    assert.equal((await pool.query('SELECT mfa_ok FROM sessions WHERE account_id = $1', [lea])).rows[0].mfa_ok, false);
  });

  it('refuses a failed verification and a missing challenge', async () => {
    const id = await account('lea@example.org');
    await addKey(id, 'cred-1');
    const cookie = await session(id, false);
    assert.equal((await post('/cles/connexion/verification', { response: { id: 'cred-1' } }, cookie)).status, 400);
    await post('/cles/connexion/options', {}, cookie);
    verified = false;
    assert.equal((await post('/cles/connexion/verification', { response: { id: 'cred-1' } }, cookie)).status, 400);
  });

  it('rate-limits with the same key as the TOTP step', async () => {
    const id = await account('lea@example.org');
    const cookie = await session(id, false);
    let last;
    for (let i = 0; i < 11; i++) last = await post('/cles/connexion/verification', { response: { id: 'x' } }, cookie);
    assert.equal(last.status, 429);
  });
});

describe('passkey deletion and scripts', () => {
  it('refuses to delete the last key of a moderator', async () => {
    const id = await account('mod@example.org', 'moderator');
    await pool.query("INSERT INTO passkeys (id, account_id, public_key, counter, name) VALUES ('k1', $1, '\\x01', 0, 'k')", [id]);
    const cookie = await session(id, true);
    const response = await fetch(`${base}/compte/securite/cles/suppression`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: config.origin, 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: 'id=k1',
    });
    assert.equal(response.status, 400);
    assert.equal((await pool.query('SELECT 1 FROM passkeys')).rowCount, 1);
  });

  it('serves the browser bundle and the FDL script', async () => {
    const bundle = await fetch(`${base}/static/simplewebauthn.js`);
    assert.equal(bundle.status, 200);
    assert.ok((await bundle.text()).includes('startAuthentication'));
    const script = await fetch(`${base}/static/fdl-passkeys.js`);
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
  });
});
