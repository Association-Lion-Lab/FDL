import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { migrate } from '../src/db.js';
import { getOwnRecipe, isTrusted, listMine, saveDraft, submitVersion } from '../src/contributions.js';
import { getRecipe, publishVersion, searchRecipes } from '../src/recipes.js';
import { createTestDatabase } from './helpers/db.js';
import { recipe } from './helpers/recipes.js';

let testDb;
let pool;
let dataDir;
let n = 0;

beforeEach(async () => {
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
  dataDir = await mkdtemp(join(tmpdir(), 'fdl-contrib-'));
});
afterEach(async () => {
  await testDb.drop();
  await rm(dataDir, { recursive: true, force: true });
});

async function author() {
  const { rows } = await pool.query(
    "INSERT INTO accounts (email, display_name, password_hash, role) VALUES ($1, 'Auteur', 'x', 'member') RETURNING id",
    [`c${++n}@example.org`]
  );
  return Number(rows[0].id);
}
// An author with enough published recipes to be trusted.
async function trusted() {
  const authorId = await author();
  for (let i = 0; i < 3; i++) await publishVersion(pool, { authorId, fields: recipe({ title: `Ancienne ${authorId}-${i}` }) });
  return authorId;
}
async function submit(authorId, fields, mode = 'public') {
  const { id } = await saveDraft(pool, { authorId, draft: recipe(fields) });
  return { id, ...(await submitVersion(pool, { recipeId: id, authorId, mode, dataDir })) };
}
const rejects = (promise, code) => assert.rejects(promise, { code });

describe('drafts', () => {
  it('accepts an incomplete draft but refuses to submit it', async () => {
    const authorId = await author();
    const { id } = await saveDraft(pool, { authorId, draft: { title: '' } });
    await rejects(submitVersion(pool, { recipeId: id, authorId, mode: 'public', dataDir }), 'invalid_recipe');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM recipe_versions WHERE recipe_id = $1', [id])).rows[0].n, 0);
  });

  it('refuses another author draft and leaves it unchanged', async () => {
    const owner = await author();
    const other = await author();
    const { id } = await saveDraft(pool, { authorId: owner, draft: { title: 'Mien' } });
    await rejects(saveDraft(pool, { recipeId: id, authorId: other, draft: { title: 'Pris' } }), 'not_found');
    assert.equal((await getOwnRecipe(pool, { recipeId: id, authorId: owner })).draft.title, 'Mien');
    assert.equal(await getOwnRecipe(pool, { recipeId: id, authorId: other }), null);
  });
});

describe('trust', () => {
  it('sends a new author to moderation until three recipes are published', async () => {
    const authorId = await author();
    const first = await submit(authorId, { title: 'Première' });
    assert.equal(first.status, 'pending');
    assert.equal((await searchRecipes(pool)).items.length, 0);
    assert.equal(await isTrusted(pool, authorId), false);
    for (let i = 0; i < 3; i++) await publishVersion(pool, { authorId, fields: recipe({ title: `P${i}` }) });
    assert.equal(await isTrusted(pool, authorId), true);
    const next = await submit(authorId, { title: 'Suivante' });
    assert.equal(next.status, 'published');
    assert.equal((await getRecipe(pool, next.id)).title, 'Suivante');
  });
});

describe('automatic filters', () => {
  it('flags links, banned words and duplicates', async () => {
    await writeFile(join(dataDir, 'mots-interdits.txt'), 'Arnaque\n');
    const authorId = await trusted();
    await publishVersion(pool, { authorId: await author(), fields: recipe({ title: 'Pâtes au pesto' }) });
    const link = await submit(authorId, { title: 'Voir www.exemple.fr' });
    assert.deepEqual([link.status, link.flags], ['pending', ['link']]);
    const banned = await submit(authorId, { title: 'Une arnaque' });
    assert.deepEqual([banned.status, banned.flags], ['pending', ['banned_word']]);
    const dup = await submit(authorId, { title: 'pates au PESTO' });
    assert.deepEqual([dup.status, dup.flags], ['pending', ['duplicate']]);
    const clean = await submit(authorId, { title: 'Arnaquette', sourceUrl: 'https://exemple.fr/a' });
    assert.deepEqual([clean.status, clean.flags], ['published', []]);
  });
});

describe('submitVersion', () => {
  it('keeps one pending version when submitted twice at once', async () => {
    const authorId = await author();
    const { id } = await saveDraft(pool, { authorId, draft: recipe() });
    await Promise.all([1, 2].map(() => submitVersion(pool, { recipeId: id, authorId, mode: 'public', dataDir })));
    const { rows } = await pool.query('SELECT version, status FROM recipe_versions WHERE recipe_id = $1 ORDER BY version', [id]);
    assert.deepEqual(rows.map((r) => r.status).sort(), ['pending', 'rejected']);
    const { rows: decisions } = await pool.query('SELECT reason, moderator_id FROM moderation_decisions WHERE recipe_id = $1', [id]);
    assert.deepEqual(decisions, [{ reason: 'Remplacée par une version plus récente.', moderator_id: null }]);
  });

  it('keeps the old version public while a new one waits', async () => {
    const authorId = await author();
    const { id } = await publishVersion(pool, { authorId, fields: recipe({ title: 'Ancienne' }) });
    await saveDraft(pool, { recipeId: id, authorId, draft: recipe({ title: 'Nouvelle' }) });
    const result = await submitVersion(pool, { recipeId: id, authorId, mode: 'public', dataDir });
    assert.equal(result.status, 'pending');
    assert.equal((await getRecipe(pool, id)).title, 'Ancienne');
    const mine = await listMine(pool, authorId);
    assert.equal(mine[0].state, 'published_pending');
    assert.equal(mine[0].title, 'Nouvelle');
  });

  it('refuses a private version of a published recipe', async () => {
    const authorId = await author();
    const { id } = await publishVersion(pool, { authorId, fields: recipe() });
    await saveDraft(pool, { recipeId: id, authorId, draft: recipe() });
    await rejects(submitVersion(pool, { recipeId: id, authorId, mode: 'private', dataDir }), 'already_public');
  });

  it('keeps a private version private and lists the states', async () => {
    const authorId = await author();
    const priv = await submit(authorId, {}, 'private');
    assert.equal(priv.status, 'private');
    await saveDraft(pool, { authorId, draft: {} });
    const mine = await listMine(pool, authorId);
    assert.deepEqual(mine.map((m) => [m.state, m.title]), [['draft', 'Sans titre'], ['private', 'Soupe de légumes']]);
    assert.equal(mine[0].lastDecision, null);
  });
});
