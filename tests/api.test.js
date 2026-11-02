import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { apiRecipe, recipeStates } from '../src/api.js';
import { saveDraft, submitVersion } from '../src/contributions.js';
import { migrate } from '../src/db.js';
import { publishVersion } from '../src/recipes.js';
import { createApp } from '../src/http.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { openSession } from '../src/sessions.js';
import { createTestDatabase } from './helpers/db.js';
import { recipe } from './helpers/recipes.js';

const config = { origin: 'http://localhost', rpID: 'localhost', secretKey: Buffer.alloc(32, 7) };
let testDb;
let pool;
let me;
let server;
let base;
let cookie;
let n = 0;

const get = (path, withCookie = cookie) => fetch(`${base}${path}`, { redirect: 'manual', headers: withCookie ? { cookie: withCookie } : {} });

async function account(name = `Membre ${++n}`) {
  const { rows } = await pool.query(
    "INSERT INTO accounts (email, display_name, password_hash, role) VALUES ($1, $2, 'h', 'member') RETURNING id",
    [`a${++n}@example.org`, name]
  );
  return rows[0].id;
}
const publish = async (authorId = null, fields = {}) => String((await publishVersion(pool, { authorId, fields: recipe(fields) })).id);
const submit = async (authorId, mode, recipeId = null) => {
  const saved = await saveDraft(pool, { recipeId, authorId, draft: recipe() });
  await submitVersion(pool, { recipeId: saved.id, authorId, mode, dataDir: tmpdir() });
  return String(saved.id);
};

beforeEach(async () => {
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
  me = await account();
  server = createApp({ routes: buildRoutes(pool, () => {}, config, {}), log: () => {}, before: buildBefore(pool, config) })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = `fdl_session=${await openSession(pool, me, { mfaOk: true })}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.drop();
});

describe('recipeStates', () => {
  it('gives each id its state and version', async () => {
    const other = await account();
    const pub = await publish(me);
    const priv = await submit(me, 'private');
    const theirs = await submit(other, 'private');
    const gone = await publish(me);
    await pool.query("UPDATE recipes SET removed_at = now(), removed_reason = 'x' WHERE id = $1", [gone]);
    const states = await recipeStates(pool, [pub, priv, theirs, gone, '999999'], me);
    assert.deepEqual(states.get(Number(pub)), { state: 'published', version: 1 });
    assert.deepEqual(states.get(Number(priv)), { state: 'private', version: 1 });
    assert.deepEqual(states.get(Number(theirs)), { state: 'not_found' });
    assert.deepEqual(states.get(Number(gone)), { state: 'removed' });
    assert.deepEqual(states.get(999999), { state: 'not_found' });
  });

  it('keeps the published version while a newer one waits', async () => {
    const author = await account();
    const id = await publish(author);
    await submit(author, 'public', id);
    const { rows } = await pool.query("SELECT status FROM recipe_versions WHERE recipe_id = $1 AND version = 2", [id]);
    assert.equal(rows[0].status, 'pending');
    const states = await recipeStates(pool, [id], null);
    assert.deepEqual(states.get(Number(id)), { state: 'published', version: 1 });
  });

  it('counts a banned author as removal', async () => {
    const author = await account();
    const id = await publish(author);
    await pool.query('UPDATE accounts SET banned_at = now() WHERE id = $1', [author]);
    const states = await recipeStates(pool, [id], null);
    assert.deepEqual(states.get(Number(id)), { state: 'removed' });
  });
});

describe('apiRecipe', () => {
  it('projects a published recipe without photo, rating or comment', async () => {
    const { rows: [{ display_name: name }] } = await pool.query('SELECT display_name FROM accounts WHERE id = $1', [me]);
    const pub = await publish(me);
    const { state, recipe: r } = await apiRecipe(pool, pub, null, 'https://fdl.example');
    assert.equal(state, 'published');
    assert.equal(r.url, `https://fdl.example/recette?id=${pub}`);
    assert.equal(r.visibility, 'public');
    assert.equal(r.title, 'Soupe de légumes');
    assert.equal(r.author, name);
    assert.ok(r.publishedAt);
    for (const key of ['photo', 'rating', 'comments']) assert.ok(!(key in r), key);
  });

  it('shows a private recipe to its author only', async () => {
    const other = await account();
    const id = await submit(me, 'private');
    const own = await apiRecipe(pool, id, me, 'https://fdl.example');
    assert.equal(own.state, 'private');
    assert.equal(own.recipe.visibility, 'private');
    assert.equal(own.recipe.publishedAt, null);
    assert.deepEqual(await apiRecipe(pool, id, other, 'https://fdl.example'), { state: 'not_found' });
  });
});

describe('/api/v1', () => {
  it('answers 401 JSON without a session', async () => {
    const response = await get('/api/v1/recettes', null);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).error.code, 'unauthorized');
  });

  it('searches with the site filters and a page size', async () => {
    await publish(null, { title: 'Soupe un' });
    await publish(null, { title: 'Soupe deux' });
    await publish(null, { title: 'Soupe trois' });
    const first = await get('/api/v1/recettes?limite=2');
    assert.equal(first.headers.get('cache-control'), 'no-store');
    const page1 = await first.json();
    assert.equal(page1.items.length, 2);
    assert.deepEqual(Object.keys(page1.items[0]), ['id', 'title', 'minutes', 'diet', 'author']);
    assert.ok(page1.next);
    const page2 = await (await get(`/api/v1/recettes?limite=2&apres=${page1.next}`)).json();
    assert.equal(page2.items.length, 1);
    assert.equal(page2.next, null);
    const bad = await get('/api/v1/recettes?apres=xx');
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'bad_cursor');
    assert.equal((await (await get('/api/v1/recettes?q=trois')).json()).items.length, 1);
    assert.equal((await (await get('/api/v1/recettes?limite=0')).json()).items.length, 3);
  });

  it('serves a recipe, 404 for unknown or foreign private, 410 once removed', async () => {
    const other = await account();
    const pub = await publish(other);
    const theirs = await submit(other, 'private');
    const ok = await get(`/api/v1/recette?id=${pub}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal((await ok.json()).url, `http://localhost/recette?id=${pub}`);
    for (const id of ['abc', '99999999999999999999', '999999', theirs, '']) {
      const response = await get(`/api/v1/recette?id=${id}`);
      assert.equal(response.status, 404, id);
      assert.equal((await response.json()).error.message, 'Recette introuvable.');
    }
    await pool.query("UPDATE recipes SET removed_at = now(), removed_reason = 'x' WHERE id = $1", [pub]);
    const gone = await get(`/api/v1/recette?id=${pub}`);
    assert.equal(gone.status, 410);
    assert.equal((await gone.json()).error.code, 'removed');
  });

  it('reports states in one call', async () => {
    const pub = await publish(me);
    const gone = await publish(me);
    await pool.query("UPDATE recipes SET removed_at = now(), removed_reason = 'x' WHERE id = $1", [gone]);
    const response = await get(`/api/v1/etat?ids=${pub},${gone},999`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      [pub]: { state: 'published', version: 1 }, [gone]: { state: 'removed' }, 999: { state: 'not_found' },
    });
  });

  it('refuses malformed ids', async () => {
    for (const ids of ['', 'a', '1,,2', '1,1', Array.from({ length: 101 }, (_, i) => i + 1).join(','), '99999999999999999999']) {
      assert.equal((await get(`/api/v1/etat?ids=${ids}`)).status, 400, ids);
    }
    assert.equal((await get('/api/v1/etat')).status, 400);
    assert.equal((await get(`/api/v1/etat?ids=${Array.from({ length: 100 }, (_, i) => i + 1).join(',')}`)).status, 200);
  });

  it('lists my published and private recipes, not my drafts', async () => {
    const pub = await publish(me);
    const priv = await submit(me, 'private');
    await saveDraft(pool, { recipeId: null, authorId: me, draft: recipe() });
    await publish(await account());
    const pending = await publish(me, { title: 'Titre publié' });
    const saved = await saveDraft(pool, { recipeId: pending, authorId: me, draft: recipe({ title: 'Titre en attente' }) });
    await submitVersion(pool, { recipeId: saved.id, authorId: me, mode: 'public', dataDir: tmpdir() });
    const response = await get('/api/v1/mes-recettes');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { items } = await response.json();
    assert.deepEqual(items.map(({ id, state, version }) => [String(id), state, version]).sort(), [[priv, 'private', 1], [pub, 'published', 1], [pending, 'published', 1]].sort());
    assert.equal(items.find(({ id }) => String(id) === pending).title, 'Titre publié');
  });

  it('keeps a private recipe listed while its public submission waits', async () => {
    const id = await submit(me, 'private');
    const saved = await saveDraft(pool, { recipeId: id, authorId: me, draft: recipe({ title: 'Titre public en attente' }) });
    await submitVersion(pool, { recipeId: saved.id, authorId: me, mode: 'public', dataDir: tmpdir() });
    const { items } = await (await get('/api/v1/mes-recettes')).json();
    assert.deepEqual(items.map(({ id: i, state, version, title }) => [String(i), state, version, title]), [[id, 'private', 1, 'Soupe de légumes']]);
  });

  it('hides a removed private recipe from strangers', async () => {
    const other = await account();
    const id = await submit(other, 'private');
    await pool.query("UPDATE recipes SET removed_at = now(), removed_reason = 'x' WHERE id = $1", [id]);
    assert.deepEqual((await recipeStates(pool, [id], me)).get(Number(id)), { state: 'not_found' });
    assert.deepEqual((await recipeStates(pool, [id], other)).get(Number(id)), { state: 'removed' });
  });

  it('answers 403 JSON to staff without a passkey', async () => {
    await pool.query("UPDATE accounts SET role = 'moderator' WHERE id = $1", [me]);
    const response = await get('/api/v1/recettes');
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).error.code, 'forbidden');
  });
});
