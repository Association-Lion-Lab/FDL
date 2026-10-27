import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { migrate, LATEST_SCHEMA_VERSION } from '../src/db.js';
import { createBackup } from '../scripts/backup.js';
import { createTestDatabase } from './helpers/db.js';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

let testDb;
let root;
let dataDir;

before(async () => {
  testDb = await createTestDatabase();
  await migrate(testDb.pool);
  await testDb.pool.query('CREATE TABLE backup_probe (n int)');
  await testDb.pool.query('INSERT INTO backup_probe VALUES (1), (2)');
  root = await mkdtemp(join(tmpdir(), 'fdl-backup-'));
  dataDir = join(root, 'data');
  await mkdir(join(dataDir, 'photos'), { recursive: true });
  await mkdir(join(dataDir, 'tmp'));
  await mkdir(join(dataDir, 'backups'));
  await writeFile(join(dataDir, 'photos', 'a.jpg'), 'photo-bytes');
  await writeFile(join(dataDir, 'tmp', 'x'), 'temp');
  await writeFile(join(dataDir, 'backups', 'old'), 'old');
});

after(async () => {
  await testDb.drop();
  await rm(root, { recursive: true, force: true });
});

test('createBackup writes dump, files and a manifest with correct checksums', async () => {
  const outDir = join(root, 'out-ok');
  const dir = await createBackup({
    config: { dataDir, pgBinDir: process.env.FDL_PG_BIN_DIR || '' },
    database: testDb.database,
    outDir
  });

  assert.match(dir, /fdl-backup-[^:]+$/);
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 1);
  assert.equal(manifest.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.ok(!Number.isNaN(Date.parse(manifest.createdAt)));
  assert.deepEqual(Object.keys(manifest.files).sort(), ['database.dump', 'files/photos/a.jpg']);
  assert.equal(manifest.files['files/photos/a.jpg'], sha256('photo-bytes'));
  assert.equal(manifest.files['database.dump'], sha256(await readFile(join(dir, 'database.dump'))));
  assert.deepEqual(await readdir(join(dir, 'files')), ['photos']);
});

test('createBackup rejects and leaves no manifest when pg_dump is missing', async () => {
  const outDir = join(root, 'out-bad');
  const emptyBin = join(root, 'empty-bin');
  await mkdir(emptyBin);
  await assert.rejects(createBackup({
    config: { dataDir, pgBinDir: emptyBin },
    database: testDb.database,
    outDir
  }));
  const entries = await readdir(outDir, { recursive: true });
  assert.ok(!entries.some((e) => e.endsWith('manifest.json')));
});
