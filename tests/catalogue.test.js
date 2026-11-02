import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveDraft, submitVersion } from '../src/contributions.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
import { photoPath } from '../src/photos.js';
import { publishVersion } from '../src/recipes.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { openSession } from '../src/sessions.js';
import { createTestDatabase } from './helpers/db.js';
import { recipe } from './helpers/recipes.js';

const config = { origin: 'http://localhost', rpID: 'localhost', secretKey: Buffer.alloc(32, 7) };
let testDb;
let pool;
let server;
let base;
let cookie;

let n = 0;
async function account(name = `Membre ${++n}`) {
  const { rows } = await pool.query(
    "INSERT INTO accounts (email, display_name, password_hash, role) VALUES ($1, $2, 'h', 'member') RETURNING id",
    [`c${++n}@example.org`, name]
  );
  return rows[0].id;
}

beforeEach(async () => {
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
  server = createApp({ routes: buildRoutes(pool, () => {}, config, {}), log: () => {}, before: buildBefore(pool, config) })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = `fdl_session=${await openSession(pool, await account(), { mfaOk: true })}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.drop();
});

const get = (path, withCookie = cookie) => fetch(`${base}${path}`, { redirect: 'manual', headers: withCookie ? { cookie: withCookie } : {} });
const page = async (path) => {
  const response = await get(path);
  return { status: response.status, text: await response.text() };
};
const publish = (fields = {}, authorId = null) => publishVersion(pool, { authorId, fields: recipe(fields) });

describe('catalogue pages', () => {
  it('send visitors without a session to sign-in', async () => {
    for (const path of ['/', '/recherche', '/recette?id=1']) {
      const response = await get(path, null);
      assert.equal(response.status, 303, path);
      assert.equal(response.headers.get('location'), '/connexion', path);
    }
  });

  it('show an empty showcase, then published titles and the search field', async () => {
    const empty = await page('/');
    assert.equal(empty.status, 200);
    assert.ok(empty.text.includes("Aucune recette publiée pour l'instant."));
    assert.ok(empty.text.includes('name="q"'));
    await publish({ title: 'Tarte aux pommes', minutes: 20, diet: 'vegetarian' });
    const full = await page('/');
    assert.ok(full.text.includes('Tarte aux pommes'));
    assert.ok(full.text.includes('Récemment ajoutées'));
    assert.ok(full.text.includes('Rapides'));
    assert.ok(!full.text.includes("Aucune recette publiée pour l'instant."));
  });

  it('escape recipe text and author names', async () => {
    const authorId = await account('<img src=x>');
    const { id } = await publish({
      title: '<script>alert(1)</script>',
      ingredients: [{ name: '<b>sel</b>', amount: 1, unit: 'g', preparation: 'unknown' }],
      steps: [{ kind: 'prep', instruction: '<i>mélanger</i>', minutes: null }],
    }, authorId);
    for (const path of [`/recette?id=${id}`, '/recherche', '/']) {
      const { text } = await page(path);
      assert.ok(text.includes('&lt;script&gt;'), path);
      assert.ok(!text.includes('<script>alert'), path);
      assert.ok(text.includes('&lt;img'), path);
      assert.ok(!text.includes('<img src=x>'), path);
    }
    const { text } = await page(`/recette?id=${id}`);
    assert.ok(text.includes('&lt;b&gt;sel&lt;/b&gt;'));
    assert.ok(text.includes('&lt;i&gt;mélanger&lt;/i&gt;'));
  });

  it('answer 404 for bad, unknown, private and banned recipes', async () => {
    const hidden = await publish();
    await pool.query("UPDATE recipes SET visibility = 'private' WHERE id = $1", [hidden.id]);
    const bannedId = await account();
    const banned = await publish({}, bannedId);
    await pool.query('UPDATE accounts SET banned_at = now() WHERE id = $1', [bannedId]);
    for (const id of ['abc', '99999999999999999999', '12345', '', '1.5', String(hidden.id), String(banned.id)]) {
      const { status, text } = await page(`/recette?id=${id}`);
      assert.equal(status, 404, id);
      assert.ok(text.includes('Recette introuvable'), id);
    }
    assert.equal((await page('/recette')).status, 404);
  });

  it('show a full recipe page with licence and version', async () => {
    const authorId = await account();
    const { id } = await publish({
      title: 'Gratin',
      servings: 6,
      seasons: ['winter'],
      ingredients: [{ name: 'pommes de terre', amount: 1, unit: 'kg', preparation: 'raw' }],
      sourceUrl: 'https://example.org/gratin',
    }, authorId);
    await pool.query('DELETE FROM accounts WHERE id = $1', [authorId]);
    const { status, text } = await page(`/recette?id=${id}`);
    assert.equal(status, 200);
    for (const expected of ['Gratin', 'Auteur anonyme', 'Version 1', 'Texte sous licence CC BY-SA 4.0',
      'https://creativecommons.org/licenses/by-sa/4.0/deed.fr', 'Hiver', '1 kg pommes de terre', 'cru', '6',
      'https://example.org/gratin', 'Recette de famille', 'id="print"', '/static/fdl-print.js']) {
      assert.ok(text.includes(expected), expected);
    }
    const script = await get('/static/fdl-print.js');
    assert.equal(script.status, 200);
    assert.ok((await script.text()).includes('print'));
  });

  it('answer 400 for a tampered page link', async () => {
    const { status, text } = await page('/recherche?apres=zzz');
    assert.equal(status, 400);
    assert.ok(text.includes('Lien de page invalide'));
    const dated = Buffer.from(JSON.stringify({ t: '2026-02-30', i: 1 })).toString('base64url');
    assert.equal((await page(`/recherche?apres=${dated}`)).status, 400);
  });

  it('ignore NUL bytes in filters', async () => {
    await publish({ title: 'Soupe' });
    for (const query of ['q=%00', 'univers=%00', 'q=so%00upe', 'saison=winter%00']) {
      assert.equal((await page(`/recherche?${query}`)).status, 200, query);
    }
  });

  it('apply known filters and ignore unknown values', async () => {
    await publish({ title: 'Végé', diet: 'vegetarian' });
    await publish({ title: 'Poisson', diet: 'pescetarian' });
    const { status, text } = await page('/recherche?regime=vegetarian&duree=abc&saison=lundi');
    assert.equal(status, 200);
    assert.ok(text.includes('Végé'));
    assert.ok(!text.includes('Poisson'));
    assert.ok((await page('/recherche?q=introuvable')).text.includes('Aucune recette ne correspond.'));
  });

  it('page through results with "Page suivante"', async () => {
    for (let i = 0; i < 25; i++) await publish({ title: `Recette numéro ${String(i).padStart(2, '0')}` });
    const first = await page('/recherche?regime=vegan');
    assert.equal(first.text.match(/Recette numéro/g).length, 20);
    const link = first.text.match(/href="(\/recherche\?[^"]*apres=[^"]*)"[^>]*>Page suivante/);
    assert.ok(link, 'next link');
    const href = link[1].replaceAll('&amp;', '&');
    assert.ok(href.includes('regime=vegan'));
    const second = await page(href);
    assert.equal(second.text.match(/Recette numéro/g).length, 5);
    assert.ok(!second.text.includes('Page suivante'));
  });
});

describe('recipe photos', () => {
  const FILE = 'a'.repeat(64);
  const bytes = Buffer.from('not really a jpeg');
  const as = async (id, role = 'member') => {
    if (role !== 'member') {
      await pool.query('UPDATE accounts SET role = $2 WHERE id = $1', [id, role]);
      await pool.query("INSERT INTO passkeys (id, account_id, public_key, counter, name) VALUES ($1, $2, '\\x01', 0, 'k')", [`k${id}`, id]);
    }
    return `fdl_session=${await openSession(pool, id, { mfaOk: true })}`;
  };
  const photo = { file: FILE, credit: 'Léa' };
  const photoGet = async (file, who = cookie) => {
    const response = await get(`/photo?f=${file}`, who);
    return { response, status: response.status, body: Buffer.from(await response.arrayBuffer()) };
  };
  // A recipe of `author`, saved as draft and optionally submitted; returns its id.
  const own = async (author, { mode, photoFields = photo } = {}) => {
    const { id } = await saveDraft(pool, { authorId: author, draft: recipe({ photo: photoFields }) });
    if (mode) await submitVersion(pool, { recipeId: id, authorId: author, mode, dataDir: config.dataDir });
    return id;
  };

  beforeEach(async () => {
    config.dataDir = await mkdtemp(join(tmpdir(), 'fdl-cat-'));
    await mkdir(join(config.dataDir, 'photos'));
    await writeFile(photoPath(config.dataDir, FILE), bytes);
  });
  afterEach(() => rm(config.dataDir, { recursive: true, force: true }));

  it('shows the photo and its escaped credit on a public recipe, and serves it to members', async () => {
    const { id } = await publish({ photo: { file: FILE, credit: '<b>x</b>' } });
    const shown = await page(`/recette?id=${id}`);
    assert.ok(shown.text.includes(`<img src="/photo?f=${FILE}"`));
    assert.ok(shown.text.includes('Photo : &lt;b&gt;x&lt;/b&gt;'));
    assert.ok(!shown.text.includes('<b>x</b>'));
    const sent = await photoGet(FILE);
    assert.equal(sent.status, 200);
    assert.equal(sent.response.headers.get('content-type'), 'image/jpeg');
    assert.equal(sent.response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(sent.response.headers.get('cache-control'), 'private, max-age=86400');
    assert.deepEqual(sent.body, bytes);
  });

  it('shows no figure without a photo', async () => {
    const { id } = await publish();
    assert.ok(!(await page(`/recette?id=${id}`)).text.includes('<figure>'));
  });

  it('requires a session', async () => {
    await publish({ photo });
    assert.equal((await get(`/photo?f=${FILE}`, null)).status, 303);
  });

  it('hides a photo cited only by a draft, private, pending, removed or banned recipe, from other members', async () => {
    const author = await account();
    await own(author);
    assert.equal((await photoGet(FILE)).status, 404, 'draft');
    const priv = await own(author, { mode: 'private' });
    assert.equal((await photoGet(FILE)).status, 404, 'private');
    await pool.query('DELETE FROM recipes WHERE id = $1', [priv]);
    await own(author, { mode: 'public' });
    assert.equal((await photoGet(FILE)).status, 404, 'pending');
    await pool.query('DELETE FROM recipes');
    const { id } = await publish({ photo }, author);
    assert.equal((await photoGet(FILE)).status, 200);
    await pool.query('UPDATE recipes SET removed_at = now() WHERE id = $1', [id]);
    assert.equal((await photoGet(FILE)).status, 404, 'removed');
    await pool.query('UPDATE recipes SET removed_at = NULL WHERE id = $1', [id]);
    await pool.query('UPDATE accounts SET banned_at = now() WHERE id = $1', [author]);
    assert.equal((await photoGet(FILE)).status, 404, 'banned');
  });

  it('serves the author their draft, private and pending photos, and a moderator the pending one', async () => {
    const author = await account();
    const mine = await as(author);
    await own(author);
    assert.equal((await photoGet(FILE, mine)).status, 200, 'draft');
    await pool.query('DELETE FROM recipes');
    await own(author, { mode: 'private' });
    assert.equal((await photoGet(FILE, mine)).status, 200, 'private');
    await pool.query('DELETE FROM recipes');
    await own(author, { mode: 'public' });
    assert.equal((await photoGet(FILE, mine)).status, 200, 'pending');
    assert.equal((await photoGet(FILE, await as(await account(), 'moderator'))).status, 200, 'moderator');
    assert.equal((await photoGet(FILE)).status, 404, 'other member');
  });

  it('answers 404 for malformed names, a missing file and a cited file gone from disk', async () => {
    await publish({ photo });
    for (const f of ['../../etc/passwd', '', FILE.toUpperCase(), 'a'.repeat(63)]) {
      assert.equal((await photoGet(encodeURIComponent(f))).status, 404, f);
    }
    assert.equal((await get('/photo', cookie)).status, 404);
    await rm(photoPath(config.dataDir, FILE));
    assert.equal((await photoGet(FILE)).status, 404);
  });

  it('serves the form script', async () => {
    const response = await get('/static/fdl-photo.js');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/javascript/);
  });
});

describe('ratings', () => {
  const memberCookie = async () => `fdl_session=${await openSession(pool, await account(), { mfaOk: true })}`;
  const rate = async (fields, who = cookie) => {
    const response = await fetch(`${base}/recette/note`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: who, origin: config.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
    return { status: response.status, location: response.headers.get('location'), text: await response.text() };
  };
  const rows = async () => (await pool.query('SELECT * FROM ratings ORDER BY account_id')).rows;

  it('refuse the author, hidden recipes and bad values, and write nothing', async () => {
    const authorId = await account();
    const author = `fdl_session=${await openSession(pool, authorId, { mfaOk: true })}`;
    const { id } = await publish({}, authorId);
    const own = await rate({ id: String(id), etoiles: '5' }, author);
    assert.equal(own.status, 403);
    assert.ok(own.text.includes('Vous ne pouvez pas noter votre propre recette.'));
    await pool.query("UPDATE recipes SET visibility = 'private' WHERE id = $1", [id]);
    assert.equal((await rate({ id: String(id), etoiles: '5' })).status, 404);
    await pool.query("UPDATE recipes SET visibility = 'public' WHERE id = $1", [id]);
    for (const bad of ['6', '0', '3.5', '1e0', ' 3', '-1', '', 'abc', '3\0']) {
      assert.equal((await rate({ id: String(id), etoiles: bad })).status, 400, JSON.stringify(bad));
    }
    for (const bad of ['', 'x', '99999999999999999999', '0']) {
      assert.equal((await rate({ id: bad, etoiles: '3' })).status, 404, bad);
    }
    assert.deepEqual(await rows(), []);
  });

  it('replace a second note of the same member and show the average', async () => {
    const { id } = await publish({});
    const first = await rate({ id: String(id), etoiles: '1' });
    assert.equal(first.status, 303);
    assert.equal(first.location, `/recette?id=${id}`);
    await rate({ id: String(id), etoiles: '5' });
    assert.deepEqual((await rows()).map((r) => r.stars), [5]);
    assert.ok((await page(`/recette?id=${id}`)).text.includes('<option value="5" selected>'));
    assert.ok((await page(`/recette?id=${id}`)).text.includes('5 / 5 (1 note)'));
    await rate({ id: String(id), etoiles: '4' }, await memberCookie());
    await rate({ id: String(id), etoiles: '4' }, await memberCookie());
    const shown = await page(`/recette?id=${id}`);
    assert.ok(shown.text.includes('4,3 / 5 (3 notes)'));
    assert.ok((await page('/recherche')).text.includes('4,3 / 5 (3 notes)'));
  });

  it('show "Pas encore de note", and the best rated row from 3 notes', async () => {
    const authorId = await account();
    const { id } = await publish({ title: 'Étoilée' }, authorId);
    const author = `fdl_session=${await openSession(pool, authorId, { mfaOk: true })}`;
    const unrated = await page(`/recette?id=${id}`);
    assert.ok(unrated.text.includes('Pas encore de note'));
    assert.ok(!(await page('/')).text.includes('Les mieux notées'));
    for (let i = 0; i < 3; i++) await rate({ id: String(id), etoiles: '5' }, await memberCookie());
    const home = (await page('/')).text;
    assert.ok(home.indexOf('Les mieux notées') > home.indexOf('Récemment ajoutées'));
    assert.ok(home.indexOf('Les mieux notées') < home.indexOf('Rapides'));
    assert.ok(!(await get(`/recette?id=${id}`, author).then((r) => r.text())).includes('action="/recette/note"'));
  });
});
