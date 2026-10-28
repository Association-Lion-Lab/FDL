import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { migrate } from '../src/db.js';
import { currentSeason, getRecipe, publishVersion, searchRecipes } from '../src/recipes.js';
import { createTestDatabase } from './helpers/db.js';
import { recipe } from './helpers/recipes.js';

let testDb;
let pool;

beforeEach(async () => {
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
});

afterEach(() => testDb.drop());

let n = 0;
async function account(name = `Auteur ${++n}`) {
  const { rows } = await pool.query(
    "INSERT INTO accounts (email, display_name, password_hash, role) VALUES ($1, $2, 'h', 'member') RETURNING id",
    [`r${++n}@example.org`, name]
  );
  return rows[0].id;
}

const publish = (fields, authorId = null) => publishVersion(pool, { authorId, fields: recipe(fields) });
const titles = async (filters, page) => (await searchRecipes(pool, filters, page)).items.map((c) => c.title).sort();
const cursor = (value) => Buffer.from(value).toString('base64url');

describe('publishVersion and getRecipe', () => {
  it('reads back every field of the published version', async () => {
    const authorId = await account('Alice');
    const fields = recipe({ seasons: ['winter'], sourceUrl: 'https://example.org/soupe' });
    const { id, version } = await publishVersion(pool, { authorId, fields });
    assert.equal(version, 1);
    const view = await getRecipe(pool, id);
    assert.equal(view.id, id);
    assert.equal(view.version, 1);
    for (const key of ['title', 'minutes', 'servings', 'diet', 'tags', 'seasons', 'ingredients', 'steps', 'provenance', 'sourceUrl']) {
      assert.deepEqual(view[key], fields[key], key);
    }
    assert.equal(view.universe, null);
    assert.equal(view.licence, 'CC-BY-SA-4.0');
    assert.equal(view.author, 'Alice');
    assert.ok(view.submittedAt instanceof Date);
    assert.ok(view.publishedAt instanceof Date);
  });

  it('publishes a new version without moving the recipe in the listing', async () => {
    const first = await publish({ title: 'Première' });
    await publish({ title: 'Seconde' });
    const { version } = await publishVersion(pool, { recipeId: first.id, fields: recipe({ title: 'Première v2' }) });
    assert.equal(version, 2);
    const view = await getRecipe(pool, first.id);
    assert.equal(view.version, 2);
    assert.equal(view.title, 'Première v2');
    const { items } = await searchRecipes(pool);
    assert.deepEqual(items.map((c) => c.title), ['Seconde', 'Première v2']);
  });

  it('rejects out-of-limit fields without writing anything', async () => {
    const bad = [
      { title: 'x'.repeat(121) },
      { minutes: 0 },
      { tags: ['x'.repeat(41)] },
      { steps: [] },
      { ingredients: [{ name: 'sel', amount: 1, unit: '', preparation: 'grilled' }] },
    ];
    for (const fields of bad) {
      await assert.rejects(publish(fields), { code: 'invalid_recipe' }, JSON.stringify(fields));
    }
    const { rowCount } = await pool.query('SELECT 1 FROM recipes');
    assert.equal(rowCount, 0);
  });

  it('hides drafts, private recipes and banned authors', async () => {
    const draft = await publish({ title: 'Brouillon' });
    const hidden = await publish({ title: 'Privée' });
    const bannedId = await account();
    const banned = await publish({ title: 'Bannie' }, bannedId);
    await publish({ title: 'Visible' });
    await pool.query("UPDATE recipes SET visibility = 'draft' WHERE id = $1", [draft.id]);
    await pool.query("UPDATE recipes SET visibility = 'private' WHERE id = $1", [hidden.id]);
    await pool.query('UPDATE accounts SET banned_at = now() WHERE id = $1', [bannedId]);
    assert.deepEqual(await titles(), ['Visible']);
    for (const { id } of [draft, hidden, banned]) assert.equal(await getRecipe(pool, id), null);
    assert.equal(await getRecipe(pool, 999999), null);
  });

  it('keeps the recipe of a deleted account, without author', async () => {
    const authorId = await account();
    const { id } = await publish({}, authorId);
    await pool.query('DELETE FROM accounts WHERE id = $1', [authorId]);
    assert.equal((await getRecipe(pool, id)).author, null);
    assert.equal((await searchRecipes(pool)).items[0].author, null);
  });
});

describe('searchRecipes', () => {
  it('ignores case, accents and plurals', async () => {
    await publish({ title: 'Poireaux vinaigrette' });
    await publish({ title: 'Pâtes au pesto' });
    assert.deepEqual(await titles({ q: 'poireau' }), ['Poireaux vinaigrette']);
    assert.deepEqual(await titles({ q: 'POIREAUX' }), ['Poireaux vinaigrette']);
    assert.deepEqual(await titles({ q: 'pates' }), ['Pâtes au pesto']);
    assert.deepEqual(await titles({ q: '   ' }), ['Poireaux vinaigrette', 'Pâtes au pesto'].sort());
  });

  it('finds a recipe by ingredient or tag', async () => {
    await publish({ title: 'Salade', ingredients: [{ name: 'betteraves', amount: 2, unit: '', preparation: 'cooked' }], tags: ['été'] });
    assert.deepEqual(await titles({ q: 'betterave' }), ['Salade']);
    assert.deepEqual(await titles({ q: 'ete' }), ['Salade']);
  });

  it('survives odd query syntax', async () => {
    await publish({});
    for (const q of ["'", '&|!(', '"non fermé', 'x'.repeat(500)]) {
      assert.ok(Array.isArray((await searchRecipes(pool, { q })).items), q);
    }
  });

  it('filters diets as "suitable for"', async () => {
    for (const diet of ['vegan', 'vegetarian', 'pescetarian', 'omnivore']) await publish({ title: diet, diet });
    assert.deepEqual(await titles({ diet: 'vegan' }), ['vegan']);
    assert.deepEqual(await titles({ diet: 'vegetarian' }), ['vegan', 'vegetarian']);
    assert.deepEqual(await titles({ diet: 'pescetarian' }), ['pescetarian', 'vegan', 'vegetarian']);
    assert.deepEqual(await titles({ diet: 'omnivore' }), ['omnivore', 'pescetarian', 'vegan', 'vegetarian']);
  });

  it('matches any shared season and never an unset one', async () => {
    await publish({ title: 'hiver-automne', seasons: ['winter', 'autumn'] });
    await publish({ title: 'aucune', seasons: [] });
    await publish({ title: 'été', seasons: ['summer'] });
    assert.deepEqual(await titles({ seasons: ['winter'] }), ['hiver-automne']);
  });

  it('filters by maximum duration and universe', async () => {
    await pool.query("INSERT INTO universes (slug, label) VALUES ('monde', 'Cuisine du monde')");
    await publish({ title: 'trente', minutes: 30, universe: 'monde' });
    await publish({ title: 'trente et une', minutes: 31 });
    assert.deepEqual(await titles({ maxMinutes: 30 }), ['trente']);
    assert.deepEqual(await titles({ universe: 'monde' }), ['trente']);
    assert.deepEqual((await getRecipe(pool, (await searchRecipes(pool, { universe: 'monde' })).items[0].id)).universe,
      { slug: 'monde', label: 'Cuisine du monde' });
  });

  it('pages with a cursor, without duplicates', async () => {
    for (let i = 0; i < 25; i++) await publish({ title: `r${i}` });
    const first = await searchRecipes(pool);
    assert.equal(first.items.length, 20);
    assert.ok(first.next);
    const second = await searchRecipes(pool, {}, { after: first.next });
    assert.equal(second.items.length, 5);
    assert.equal(second.next, null);
    const ids = [...first.items, ...second.items].map((c) => c.id);
    assert.equal(new Set(ids).size, 25);
    assert.equal((await searchRecipes(pool, {}, { limit: 500 })).items.length, 25);
  });

  it('caps the page size at 50', async () => {
    for (let i = 0; i < 51; i++) await publish({ title: `r${i}` });
    assert.equal((await searchRecipes(pool, {}, { limit: 500 })).items.length, 50);
  });

  it('rejects a tampered cursor', async () => {
    const bad = ['zzz', cursor('[]'), cursor('{"t":"x","i":1}'), cursor('{"t":"2026-01-01T00:00:00Z","i":1e30}'),
      ...['1', '2026-02-30', '2026-10-28 junk', '+275760-09-13T00:00:00.000Z', '2026-02-30T00:00:00.000000Z']
        .map((t) => cursor(JSON.stringify({ t, i: 1 })))];
    for (const after of bad) await assert.rejects(searchRecipes(pool, {}, { after }), { code: 'bad_cursor' }, after);
  });
});

describe('currentSeason', () => {
  it('maps months to meteorological seasons', () => {
    assert.equal(currentSeason(new Date('2026-12-15T12:00:00Z')), 'winter');
    assert.equal(currentSeason(new Date('2026-03-01T12:00:00Z')), 'spring');
    assert.equal(currentSeason(new Date('2026-08-31T12:00:00Z')), 'summer');
    assert.equal(currentSeason(new Date('2026-11-30T12:00:00Z')), 'autumn');
  });
});
