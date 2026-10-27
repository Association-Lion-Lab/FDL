import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { loadConfig } from '../src/config.js';
import { createPool, LATEST_SCHEMA_VERSION } from '../src/db.js';

const run = promisify(execFile);
// Mêmes exclusions que la sauvegarde.
const EXCLUDED = new Set(['tmp', 'backups']);

const fail = (code, message) => Object.assign(new Error(message), { code });

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function readManifest(dir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw fail('backup_invalid', 'Sauvegarde invalide : manifest.json est absent ou illisible.');
  }
  if (manifest?.format !== 1 || typeof manifest.files !== 'object' || manifest.files === null) {
    throw fail('backup_invalid', 'Sauvegarde invalide : format de manifeste non pris en charge.');
  }
  return manifest;
}

async function verifyFiles(dir, files) {
  const corrupted = (detail) => fail('backup_corrupted', `Sauvegarde corrompue : ${detail}.`);
  for (const [name, expected] of Object.entries(files)) {
    const path = resolve(dir, name);
    const rel = relative(dir, path);
    if (isAbsolute(name) || rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw corrupted('chemin hors de la sauvegarde dans le manifeste');
    }
    let actual;
    try {
      actual = await sha256(path);
    } catch {
      throw corrupted(`fichier manquant (${name})`);
    }
    if (actual !== expected) throw corrupted(`somme de contrôle différente (${name})`);
  }
  const present = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of present.filter((e) => e.isFile())) {
    const name = relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/');
    if (name !== 'manifest.json' && !Object.hasOwn(files, name)) {
      throw corrupted(`fichier absent du manifeste (${name})`);
    }
  }
}

async function assertTargetEmpty(database, dataDir) {
  const notEmpty = () => fail('target_not_empty', 'Restauration refusée : la base cible ou le dossier de données n’est pas vide.');
  const pool = createPool({ database });
  try {
    const { rows } = await pool.query(`
      SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f'))::int AS tables,
             (SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql')::int AS extensions`);
    if (rows[0].tables > 0 || rows[0].extensions > 0) throw notEmpty();
  } finally {
    await pool.end();
  }
  let names = [];
  try {
    names = await readdir(dataDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (names.some((name) => !EXCLUDED.has(name))) throw notEmpty();
}

export async function restoreBackup({ config, database, backupDir }) {
  const dir = resolve(backupDir);
  const manifest = await readManifest(dir);
  await verifyFiles(dir, manifest.files);
  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion > LATEST_SCHEMA_VERSION) {
    throw fail('schema_incompatible', 'Sauvegarde incompatible : elle vient d’une version plus récente de l’application.');
  }
  await assertTargetEmpty(database, config.dataDir);

  // Mot de passe via PGPASSWORD hérité de l'environnement, jamais en argument.
  const pgRestore = config.pgBinDir ? join(config.pgBinDir, 'pg_restore') : 'pg_restore';
  await run(pgRestore, ['--exit-on-error', '--single-transaction', '--no-owner', `--dbname=${database}`, join(dir, 'database.dump')]);

  try {
    await mkdir(config.dataDir, { recursive: true });
    for (const name of await readdir(join(dir, 'files'))) {
      await cp(join(dir, 'files', name), join(config.dataDir, name), { recursive: true });
    }
  } catch (error) {
    throw fail('files_copy_failed', `La base est restaurée mais la copie des fichiers a échoué (${error.code || error.message}) : le dossier de données est incomplet.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const backupDir = process.argv[2];
    if (!backupDir) throw new Error('Usage : npm run restore -- <dossier de sauvegarde>');
    const config = loadConfig(process.env);
    await restoreBackup({ config, database: process.env.PGDATABASE, backupDir });
    console.log('Restauration terminée.');
  } catch (error) {
    const detail = String(error.code ? error.message : error.stderr || error.message).trim().split('\n')[0];
    console.error(`Restauration impossible : ${detail}`);
    process.exit(1);
  }
}
