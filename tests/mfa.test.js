import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as OTPAuth from 'otpauth';

import { hashPassword } from '../src/accounts.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
import {
  createRecoveryCodes, decryptSecret, encryptSecret, hasSecondFactor, startTotp, useRecoveryCode, verifyTotp,
} from '../src/mfa.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { createTestDatabase } from './helpers/db.js';

const key = Buffer.alloc(32, 7);
const config = { origin: 'http://localhost', secretKey: key };
const PASSWORD = 'un mot de passe solide';
let testDb;
let pool;
let server;
let base;
let id;

beforeEach(async () => {
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
  const { rows } = await pool.query(
    "INSERT INTO accounts (email, display_name, password_hash, role) VALUES ('lea@example.org', 'Léa', $1, 'member') RETURNING id",
    [await hashPassword(PASSWORD)]
  );
  id = rows[0].id;
  server = createApp({ routes: buildRoutes(pool, () => {}, config), log: () => {}, before: buildBefore(pool, config) })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.drop();
});

const post = (path, form, cookie) => fetch(`${base}${path}`, {
  method: 'POST',
  redirect: 'manual',
  headers: { origin: config.origin, 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(form),
});
const get = (path, cookie) => fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const cookieOf = (response) => response.headers.get('set-cookie').split(';')[0];
const codeFor = (secret, timestamp = Date.now()) =>
  OTPAuth.TOTP.generate({ secret: OTPAuth.Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30, timestamp });
const enable = async () => {
  const { secret } = await startTotp(pool, key, id, 'lea@example.org');
  assert.equal(await verifyTotp(pool, key, id, codeFor(secret, Date.now() - 30000), { activate: true }), true);
  return secret;
};

describe('secret encryption', () => {
  it('round-trips and is bound to the account and key', () => {
    const stored = encryptSecret(key, 1, 'ABC');
    assert.ok(stored.startsWith('v1:'));
    assert.equal(decryptSecret(key, 1, stored), 'ABC');
    assert.throws(() => decryptSecret(key, 2, stored));
    assert.throws(() => decryptSecret(Buffer.alloc(32, 8), 1, stored));
    const [v, iv, tag, data] = stored.split(':');
    assert.throws(() => decryptSecret(key, 1, [v, iv, tag.slice(0, 8), data].join(':')));
  });
});

describe('totp', () => {
  it('stores only the encrypted secret and returns a QR code', async () => {
    const started = await startTotp(pool, key, id, 'lea@example.org');
    const { rows: [row] } = await pool.query('SELECT secret FROM totp_secrets WHERE account_id = $1', [id]);
    assert.ok(row.secret.startsWith('v1:'));
    assert.ok(!row.secret.includes(started.secret));
    assert.ok(started.qrSvg.startsWith('<svg'));
    assert.ok(started.uri.startsWith('otpauth://totp/'));
    assert.equal(await hasSecondFactor(pool, id), false);
  });

  it('accepts a right code once, then rejects the replay', async () => {
    const { secret } = await startTotp(pool, key, id, 'lea@example.org');
    const code = codeFor(secret);
    assert.equal(await verifyTotp(pool, key, id, code, { activate: true }), true);
    assert.equal(await hasSecondFactor(pool, id), true);
    assert.equal(await verifyTotp(pool, key, id, code), false);
  });

  it('does not accept a pending secret at sign-in, nor confirm it', async () => {
    const { secret } = await startTotp(pool, key, id, 'lea@example.org');
    assert.equal(await verifyTotp(pool, key, id, codeFor(secret)), false);
    assert.equal(await hasSecondFactor(pool, id), false);
  });

  it('rejects a wrong code and keeps the secret unconfirmed', async () => {
    const { secret } = await startTotp(pool, key, id, 'lea@example.org');
    const wrong = codeFor(secret) === '000000' ? '000001' : '000000';
    assert.equal(await verifyTotp(pool, key, id, wrong), false);
    assert.equal(await verifyTotp(pool, key, id, 'abc'), false);
    assert.equal(await hasSecondFactor(pool, id), false);
  });

  it('refuses to replace a confirmed secret', async () => {
    await enable();
    await assert.rejects(startTotp(pool, key, id, 'lea@example.org'));
  });
});

describe('recovery codes', () => {
  it('makes 10 codes, stores hashes only, and each works once', async () => {
    const codes = await createRecoveryCodes(pool, id);
    assert.equal(codes.length, 10);
    assert.match(codes[0], /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    const { rows } = await pool.query('SELECT code_hash FROM recovery_codes WHERE account_id = $1', [id]);
    assert.equal(rows.length, 10);
    assert.equal(await useRecoveryCode(pool, id, codes[0]), true);
    assert.equal(await useRecoveryCode(pool, id, codes[0]), false);
    const [first] = await createRecoveryCodes(pool, id);
    assert.equal(await useRecoveryCode(pool, id, codes[1]), false);
    const spaced = first.toLowerCase().replace('-', ' ');
    assert.equal(await useRecoveryCode(pool, id, spaced), true);
  });
});

describe('sign-in with a second factor', () => {
  const login = () => post('/connexion', { email: 'lea@example.org', password: PASSWORD });

  it('holds the session at /connexion/verification until a right code, then rotates the cookie', async () => {
    const secret = await enable();
    const response = await login();
    assert.equal(response.headers.get('location'), '/connexion/verification');
    const old = cookieOf(response);
    const held = await get('/', old);
    assert.equal(held.headers.get('location'), '/connexion/verification');
    assert.equal((await get('/connexion/verification', old)).status, 200);

    assert.equal((await post('/connexion/verification', { code: '12' }, old)).status, 400);
    const ok = await post('/connexion/verification', { code: codeFor(secret) }, old);
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/');
    const fresh = cookieOf(ok);
    assert.equal((await get('/', fresh)).status, 200);
    assert.equal((await get('/', old)).status, 303);
    // A fully signed-in session has no business on the verification page.
    assert.equal((await get('/connexion/verification', fresh)).headers.get('location'), '/');
    assert.equal((await post('/connexion/verification', { code: 'x' }, fresh)).headers.get('location'), '/');
    assert.equal((await get('/connexion/verification')).headers.get('location'), '/connexion');
  });

  it('accepts a recovery code once', async () => {
    await enable();
    const [code] = await createRecoveryCodes(pool, id);
    const first = await post('/connexion/verification', { code }, cookieOf(await login()));
    assert.equal(first.headers.get('location'), '/');
    const second = await post('/connexion/verification', { code }, cookieOf(await login()));
    assert.equal(second.status, 400);
  });

  it('limits attempts per account', async () => {
    await enable();
    const cookie = cookieOf(await login());
    for (let i = 0; i < 10; i += 1) assert.equal((await post('/connexion/verification', { code: 'nope' }, cookie)).status, 400);
    assert.equal((await post('/connexion/verification', { code: 'nope' }, cookie)).status, 429);
  });
});

describe('/compte/securite', () => {
  it('activates TOTP end to end and shows recovery codes once', async () => {
    const cookie = cookieOf(await post('/connexion', { email: 'lea@example.org', password: PASSWORD }));
    const status = await get('/compte/securite', cookie);
    assert.equal(status.status, 200);
    const statusText = await status.text();
    assert.ok(statusText.includes('Activer le code à 6 chiffres'));
    assert.ok(statusText.includes('action="/deconnexion"'));

    const start = await post('/compte/securite/totp', {}, cookie);
    const text = await start.text();
    assert.ok(text.includes('<svg') && text.includes('otpauth://'));
    assert.equal(start.headers.get('cache-control'), 'no-store');
    const { rows: [row] } = await pool.query('SELECT secret FROM totp_secrets WHERE account_id = $1', [id]);
    const secret = decryptSecret(key, id, row.secret);
    assert.ok(text.includes(secret.match(/.{1,4}/g).join(' ')));

    assert.equal((await post('/compte/securite/totp/confirmation', { code: '000000' }, cookie)).status, 400);
    const done = await post('/compte/securite/totp/confirmation', { code: codeFor(secret) }, cookie);
    assert.equal(done.status, 200);
    assert.equal(((await done.text()).match(/<code>/g) ?? []).length, 10);
    assert.equal(await hasSecondFactor(pool, id), true);
    assert.ok((await (await get('/compte/securite', cookie)).text()).includes('Codes restants : 10.'));
  });

  it('changes the password and drops other sessions', async () => {
    const login = () => post('/connexion', { email: 'lea@example.org', password: PASSWORD });
    const cookie = cookieOf(await login());
    const other = cookieOf(await login());
    const bad = await post('/compte/securite/mot-de-passe', { current: 'faux faux faux', password: 'nouveau mot de passe' }, cookie);
    assert.equal(bad.status, 400);
    const ok = await post('/compte/securite/mot-de-passe', { current: PASSWORD, password: 'nouveau mot de passe' }, cookie);
    assert.equal(ok.status, 200);
    assert.equal((await get('/', cookie)).status, 200);
    assert.equal((await get('/', other)).status, 303);
    const again = await post('/connexion', { email: 'lea@example.org', password: 'nouveau mot de passe' });
    assert.equal(again.headers.get('location'), '/');
  });
});
