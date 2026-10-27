import { pathToFileURL } from 'node:url';

import { parsePort } from './config.js';
import { createApp, sendJson } from './http.js';

export const routes = {
  'GET /health': (request, response) => sendJson(response, 200, { status: 'ok' }),
};

export function startServer({
  host = process.env.HOST || '127.0.0.1',
  port = parsePort(process.env.PORT),
} = {}) {
  const server = createApp({ routes });
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
