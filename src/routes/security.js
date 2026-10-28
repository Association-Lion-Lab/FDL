import { checkPassword, hashPassword, verifyPassword } from '../accounts.js';
import { createRecoveryCodes, startTotp, verifyTotp } from '../mfa.js';
import { html, raw, readBody, redirect, sendPage } from '../web.js';
import { field, tooMany } from './auth.js';

const group4 = (secret) => secret.match(/.{1,4}/g).join(' ');

export function securityRoutes(pool, config, { limiter }) {
  const page = (response, title, body, status = 200) => sendPage(response, status, title, html`<h1>${title}</h1>
${body}
<p><a href="/">Retour à l'accueil</a></p>`);

  async function overview(request, response, { error = null, notice = null, status = 200 } = {}) {
    const id = request.session.accountId;
    const [{ rows: [totp] }, { rows: passkeys }, { rows: [codes] }] = await Promise.all([
      pool.query('SELECT 1 FROM totp_secrets WHERE account_id = $1 AND confirmed_at IS NOT NULL', [id]),
      pool.query('SELECT name FROM passkeys WHERE account_id = $1 ORDER BY created_at', [id]),
      pool.query('SELECT count(*)::int AS n FROM recovery_codes WHERE account_id = $1 AND used_at IS NULL', [id]),
    ]);
    const mandatory = new URL(request.url, 'http://x').searchParams.get('obligatoire') === '1';
    page(response, 'Sécurité du compte', html`
${mandatory && !totp && !passkeys.length ? html`<p>Votre rôle exige une seconde étape de connexion : activez le code à 6 chiffres ou ajoutez une clé d'accès.</p>` : ''}
${notice ? html`<p role="status">${notice}</p>` : ''}
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<h2>Code à 6 chiffres</h2>
<p>${totp ? 'Activé.' : 'Pas activé.'}</p>
${totp ? '' : html`<form method="post" action="/compte/securite/totp"><button type="submit">Activer le code à 6 chiffres</button></form>`}
<h2>Clés d'accès</h2>
${passkeys.length ? html`<ul>${passkeys.map((p) => html`<li>${p.name}</li>`)}</ul>` : html`<p>Aucune clé d'accès.</p>`}
<button type="button" disabled>Ajouter une clé d'accès</button>
<h2>Codes de récupération</h2>
<p>Codes restants : ${codes.n}.</p>
<form method="post" action="/compte/securite/recuperation"><button type="submit">Nouveaux codes de récupération</button></form>
<h2>Mot de passe</h2>
<form method="post" action="/compte/securite/mot-de-passe">
<label>Ancien mot de passe <input name="current" type="password" required></label>
<label>Nouveau mot de passe (12 caractères au moins) <input name="password" type="password" required></label>
<button type="submit">Changer mon mot de passe</button>
</form>`, status);
  }

  const showCodes = (response, codes) => page(response, 'Codes de récupération', html`
<p>Notez ces codes dans un endroit sûr : ils ne seront plus affichés. Chacun ne sert qu'une fois.</p>
<ul>${codes.map((c) => html`<li><code>${c}</code></li>`)}</ul>`);

  // Counts every attempt up front, as sign-in does.
  const limited = (request, name) => limiter.hit(`${name}:${request.session.accountId}`);

  return {
    'GET /compte/securite': (request, response) => overview(request, response),

    'POST /compte/securite/totp': async (request, response) => {
      const id = request.session.accountId;
      const { rows: [account] } = await pool.query('SELECT email FROM accounts WHERE id = $1', [id]);
      let started;
      try {
        started = await startTotp(pool, config.secretKey, id, account.email);
      } catch {
        return overview(request, response, { error: 'Le code à 6 chiffres est déjà activé.', status: 409 });
      }
      page(response, 'Activer le code à 6 chiffres', html`
<p>Scannez ce QR code avec votre application d'authentification.</p>
<div>${raw(started.qrSvg)}</div>
<p>Pas de scanner ? Saisissez cette clé : <code>${group4(started.secret)}</code>
ou ouvrez <a href="${started.uri}">le lien otpauth</a>.</p>
<form method="post" action="/compte/securite/totp/confirmation">
<label>Code affiché par l'application <input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" required></label>
<button type="submit">Confirmer</button>
</form>`);
    },

    'POST /compte/securite/totp/confirmation': async (request, response) => {
      if (limited(request, 'verification')) return tooMany(response);
      const id = request.session.accountId;
      const code = field(await readBody(request), 'code');
      if (!(await verifyTotp(pool, config.secretKey, id, code))) {
        return overview(request, response, { error: "Code incorrect. Recommencez l'activation.", status: 400 });
      }
      limiter.reset(`verification:${id}`);
      const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM recovery_codes WHERE account_id = $1', [id]);
      if (n) return redirect(response, '/compte/securite');
      showCodes(response, await createRecoveryCodes(pool, id));
    },

    'POST /compte/securite/recuperation': async (request, response) => {
      showCodes(response, await createRecoveryCodes(pool, request.session.accountId));
    },

    'POST /compte/securite/mot-de-passe': async (request, response) => {
      if (limited(request, 'mot-de-passe')) return tooMany(response);
      const id = request.session.accountId;
      const body = await readBody(request);
      const { rows: [account] } = await pool.query('SELECT password_hash FROM accounts WHERE id = $1', [id]);
      if (!(await verifyPassword(field(body, 'current'), account.password_hash))) {
        return overview(request, response, { error: 'Ancien mot de passe incorrect.', status: 400 });
      }
      const problem = checkPassword(field(body, 'password'));
      if (problem) return overview(request, response, { error: problem, status: 400 });
      await pool.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [id, await hashPassword(field(body, 'password'))]);
      // Any other session (a thief's, for instance) stops working with the old password.
      await pool.query('DELETE FROM sessions WHERE account_id = $1 AND token_hash <> $2', [id, request.session.tokenHash]);
      overview(request, response, { notice: 'Mot de passe changé.' });
    },
  };
}
