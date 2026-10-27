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

function parseOrigin(value) {
  const fail = () => new Error('FDL_ORIGIN doit être une adresse http(s) sans chemin, par exemple https://fdl.example.org.');
  if (!value) throw new Error('FDL_ORIGIN est obligatoire.');

  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail();
  }
  const bare = (url.protocol === 'http:' || url.protocol === 'https:')
    && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  if (!bare) throw fail();

  return { origin: url.origin, rpID: url.hostname };
}

function parseSecretKey(value) {
  if (!value) throw new Error('FDL_SECRET_KEY est obligatoire.');
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('FDL_SECRET_KEY doit contenir 64 caractères hexadécimaux (32 octets).');
  }
  return Buffer.from(value, 'hex');
}

export function loadConfig(env) {
  checkDataDir(env.FDL_DATA_DIR);
  const port = parsePort(env.PORT);

  // pg relit lui-même ces variables ; on vérifie seulement leur présence.
  for (const name of ['PGHOST', 'PGDATABASE', 'PGUSER']) {
    if (!env[name]) throw new Error(`${name} est obligatoire.`);
  }

  const { origin, rpID } = parseOrigin(env.FDL_ORIGIN);
  const secretKey = parseSecretKey(env.FDL_SECRET_KEY);

  return Object.freeze({
    host: env.HOST || '127.0.0.1',
    port,
    dataDir: env.FDL_DATA_DIR,
    pgBinDir: env.FDL_PG_BIN_DIR || '',
    origin,
    rpID,
    secretKey,
  });
}
