import { pathToFileURL } from 'node:url';

import { parsePort } from './config.js';
import { LATEST_SCHEMA_VERSION, readSchemaVersion } from './db.js';
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

export function startServer({
  host = process.env.HOST || '127.0.0.1',
  port = parsePort(process.env.PORT),
  pool = null, // ponytail: wired to a real pool by the startup task
} = {}) {
  const server = createApp({ routes: buildRoutes(pool) });
  server.listen(port, host, () => {
    console.log(`FDL écoute sur http://${host}:${port}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    startServer();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
