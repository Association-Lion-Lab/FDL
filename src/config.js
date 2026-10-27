import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export function parsePort(value) {
  if (value === undefined || value === '') return 3000;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT doit être un entier compris entre 1 et 65535.');
  }

  return port;
}

function checkDataDir(dir) {
  if (!dir) throw new Error('FDL_DATA_DIR est obligatoire.');
  if (!isAbsolute(dir)) throw new Error('FDL_DATA_DIR doit être un chemin absolu.');

  let stats;
  try {
    stats = statSync(dir);
  } catch {
    throw new Error('FDL_DATA_DIR doit désigner un dossier qui existe.');
  }
  if (!stats.isDirectory()) throw new Error('FDL_DATA_DIR doit désigner un dossier, pas un fichier.');
}

export function loadConfig(env) {
  checkDataDir(env.FDL_DATA_DIR);
  const port = parsePort(env.PORT);

  // pg relit lui-même ces variables ; on vérifie seulement leur présence.
  for (const name of ['PGHOST', 'PGDATABASE', 'PGUSER']) {
    if (!env[name]) throw new Error(`${name} est obligatoire.`);
  }

  return Object.freeze({
    host: env.HOST || '127.0.0.1',
    port,
    dataDir: env.FDL_DATA_DIR,
    pgBinDir: env.FDL_PG_BIN_DIR || '',
  });
}
