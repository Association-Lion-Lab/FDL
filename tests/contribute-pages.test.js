import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { saveDraft, submitVersion } from '../src/contributions.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
import { stripJpeg } from '../src/photos.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { openSession } from '../src/sessions.js';
import { createTestDatabase } from './helpers/db.js';
import { jpeg } from './helpers/photos.js';
import { recipe } from './helpers/recipes.js';

const config = { origin: 'http://localhost', rpID: 'localhost', secretKey: Buffer.alloc(32, 7), dataDir: '' };
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
  config.dataDir = await mkdtemp(join(tmpdir(), 'fdl-pages-'));
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
  await rm(config.dataDir, { recursive: true, force: true });
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
// Multipart send; `files` maps a field name to a Buffer.
const postForm = async (fields, files = {}, who = me, type = 'image/jpeg') => {
  const body = new FormData();
  for (const [key, value] of fields) body.append(key, value);
  for (const [key, buffer] of Object.entries(files)) body.append(key, new Blob([buffer], { type }), 'photo.jpg');
  const response = await fetch(`${base}/mes-recettes/edition`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: who.cookie, origin: config.origin },
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
    assert.match(sent.text, /Recette introuvable/);
    const edit = await get(`/mes-recettes/edition?id=${id}`);
    assert.equal(edit.status, 404);
    assert.match(edit.text, /Recette introuvable/);
    const { rows } = await pool.query('SELECT draft FROM recipes WHERE id = $1', [id]);
    assert.equal(rows[0].draft.title, 'Secret');
  });

  it('answers 404 on a removed recipe and an unknown id', async () => {
    const { id } = await saveDraft(pool, { authorId: me.id, draft: recipe() });
    await pool.query('UPDATE recipes SET removed_at = now() WHERE id = $1', [id]);
    for (const res of [
      await get(`/mes-recettes/edition?id=${id}`),
      await post([['id', String(id)], ...full('brouillon')]),
      await get('/mes-recettes/edition?id=999999'),
      await get('/mes-recettes/edition?id=abc'),
    ]) {
      assert.equal(res.status, 404);
      assert.match(res.text, /Recette introuvable/);
    }
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

  it('answers 413 when the draft outgrows its stored size, and writes nothing', async () => {
    const sent = await post([['action', 'brouillon'], ...Array(10000).fill(['ingredient_name', 'a'])]);
    assert.equal(sent.status, 413);
    assert.match(sent.text, /Brouillon trop volumineux/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM recipes')).rows[0].n, 0);
  });

  it('reads 20 000 repeated row fields in linear time', async () => {
    const started = Date.now();
    const sent = await post([['action', 'brouillon'], ...Array(20000).fill(['step_kind', ''])]);
    assert.equal(sent.status, 303);
    assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
  });

  it('reads 20 000 empty multipart lines in linear time', async () => {
    const started = Date.now();
    const sent = await postForm(full('brouillon', {}, Array(20000).fill(['ingredient_name', ''])));
    assert.equal(sent.status, 303);
    assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
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

describe('recipe photo', () => {
  const photos = () => readdir(join(config.dataDir, 'photos')).catch(() => []);
  const draftPhoto = async (id) => (await pool.query('SELECT draft->\'photo\' AS photo FROM recipes WHERE id = $1', [id])).rows[0].photo;
  const upload = (extra = [], file = jpeg(), type = 'image/jpeg') => postForm(full('brouillon', {}, extra), { photo: file }, me, type);
  const firstId = async () => (await pool.query('SELECT id FROM recipes ORDER BY id LIMIT 1')).rows[0].id;
  // A JPEG padded with COM segments up to `size` bytes.
  const padded = (size) => {
    const base = jpeg();
    const parts = [base.subarray(0, 2)];
    let remaining = size - base.length;
    while (remaining > 0) {
      const part = remaining > 65541 ? 65537 : remaining > 65537 ? remaining - 4 : remaining;
      const com = Buffer.alloc(part);
      com.writeUInt16BE(0xfffe, 0);
      com.writeUInt16BE(part - 2, 2);
      parts.push(com);
      remaining -= part;
    }
    parts.push(base.subarray(2));
    return Buffer.concat(parts);
  };

  it('answers a friendly HTML 413 above the body cap', async () => {
    const sent = await postForm(full('brouillon'), { photo: Buffer.alloc(8 * 1024 * 1024 + 300 * 1024) });
    assert.equal(sent.status, 413);
    assert.match(sent.response.headers.get('content-type'), /text\/html/);
    assert.ok(sent.text.includes('Photo trop lourde'));
    assert.equal(await versions(), 0);
  });

  it('shows the photo fields in a multipart form', async () => {
    const form = (await get('/mes-recettes/edition')).text;
    assert.match(form, /<form[^>]*enctype="multipart\/form-data"/);
    for (const name of ['photo', 'photo_credit', 'atteste_photo']) assert.equal(count(form, name), 1, name);
  });

  it('stores a stripped photo, then keeps it and updates the credit without a new file', async () => {
    const sent = await upload([['photo_credit', 'Léa']]);
    assert.equal(sent.status, 303);
    const names = await photos();
    assert.equal(names.length, 1);
    const stored = await readFile(join(config.dataDir, 'photos', names[0]));
    assert.deepEqual(stored, stripJpeg(jpeg()));
    assert.ok(!stored.includes('GPSLatitude'));
    const id = await firstId();
    const file = names[0].slice(0, -4);
    assert.deepEqual(await draftPhoto(id), { file, credit: 'Léa' });
    const again = await postForm([['id', String(id)], ...full('brouillon', {}, [['photo_credit', 'Léa B.']])]);
    assert.equal(again.status, 303);
    assert.deepEqual(await draftPhoto(id), { file, credit: 'Léa B.' });
    const form = await get(`/mes-recettes/edition?id=${id}`);
    assert.ok(form.text.includes(`/photo?f=${file}`));
    assert.ok(form.text.includes('value="Léa B."'));
  });

  it("ignores a photo_file naming another account's photo", async () => {
    await postForm(full('brouillon', {}, [['photo_credit', 'Eve']]), { photo: jpeg() }, other);
    const theirs = (await photos())[0].slice(0, -4);
    await postForm(full('brouillon', {}, [['photo_file', theirs], ['photo_credit', 'X']]));
    const { rows } = await pool.query('SELECT draft->\'photo\' AS photo FROM recipes WHERE author_id = $1', [me.id]);
    assert.equal(rows[0].photo, null);
  });

  it('removes the photo on retirer_photo', async () => {
    await upload([['photo_credit', 'Léa']]);
    const id = await firstId();
    assert.equal((await postForm([['id', String(id)], ...full('brouillon', {}, [['retirer_photo', '1']])])).status, 303);
    assert.equal(await draftPhoto(id), null);
  });

  it("keeps its own photo when photo_file names another account's photo", async () => {
    await upload([['photo_credit', 'Moi']]);
    const id = await firstId();
    const mine = (await draftPhoto(id)).file;
    await postForm(full('brouillon', {}, [['photo_credit', 'Eve']]), { photo: jpeg({ width: 3 }) }, other);
    const theirs = (await photos()).map((n) => n.slice(0, -4)).find((f) => f !== mine);
    await postForm([['id', String(id)], ...full('brouillon', {}, [['photo_file', theirs], ['photo_credit', 'Moi']])]);
    assert.deepEqual(await draftPhoto(id), { file: mine, credit: 'Moi' });
  });

  it('keeps a removed photo removed on the next save, even when a published version has one', async () => {
    const sent = await postForm(full('publier', {}, [['photo_credit', 'Léa'], ['atteste_texte', '1'], ['atteste_photo', '1']]), { photo: jpeg() });
    assert.equal(sent.status, 303);
    const recipeId = await firstId();
    assert.ok((await pool.query('SELECT photo FROM recipe_versions WHERE recipe_id = $1', [recipeId])).rows[0].photo);
    await postForm([['id', String(recipeId)], ...full('brouillon', {}, [['retirer_photo', '1']])]);
    assert.equal(await draftPhoto(recipeId), null);
    await postForm([['id', String(recipeId)], ...full('brouillon', {}, [['photo_credit', 'Léa']])]);
    assert.equal(await draftPhoto(recipeId), null);
  });

  it('refuses a non-JPEG file with 400, keeps the title and stores nothing', async () => {
    const sent = await upload([], Buffer.from('<html></html>'));
    assert.equal(sent.status, 400);
    assert.ok(sent.text.includes('La photo doit être une image JPEG de 8 000 pixels de côté au plus.'));
    assert.deepEqual(await photos(), []);
    assert.equal((await pool.query('SELECT draft->>\'title\' AS t FROM recipes')).rows[0].t, 'Soupe');
  });

  it('refuses a file over 1 MiB with 400, keeps the title and stores nothing', async () => {
    const big = padded(1024 * 1024 + 1);
    assert.equal(big.length, 1024 * 1024 + 1);
    const sent = await upload([], big);
    assert.equal(sent.status, 400);
    assert.ok(sent.text.includes('La photo dépasse 1 Mo.'));
    assert.deepEqual(await photos(), []);
    assert.equal((await pool.query('SELECT draft->>\'title\' AS t FROM recipes')).rows[0].t, 'Soupe');
    assert.equal((await upload([], padded(1024 * 1024))).status, 303);
  });

  it('asks for the photo attestation on publication, then writes the version with the photo', async () => {
    const publish = (extra) => postForm(full('publier', {}, [['photo_credit', 'Léa'], ['atteste_texte', '1'], ...extra]), { photo: jpeg() });
    const refused = await publish([]);
    assert.equal(refused.status, 400);
    assert.ok(refused.text.includes('J&#39;ai pris cette photo ou j&#39;ai le droit de la publier'));
    assert.equal(await versions(), 0);
    const id = await firstId();
    const sent = await postForm([['id', String(id)], ...full('publier', {}, [['photo_credit', 'Léa'], ['atteste_texte', '1'], ['atteste_photo', '1']])]);
    assert.equal(sent.status, 303);
    const { rows } = await pool.query('SELECT photo, photo_credit FROM recipe_versions WHERE recipe_id = $1 AND version = 1', [id]);
    assert.equal(rows[0].photo, (await photos())[0].slice(0, -4));
    assert.equal(rows[0].photo_credit, 'Léa');
  });

  it('refuses publication of a photo without credit', async () => {
    const sent = await postForm(full('publier', {}, [['atteste_texte', '1'], ['atteste_photo', '1']]), { photo: jpeg() });
    assert.equal(sent.status, 400);
    assert.ok(sent.text.includes("Indiquez l&#39;auteur de la photo"));
    assert.equal(await versions(), 0);
  });

  it('limits photo uploads to 10 per quarter hour, and counts only requests with a file', async () => {
    for (let i = 0; i < 12; i++) assert.equal((await postForm(full('brouillon'))).status, 303);
    for (let i = 0; i < 10; i++) assert.equal((await upload([['photo_credit', 'a']])).status, 303, `upload ${i + 1}`);
    assert.equal((await upload([['photo_credit', 'a']])).status, 429);
  });
});
