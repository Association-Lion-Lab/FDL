import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createLink, hashPassword } from '../src/accounts.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
import { createLimiter } from '../src/ratelimit.js';
import { authRoutes } from '../src/routes/auth.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { createTestDatabase } from './helpers/db.js';

const config = { origin: 'http://localhost' };
const PASSWORD = 'un mot de passe solide';
let testDb;
let pool;
let server;
let base;

beforeEach(async () => {
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
  server = createApp({ routes: buildRoutes(pool, () => {}, config), log: () => {}, before: buildBefore(pool, config) })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.drop();
});

const post = (path, form, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  redirect: 'manual',
  headers: { origin: config.origin, 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(form),
});
const get = (path, cookie) => fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const cookieOf = (response) => response.headers.get('set-cookie').split(';')[0];

async function member(email = 'lea@example.org', role = 'member') {
  const { rows } = await pool.query(
    'INSERT INTO accounts (email, display_name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
    [email, 'Léa', await hashPassword(PASSWORD), role]
  );
  return rows[0].id;
}

describe('limiter', () => {
  it('trips after max hits and resets', () => {
    const limiter = createLimiter({ max: 2, windowMs: 1000 });
    assert.equal(limiter.hit('a'), false);
    assert.equal(limiter.hit('a'), false);
    assert.equal(limiter.hit('a'), true);
    assert.equal(limiter.hit('b'), false);
    limiter.reset('a');
    assert.equal(limiter.hit('a'), false);
  });
});

describe('limiter bounds', () => {
  it('evicts the oldest key once full instead of growing or refusing', () => {
    const limiter = createLimiter({ max: 2, windowMs: 1000, maxKeys: 3 });
    for (const k of ['a', 'b', 'c']) assert.equal(limiter.hit(k), false);
    assert.equal(limiter.hit('d'), false);
    assert.equal(limiter.size, 3);
    assert.equal(limiter.hit('a'), false);
  });
});

describe('sign-up', () => {
  const form = (code, extra = {}) => ({
    code, email: 'new@example.org', displayName: '<b>Zoé</b>', password: PASSWORD, confirm: PASSWORD, ...extra,
  });

  it('runs the full path: invitation, sign-up, cookie, waiting page with escaped name', async () => {
    const code = await createLink(pool, { kind: 'invitation' });
    const page = await get(`/inscription?code=${code}`);
    assert.equal(page.status, 200);
    const response = await post('/inscription', form(code));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/compte/securite');
    const cookie = cookieOf(response);
    const home = await get('/', cookie);
    assert.equal(home.status, 200);
    const text = await home.text();
    assert.ok(text.includes('Bienvenue &lt;b&gt;Zoé&lt;/b&gt;, le catalogue arrive bientôt.'));
    assert.ok(text.includes('/compte/securite'));
  });

  it('sends staff to the mandatory security page', async () => {
    const code = await createLink(pool, { kind: 'invitation', role: 'moderator' });
    const response = await post('/inscription', form(code));
    assert.equal(response.headers.get('location'), '/compte/securite?obligatoire=1');
  });

  it('answers 410 for an invalid or used link', async () => {
    const page = await get('/inscription?code=nope');
    assert.equal(page.status, 410);
    assert.ok((await page.text()).includes('Ce lien n&#39;est plus valable. Demandez-en un nouveau.'));
    assert.equal((await post('/inscription', form('nope'))).status, 410);
  });

  it('refuses mismatched passwords without creating an account or consuming the link', async () => {
    const code = await createLink(pool, { kind: 'invitation' });
    const response = await post('/inscription', form(code, { confirm: 'autre chose du tout' }));
    assert.equal(response.status, 400);
    assert.ok((await response.text()).includes('Les mots de passe ne correspondent pas.'));
    assert.equal((await pool.query('SELECT 1 FROM accounts')).rowCount, 0);
    assert.equal((await post('/inscription', form(code))).status, 303);
  });

  it('refuses a short password', async () => {
    const code = await createLink(pool, { kind: 'invitation' });
    const response = await post('/inscription', form(code, { password: 'court', confirm: 'court' }));
    assert.equal(response.status, 400);
    assert.equal((await pool.query('SELECT 1 FROM accounts')).rowCount, 0);
  });

  it('limits sign-up attempts per IP', async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await post('/inscription', form('nope'), { 'x-forwarded-for': '9.9.9.9' });
    assert.equal(last.status, 429);
  });
});

describe('password reset', () => {
  it('resets the password then redirects to sign-in', async () => {
    const id = await member();
    const code = await createLink(pool, { kind: 'reset', accountId: id });
    assert.equal((await get(`/reinitialisation?code=${code}`)).status, 200);
    const response = await post('/reinitialisation', { code, password: 'nouveau mot de passe', confirm: 'nouveau mot de passe' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/connexion');
    const login = await post('/connexion', { email: 'lea@example.org', password: 'nouveau mot de passe' });
    assert.equal(login.headers.get('location'), '/');
  });

  it('answers 410 for an invalid link', async () => {
    assert.equal((await get('/reinitialisation?code=nope')).status, 410);
    const response = await post('/reinitialisation', { code: 'nope', password: PASSWORD, confirm: PASSWORD });
    assert.equal(response.status, 410);
  });
});

describe('sign-in and sign-out', () => {
  it('shows the form', async () => {
    assert.equal((await get('/connexion')).status, 200);
  });

  it('signs in without a second factor', async () => {
    await member();
    const response = await post('/connexion', { email: ' LEA@example.org ', password: PASSWORD });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/');
    assert.equal((await get('/', cookieOf(response))).status, 200);
  });

  it('opens a half session when a second factor exists', async () => {
    const id = await member();
    await pool.query('INSERT INTO totp_secrets (account_id, secret, confirmed_at) VALUES ($1, $2, now())', [id, 'x']);
    const response = await post('/connexion', { email: 'lea@example.org', password: PASSWORD });
    assert.equal(response.headers.get('location'), '/connexion/verification');
    assert.equal((await get('/', cookieOf(response))).status, 303);
    const { rows } = await pool.query('SELECT mfa_ok FROM sessions');
    assert.deepEqual(rows, [{ mfa_ok: false }]);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    await member();
    const wrong = await post('/connexion', { email: 'lea@example.org', password: 'mauvais mot de passe' });
    const unknown = await post('/connexion', { email: 'inconnu@example.org', password: PASSWORD });
    assert.equal(wrong.status, 200);
    assert.equal(unknown.status, 200);
    assert.equal(wrong.headers.get('set-cookie'), null);
    const [a, b] = [await wrong.text(), await unknown.text()];
    assert.ok(a.includes('E-mail ou mot de passe incorrect.'));
    assert.equal(a.replace(/value="[^"]*"/g, ''), b.replace(/value="[^"]*"/g, ''));
  });

  it('rejects the 11th attempt on one email even from different IPs', async () => {
    await member();
    let last;
    for (let i = 0; i < 11; i++) {
      last = await post('/connexion', { email: 'Lea@example.org', password: 'mauvais mot de passe' }, { 'x-forwarded-for': `1.1.1.${i}` });
      if (i < 10) assert.equal(last.status, 200);
    }
    assert.equal(last.status, 429);
    assert.ok((await last.text()).includes('Trop de tentatives. Réessayez dans 15 minutes.'));
    const good = await post('/connexion', { email: 'lea@example.org', password: PASSWORD }, { 'x-forwarded-for': '2.2.2.2' });
    assert.equal(good.status, 429);
  });

  it('limits per IP across emails', async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      last = await post('/connexion', { email: `u${i}@example.org`, password: 'x' }, { 'x-forwarded-for': '3.3.3.3' });
    }
    assert.equal(last.status, 429);
  });

  it('refuses a banned account with the generic message and no session', async () => {
    await member();
    await pool.query('UPDATE accounts SET banned_at = now()');
    const response = await post('/connexion', { email: 'lea@example.org', password: PASSWORD });
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes('E-mail ou mot de passe incorrect.'));
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal((await pool.query('SELECT 1 FROM sessions')).rowCount, 0);
  });

  it('signs out: the old cookie no longer works', async () => {
    await member();
    const cookie = cookieOf(await post('/connexion', { email: 'lea@example.org', password: PASSWORD }));
    const response = await post('/deconnexion', {}, { cookie });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/connexion');
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await get('/', cookie)).status, 303);
    assert.equal((await pool.query('SELECT 1 FROM sessions')).rowCount, 0);
  });

  it('does not grow the limiter once the IP is tripped, and bounds the email length', async () => {
    const limiter = createLimiter();
    const own = createApp({ routes: authRoutes(pool, config, { limiter }), log: () => {}, before: buildBefore(pool, config) })
      .listen(0, '127.0.0.1');
    await new Promise((resolve) => own.once('listening', resolve));
    const url = `http://127.0.0.1:${own.address().port}/connexion`;
    const send = (email, ip) => fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: config.origin, 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
      body: new URLSearchParams({ email, password: 'x' }),
    });
    try {
      for (let i = 0; i < 10; i++) await send(`e${i}@example.org`, '4.4.4.4');
      const before = limiter.size;
      for (let i = 0; i < 1000; i++) assert.equal((await send(`z${i}@example.org`, '4.4.4.4')).status, 429);
      assert.equal(limiter.size, before);
      const long = await send(`${'a'.repeat(300)}@example.org`, '5.5.5.5');
      assert.equal(long.status, 200);
      assert.equal(limiter.size, before + 1);
    } finally {
      await new Promise((resolve) => own.close(resolve));
    }
  });

  it('a successful login does not clear the IP counter', async () => {
    await member();
    const headers = { 'x-forwarded-for': '6.6.6.6' };
    for (let i = 0; i < 9; i++) await post('/connexion', { email: `o${i}@example.org`, password: 'x' }, headers);
    const ok = await post('/connexion', { email: 'lea@example.org', password: PASSWORD }, headers);
    assert.equal(ok.status, 303);
    assert.equal((await post('/connexion', { email: 'p@example.org', password: 'x' }, headers)).status, 429);
  });

  it('gives staff a 12 hour cookie and members 30 days', async () => {
    await member('staff@example.org', 'moderator');
    await member('lea@example.org');
    const staff = await post('/connexion', { email: 'staff@example.org', password: PASSWORD });
    assert.match(staff.headers.get('set-cookie'), /Max-Age=43200/);
    const plain = await post('/connexion', { email: 'lea@example.org', password: PASSWORD });
    assert.match(plain.headers.get('set-cookie'), /Max-Age=2592000/);
  });

  it('closes the carried session when signing in again', async () => {
    await member();
    const first = cookieOf(await post('/connexion', { email: 'lea@example.org', password: PASSWORD }));
    assert.equal((await get('/', first)).status, 200);
    const second = cookieOf(await post('/connexion', { email: 'lea@example.org', password: PASSWORD }, { cookie: first }));
    assert.equal((await get('/', first)).status, 303);
    assert.equal((await get('/', second)).status, 200);
  });

  it('closes the carried session when signing up', async () => {
    await member();
    const first = cookieOf(await post('/connexion', { email: 'lea@example.org', password: PASSWORD }));
    const code = await createLink(pool, { kind: 'invitation' });
    const response = await post('/inscription', {
      code, email: 'new@example.org', displayName: 'Zoé', password: PASSWORD, confirm: PASSWORD,
    }, { cookie: first });
    assert.equal(response.status, 303);
    assert.equal((await get('/', first)).status, 303);
  });

  it('falls back to the socket address when X-Forwarded-For ends empty', async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      last = await post('/connexion', { email: `f${i}@example.org`, password: 'x' }, { 'x-forwarded-for': '1.2.3.4, ' });
    }
    assert.equal(last.status, 429);
    const socket = await fetch(`${base}/connexion`, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: config.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'h@example.org', password: 'x' }),
    });
    assert.equal(socket.status, 429);
    const other = await post('/connexion', { email: 'g@example.org', password: 'x' }, { 'x-forwarded-for': '7.7.7.7' });
    assert.equal(other.status, 200);
  });
});
