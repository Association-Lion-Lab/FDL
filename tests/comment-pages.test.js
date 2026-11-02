import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { COMMENT_INVALID } from '../src/comments.js';
import { saveDraft, submitVersion } from '../src/contributions.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
import { publishVersion } from '../src/recipes.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { openSession } from '../src/sessions.js';
import { createTestDatabase } from './helpers/db.js';
import { recipe } from './helpers/recipes.js';

const config = { origin: 'http://localhost', rpID: 'localhost', secretKey: Buffer.alloc(32, 7), dataDir: '' };
let testDb;
let pool;
let server;
let base;
let me;
let other;
let recipeId;

let n = 0;
async function member(name = 'Membre') {
  const { rows } = await pool.query(
    "INSERT INTO accounts (email, display_name, password_hash, role) VALUES ($1, $2, 'h', 'member') RETURNING id",
    [`c${++n}@example.org`, name]
  );
  return { id: Number(rows[0].id), cookie: `fdl_session=${await openSession(pool, rows[0].id, { mfaOk: true })}` };
}

beforeEach(async () => {
  config.dataDir = await mkdtemp(join(tmpdir(), 'fdl-cpages-'));
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
  server = createApp({ routes: buildRoutes(pool, () => {}, config, {}), log: () => {}, before: buildBefore(pool, config) })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  me = await member('Moi');
  other = await member('Autre');
  const author = await member('Cuisinier');
  recipeId = (await publishVersion(pool, { authorId: author.id, fields: recipe() })).id;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.drop();
  await rm(config.dataDir, { recursive: true, force: true });
});

const get = async (path, who = me) => {
  const response = await fetch(`${base}${path}`, { redirect: 'manual', headers: { cookie: who.cookie } });
  return { status: response.status, text: await response.text(), response };
};
const post = async (path, fields, who = me) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: who.cookie, origin: config.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  return { status: response.status, text: await response.text(), response };
};
const comment = (texte, who = me, id = recipeId) => post('/recette/commentaire', { id, texte }, who);
// Insert directly, bypassing moderation: status defaults to published.
async function seed(authorId, body = 'Très bon', status = 'published', rid = recipeId) {
  const { rows } = await pool.query('INSERT INTO comments (recipe_id, author_id, body, status) VALUES ($1, $2, $3, $4) RETURNING id', [rid, authorId, body, status]);
  return Number(rows[0].id);
}
// A private recipe of `me`: shown to its author with a status banner, invisible to comments.
async function privateRecipe() {
  const { id } = await saveDraft(pool, { recipeId: null, authorId: me.id, draft: recipe() });
  await submitVersion(pool, { recipeId: id, authorId: me.id, mode: 'private', dataDir: config.dataDir });
  return id;
}
const bodyOf =async (id) => (await pool.query('SELECT body FROM comments WHERE id = $1', [id])).rows[0]?.body;

describe('recipe page', () => {
  it('shows the comment section and form', async () => {
    const { text } = await get(`/recette?id=${recipeId}`);
    assert.match(text, /<h2>Commentaires<\/h2>/);
    assert.match(text, /id="commentaires"/);
    assert.match(text, /action="\/recette\/commentaire"/);
    assert.match(text, /<textarea name="texte"/);
  });

  it('has no comment form on the author banner page', async () => {
    const id = await privateRecipe();
    const { text } = await get(`/recette?id=${id}`);
    assert.match(text, /État :/);
    assert.doesNotMatch(text, /action="\/recette\/commentaire"/);
  });
});

describe('published recipe with a pending revision', () => {
  it('keeps the comment section, comments and form for its author', async () => {
    const id = (await publishVersion(pool, { authorId: me.id, fields: recipe({ title: 'Ma soupe' }) })).id;
    await saveDraft(pool, { recipeId: id, authorId: me.id, draft: recipe({ title: 'Ma soupe v2' }) });
    await submitVersion(pool, { recipeId: id, authorId: me.id, mode: 'public', dataDir: config.dataDir });
    await seed(other.id, 'Joli plat', 'published', id);
    const { text } = await get(`/recette?id=${id}`);
    assert.match(text, /Publiée, nouvelle version en attente/);
    assert.match(text, /<h2>Commentaires<\/h2>/);
    assert.match(text, /Joli plat/);
    assert.match(text, /action="\/recette\/commentaire"/);
  });
});

describe('POST /recette/commentaire', () => {
  it('404s on an empty text sent to a private recipe, not 400', async () => {
    assert.equal((await comment('', me, await privateRecipe())).status, 404);
  });

  it('redirects and shows a new account comment as pending to its author only', async () => {
    const { status, response } = await comment('Bonjour tout le monde');
    assert.equal(status, 303);
    assert.equal(response.headers.get('location'), `/recette?id=${recipeId}#commentaires`);
    const mine = await get(`/recette?id=${recipeId}`);
    assert.match(mine.text, /Bonjour tout le monde/);
    assert.match(mine.text, /En attente de modération/);
    assert.doesNotMatch((await get(`/recette?id=${recipeId}`, other)).text, /Bonjour tout le monde/);
  });

  it('escapes the body and never links it', async () => {
    await seed(other.id, '<script>alert(1)</script> https://x.fr');
    const { text } = await get(`/recette?id=${recipeId}`);
    assert.match(text, /&lt;script&gt;/);
    assert.doesNotMatch(text, /<script>alert/);
    assert.doesNotMatch(text, /<a href="https:\/\/x\.fr/);
  });

  it('refuses an empty text with 400 and the message', async () => {
    const { status, text } = await comment('   ');
    assert.equal(status, 400);
    assert.ok(text.includes(COMMENT_INVALID));
  });

  it('keeps the typed text on a refusal', async () => {
    const { status, text } = await comment('x'.repeat(1001));
    assert.equal(status, 400);
    assert.ok(text.includes('x'.repeat(1001)));
  });

  it('404s on an unknown recipe or a private one', async () => {
    assert.equal((await comment('Salut', me, 999999)).status, 404);
    assert.equal((await comment('Salut', me, 'abc')).status, 404);
    assert.equal((await comment('Salut', me, await privateRecipe())).status, 404);
  });

  it('returns 429 on the 11th write in the window', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await comment(`Message ${i}`)).status, 303);
    assert.equal((await comment('Trop')).status, 429);
  });

  it('hides the comments of a banned author', async () => {
    await seed(other.id, 'Message du banni');
    assert.match((await get(`/recette?id=${recipeId}`)).text, /Message du banni/);
    await pool.query('UPDATE accounts SET banned_at = now() WHERE id = $1', [other.id]);
    assert.doesNotMatch((await get(`/recette?id=${recipeId}`)).text, /Message du banni/);
  });
});

describe('comment display', () => {
  it('shows author, date, edit mark and report link on a foreign comment', async () => {
    const id = await seed(other.id);
    await pool.query("UPDATE comments SET edited_at = now() WHERE id = $1", [id]);
    const { text } = await get(`/recette?id=${recipeId}`);
    assert.match(text, /Autre/);
    assert.match(text, new RegExp(String(new Date().getFullYear())));
    assert.match(text, /\(modifié\)/);
    assert.ok(text.includes(`/recette/signaler?id=${recipeId}&amp;commentaire=${id}`) || text.includes(`/recette/signaler?id=${recipeId}&commentaire=${id}`));
  });

  it('gives the author edit and delete, no report link', async () => {
    const id = await seed(me.id);
    const { text } = await get(`/recette?id=${recipeId}`);
    assert.ok(text.includes(`/recette/commentaire/modifier?id=${id}`));
    assert.match(text, /action="\/recette\/commentaire\/supprimer"/);
    assert.doesNotMatch(text, /commentaire=\d/);
  });

  it('shows a refusal reason to the author', async () => {
    const id = await seed(me.id, 'Hmm', 'rejected');
    await pool.query("UPDATE comments SET reason = 'Hors sujet' WHERE id = $1", [id]);
    const { text } = await get(`/recette?id=${recipeId}`);
    assert.match(text, /Refusé\. Motif : Hors sujet/);
  });
});

describe('edit and delete', () => {
  it('shows a prefilled form to the author, 404 otherwise', async () => {
    const id = await seed(me.id, 'Original');
    const { status, text } = await get(`/recette/commentaire/modifier?id=${id}`);
    assert.equal(status, 200);
    assert.match(text, /<textarea name="texte"[^>]*>Original<\/textarea>/);
    assert.equal((await get(`/recette/commentaire/modifier?id=${id}`, other)).status, 404);
    assert.equal((await get('/recette/commentaire/modifier?id=abc')).status, 404);
    const removed = await seed(me.id, 'Parti', 'removed');
    assert.equal((await get(`/recette/commentaire/modifier?id=${removed}`)).status, 404);
    await pool.query('UPDATE recipes SET removed_at = now() WHERE id = $1', [recipeId]);
    assert.equal((await get(`/recette/commentaire/modifier?id=${id}`)).status, 404);
  });

  it('updates for the author and 404s for another account', async () => {
    const id = await seed(me.id, 'Original');
    const { status, response } = await post('/recette/commentaire/modifier', { id, texte: 'Corrigé' });
    assert.equal(status, 303);
    assert.equal(response.headers.get('location'), `/recette?id=${recipeId}#commentaires`);
    assert.equal(await bodyOf(id), 'Corrigé');
    assert.equal((await post('/recette/commentaire/modifier', { id, texte: 'Pirate' }, other)).status, 404);
    assert.equal(await bodyOf(id), 'Corrigé');
  });

  it('returns the edit form with the message on an invalid text', async () => {
    const id = await seed(me.id, 'Original');
    const { status, text } = await post('/recette/commentaire/modifier', { id, texte: '' });
    assert.equal(status, 400);
    assert.ok(text.includes(COMMENT_INVALID));
    assert.equal(await bodyOf(id), 'Original');
  });

  it('deletes for the author and 404s for another account', async () => {
    const id = await seed(me.id);
    assert.equal((await post('/recette/commentaire/supprimer', { id }, other)).status, 404);
    assert.equal(await bodyOf(id), 'Très bon');
    assert.equal((await post('/recette/commentaire/supprimer', { id })).status, 303);
    assert.equal(await bodyOf(id), undefined);
  });
});

describe('reporting a comment', () => {
  const reports = async () => (await pool.query('SELECT comment_id FROM reports ORDER BY id')).rows.map((r) => (r.comment_id === null ? null : Number(r.comment_id)));
  const report = (id, commentaire, who = me) => post('/recette/signaler', { id, commentaire, category: 'spam', detail: '' }, who);

  it('shows the form with the hidden field and stores comment_id', async () => {
    const id = await seed(other.id);
    const form = await get(`/recette/signaler?id=${recipeId}&commentaire=${id}`);
    assert.equal(form.status, 200);
    assert.match(form.text, /name="commentaire" value="\d+"/);
    assert.equal((await report(recipeId, id)).status, 200);
    assert.deepEqual(await reports(), [id]);
  });

  it('404s for pending, banned-author or other-recipe comments', async () => {
    const pending = await seed(other.id, 'x', 'pending');
    assert.equal((await get(`/recette/signaler?id=${recipeId}&commentaire=${pending}`)).status, 404);
    const banned = await member('Banni');
    const bannedId = await seed(banned.id);
    await pool.query('UPDATE accounts SET banned_at = now() WHERE id = $1', [banned.id]);
    assert.equal((await report(recipeId, bannedId)).status, 404);
    const otherRecipe = (await publishVersion(pool, { authorId: other.id, fields: recipe({ title: 'Autre' }) })).id;
    const ok = await seed(other.id);
    assert.equal((await report(otherRecipe, ok)).status, 404);
    assert.equal((await reports()).length, 0);
  });

  it('dedupes an open comment report and keeps recipe and comment reports apart', async () => {
    const id = await seed(other.id);
    const first = await report(recipeId, id);
    const second = await report(recipeId, id);
    assert.equal(second.status, 200);
    assert.equal(second.text, first.text);
    assert.equal((await reports()).length, 1);
    assert.equal((await report(recipeId, '')).status, 200);
    assert.equal((await reports()).length, 2);
  });
});
