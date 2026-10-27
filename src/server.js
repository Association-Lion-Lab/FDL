import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { parsePort } from './config.js';

export function createApp() {
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      error: { code: 'not_found', message: 'Ressource introuvable.' },
    }));
  });
}

export function startServer({
  host = process.env.HOST || '127.0.0.1',
  port = parsePort(process.env.PORT),
} = {}) {
  const server = createApp();
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
