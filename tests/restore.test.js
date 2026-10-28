import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { migrate, readSchemaVersion, LATEST_SCHEMA_VERSION } from '../src/db.js';
import { createBackup } from '../scripts/backup.js';
import { restoreBackup } from '../scripts/restore.js';
import { createTestDatabase } from './helpers/db.js';

const pgBinDir = process.env.FDL_PG_BIN_DIR || '';
let dbA;
let root;
let dataDir;
let counter = 0;

const freshBackup = async () => createBackup({ config: { dataDir, pgBinDir }, database: dbA.database, outDir: join(root, `out-${counter++}`) });
const freshTarget = async () => {
  const db = await createTestDatabase();
  const dir = join(root, `target-${counter++}`);
  await mkdir(dir);
  return { db, dir };
};
const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code && /[a-zé]/.test(error.message));

before(async () => {
  dbA = await createTestDatabase();
  await migrate(dbA.pool);
  await dbA.pool.query('CREATE TABLE restore_probe (n int)');
  await dbA.pool.query('INSERT INTO restore_probe VALUES (1), (2)');
  root = await mkdtemp(join(tmpdir(), 'fdl-restore-'));
  dataDir = join(root, 'data');
  await mkdir(join(dataDir, 'photos'), { recursive: true });
  await writeFile(join(dataDir, 'photos', 'a.jpg'), 'photo-bytes');
});

after(async () => {
  await dbA.drop();
  await rm(root, { recursive: true, force: true });
});

test('round trip restores schema, rows and files', async () => {
  const backup = await freshBackup();
  const { db, dir } = await freshTarget();
  try {
    // backups/ et tmp/ ne comptent pas comme données.
    await mkdir(join(dir, 'backups'));
    await writeFile(join(dir, 'backups', 'x'), 'x');
    // Le journal de sécurité (logs/) non plus.
    await mkdir(join(dir, 'logs'));
    await writeFile(join(dir, 'logs', 'securite.log'), '{}\n');
    await restoreBackup({ config: { dataDir: dir, pgBinDir }, database: db.database, backupDir: backup });
    assert.equal(await readSchemaVersion(db.pool), await readSchemaVersion(dbA.pool));
    const { rows } = await db.pool.query('SELECT n FROM restore_probe ORDER BY n');
    assert.deepEqual(rows.map((r) => r.n), [1, 2]);
    assert.equal(await readFile(join(dir, 'photos', 'a.jpg'), 'utf8'), 'photo-bytes');
  } finally {
    await db.drop();
  }
});

test('a modified dump is backup_corrupted and nothing is restored', async () => {
  const backup = await freshBackup();
  await appendFile(join(backup, 'database.dump'), 'x');
  const { db, dir } = await freshTarget();
  try {
    await rejects(restoreBackup({ config: { dataDir: dir, pgBinDir }, database: db.database, backupDir: backup }), 'backup_corrupted');
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
    assert.equal(rows[0].n, 0);
  } finally {
    await db.drop();
  }
});

test('an unlisted file or a path escaping the backup is backup_corrupted', async () => {
  const { db, dir } = await freshTarget();
  try {
    const extra = await freshBackup();
    await writeFile(join(extra, 'files', 'intrus'), 'x');
    await rejects(restoreBackup({ config: { dataDir: dir, pgBinDir }, database: db.database, backupDir: extra }), 'backup_corrupted');

    const escape = await freshBackup();
    const manifest = JSON.parse(await readFile(join(escape, 'manifest.json'), 'utf8'));
    manifest.files['../evil'] = 'a'.repeat(64);
    await writeFile(join(escape, 'manifest.json'), JSON.stringify(manifest));
    await rejects(restoreBackup({ config: { dataDir: dir, pgBinDir }, database: db.database, backupDir: escape }), 'backup_corrupted');
  } finally {
    await db.drop();
  }
});

test('a missing manifest is backup_invalid', async () => {
  const backup = await freshBackup();
  await rm(join(backup, 'manifest.json'));
  const { db, dir } = await freshTarget();
  try {
    await rejects(restoreBackup({ config: { dataDir: dir, pgBinDir }, database: db.database, backupDir: backup }), 'backup_invalid');
  } finally {
    await db.drop();
  }
});

test('a newer schemaVersion is schema_incompatible', async () => {
  const backup = await freshBackup();
  const path = join(backup, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.schemaVersion = LATEST_SCHEMA_VERSION + 1;
  await writeFile(path, JSON.stringify(manifest));
  const { db, dir } = await freshTarget();
  try {
    await rejects(restoreBackup({ config: { dataDir: dir, pgBinDir }, database: db.database, backupDir: backup }), 'schema_incompatible');
  } finally {
    await db.drop();
  }
});

test('a non-empty database or dataDir is target_not_empty and untouched', async () => {
  const backup = await freshBackup();
  const { db, dir } = await freshTarget();
  try {
    await db.pool.query('CREATE TABLE keep (n int)');
    await db.pool.query('INSERT INTO keep VALUES (7)');
    await rejects(restoreBackup({ config: { dataDir: dir, pgBinDir }, database: db.database, backupDir: backup }), 'target_not_empty');
    assert.deepEqual((await db.pool.query('SELECT n FROM keep')).rows, [{ n: 7 }]);
    await db.pool.query('DROP TABLE keep');

    await writeFile(join(dir, 'existing'), 'x');
    await rejects(restoreBackup({ config: { dataDir: dir, pgBinDir }, database: db.database, backupDir: backup }), 'target_not_empty');
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n, 0);
  } finally {
    await db.drop();
  }
});

test('a failing pg_restore is restore_failed and leaves the database empty', async () => {
  const backup = await freshBackup();
  const { db, dir } = await freshTarget();
  const emptyBin = join(root, `empty-bin-${counter++}`);
  await mkdir(emptyBin);
  try {
    await rejects(restoreBackup({ config: { dataDir: dir, pgBinDir: emptyBin }, database: db.database, backupDir: backup }), 'restore_failed');
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n, 0);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await db.drop();
  }
});

test('a symlink inside the backup is backup_corrupted and the target is untouched', async () => {
  const backup = await freshBackup();
  await symlink('/etc', join(backup, 'files', 'lien'));
  const { db, dir } = await freshTarget();
  try {
    await rejects(restoreBackup({ config: { dataDir: dir, pgBinDir }, database: db.database, backupDir: backup }), 'backup_corrupted');
    assert.deepEqual(await readdir(dir), []);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n, 0);
  } finally {
    await db.drop();
  }
});
