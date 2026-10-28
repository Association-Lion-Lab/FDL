import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { saveDraft, submitVersion } from '../src/contributions.js';
import { migrate } from '../src/db.js';
import { createApp } from '../src/http.js';
import { decide, listQueue } from '../src/moderation.js';
import { getRecipe } from '../src/recipes.js';
import { buildBefore, buildRoutes } from '../src/server.js';
import { openSession } from '../src/sessions.js';
import { createTestDatabase } from './helpers/db.js';
import { recipe } from './helpers/recipes.js';

const config = { origin: 'http://localhost', rpID: 'localhost', secretKey: Buffer.alloc(32, 7), dataDir: '/nonexistent-fdl-data' };
let testDb;
let pool;
let server;
let base;
let author;
let mod;

let n = 0;
async function account(role) {
  const { rows } = await pool.query(
    'INSERT INTO accounts (email, display_name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
    [`m${++n}@example.org`, `Compte ${n}`, 'h', role]
  );
  const id = rows[0].id;
  if (role === 'admin' || role === 'moderator') {
    await pool.query("INSERT INTO passkeys (id, account_id, public_key, counter, name) VALUES ($1, $2, '\\x01', 0, 'k')", [`k${id}`, id]);
  }
  return { id, cookie: `fdl_session=${await openSession(pool, id, { mfaOk: true })}` };
}

beforeEach(async () => {
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
  server = createApp({ routes: buildRoutes(pool, () => {}, config, {}), log: () => {}, before: buildBefore(pool, config) })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  author = await account('member');
  mod = await account('moderator');
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.drop();
});

const get = async (path, who) => {
  const response = await fetch(`${base}${path}`, { redirect: 'manual', headers: { cookie: who.cookie } });
  return { status: response.status, text: await response.text(), response };
};
const postTo = async (path, fields, who) => {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: who.cookie, origin: config.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  return { status: response.status, text: await response.text(), response };
};
const post = (fields, who = mod) => postTo('/moderation/decision', fields, who);

// A pending public version, written by a member who is not yet trusted.
async function pending(overrides = {}) {
  const { id } = await saveDraft(pool, { authorId: author.id, draft: recipe(overrides) });
  const { version } = await submitVersion(pool, { recipeId: id, authorId: author.id, mode: 'public', dataDir: config.dataDir });
  return { id, version };
}
const decision = (kind, { id, version }, reason = 'Parce que.') => ({ moderatorId: mod.id, kind, recipeId: id, version, reason });

describe('moderation access', () => {
  it('refuses members, serves moderators and admins', async () => {
    const { id, version } = await pending();
    const paths = ['/moderation', `/moderation/version?id=${id}&version=${version}`];
    for (const path of paths) assert.equal((await get(path, author)).status, 403, path);
    assert.equal((await post({ kind: 'accept', id, version, motif: 'ok' }, author)).status, 403);
    assert.equal((await get('/moderation', mod)).status, 200);
    assert.equal((await get(paths[1], mod)).status, 200);
    assert.equal((await get('/moderation', await account('admin'))).status, 200);
  });

  it('lists the queue with the item, its flags and the open reports', async () => {
    const { id } = await pending({ title: 'Liste <b>x</b>' });
    await pool.query("INSERT INTO reports (recipe_id, reporter_id, category, detail) VALUES ($1, $2, 'spam', '<i>pub</i>')", [id, author.id]);
    const queue = await listQueue(pool);
    assert.equal(queue.pending.length, 1);
    assert.equal(queue.reports.length, 1);
    const page = (await get('/moderation', mod)).text;
    assert.ok(page.includes('Liste &lt;b&gt;x&lt;/b&gt;'));
    assert.ok(page.includes('&lt;i&gt;pub&lt;/i&gt;'));
    assert.ok(!page.includes('<i>pub</i>'));
  });
});

describe('decisions', () => {
  it('accepts a version: public, shown to its author with the reason, logged', async () => {
    const target = await pending();
    const sent = await post({ kind: 'accept', id: target.id, version: target.version, motif: 'Bravo' });
    assert.equal(sent.status, 303);
    assert.equal(sent.response.headers.get('location'), '/moderation');
    assert.equal((await getRecipe(pool, target.id)).version, target.version);
    const list = (await get('/mes-recettes', author)).text;
    assert.ok(list.includes('Publiée'));
    assert.ok(list.includes('Bravo'));
    const { rows } = await pool.query('SELECT * FROM admin_log');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'recipe_accepted');
    assert.equal(String(rows[0].actor_id), String(mod.id));
    assert.deepEqual(rows[0].detail, { recipeId: target.id, version: target.version, reason: 'Bravo' });
  });

  it('refuses without a reason, then rejects with an escaped one', async () => {
    const target = await pending();
    for (const motif of ['', '   ', 'x'.repeat(501)]) {
      assert.equal((await post({ kind: 'reject', id: target.id, version: target.version, motif })).status, 400);
    }
    const status = () => pool.query('SELECT status FROM recipe_versions WHERE recipe_id = $1', [target.id]).then((r) => r.rows[0].status);
    assert.equal(await status(), 'pending');
    assert.equal((await pool.query('SELECT 1 FROM admin_log')).rowCount, 0);
    assert.equal((await post({ kind: 'reject', id: target.id, version: target.version, motif: '<b>non</b>' })).status, 303);
    assert.equal(await status(), 'rejected');
    const list = (await get('/mes-recettes', author)).text;
    assert.ok(list.includes('&lt;b&gt;non&lt;/b&gt;'));
    assert.ok(!list.includes('<b>non</b>'));
  });

  it('removes a reported published recipe and closes its reports', async () => {
    const target = await pending();
    await decide(pool, decision('accept', target));
    const { rows: [{ id: reportId }] } = await pool.query(
      "INSERT INTO reports (recipe_id, reporter_id, category) VALUES ($1, $2, 'illegal') RETURNING id", [target.id, mod.id]);
    const sent = await post({ kind: 'remove', id: target.id, motif: 'Contenu illicite' });
    assert.equal(sent.status, 303);
    assert.equal(await getRecipe(pool, target.id), null);
    assert.equal((await get(`/recette?id=${target.id}`, author)).status, 404);
    assert.equal((await get(`/recette?id=${target.id}`, mod)).status, 404);
    const { rows: [report] } = await pool.query('SELECT closed_at, decision_id FROM reports WHERE id = $1', [reportId]);
    assert.ok(report.closed_at && report.decision_id);
    const list = (await get('/mes-recettes', author)).text;
    assert.ok(list.includes('Retirée'));
    assert.ok(list.includes('Contenu illicite'));
    assert.equal((await get(`/moderation/version?id=${target.id}&version=${target.version}`, mod)).status, 200);
    assert.deepEqual(await decide(pool, decision('remove', target)), { error: 'already_done' });
  });

  it('dismisses a report and keeps the recipe', async () => {
    const target = await pending();
    await decide(pool, decision('accept', target));
    const { rows: [{ id: reportId }] } = await pool.query(
      "INSERT INTO reports (recipe_id, reporter_id, category) VALUES ($1, $2, 'spam') RETURNING id", [target.id, mod.id]);
    const args = { moderatorId: mod.id, kind: 'dismiss', recipeId: target.id, reportId, reason: 'Rien à signaler' };
    assert.deepEqual(await decide(pool, args), { ok: true });
    assert.ok(await getRecipe(pool, target.id));
    assert.deepEqual(await decide(pool, args), { error: 'already_done' });
    assert.equal((await pool.query("SELECT 1 FROM admin_log WHERE action = 'report_dismissed'")).rowCount, 1);
  });

  it('answers 409 for a version already handled and 404 for an unknown one', async () => {
    const target = await pending();
    await post({ kind: 'accept', id: target.id, version: target.version, motif: 'ok' });
    const again = await post({ kind: 'reject', id: target.id, version: target.version, motif: 'ok' });
    assert.equal(again.status, 409);
    assert.ok(again.text.includes('Déjà traitée'));
    assert.deepEqual(await decide(pool, decision('accept', { id: target.id, version: 99 })), { error: 'not_found' });
    assert.deepEqual(await decide(pool, decision('accept', { id: 999999, version: 1 })), { error: 'not_found' });
    assert.deepEqual(await decide(pool, decision('accept', target, '')), { error: 'bad_reason' });
  });

  it('lets only the first of two concurrent decisions win', async () => {
    const target = await pending();
    const results = await Promise.all([decide(pool, decision('accept', target)), decide(pool, decision('reject', target))]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => r.error === 'already_done').length, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM moderation_decisions WHERE reason = 'Parce que.'")).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM admin_log')).rows[0].n, 1);
  });

  it('stops the author from editing or resubmitting a removed recipe', async () => {
    const target = await pending();
    await decide(pool, decision('accept', target));
    await decide(pool, { moderatorId: mod.id, kind: 'remove', recipeId: target.id, reason: 'Non' });
    for (const action of ['brouillon', 'publier']) {
      const sent = await postTo('/mes-recettes/edition', { id: String(target.id), title: 'Autre', action, atteste_texte: '1' }, author);
      assert.equal(sent.status, 404, action);
    }
    assert.equal((await get(`/mes-recettes/edition?id=${target.id}`, author)).status, 404);
  });
});

describe('reports', () => {
  const reporter = () => account('member');
  async function published() {
    const target = await pending();
    await decide(pool, decision('accept', target));
    return target.id;
  }
  const openReports = async (id) => (await pool.query('SELECT * FROM reports WHERE recipe_id = $1 AND closed_at IS NULL', [id])).rows;

  it('shows the form, records a report and queues it for moderators', async () => {
    const id = await published();
    const who = await reporter();
    assert.ok((await get(`/recette?id=${id}`, who)).text.includes(`/recette/signaler?id=${id}`));
    const form = await get(`/recette/signaler?id=${id}`, who);
    assert.equal(form.status, 200);
    for (const c of ['illegal', 'copyright', 'off_topic', 'spam', 'other']) assert.ok(form.text.includes(`value="${c}"`), c);
    const sent = await postTo('/recette/signaler', { id: String(id), category: 'spam', detail: '<b>pub</b>' }, who);
    assert.equal(sent.status, 200);
    assert.ok(sent.text.includes('Merci, votre signalement sera examiné.'));
    const rows = await openReports(id);
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0].reporter_id), String(who.id));
    assert.ok((await get('/moderation', mod)).text.includes('&lt;b&gt;pub&lt;/b&gt;'));
  });

  it('answers a duplicate open report the same way without a second row', async () => {
    const id = await published();
    const who = await reporter();
    await postTo('/recette/signaler', { id: String(id), category: 'spam' }, who);
    const again = await postTo('/recette/signaler', { id: String(id), category: 'other', detail: 'encore' }, who);
    assert.equal(again.status, 200);
    assert.ok(again.text.includes('Merci, votre signalement sera examiné.'));
    assert.equal((await openReports(id)).length, 1);
  });

  it('refuses an unknown category or a 1 001 character detail', async () => {
    const id = await published();
    const who = await reporter();
    assert.equal((await postTo('/recette/signaler', { id: String(id), category: 'nope' }, who)).status, 400);
    assert.equal((await postTo('/recette/signaler', { id: String(id), category: 'spam', detail: 'x'.repeat(1001) }, who)).status, 400);
    assert.equal((await postTo('/recette/signaler', { id: String(id), category: 'spam', detail: 'x'.repeat(1000) }, who)).status, 200);
    assert.equal((await openReports(id)).length, 1);
  });

  it('answers 404 and writes nothing for an unknown or invisible recipe', async () => {
    const hidden = await pending();
    const who = await reporter();
    for (const id of [String(hidden.id), '999999', 'abc', '99999999999999999999']) {
      assert.equal((await postTo('/recette/signaler', { id, category: 'spam' }, who)).status, 404, id);
      assert.equal((await get(`/recette/signaler?id=${id}`, who)).status, 404, id);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM reports')).rows[0].n, 0);
  });

  it('lets 10 reports through per quarter hour and refuses the 11th', async () => {
    const who = await reporter();
    const ids = [];
    for (let i = 0; i < 11; i++) ids.push(await published());
    for (const id of ids.slice(0, 10)) assert.equal((await postTo('/recette/signaler', { id: String(id), category: 'spam' }, who)).status, 200);
    assert.equal((await postTo('/recette/signaler', { id: String(ids[10]), category: 'spam' }, who)).status, 429);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM reports')).rows[0].n, 10);
  });
});
