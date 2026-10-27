import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const MIGRATION_FILE = /^(\d{4})-.+\.sql$/;
const MIGRATION_LOCK = 7302231;

function listMigrations(dir) {
  return readdirSync(dir)
    .map((file) => ({ file, match: MIGRATION_FILE.exec(file) }))
    .filter(({ match }) => match)
    .map(({ file, match }) => ({ file, version: Number(match[1]) }))
    .sort((a, b) => a.version - b.version);
}

export const LATEST_SCHEMA_VERSION = Math.max(0, ...listMigrations(MIGRATIONS_DIR).map((m) => m.version));

// Lit les variables PG* (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE).
export function createPool({ database } = {}) {
  // Bounded connect time so /ready answers 503 instead of hanging on a dropped network.
  return new pg.Pool({ connectionTimeoutMillis: 2000, ...(database ? { database } : {}) });
}

export async function readSchemaVersion(db) {
  const { rows: [{ present }] } = await db.query("SELECT to_regclass('fdl_schema') IS NOT NULL AS present");
  if (!present) return 0;
  const { rows } = await db.query('SELECT version FROM fdl_schema');
  return rows.length ? rows[0].version : 0;
}

export async function migrate(pool, { dir = MIGRATIONS_DIR } = {}) {
  const migrations = listMigrations(dir);
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    const from = await readSchemaVersion(client);
    if (from > latest) {
      const error = new Error(
        `La base est en version ${from}, plus récente que cette application (version ${latest}). Mettez l'application à jour.`
      );
      error.code = 'schema_incompatible';
      throw error;
    }
    const pending = migrations.filter((m) => m.version > from);
    for (const { file } of pending) {
      await client.query(await readFile(join(dir, file), 'utf8'));
    }
    if (pending.length) {
      await client.query('DELETE FROM fdl_schema');
      await client.query('INSERT INTO fdl_schema (version) VALUES ($1)', [latest]);
    }
    await client.query('COMMIT');
    return { from, to: pending.length ? latest : from };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
