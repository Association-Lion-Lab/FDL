import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { LATEST_SCHEMA_VERSION, createPool, migrate, readSchemaVersion } from './db.js';
import { createApp, sendError, sendJson } from './http.js';

export function buildRoutes(pool, log = console.error) {
  return {
    'GET /health': (request, response) => sendJson(response, 200, { status: 'ok' }),
    'GET /ready': async (request, response) => {
      // Failures are logged for the operator, never put in the HTTP body.
      let ready = false;
      try {
        const version = await readSchemaVersion(pool);
        ready = version === LATEST_SCHEMA_VERSION;
        if (!ready) log(`ready: schema ${version} attendu ${LATEST_SCHEMA_VERSION}`);
      } catch (error) {
        log(`ready: ${error?.code ?? 'inconnu'} ${error?.message}`);
      }
      if (ready) sendJson(response, 200, { status: 'ok' });
      else sendError(response, 503, 'not_ready', 'Service momentanément indisponible.');
    },
  };
}

export async function main(env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    // Config messages are French and never contain secrets.
    console.error(error.message);
    process.exitCode = 1;
    return null;
  }

  const pool = createPool({ log: console.error });
  const fail = async (message) => {
    console.error(message);
    process.exitCode = 1;
    await pool.end().catch(() => {});
    return null;
  };

  try {
    const { from, to } = await migrate(pool);
    if (from !== to) console.log(`migrations : ${from} → ${to}`);
  } catch (error) {
    // Never print pg's message: it can echo connection details.
    return fail(
      error.code === 'schema_incompatible'
        ? error.message
        : `Base de données injoignable ou refusée : ${error.code ?? 'inconnu'}`
    );
  }

  const server = createApp({ routes: buildRoutes(pool) });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
  } catch (error) {
    return fail(`Impossible d'écouter sur ${config.host}:${config.port} : ${error.code ?? 'inconnu'}`);
  }
  server.once('close', () => pool.end().catch(() => {}));
  console.log(`FDL écoute sur http://${config.host}:${config.port}`);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
