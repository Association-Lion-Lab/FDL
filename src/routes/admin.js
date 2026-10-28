import { verifyTotp } from '../mfa.js';
import { elevateSession } from '../sessions.js';
import { html, readBody, redirect, sendPage } from '../web.js';
import { clientIp, field, form, tooMany } from './auth.js';

// Only paths under /admin: anything else (absolute URL, //host, /other) falls back to /admin.
const safeReturn = (value) => (/^\/admin(?:[/?][\x21-\x7e]*)?$/.test(value) ? value : '/admin');

// Where a sensitive route sends a session that is not elevated (see requireElevated in sessions.js).
export const elevationUrl = (request) => `/admin/confirmation?retour=${encodeURIComponent(request.url)}`;

export function adminRoutes(pool, config, { limiter, securityLog }) {
  const staffOnly = (handler) => (request, response) =>
    request.session.role === 'moderator' || request.session.role === 'admin'
      ? handler(request, response)
      : sendPage(response, 403, 'Accès refusé', html`<h1>Accès refusé</h1>
<p>Cette page est réservée au personnel.</p>`);

  const confirmPage = async (request, response, retour, error = null, status = 200) => {
    const { rowCount } = await pool.query('SELECT 1 FROM passkeys WHERE account_id = $1', [request.session.accountId]);
    form(response, {
      status,
      title: 'Confirmer mon identité',
      action: '/admin/confirmation',
      button: 'Confirmer',
      error,
      fields: html`${rowCount ? html`<button type="button" id="passkey-elevate" data-retour="${retour}">Utiliser ma clé d'accès</button>
<p id="passkey-message" role="alert"></p>
<script src="/static/simplewebauthn.js"></script>
<script src="/static/fdl-passkeys.js"></script>` : ''}
<input type="hidden" name="retour" value="${retour}">
<label>Code à 6 chiffres
<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" required></label>`,
    });
  };

  return {
    'GET /admin': staffOnly((request, response) => sendPage(response, 200, 'Administration', html`<h1>Administration</h1>
<p><a href="/">Retour à l'accueil</a></p>`)),

    'GET /admin/confirmation': staffOnly((request, response) =>
      confirmPage(request, response, safeReturn(new URL(request.url, 'http://x').searchParams.get('retour') ?? ''))),

    'POST /admin/confirmation': staffOnly(async (request, response) => {
      const { accountId, tokenHash } = request.session;
      const key = `elevation:${accountId}`;
      const who = { scope: 'elevation', accountId, ip: clientIp(request) };
      if (limiter.hit(key)) {
        securityLog('rate_limited', who);
        return tooMany(response);
      }
      const body = await readBody(request);
      const retour = safeReturn(field(body, 'retour'));
      // No `activate`: a pending TOTP secret never counts as a second factor.
      if (!(await verifyTotp(pool, config.secretKey, accountId, field(body, 'code')))) {
        securityLog('mfa_failed', who);
        return confirmPage(request, response, retour, 'Code incorrect.', 400);
      }
      limiter.reset(key);
      await elevateSession(pool, tokenHash);
      redirect(response, retour);
    }),
  };
}
