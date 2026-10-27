import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { loadConfig } from '../src/config.js';
import { createPool, readSchemaVersion } from '../src/db.js';

const run = promisify(execFile);
// Exclus de la copie des données (Tâche 7 applique les mêmes règles).
const EXCLUDED = new Set(['tmp', 'backups']);

export async function createBackup({ config, database, outDir }) {
  const createdAt = new Date().toISOString();
  await mkdir(outDir, { recursive: true });
  const dir = resolve(outDir, `fdl-backup-${createdAt.replaceAll(':', '')}`);
  await mkdir(dir); // échoue si le dossier existe déjà

  try {
    const pool = createPool({ database });
    let schemaVersion;
    try {
      schemaVersion = await readSchemaVersion(pool);
    } finally {
      await pool.end();
    }

    // Mot de passe via PGPASSWORD hérité de l'environnement, jamais en argument.
    const pgDump = config.pgBinDir ? join(config.pgBinDir, 'pg_dump') : 'pg_dump';
    await run(pgDump, ['--format=custom', '--file', join(dir, 'database.dump'), '--dbname', database]);

    await cp(config.dataDir, join(dir, 'files'), {
      recursive: true,
      filter: (src) => !EXCLUDED.has(relative(config.dataDir, src))
    });

    const files = {};
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    for (const entry of entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(entry.parentPath, entry.name);
      files[relative(dir, path).split(sep).join('/')] = createHash('sha256').update(await readFile(path)).digest('hex');
    }

    // Écrit en dernier : une sauvegarde partielle n'a jamais de manifeste.
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ format: 1, schemaVersion, createdAt, files }, null, 2));
    return dir;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const outDir = process.argv[2];
    if (!outDir) throw new Error('Usage : npm run backup -- <dossier de sortie>');
    const config = loadConfig(process.env);
    console.log(await createBackup({ config, database: process.env.PGDATABASE, outDir }));
  } catch (error) {
    const detail = String(error.stderr || error.message).trim().split('\n')[0];
    console.error(`Sauvegarde impossible : ${detail}`);
    process.exit(1);
  }
}
