import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { LATEST_SCHEMA_VERSION, createPool, migrate, readSchemaVersion } from './db.js';
import { createApp, sendError, sendJson } from './http.js';
import { createLimiter } from './ratelimit.js';
import { passkeyRoutes } from './passkeys.js';
import { sweepPhotos } from './photos.js';
import { adminRoutes } from './routes/admin.js';
import { apiRoutes } from './routes/api.js';
import { loadToken } from './oauth.js';
import { authRoutes, clientIp } from './routes/auth.js';
import { SUITE_COOKIE, oauthRoutes } from './routes/oauth.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { commentRoutes } from './routes/comments.js';
import { contributionRoutes } from './routes/contributions.js';
import { moderationRoutes } from './routes/moderation.js';
import { createSecurityLog } from './securitylog.js';
import { securityRoutes } from './routes/security.js';
import { loadSession } from './sessions.js';
import { parseCookies, redirect } from './web.js';

const css = readFileSync(new URL('./static/fdl.css', import.meta.url));

// Exact paths reachable without a session.
export const PUBLIC_PATHS = new Set([
  '/health',
  '/ready',
  '/connexion',
  '/connexion/verification',
  '/inscription',
  '/reinitialisation',
  '/deconnexion',
  '/static/fdl.css',
  '/static/simplewebauthn.js',
  '/static/fdl-passkeys.js',
  '/cles/connexion/options',
  '/cles/connexion/verification',
  '/oauth/jeton',
]);

// Sign-out and static assets are already public; these are the rest of what a keyless staff session may open.
const KEY_PAGES = /^\/(?:compte\/securite(?:\/|$)|cles\/)/;

export function buildBefore(pool, config, { limiter = createLimiter({ max: 300 }) } = {}) {
  return async (request, response) => {
    let pathname = null;
    try {
      pathname = new URL(request.url, 'http://x').pathname;
    } catch {
      // unparseable target: never public
    }
    // The token call comes from the Manger! server, which sends no Origin.
    const tokenCall = request.method === 'POST' && pathname === '/oauth/jeton';
    if (request.method === 'POST' && !tokenCall && request.headers.origin !== config.origin) {
      sendError(response, 403, 'bad_origin', 'Origine de la requête refusée.');
      return false;
    }
    const api = pathname?.startsWith('/api/');
    const tooMany = () => sendError(response, 429, 'rate_limited', 'Trop de requêtes. Réessayez plus tard.');
    if ((api || pathname === '/oauth/jeton') && limiter.hit(`api-ip:${clientIp(request)}`)) {
      tooMany();
      return false;
    }
    const bearer = api && request.headers.authorization?.startsWith('Bearer ');
    if (bearer) {
      request.session = await loadToken(pool, request.headers.authorization.slice(7));
      if (request.session && limiter.hit(`api-client:${request.session.clientId}`)) {
        tooMany();
        return false;
      }
    } else {
      request.session = await loadSession(pool, parseCookies(request).fdl_session);
    }
    if (PUBLIC_PATHS.has(pathname)) return true;
    // API answers depend on the account: never cached.
    if (api) response.setHeader('cache-control', 'no-store');
    if (!request.session?.mfaOk) {
      if (api) {
        response.setHeader('www-authenticate', 'Bearer');
        sendError(response, 401, 'unauthorized', 'Connexion requise.');
        return false;
      }
      const cookies = request.method === 'GET' && pathname === '/oauth/autoriser'
        ? [`${SUITE_COOKIE}=${encodeURIComponent(request.url)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`]
        : [];
      redirect(response, request.session ? '/connexion/verification' : '/connexion', cookies);
      return false;
    }
    // Staff without a passkey can only reach the pages that let them add one.
    const { role, accountId } = request.session;
    if ((role === 'moderator' || role === 'admin') && !KEY_PAGES.test(pathname)) {
      const { rowCount } = await pool.query('SELECT 1 FROM passkeys WHERE account_id = $1', [accountId]);
      if (!rowCount) {
        if (api) {
          sendError(response, 403, 'forbidden', "Ajoutez une clé d'accès à votre compte avant d'utiliser l'API.");
          return false;
        }
        redirect(response, '/compte/securite?obligatoire=1');
        return false;
      }
    }
    return true;
  };
}

export function buildRoutes(pool, log = console.error, config, passkeyLib) {
  const securityLog = createSecurityLog(config?.dataDir);
  const limiter = createLimiter({ onTrip: (fields) => securityLog('rate_limited', fields) });
  return {
    ...authRoutes(pool, config, { limiter, securityLog }),
    ...securityRoutes(pool, config, { limiter }),
    ...passkeyRoutes(pool, config, passkeyLib, { limiter, securityLog }),
    ...adminRoutes(pool, config, { limiter, securityLog }),
    ...catalogueRoutes(pool, config),
    ...contributionRoutes(pool, config, { limiter }),
    ...commentRoutes(pool, config, { limiter }),
    ...moderationRoutes(pool, config),
    ...apiRoutes(pool, config),
    ...oauthRoutes(pool, config),
    'GET /static/fdl.css': (request, response) => {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      response.end(css);
    },
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

  await sweepPhotos(pool, config.dataDir).catch((e) => console.error(`photos : nettoyage impossible (${e.code ?? 'inconnu'})`));

  const server = createApp({ routes: buildRoutes(pool, console.error, config), before: buildBefore(pool, config) });
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
