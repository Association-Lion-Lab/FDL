import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { hashToken } from '../src/accounts.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { clearSessionCookie, closeSession, loadSession, openSession, sessionCookie } from '../src/sessions.js';
import { createTestDatabase } from './helpers/db.js';

const config = { origin: 'http://localhost' };
let testDb;
let pool;

beforeEach(async () => {
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
});

afterEach(() => testDb.drop());

async function account(role = 'member') {
  const { rows } = await pool.query(
    `INSERT INTO accounts (email, display_name, password_hash, role)
     VALUES ($1, 'Léa', 'x', $2) RETURNING id`,
    [`${role}@example.org`, role]
  );
  return rows[0].id;
}

describe('sessions', () => {
  it('stores only the hash and loads the session', async () => {
    const id = await account('admin');
    const token = await openSession(pool, id, { mfaOk: true });
    const { rows } = await pool.query('SELECT token_hash FROM sessions');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].token_hash.equals(hashToken(token)));
    assert.ok(!rows[0].token_hash.toString('utf8').includes(token));
    const session = await loadSession(pool, token);
    assert.equal(session.accountId, id);
    assert.equal(session.role, 'admin');
    assert.equal(session.displayName, 'Léa');
    assert.equal(session.mfaOk, true);
    assert.ok(session.tokenHash.equals(hashToken(token)));
  });

  it('lasts 30 days for members and 12 hours for staff', async () => {
    for (const [role, hours] of [['member', 720], ['adherent', 720], ['moderator', 12], ['admin', 12]]) {
      const token = await openSession(pool, await account(role), { mfaOk: false });
      const { rows } = await pool.query(
        'SELECT extract(epoch FROM expires_at - created_at) / 3600 AS h FROM sessions WHERE token_hash = $1',
        [hashToken(token)]
      );
      assert.equal(Math.round(Number(rows[0].h)), hours, role);
    }
  });

  it('refuses and deletes expired, banned and closed sessions; ignores unknown ones', async () => {
    const id = await account();
    const expired = await openSession(pool, id, { mfaOk: true });
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second'");
    assert.equal(await loadSession(pool, expired), null);
    assert.equal((await pool.query('SELECT 1 FROM sessions')).rowCount, 0);

    const banned = await openSession(pool, id, { mfaOk: true });
    await pool.query('UPDATE accounts SET banned_at = now()');
    assert.equal(await loadSession(pool, banned), null);
    assert.equal((await pool.query('SELECT 1 FROM sessions')).rowCount, 0);

    await pool.query('UPDATE accounts SET banned_at = NULL');
    const open = await openSession(pool, id, { mfaOk: true });
    await closeSession(pool, hashToken(open));
    assert.equal(await loadSession(pool, open), null);
    assert.equal(await loadSession(pool, 'inconnu'), null);
  });

  it('builds the cookies', () => {
    assert.equal(sessionCookie('abc', 60), 'fdl_session=abc; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=60');
    assert.match(clearSessionCookie(), /^fdl_session=; .*Max-Age=0$/);
  });
});

describe('beta gate with a session', () => {
  async function start() {
    const routes = {
      ...buildRoutes(pool, () => {}, config),
      'GET /prive': (request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(`ok ${request.session.displayName}`);
      },
    };
    const server = createApp({ routes, log: () => {}, before: buildBefore(pool, config) }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  }
  const get = (base, path, token) => fetch(`${base}${path}`, {
    redirect: 'manual',
    headers: token ? { cookie: `fdl_session=${token}` } : {},
  });

  it('serves private routes to a valid session, JSON 404 for unknown ones', async () => {
    const { server, base } = await start();
    try {
      const token = await openSession(pool, await account(), { mfaOk: true });
      const response = await get(base, '/prive', token);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'ok Léa');
      assert.equal((await get(base, '/nimporte-quoi', token)).status, 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('redirects a session without MFA, a banned account and an expired session', async () => {
    const { server, base } = await start();
    try {
      const id = await account();
      const noMfa = await openSession(pool, id, { mfaOk: false });
      const half = await get(base, '/prive', noMfa);
      assert.equal(half.status, 303);
      assert.equal(half.headers.get('location'), '/connexion/verification');

      const token = await openSession(pool, id, { mfaOk: true });
      assert.equal((await get(base, '/prive', token)).status, 200);
      await pool.query('UPDATE accounts SET banned_at = now()');
      const response = await get(base, '/prive', token);
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('location'), '/connexion');
      const { rowCount } = await pool.query('SELECT 1 FROM sessions WHERE token_hash = $1', [hashToken(token)]);
      assert.equal(rowCount, 0);

      await pool.query('UPDATE accounts SET banned_at = NULL');
      const old = await openSession(pool, id, { mfaOk: true });
      await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hashToken(old)]);
      assert.equal((await get(base, '/prive', old)).status, 303);
      assert.equal((await pool.query('SELECT 1 FROM sessions WHERE token_hash = $1', [hashToken(old)])).rowCount, 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
