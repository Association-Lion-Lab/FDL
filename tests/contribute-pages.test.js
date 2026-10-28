import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { saveDraft, submitVersion } from '../src/contributions.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { openSession } from '../src/sessions.js';
import { createTestDatabase } from './helpers/db.js';
import { recipe } from './helpers/recipes.js';

const config = { origin: 'http://localhost', rpID: 'localhost', secretKey: Buffer.alloc(32, 7), dataDir: '/nonexistent-fdl-data' };
let testDb;
let pool;
let server;
let base;
let me;
let other;

let n = 0;
async function member() {
  const { rows } = await pool.query(
    "INSERT INTO accounts (email, display_name, password_hash, role) VALUES ($1, 'Membre', 'h', 'member') RETURNING id",
    [`p${++n}@example.org`]
  );
  return { id: rows[0].id, cookie: `fdl_session=${await openSession(pool, rows[0].id, { mfaOk: true })}` };
}

beforeEach(async () => {
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
  server = createApp({ routes: buildRoutes(pool, () => {}, config, {}), log: () => {}, before: buildBefore(pool, config) })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  me = await member();
  other = await member();
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.drop();
});

const get = async (path, who = me) => {
  const response = await fetch(`${base}${path}`, { redirect: 'manual', headers: { cookie: who.cookie } });
  return { status: response.status, text: await response.text(), response };
};
const post = async (fields, who = me) => {
  const body = new URLSearchParams();
  for (const [key, value] of fields) body.append(key, value);
  const response = await fetch(`${base}/mes-recettes/edition`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: who.cookie, origin: config.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  return { status: response.status, text: await response.text(), response };
};
const full = (action, overrides = {}, extra = []) => [
  ['action', action], ['title', 'Soupe'], ['minutes', '30'], ['servings', '4'], ['diet', 'vegan'],
  ['provenance', 'Famille'], ['ingredient_name', 'carotte'], ['ingredient_amount', '3,5'], ['ingredient_unit', 'kg'],
  ['ingredient_preparation', 'raw'], ['ingredient_name', ''], ['ingredient_amount', ''], ['ingredient_unit', ''],
  ['ingredient_preparation', 'unknown'], ['step_kind', 'cook'], ['step_instruction', 'Cuire.'], ['step_minutes', '20'],
  ...extra,
].map(([key, value]) => [key, overrides[key] ?? value]);
const count = (text, name) => text.split(`name="${name}"`).length - 1;
const versions = async () => (await pool.query('SELECT count(*)::int AS n FROM recipe_versions')).rows[0].n;

describe('author pages', () => {
  it('lets a member publish a full recipe, which then waits for moderation', async () => {
    const sent = await post(full('publier', {}, [['atteste_texte', '1']]));
    assert.equal(sent.status, 303);
    assert.equal(sent.response.headers.get('location'), '/mes-recettes');
    const list = await get('/mes-recettes');
    assert.ok(list.text.includes('En attente de modération'));
    assert.ok(list.text.includes('Soupe'));
    assert.ok(list.text.includes('Mes recettes'));
  });

  it('refuses publication without the attestation, and writes no version', async () => {
    const sent = await post(full('publier'));
    assert.equal(sent.status, 400);
    assert.ok(sent.text.includes('Je suis l&#39;auteur de ce texte'));
    assert.ok(sent.text.includes('role="alert"'));
    assert.equal(await versions(), 0);
  });

  it('adds blank lines on "lignes"', async () => {
    const sent = await post(full('lignes'));
    assert.equal(sent.status, 200);
    assert.equal(count(sent.text, 'ingredient_name'), 11);
    assert.equal(count(sent.text, 'step_instruction'), 7);
  });

  it('shows the form with at least 5 ingredient and 3 step lines', async () => {
    const form = await get('/mes-recettes/edition');
    assert.equal(form.status, 200);
    assert.equal(count(form.text, 'ingredient_name'), 5);
    assert.equal(count(form.text, 'step_instruction'), 3);
  });

  it('answers 400 on an invalid field and keeps the other values', async () => {
    const sent = await post(full('privee', { minutes: 'abc' }));
    assert.equal(sent.status, 400);
    assert.ok(sent.text.includes('role="alert"'));
    assert.ok(sent.text.includes('value="abc"'));
    assert.ok(sent.text.includes('value="Soupe"'));
    assert.ok(sent.text.includes('value="3.5"'));
    assert.equal(await versions(), 0);
  });

  it("answers 404 on another member's recipe and writes nothing", async () => {
    const { id } = await saveDraft(pool, { authorId: other.id, draft: recipe({ title: 'Secret' }) });
    const sent = await post([['id', String(id)], ...full('brouillon')]);
    assert.equal(sent.status, 404);
    assert.equal((await get(`/mes-recettes/edition?id=${id}`)).status, 404);
    const { rows } = await pool.query('SELECT draft FROM recipes WHERE id = $1', [id]);
    assert.equal(rows[0].draft.title, 'Secret');
  });

  it('answers 404 on a removed recipe and an unknown id', async () => {
    const { id } = await saveDraft(pool, { authorId: me.id, draft: recipe() });
    await pool.query('UPDATE recipes SET removed_at = now() WHERE id = $1', [id]);
    assert.equal((await get(`/mes-recettes/edition?id=${id}`)).status, 404);
    assert.equal((await post([['id', String(id)], ...full('brouillon')])).status, 404);
    assert.equal((await get('/mes-recettes/edition?id=999999')).status, 404);
    assert.equal((await get('/mes-recettes/edition?id=abc')).status, 404);
  });

  it('shows the author their private recipe, and hides it from others', async () => {
    const { id } = await saveDraft(pool, { authorId: me.id, draft: recipe({ title: 'Ma privée' }) });
    await submitVersion(pool, { recipeId: id, authorId: me.id, mode: 'private', dataDir: config.dataDir });
    const mine = await get(`/recette?id=${id}`);
    assert.equal(mine.status, 200);
    assert.ok(mine.text.includes('Ma privée'));
    assert.ok(mine.text.includes('Privée'));
    assert.equal((await get(`/recette?id=${id}`, other)).status, 404);
  });

  it('escapes HTML in a draft title on the list and in the form', async () => {
    const sent = await post(full('brouillon', { title: '<script>x</script>' }));
    assert.equal(sent.status, 303);
    const list = await get('/mes-recettes');
    assert.ok(!list.text.includes('<script>x</script>'));
    assert.ok(list.text.includes('&lt;script&gt;x&lt;/script&gt;'));
    const { rows } = await pool.query('SELECT id FROM recipes');
    const form = await get(`/mes-recettes/edition?id=${rows[0].id}`);
    assert.ok(!form.text.includes('<script>x</script>'));
    assert.ok(form.text.includes('&lt;script&gt;x&lt;/script&gt;'));
  });
});
