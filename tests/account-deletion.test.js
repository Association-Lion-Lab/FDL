import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deleteAccount, hashPassword } from '../src/accounts.js';
import { recipeStates } from '../src/api.js';
import { saveDraft, submitVersion } from '../src/contributions.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
import { decide } from '../src/moderation.js';
import { publishVersion } from '../src/recipes.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { openSession } from '../src/sessions.js';
import { createTestDatabase } from './helpers/db.js';
import { recipe } from './helpers/recipes.js';

const PASSWORD = 'un mot de passe solide';
let testDb;
let pool;
let dataDir;
let server;
let base;
let config;

let n = 0;
async function account(role = 'member') {
  const { rows } = await pool.query(
    "INSERT INTO accounts (email, display_name, password_hash, role) VALUES ($1, 'Léa', $2, $3) RETURNING id",
    [`d${++n}@example.org`, await hashPassword(PASSWORD), role]
  );
  return rows[0].id;
}
const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;

beforeEach(async () => {
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
  dataDir = await mkdtemp(join(tmpdir(), 'fdl-deletion-'));
  config = { origin: 'http://localhost', secretKey: Buffer.alloc(32, 7), dataDir };
  server = createApp({ routes: buildRoutes(pool, () => {}, config), log: () => {}, before: buildBefore(pool, config) })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.drop();
  await rm(dataDir, { recursive: true, force: true });
});

describe('deleteAccount', () => {
  it('keeps published recipes anonymous and erases the rest', async () => {
    const me = await account();
    const other = await account();
    const theirs = (await publishVersion(pool, { authorId: other, fields: recipe() })).id;
    const published = (await publishVersion(pool, { authorId: me, fields: recipe({ title: 'Publiée' }) })).id;
    // A pending revision and a draft on the published recipe: unpublished text of the author.
    await saveDraft(pool, { recipeId: published, authorId: me, draft: recipe({ title: 'Révision' }) });
    await submitVersion(pool, { recipeId: published, authorId: me, mode: 'public', dataDir });
    await saveDraft(pool, { recipeId: published, authorId: me, draft: recipe({ title: 'Brouillon de révision' }) });
    const privateId = (await saveDraft(pool, { authorId: me, draft: recipe({ title: 'Privée' }) })).id;
    await submitVersion(pool, { recipeId: privateId, authorId: me, mode: 'private', dataDir });
    const draftId = (await saveDraft(pool, { authorId: me, draft: recipe({ title: 'Brouillon' }) })).id;
    const removed = (await publishVersion(pool, { authorId: me, fields: recipe({ title: 'Retirée' }) })).id;
    await decide(pool, { moderatorId: other, kind: 'remove', recipeId: removed, reason: 'Test' });
    await pool.query('INSERT INTO ratings (recipe_id, account_id, stars) VALUES ($1, $2, 5)', [theirs, me]);
    await pool.query("INSERT INTO comments (recipe_id, author_id, body, status) VALUES ($1, $2, 'Bon', 'published')", [theirs, me]);
    await pool.query("INSERT INTO reports (recipe_id, reporter_id, category) VALUES ($1, $2, 'spam')", [published, other]);
    await pool.query("INSERT INTO oauth_tokens (token_hash, account_id, client_id) VALUES ('\\x01', $1, 'https://manger.example.org')", [me]);
    await openSession(pool, me, { mfaOk: true });

    await deleteAccount(pool, me);

    assert.equal(await count('SELECT count(*)::int AS n FROM accounts WHERE id = $1', [me]), 0);
    const { rows: kept } = await pool.query('SELECT id, author_id, draft FROM recipes WHERE id = ANY($1) ORDER BY id', [[published, removed]]);
    assert.deepEqual(kept.map((r) => [String(r.id), r.author_id, r.draft]), [[String(published), null, null], [String(removed), null, null]]);
    assert.deepEqual((await pool.query('SELECT status FROM recipe_versions WHERE recipe_id = $1', [published])).rows, [{ status: 'published' }]);
    assert.equal(await count('SELECT count(*)::int AS n FROM recipes WHERE id = ANY($1)', [[privateId, draftId]]), 0);
    for (const table of ['ratings', 'oauth_tokens', 'sessions']) {
      assert.equal(await count(`SELECT count(*)::int AS n FROM ${table} WHERE account_id = $1`, [me]), 0, table);
    }
    assert.equal(await count('SELECT count(*)::int AS n FROM comments WHERE author_id = $1', [me]), 0);
    // Someone else's report and recipe are untouched; the private recipe now reads as not_found for Manger!.
    assert.equal(await count('SELECT count(*)::int AS n FROM reports WHERE recipe_id = $1', [published]), 1);
    assert.equal(await count('SELECT count(*)::int AS n FROM recipes WHERE id = $1 AND author_id = $2', [theirs, other]), 1);
    const states = await recipeStates(pool, [published, privateId, removed], other);
    assert.equal(states.get(Number(published)).state, 'published');
    assert.equal(states.get(Number(privateId)).state, 'not_found');
    assert.equal(states.get(Number(removed)).state, 'removed');
  });

  it('refuses the last active admin, not one of two', async () => {
    const admin = await account('admin');
    const banned = await account('admin');
    await pool.query('UPDATE accounts SET banned_at = now() WHERE id = $1', [banned]);
    await assert.rejects(deleteAccount(pool, admin), { code: 'last_admin' });
    assert.equal(await count('SELECT count(*)::int AS n FROM accounts WHERE id = $1', [admin]), 1);
    await account('admin');
    await deleteAccount(pool, admin);
    assert.equal(await count('SELECT count(*)::int AS n FROM accounts WHERE id = $1', [admin]), 0);
    await assert.rejects(deleteAccount(pool, admin), { code: 'not_found' });
  });
});

describe('deletion pages', () => {
  const post = (path, form, cookie, origin = config.origin) => fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(form),
  });
  const get = (path, cookie) => fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

  it('asks the password, then deletes and signs out', async () => {
    const me = await account();
    const { id } = await publishVersion(pool, { authorId: me, fields: recipe({ title: 'Soupe restante' }) });
    const cookie = `fdl_session=${await openSession(pool, me, { mfaOk: true })}`;
    assert.ok((await (await get('/compte/securite', cookie)).text()).includes('href="/compte/securite/suppression"'));
    const form = await get('/compte/securite/suppression', cookie);
    assert.equal(form.status, 200);
    assert.ok((await form.text()).includes('Auteur anonyme'));

    assert.equal((await post('/compte/securite/suppression', { current: PASSWORD }, cookie, 'https://evil.example')).status, 403);
    const wrong = await post('/compte/securite/suppression', { current: 'faux faux faux' }, cookie);
    assert.equal(wrong.status, 400);
    assert.ok((await wrong.text()).includes('Mot de passe incorrect.'));
    assert.equal(await count('SELECT count(*)::int AS n FROM accounts WHERE id = $1', [me]), 1);

    const done = await post('/compte/securite/suppression', { current: PASSWORD }, cookie);
    assert.equal(done.status, 200);
    assert.match(done.headers.get('set-cookie'), /^fdl_session=;/);
    assert.ok((await done.text()).includes('Compte supprimé'));
    assert.equal(await count('SELECT count(*)::int AS n FROM accounts WHERE id = $1', [me]), 0);
    assert.equal((await get('/compte/securite', cookie)).status, 303);

    const reader = `fdl_session=${await openSession(pool, await account(), { mfaOk: true })}`;
    const page = await (await get(`/recette?id=${id}`, reader)).text();
    assert.ok(page.includes('Soupe restante'));
    assert.ok(page.includes('Auteur anonyme'));
  });

  it('tells the last admin why it is refused', async () => {
    const admin = await account('admin');
    await pool.query("INSERT INTO passkeys (id, account_id, public_key, counter, name) VALUES ('k', $1, '\\x00', 0, 'Clé')", [admin]);
    const cookie = `fdl_session=${await openSession(pool, admin, { mfaOk: true })}`;
    const refused = await post('/compte/securite/suppression', { current: PASSWORD }, cookie);
    assert.equal(refused.status, 409);
    assert.ok((await refused.text()).includes('dernier administrateur'));
    assert.equal(await count('SELECT count(*)::int AS n FROM accounts WHERE id = $1', [admin]), 1);
  });
});
