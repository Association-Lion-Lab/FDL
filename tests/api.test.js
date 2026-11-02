import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { apiRecipe, recipeStates } from '../src/api.js';
import { saveDraft, submitVersion } from '../src/contributions.js';
import { migrate } from '../src/db.js';
import { publishVersion } from '../src/recipes.js';
import { createTestDatabase } from './helpers/db.js';
import { recipe } from './helpers/recipes.js';

let testDb;
let pool;
let me;
let n = 0;

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
});

afterEach(() => testDb.drop());

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
