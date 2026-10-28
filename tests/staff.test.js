import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as OTPAuth from 'otpauth';

import { hashPassword } from '../src/accounts.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
import { startTotp, verifyTotp } from '../src/mfa.js';
import { elevationUrl } from '../src/routes/admin.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { openSession, requireElevated } from '../src/sessions.js';
import { createTestDatabase } from './helpers/db.js';

const PASSWORD = 'un mot de passe solide';
const secretKey = Buffer.alloc(32, 7);
const lib = {
  generateAuthenticationOptions: async () => ({ challenge: 'c' }),
  verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { newCounter: 1 } }),
};
let config;
let dataDir;
let testDb;
let pool;
let server;
let base;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fdl-staff-'));
  config = { origin: 'http://localhost', rpID: 'localhost', secretKey, dataDir };
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
  await rm(dataDir, { recursive: true, force: true });
});

const send = (path, { method = 'GET', form, json, cookie } = {}) => fetch(`${base}${path}`, {
  method,
  redirect: 'manual',
  headers: {
    ...(method === 'POST' ? { origin: config.origin } : {}),
    ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...(cookie ? { cookie } : {}),
  },
  body: form ? new URLSearchParams(form) : json ? JSON.stringify(json) : undefined,
});
const codeFor = (secret, timestamp = Date.now()) =>
  OTPAuth.TOTP.generate({ secret: OTPAuth.Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30, timestamp });
const logLines = async () => (await readFile(join(dataDir, 'logs', 'securite.log'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

async function account(role = 'admin') {
  const { rows } = await pool.query(
    "INSERT INTO accounts (email, display_name, password_hash, role) VALUES ('staff@example.org', 'Sam', $1, $2) RETURNING id",
    [await hashPassword(PASSWORD), role]
  );
  return rows[0].id;
}
const addKey = (id) => pool.query("INSERT INTO passkeys (id, account_id, public_key, counter, name) VALUES ('k1', $1, '\\x01', 0, 'k')", [id]);
const fullSession = async (id) => `fdl_session=${await openSession(pool, id, { mfaOk: true })}`;
async function enableTotp(id) {
  const { secret } = await startTotp(pool, secretKey, id, 'staff@example.org');
  assert.equal(await verifyTotp(pool, secretKey, id, codeFor(secret, Date.now() - 30000), { activate: true }), true);
  return secret;
}
const elevatedUntil = async (id) => (await pool.query('SELECT elevated_until FROM sessions WHERE account_id = $1', [id])).rows[0].elevated_until;

describe('staff without a passkey', () => {
  it('can only reach the security page, with a notice', async () => {
    const id = await account();
    const cookie = await fullSession(id);
    for (const path of ['/admin', '/']) {
      const response = await send(path, { cookie });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/compte/securite?obligatoire=1');
    }
    const page = await send('/compte/securite?obligatoire=1', { cookie });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("exige une clé d'accès"));
    assert.equal((await send('/deconnexion', { method: 'POST', cookie })).status, 303);
  });

  it('is released once a key exists', async () => {
    const id = await account('moderator');
    await addKey(id);
    assert.equal((await send('/admin', { cookie: await fullSession(id) })).status, 200);
  });

  it('keeps members out of /admin', async () => {
    const id = await account('member');
    assert.equal((await send('/admin', { cookie: await fullSession(id) })).status, 403);
  });
});

describe('security log', () => {
  it('records a staff login without password or cookie, and failures', async () => {
    await account();
    const bad = await send('/connexion', { method: 'POST', form: { email: 'staff@example.org', password: 'mauvais mot de passe' } });
    assert.equal(bad.status, 200);
    const ok = await send('/connexion', { method: 'POST', form: { email: 'staff@example.org', password: PASSWORD } });
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    const lines = await logLines();
    assert.deepEqual(lines.map((l) => l.event), ['login_failed', 'staff_login']);
    assert.equal(lines[0].email, 'staff@example.org');
    assert.ok(lines[1].ip && lines[1].accountId);
    const text = await readFile(join(dataDir, 'logs', 'securite.log'), 'utf8');
    for (const secret of [PASSWORD, 'mauvais mot de passe', cookie.split('=')[1]]) assert.ok(!text.includes(secret));
  });

  it('records rate limiting of sign-in', async () => {
    await account();
    for (let i = 0; i < 11; i++) await send('/connexion', { method: 'POST', form: { email: 'staff@example.org', password: 'x' } });
    assert.ok((await logLines()).some((l) => l.event === 'rate_limited' && l.scope === 'connexion'));
  });
});

describe('sessions', () => {
  it('refuses a staff session older than 12 hours', async () => {
    const id = await account();
    await addKey(id);
    const cookie = await fullSession(id);
    assert.equal((await send('/admin', { cookie })).status, 200);
    await pool.query("UPDATE sessions SET created_at = now() - interval '13 hours'");
    assert.equal((await send('/admin', { cookie })).headers.get('location'), '/connexion');
  });

  it('refuses an old session of a member promoted to admin since', async () => {
    const id = await account('member');
    const cookie = await fullSession(id);
    await pool.query("UPDATE accounts SET role = 'admin'");
    await pool.query("UPDATE sessions SET created_at = now() - interval '13 hours'");
    assert.equal((await send('/', { cookie })).headers.get('location'), '/connexion');
  });
});

describe('log hardening', () => {
  it('keeps the file private', { skip: process.platform === 'win32' }, async () => {
    await account();
    await send('/connexion', { method: 'POST', form: { email: 'staff@example.org', password: 'x' } });
    assert.equal((await stat(join(dataDir, 'logs', 'securite.log'))).mode & 0o777, 0o600);
  });

  it('keeps a failed login a normal answer when the log cannot be written', async () => {
    await account();
    await writeFile(join(dataDir, 'logs'), 'pas un dossier');
    const bad = await send('/connexion', { method: 'POST', form: { email: 'staff@example.org', password: 'x' } });
    assert.equal(bad.status, 200);
  });

  it('opens no session when staff_login cannot be written', async () => {
    await account();
    await writeFile(join(dataDir, 'logs'), 'pas un dossier');
    const response = await send('/connexion', { method: 'POST', form: { email: 'staff@example.org', password: PASSWORD } });
    assert.equal(response.status, 500);
    assert.equal((await pool.query('SELECT 1 FROM sessions')).rowCount, 0);
  });
});

describe('re-authentication', () => {
  it('requireElevated follows elevated_until and the redirect target is relative', () => {
    assert.equal(requireElevated({ session: { elevatedUntil: null } }), false);
    assert.equal(requireElevated({ session: { elevatedUntil: new Date(Date.now() + 60000) } }), true);
    assert.equal(requireElevated({ session: { elevatedUntil: new Date(Date.now() - 1) } }), false);
    assert.equal(elevationUrl({ url: '/admin/x?a=1' }), '/admin/confirmation?retour=%2Fadmin%2Fx%3Fa%3D1');
  });

  it('elevates for 5 minutes with a TOTP code and honours only /admin return paths', async () => {
    const id = await account();
    await addKey(id);
    const secret = await enableTotp(id);
    const cookie = await fullSession(id);
    const page = await send('/admin/confirmation?retour=https://evil.example', { cookie });
    assert.ok((await page.text()).includes('value="/admin"'));
    const evil = await send('/admin/confirmation', { method: 'POST', cookie, form: { retour: 'https://evil.example', code: codeFor(secret) } });
    assert.equal(evil.status, 303);
    assert.equal(evil.headers.get('location'), '/admin');
    const until = new Date(await elevatedUntil(id)).getTime() - Date.now();
    assert.ok(until > 4 * 60000 && until <= 5 * 60000);
    for (const bad of ['//evil.example', '/admin@evil.example', '/admin\\evil', '/admin/../compte', '/admin/%2e%2e/compte', '/administrateur']) {
      await pool.query('UPDATE totp_secrets SET last_step = NULL');
      const response = await send('/admin/confirmation', { method: 'POST', cookie, form: { retour: bad, code: codeFor(secret) } });
      assert.equal(response.headers.get('location'), '/admin', bad);
    }
    await pool.query('UPDATE totp_secrets SET last_step = NULL');
    await pool.query('UPDATE sessions SET elevated_until = NULL');
    const good = await send('/admin/confirmation', { method: 'POST', cookie, form: { retour: '/admin/x?a=1', code: codeFor(secret, Date.now() + 30000) } });
    assert.equal(good.headers.get('location'), '/admin/x?a=1');
  });

  it('refuses a wrong code, logs it, and rate-limits', async () => {
    const id = await account();
    await addKey(id);
    await enableTotp(id);
    const cookie = await fullSession(id);
    const attempt = () => send('/admin/confirmation', { method: 'POST', cookie, form: { code: '000000' } });
    assert.equal((await attempt()).status, 400);
    for (let i = 0; i < 9; i++) await attempt();
    assert.equal((await attempt()).status, 429);
    assert.equal(await elevatedUntil(id), null);
    const events = (await logLines()).map((l) => l.event);
    assert.ok(events.includes('mfa_failed') && events.includes('rate_limited'));
  });

  it('does not accept a pending TOTP secret', async () => {
    const id = await account();
    await addKey(id);
    const { secret } = await startTotp(pool, secretKey, id, 'staff@example.org');
    const response = await send('/admin/confirmation', { method: 'POST', cookie: await fullSession(id), form: { code: codeFor(secret) } });
    assert.equal(response.status, 400);
    assert.equal(await elevatedUntil(id), null);
  });

  it('elevates with a passkey assertion on a full session only', async () => {
    const id = await account();
    await addKey(id);
    const cookie = await fullSession(id);
    await send('/cles/confirmation/options', { method: 'POST', json: {}, cookie });
    const response = await send('/cles/confirmation/verification', { method: 'POST', json: { response: { id: 'k1' } }, cookie });
    assert.equal(response.status, 200);
    assert.ok(await elevatedUntil(id));
    // A half session cannot use the re-authentication routes.
    await pool.query('DELETE FROM sessions');
    const half = `fdl_session=${await openSession(pool, id, { mfaOk: false })}`;
    assert.equal((await send('/cles/confirmation/verification', { method: 'POST', json: { response: { id: 'k1' } }, cookie: half })).status, 303);
  });
});
