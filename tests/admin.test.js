import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { hashPassword } from '../src/accounts.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { openSession } from '../src/sessions.js';
import { createTestDatabase } from './helpers/db.js';

const config = { origin: 'http://localhost', rpID: 'localhost', secretKey: Buffer.alloc(32, 7) };
let dataDir;
let testDb;
let pool;
let server;
let base;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fdl-admin-'));
  config.dataDir = dataDir;
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
  server = createApp({ routes: buildRoutes(pool, () => {}, config, {}), log: () => {}, before: buildBefore(pool, config) })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.drop();
  await rm(dataDir, { recursive: true, force: true });
});

const post = (path, form, cookie) => fetch(`${base}${path}`, {
  method: 'POST',
  redirect: 'manual',
  headers: { origin: config.origin, 'content-type': 'application/x-www-form-urlencoded', cookie },
  body: new URLSearchParams(form),
});
const get = (path, cookie) => fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

let n = 0;
async function account(role, name = `Compte ${++n}`) {
  const { rows } = await pool.query(
    'INSERT INTO accounts (email, display_name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
    [`a${++n}-${role}@example.org`, name, await hashPassword('un mot de passe solide'), role]
  );
  const id = rows[0].id;
  if (role === 'admin' || role === 'moderator') {
    await pool.query("INSERT INTO passkeys (id, account_id, public_key, counter, name) VALUES ($1, $2, '\\x01', 0, 'k')", [`k${id}`, id]);
  }
  return id;
}
async function login(id, { elevated = false } = {}) {
  const token = await openSession(pool, id, { mfaOk: true });
  if (elevated) {
    await pool.query("UPDATE sessions SET elevated_until = now() + interval '5 minutes' WHERE account_id = $1", [id]);
  }
  return `fdl_session=${token}`;
}
const adminLog = async () => (await pool.query('SELECT * FROM admin_log ORDER BY id')).rows;
const secLog = async () => (await readFile(join(dataDir, 'logs', 'securite.log'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const roleOf = async (id) => (await pool.query('SELECT role FROM accounts WHERE id = $1', [id])).rows[0].role;

describe('admin access', () => {
  it('refuses members and moderators, serves a full admin', async () => {
    const paths = ['/admin', '/admin/invitations', '/admin/comptes', '/admin/journal', '/admin/confirmation'];
    for (const role of ['member', 'moderator']) {
      const cookie = await login(await account(role));
      for (const path of paths) assert.equal((await get(path, cookie)).status, 403, `${role} ${path}`);
    }
    const cookie = await login(await account('admin'));
    for (const path of paths) assert.equal((await get(path, cookie)).status, 200, path);
  });
});

describe('accounts', () => {
  it('asks for confirmation, then changes a role and logs it twice', async () => {
    const adminId = await account('admin');
    const target = await account('member');
    const cookie = await login(adminId);
    const early = await post('/admin/comptes/role', { id: target, role: 'adherent' }, cookie);
    assert.equal(early.status, 303);
    assert.ok(early.headers.get('location').startsWith('/admin/confirmation?retour='));
    assert.equal(await roleOf(target), 'member');
    await pool.query("UPDATE sessions SET elevated_until = now() + interval '5 minutes'");
    assert.equal((await post('/admin/comptes/role', { id: target, role: 'adherent' }, cookie)).status, 303);
    assert.equal(await roleOf(target), 'adherent');
    const [row] = await adminLog();
    assert.equal(row.action, 'role_changed');
    assert.equal(row.target, String(target));
    assert.equal(row.actor_id, adminId);
    assert.ok((await secLog()).some((l) => l.event === 'role_changed' && l.to === 'adherent'));
  });

  it('refuses to demote the last admin, even when two admins demote each other at once', async () => {
    const a = await account('admin');
    const b = await account('admin');
    const cookieA = await login(a, { elevated: true });
    const cookieB = await login(b, { elevated: true });
    const results = await Promise.all([
      post('/admin/comptes/role', { id: b, role: 'member' }, cookieA),
      post('/admin/comptes/role', { id: a, role: 'member' }, cookieB),
    ]);
    // The loser is refused by the guard (409), or already demoted when its request is read (403).
    assert.equal(results.filter((r) => r.status === 303).length, 1);
    assert.ok(results.every((r) => [303, 403, 409].includes(r.status)));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM accounts WHERE role = 'admin'")).rows[0].n, 1);
    const survivor = (await roleOf(a)) === 'admin' ? a : b;
    const refused = await post('/admin/comptes/role', { id: survivor, role: 'member' }, survivor === a ? cookieA : cookieB);
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /au moins un administrateur/);
  });

  it('bans (sessions gone, self-ban refused) and unbans, with both logs', async () => {
    const adminId = await account('admin');
    const target = await account('member');
    const cookie = await login(adminId, { elevated: true });
    await login(target);
    assert.equal((await post('/admin/comptes/bannir', { id: adminId }, cookie)).status, 409);
    assert.equal((await post('/admin/comptes/bannir', { id: target }, cookie)).status, 303);
    assert.equal((await pool.query('SELECT 1 FROM sessions WHERE account_id = $1', [target])).rowCount, 0);
    assert.notEqual((await pool.query('SELECT banned_at FROM accounts WHERE id = $1', [target])).rows[0].banned_at, null);
    assert.equal((await post('/admin/comptes/debannir', { id: target }, cookie)).status, 303);
    assert.deepEqual((await adminLog()).map((r) => r.action), ['account_banned', 'account_unbanned']);
    assert.deepEqual((await secLog()).map((l) => l.event).filter((e) => e.startsWith('account_')), ['account_banned', 'account_unbanned']);
  });

  it('creates a reset link shown once, logged', async () => {
    const adminId = await account('admin');
    const target = await account('member');
    const cookie = await login(adminId, { elevated: true });
    const page = await (await post('/admin/comptes/reinitialiser', { id: target }, cookie)).text();
    const code = /\/reinitialisation\?code=([\w-]+)/.exec(page)[1];
    assert.equal((await get(`/reinitialisation?code=${code}`)).status, 200);
    assert.equal((await adminLog())[0].action, 'access_reset');
    assert.ok(!(await (await get('/admin/journal', cookie)).text()).includes(code));
  });

  it('escapes display names', async () => {
    const cookie = await login(await account('admin'));
    await account('member', '<img src=x onerror=alert(1)>');
    const page = await (await get('/admin/comptes', cookie)).text();
    assert.ok(!page.includes('<img src=x'));
    assert.ok(page.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });
});

describe('invitations', () => {
  it('shows the link once, never lists a token, revokes by hash', async () => {
    const cookie = await login(await account('admin'));
    const page = await (await post('/admin/invitations', { role: 'member', note: '<b>Léa</b>' }, cookie)).text();
    const code = /\/inscription\?code=([\w-]+)/.exec(page)[1];
    assert.ok(page.includes('Copier'));
    const list = await (await get('/admin/invitations', cookie)).text();
    assert.ok(!list.includes(code));
    assert.ok(list.includes('&lt;b&gt;Léa&lt;/b&gt;') && list.includes('en attente'));
    const id = /name="id" value="([0-9a-f]{64})"/.exec(list)[1];
    assert.equal((await post('/admin/invitations/revoquer', { id }, cookie)).status, 303);
    assert.equal((await get(`/inscription?code=${code}`)).status, 410);
    assert.ok((await (await get('/admin/invitations', cookie)).text()).includes('révoquée'));
  });

  it('needs a recent confirmation for a staff invitation only', async () => {
    const cookie = await login(await account('admin'));
    assert.equal((await post('/admin/invitations', { role: 'admin' }, cookie)).status, 303);
    assert.equal((await post('/admin/invitations', { role: 'adherent' }, cookie)).status, 200);
    assert.equal((await pool.query('SELECT 1 FROM access_links')).rowCount, 1);
  });
});
