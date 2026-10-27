import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export function sendError(response, status, code, message) {
  sendJson(response, status, { error: { code, message } });
}

export function createApp({ routes, log = console.error }) {
  return createServer(async (request, response) => {
    const { pathname } = new URL(request.url, 'http://x');
    const handler = routes[`${request.method} ${pathname}`];

    if (!handler) {
      sendError(response, 404, 'not_found', 'Ressource introuvable.');
      return;
    }

    try {
      await handler(request, response);
    } catch (error) {
      const requestId = randomUUID();
      log(`${requestId} ${error?.stack ?? error}`);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, 500, {
        error: {
          code: 'internal_error',
          message: 'Erreur interne. Réessayez plus tard.',
          requestId,
        },
      });
    }
  });
}
