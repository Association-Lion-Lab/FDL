import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { LATEST_SCHEMA_VERSION, createPool, migrate, readSchemaVersion } from '../src/db.js';
import { createTestDatabase } from './helpers/db.js';

const cleanups = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freshDatabase() {
  const db = await createTestDatabase();
  cleanups.push(db.drop);
  return db;
}

describe('migrate', () => {
  it('migrates a new database and installs unaccent', async () => {
    const { pool } = await freshDatabase();
    assert.equal(await readSchemaVersion(pool), 0);
    assert.deepEqual(await migrate(pool), { from: 0, to: LATEST_SCHEMA_VERSION });
    assert.equal(await readSchemaVersion(pool), LATEST_SCHEMA_VERSION);
    const { rowCount } = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'unaccent'");
    assert.equal(rowCount, 1);
  });

  it('creates the contribution tables and ties published_at to the published status', async () => {
    const { pool } = await freshDatabase();
    await migrate(pool);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('moderation_decisions', 'reports', 'ratings')"
    );
    assert.equal(rows[0].n, 3);
    await pool.query('INSERT INTO recipes DEFAULT VALUES');
    await assert.rejects(
      pool.query(
        `INSERT INTO recipe_versions (recipe_id, version, title, minutes, servings, diet, ingredients, steps, provenance,
           search, submitted_at, published_at, status)
         SELECT id, 1, 't', 1, 1, 'vegan', '[{}]', '[{}]', 'p', ''::tsvector, now(), now(), 'pending' FROM recipes`
      ),
      { code: '23514' }
    );
  });

  it('is idempotent', async () => {
    const { pool } = await freshDatabase();
    await migrate(pool);
    assert.deepEqual(await migrate(pool), { from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION });
  });

  it('serializes concurrent migrations', async () => {
    const { pool, database } = await freshDatabase();
    const second = createPool({ database });
    cleanups.push(() => second.end());
    const results = await Promise.all([migrate(pool), migrate(second)]);
    assert.equal(results.length, 2);
    assert.equal(await readSchemaVersion(pool), LATEST_SCHEMA_VERSION);
  });

  it('refuses a database newer than the code without changing it', async () => {
    const { pool } = await freshDatabase();
    await migrate(pool);
    await pool.query('UPDATE fdl_schema SET version = $1', [LATEST_SCHEMA_VERSION + 1]);
    await assert.rejects(migrate(pool), { code: 'schema_incompatible' });
    assert.equal(await readSchemaVersion(pool), LATEST_SCHEMA_VERSION + 1);
  });

  it('rolls everything back when a migration fails', async () => {
    const { pool } = await freshDatabase();
    const dir = await mkdtemp(join(tmpdir(), 'fdl-migrations-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, '0001-ok.sql'), 'CREATE TABLE t (id integer);');
    await writeFile(join(dir, '0002-bad.sql'), 'THIS IS NOT SQL;');
    await assert.rejects(migrate(pool, { dir }));
    assert.equal(await readSchemaVersion(pool), 0);
    const { rows } = await pool.query("SELECT to_regclass('public.t') AS t");
    assert.equal(rows[0].t, null);
  });

  it('rejects a misnamed migration file and leaves the database unchanged', async () => {
    const { pool } = await freshDatabase();
    const dir = await mkdtemp(join(tmpdir(), 'fdl-migrations-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, '0001-ok.sql'), 'CREATE TABLE t (id integer);');
    await writeFile(join(dir, '0002_bad.sql'), 'CREATE TABLE u (id integer);');
    await assert.rejects(migrate(pool, { dir }), /0002_bad.sql/);
    assert.equal(await readSchemaVersion(pool), 0);
  });

  it('rejects a duplicated version number', async () => {
    const { pool } = await freshDatabase();
    const dir = await mkdtemp(join(tmpdir(), 'fdl-migrations-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, '0001-a.sql'), 'CREATE TABLE a (id integer);');
    await writeFile(join(dir, '0001-b.sql'), 'CREATE TABLE b (id integer);');
    await assert.rejects(migrate(pool, { dir }), /0001/);
    assert.equal(await readSchemaVersion(pool), 0);
  });

  it('creates the access schema with a case-insensitive unique email', async () => {
    const { pool } = await freshDatabase();
    await migrate(pool);
    assert.ok(LATEST_SCHEMA_VERSION >= 2);
    const tables = ['accounts', 'access_links', 'sessions', 'totp_secrets', 'passkeys', 'recovery_codes', 'admin_log'];
    const { rows } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
      [tables]
    );
    assert.deepEqual(rows.map((r) => r.table_name).sort(), [...tables].sort());
    const insert = (email) =>
      pool.query("INSERT INTO accounts (email, display_name, password_hash, role) VALUES ($1, 'Bob', 'h', 'member')", [email]);
    await insert('Bob@x.fr');
    await assert.rejects(insert('bob@x.fr'), { code: '23505' });
  });

  it('creates the catalogue schema with accent-insensitive French search', async () => {
    const { pool } = await freshDatabase();
    await migrate(pool);
    const tables = ['universes', 'recipes', 'recipe_versions'];
    const { rows } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)",
      [tables]
    );
    assert.deepEqual(rows.map((r) => r.table_name).sort(), [...tables].sort());
    const { rows: [{ match }] } = await pool.query(
      "SELECT to_tsvector('fdl_fr', 'Pâtes aux poireaux') @@ websearch_to_tsquery('fdl_fr', 'pates poireau') AS match"
    );
    assert.equal(match, true);
    const { rows: [{ id }] } = await pool.query('INSERT INTO recipes DEFAULT VALUES RETURNING id');
    await assert.rejects(pool.query(
      `INSERT INTO recipe_versions (recipe_id, version, title, minutes, servings, diet, ingredients, steps, provenance, search, submitted_at, published_at)
       VALUES ($1, 1, 'T', 0, 2, 'vegan', '[{}]', '[{}]', 'p', ''::tsvector, now(), now())`,
      [id]
    ), { code: '23514' });
  });

  it('logs pool errors by code only instead of crashing', async () => {
    const { database } = await freshDatabase();
    const lines = [];
    const pool = createPool({ database, log: (line) => lines.push(line) });
    cleanups.push(() => pool.end());
    pool.emit('error', Object.assign(new Error('secret detail'), { code: '57P01' }));
    assert.deepEqual(lines, ['db: 57P01']);
  });
});
