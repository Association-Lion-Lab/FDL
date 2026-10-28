import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
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
