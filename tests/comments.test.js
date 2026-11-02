import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { migrate } from '../src/db.js';
import { addComment, COMMENT_INVALID, deleteComment, editComment, listComments, visibleComment } from '../src/comments.js';
import { listMine } from '../src/contributions.js';
import { publishVersion } from '../src/recipes.js';
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
  dataDir = await mkdtemp(join(tmpdir(), 'fdl-comments-'));
});
afterEach(async () => {
  await testDb.drop();
  await rm(dataDir, { recursive: true, force: true });
});

async function account() {
  const { rows } = await pool.query(
    "INSERT INTO accounts (email, display_name, password_hash, role) VALUES ($1, $2, 'x', 'member') RETURNING id",
    [`k${++n}@example.org`, `Membre ${n}`]
  );
  return Number(rows[0].id);
}
// An account with three published recipes: trusted for recipes, hence for comments.
async function trusted() {
  const authorId = await account();
  for (let i = 0; i < 3; i++) await publishVersion(pool, { authorId, fields: recipe({ title: `Ancienne ${authorId}-${i}` }) });
  return authorId;
}
const visibleRecipe = async () => (await publishVersion(pool, { authorId: await account(), fields: recipe() })).id;
const add = (recipeId, authorId, body = 'Très bon') => addComment(pool, { recipeId, authorId, body, dataDir });
const row = async (id) => (await pool.query('SELECT * FROM comments WHERE id = $1', [id])).rows[0];
const count = async () => (await pool.query('SELECT count(*)::int AS n FROM comments')).rows[0].n;

describe('addComment', () => {
  it('holds a new account first comment, then publishes once it has three published', async () => {
    const recipeId = await visibleRecipe();
    const member = await account();
    assert.equal((await add(recipeId, member)).status, 'pending');
    await pool.query("UPDATE comments SET status = 'published'");
    for (let i = 0; i < 2; i++) await pool.query("INSERT INTO comments (recipe_id, author_id, body, status) VALUES ($1, $2, 'x', 'published')", [recipeId, member]);
    assert.equal((await add(recipeId, member)).status, 'published');
  });

  it('publishes straight away for an account trusted on recipes', async () => {
    assert.equal((await add(await visibleRecipe(), await trusted())).status, 'published');
  });

  it('validates the text', async () => {
    const recipeId = await visibleRecipe();
    const member = await account();
    for (const body of ['  ', 'a'.repeat(1001), 42, null]) {
      await assert.rejects(add(recipeId, member, body), { code: 'invalid_comment', message: COMMENT_INVALID });
    }
    assert.equal(await count(), 0);
    const ok = await add(recipeId, member, 'a'.repeat(1000));
    assert.ok(ok.id);
    assert.equal((await row((await add(recipeId, member, '  Bon  ')).id)).body, 'Bon');
  });

  it('holds a trusted account comment with a link or a banned word', async () => {
    await writeFile(join(dataDir, 'mots-interdits.txt'), 'Pâté\n');
    const recipeId = await visibleRecipe();
    const member = await trusted();
    const link = await add(recipeId, member, 'Voir https://x.fr');
    assert.equal(link.status, 'pending');
    assert.deepEqual((await row(link.id)).flags, ['link']);
    const word = await add(recipeId, member, 'Un bon pate');
    assert.equal(word.status, 'pending');
    assert.deepEqual((await row(word.id)).flags, ['banned_word']);
  });

  it('refuses a recipe that is private, a draft, removed or by a banned author', async () => {
    const member = await trusted();
    const owner = await account();
    const draft = (await pool.query("INSERT INTO recipes (author_id, visibility) VALUES ($1, 'draft') RETURNING id", [owner])).rows[0].id;
    const priv = (await pool.query("INSERT INTO recipes (author_id, visibility) VALUES ($1, 'private') RETURNING id", [owner])).rows[0].id;
    const removed = await visibleRecipe();
    await pool.query('UPDATE recipes SET removed_at = now() WHERE id = $1', [removed]);
    const bannedAuthor = await account();
    const banned = (await publishVersion(pool, { authorId: bannedAuthor, fields: recipe() })).id;
    await pool.query('UPDATE accounts SET banned_at = now() WHERE id = $1', [bannedAuthor]);
    for (const id of [draft, priv, removed, banned]) await assert.rejects(add(id, member), { code: 'not_found' });
    assert.equal(await count(), 0);
  });
});

describe('editComment', () => {
  it('rewrites the text, stamps edited_at and recomputes the status', async () => {
    const recipeId = await visibleRecipe();
    const member = await trusted();
    const { id } = await add(recipeId, member);
    assert.equal((await row(id)).edited_at, null);
    assert.deepEqual(await editComment(pool, { commentId: id, authorId: member, body: 'Voir www.x.fr', dataDir }), { status: 'pending' });
    const after = await row(id);
    assert.equal(after.body, 'Voir www.x.fr');
    assert.ok(after.edited_at);
    assert.equal(after.status, 'pending');
  });

  it('refuses another account and a removed comment, leaving the row alone', async () => {
    const recipeId = await visibleRecipe();
    const member = await trusted();
    const { id } = await add(recipeId, member, 'Original');
    await assert.rejects(editComment(pool, { commentId: id, authorId: await account(), body: 'Pris', dataDir }), { code: 'not_found' });
    await pool.query("UPDATE comments SET status = 'removed' WHERE id = $1", [id]);
    await assert.rejects(editComment(pool, { commentId: id, authorId: member, body: 'Pris', dataDir }), { code: 'not_found' });
    await assert.rejects(editComment(pool, { commentId: 999999, authorId: member, body: 'Pris', dataDir }), { code: 'not_found' });
    await assert.rejects(editComment(pool, { commentId: id, authorId: member, body: ' ', dataDir }), { code: 'invalid_comment' });
    const after = await row(id);
    assert.equal(after.body, 'Original');
    assert.equal(after.edited_at, null);
  });

  it('refuses when the recipe is no longer visible', async () => {
    const recipeId = await visibleRecipe();
    const member = await trusted();
    const { id } = await add(recipeId, member);
    await pool.query('UPDATE recipes SET removed_at = now() WHERE id = $1', [recipeId]);
    await assert.rejects(editComment(pool, { commentId: id, authorId: member, body: 'Neuf', dataDir }), { code: 'not_found' });
  });
});

describe('deleteComment', () => {
  it('only deletes your own comment, and its open report with it', async () => {
    const recipeId = await visibleRecipe();
    const member = await trusted();
    const reporter = await account();
    const { id } = await add(recipeId, member);
    await pool.query("INSERT INTO reports (recipe_id, comment_id, reporter_id, category) VALUES ($1, $2, $3, 'other')", [recipeId, id, reporter]);
    assert.equal(await deleteComment(pool, { commentId: id, authorId: reporter }), false);
    assert.ok(await row(id));
    assert.equal(await deleteComment(pool, { commentId: id, authorId: member }), true);
    assert.equal(await row(id), undefined);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM reports WHERE comment_id IS NOT NULL')).rows[0].n, 0);
  });
});

describe('listComments', () => {
  it('shows a third party the published ones only, oldest first, minus banned authors', async () => {
    const recipeId = await visibleRecipe();
    const a = await trusted();
    const b = await trusted();
    const bad = await trusted();
    const pending = await account();
    await add(recipeId, a, 'Premier');
    await add(recipeId, bad, 'Banni');
    await add(recipeId, b, 'Second');
    await add(recipeId, pending, 'En attente');
    await pool.query('UPDATE accounts SET banned_at = now() WHERE id = $1', [bad]);
    const list = await listComments(pool, { recipeId, viewerId: await account() });
    assert.deepEqual(list.map((c) => c.body), ['Premier', 'Second']);
    assert.ok(list.every((c) => !c.mine && c.status === 'published'));
  });

  it('shows the author every one of their own comments with the reason', async () => {
    const recipeId = await visibleRecipe();
    const member = await account();
    for (const status of ['pending', 'published', 'rejected', 'removed']) {
      await pool.query("INSERT INTO comments (recipe_id, author_id, body, status, reason) VALUES ($1, $2, $3, $4, 'Motif')", [recipeId, member, status, status]);
    }
    const list = await listComments(pool, { recipeId, viewerId: member });
    assert.deepEqual(list.map((c) => c.status), ['pending', 'published', 'rejected', 'removed']);
    assert.ok(list.every((c) => c.mine && c.reason === 'Motif'));
  });
});

describe('visibleComment', () => {
  it('is null unless published, by a non-banned author, on a visible recipe', async () => {
    const recipeId = await visibleRecipe();
    const member = await trusted();
    const { id } = await add(recipeId, member);
    assert.deepEqual(await visibleComment(pool, id), { id, recipeId });
    const held = await add(recipeId, await account());
    assert.equal(await visibleComment(pool, held.id), null);
    await pool.query('UPDATE accounts SET banned_at = now() WHERE id = $1', [member]);
    assert.equal(await visibleComment(pool, id), null);
    await pool.query('UPDATE accounts SET banned_at = NULL WHERE id = $1', [member]);
    await pool.query('UPDATE recipes SET removed_at = now() WHERE id = $1', [recipeId]);
    assert.equal(await visibleComment(pool, id), null);
  });
});

describe('listMine', () => {
  it('ignores a comment decision when picking the last recipe decision', async () => {
    const authorId = await account();
    const { id } = await publishVersion(pool, { authorId, fields: recipe() });
    await pool.query("INSERT INTO moderation_decisions (recipe_id, version, decision, reason) VALUES ($1, 1, 'accepted', 'Bien')", [id]);
    const { id: commentId } = await add(id, authorId);
    await pool.query("INSERT INTO moderation_decisions (recipe_id, comment_id, decision, reason) VALUES ($1, $2, 'removed', 'Hors sujet')", [id, commentId]);
    assert.equal((await listMine(pool, authorId))[0].lastDecision.decision, 'accepted');
  });
});
