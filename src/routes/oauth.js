import { sendJson } from '../http.js';
import { createCode, exchangeCode, parseAuthorization } from '../oauth.js';
import { html, readBody, redirect, sendPage } from '../web.js';

export const SUITE_COOKIE = 'fdl_suite';
const FIELDS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state'];

function back(response, redirectUri, fields) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(fields)) if (value != null) url.searchParams.set(key, value);
  redirect(response, url.href);
}

// Returns the parsed request, or null once an answer was sent.
// Only the POST (after a click on a page showing the address) may redirect an error: client_id is self-declared.
function parse(response, params, mayRedirect) {
  const auth = params instanceof URLSearchParams ? parseAuthorization(params) : { redirectUri: null };
  if (auth.ok) return auth;
  if (mayRedirect && auth.redirectUri) back(response, auth.redirectUri, { error: auth.error, state: auth.state });
  else {
    if (!mayRedirect) response.setHeader('set-cookie', `${SUITE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    sendPage(response, 400, 'Demande de liaison invalide', html`<h1>Demande de liaison invalide</h1><p>Cette demande de liaison Manger! est invalide. Revenez dans Manger! et recommencez.</p>`);
  }
  return null;
}

export function oauthRoutes(pool) {
  const token = (response, status, body) => {
    response.setHeader('cache-control', 'no-store');
    sendJson(response, status, body);
  };
  const fail = (response, error, error_description) => token(response, 400, { error, error_description });

  return {
    'GET /oauth/autoriser': (request, response) => {
      const params = new URL(request.url, 'http://x').searchParams;
      const auth = parse(response, params, false);
      if (!auth) return;
      response.setHeader('set-cookie', `${SUITE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
      sendPage(response, 200, 'Relier Manger!', html`<h1>Relier Manger!</h1>
<p>L'instance Manger! à l'adresse <strong>${auth.clientId}</strong> demande à lire les recettes de FDL avec votre compte, y compris vos recettes privées.</p>
<p>Vous pourrez retirer cet accès à tout moment depuis la page Sécurité du compte.</p>
<form method="post" action="/oauth/autoriser">
${FIELDS.filter((name) => params.has(name)).map((name) => html`<input type="hidden" name="${name}" value="${params.get(name)}">`)}
<button type="submit" name="decision" value="autoriser">Autoriser</button>
<button type="submit" name="decision" value="refuser">Refuser</button>
</form>`);
    },

    'POST /oauth/autoriser': async (request, response) => {
      const params = await readBody(request);
      const auth = parse(response, params, true);
      if (!auth) return;
      if (params.get('decision') !== 'autoriser') return back(response, auth.redirectUri, { error: 'access_denied', state: auth.state });
      const code = await createCode(pool, { accountId: request.session.accountId, clientId: auth.clientId, redirectUri: auth.redirectUri, challenge: auth.challenge });
      back(response, auth.redirectUri, { code, state: auth.state });
    },

    'POST /oauth/jeton': async (request, response) => {
      const body = await readBody(request).catch(() => null);
      if (!(body instanceof URLSearchParams)) return fail(response, 'invalid_request', 'Corps urlencodé attendu.');
      if (body.get('grant_type') !== 'authorization_code') return fail(response, 'unsupported_grant_type', 'Seul authorization_code est accepté.');
      const [code, clientId, redirectUri, verifier] = ['code', 'client_id', 'redirect_uri', 'code_verifier'].map((name) => body.get(name));
      if (!code || !clientId || !redirectUri || !verifier) return fail(response, 'invalid_request', 'Paramètre manquant ou invalide.');
      const access = await exchangeCode(pool, { code, clientId, redirectUri, verifier });
      if (!access) return fail(response, 'invalid_grant', 'Code invalide, expiré ou déjà utilisé.');
      token(response, 200, { access_token: access, token_type: 'Bearer' });
    },
  };
}
