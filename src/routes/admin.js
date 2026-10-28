import { readFileSync } from 'node:fs';

import { createLink } from '../accounts.js';
import { verifyTotp } from '../mfa.js';
import { elevateSession, requireElevated } from '../sessions.js';
import { html, raw, readBody, redirect, sendPage } from '../web.js';
import { clientIp, field, form, tooMany } from './auth.js';

const copyScript = readFileSync(new URL('../static/fdl-copy.js', import.meta.url));
const ROLES = ['member', 'adherent', 'moderator', 'admin'];
const STATES = { pending: 'en attente', used: 'utilisée', expired: 'expirée', revoked: 'révoquée' };
const when = (date) => (date ? date.toISOString().slice(0, 16).replace('T', ' ') : '');

// Only paths under /admin, resolved so dot segments (also %2e) cannot climb out:
// anything else (absolute URL, //host, /admin@host, /admin/../x) falls back to /admin.
function safeReturn(value) {
  const origin = 'http://x';
  try {
    const url = new URL(value, origin);
    const inside = url.pathname === '/admin' || url.pathname.startsWith('/admin/');
    return url.origin === origin && inside && !/[\\]/.test(value) ? url.pathname + url.search : '/admin';
  } catch {
    return '/admin';
  }
}

// Where a sensitive route sends a session that is not elevated (see requireElevated in sessions.js).
export const elevationUrl = (request) => `/admin/confirmation?retour=${encodeURIComponent(request.url)}`;

export function adminRoutes(pool, config, { limiter, securityLog }) {
  // Moderator screens arrive with `contributions`: for now /admin is for admins only.
  const staffOnly = (handler) => (request, response) =>
    request.session.role === 'admin'
      ? handler(request, response)
      : sendPage(response, 403, 'Accès refusé', html`<h1>Accès refusé</h1>
<p>Cette page est réservée aux administrateurs.</p>`);

  // POST handlers send a stale session to re-authenticate, then back to the section's page.
  const needsElevation = (request, response, page) => {
    if (requireElevated(request)) return false;
    redirect(response, elevationUrl({ url: page }));
    return true;
  };

  const refuse = (response, status, message, back) =>
    sendPage(response, status, 'Action refusée', html`<h1>Action refusée</h1>
<p class="error" role="alert">${message}</p>
<p><a href="${back}">Retour</a></p>`);

  // Shows a one-time link: the page is no-store and the token is never stored or listed.
  const showLink = (response, title, path, token) => sendPage(response, 200, title, html`<h1>${title}</h1>
<p>Ce lien ne sera plus affiché. Copiez-le maintenant.</p>
<input id="link" readonly value="${`${config.origin}${path}?code=${token}`}">
<button type="button" id="copy">Copier</button>
<p id="copy-message" role="status"></p>
<p><a href="/admin">Retour à l'administration</a></p>
<script src="/static/fdl-copy.js"></script>`);

  // One transaction: the change, its admin_log line and its securite.log line stand or fall together.
  async function transact(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function record(client, request, action, targetId, detail) {
    const actorId = request.session.accountId;
    await client.query('INSERT INTO admin_log (actor_id, action, target, detail) VALUES ($1, $2, $3, $4)',
      [actorId, action, String(targetId), JSON.stringify(detail)]);
    securityLog(action, { accountId: actorId, targetId, ip: clientIp(request), ...detail });
  }

  // Locks every active admin plus the target (same order everywhere, so no deadlock): a concurrent
  // demotion or ban waits, then sees the remaining admins.
  async function lockAccounts(client, id) {
    const { rows } = await client.query(
      `SELECT id, role, banned_at IS NOT NULL AS banned FROM accounts
       WHERE id = $1 OR (role = 'admin' AND banned_at IS NULL) ORDER BY id FOR UPDATE`, [id]);
    const target = rows.find((r) => String(r.id) === id);
    const activeAdmin = target?.role === 'admin' && !target.banned;
    return { target, lastAdmin: activeAdmin && !rows.some((r) => r.role === 'admin' && !r.banned && r.id !== target.id) };
  }

  // Body, id and elevation checks, then fn in a transaction; fn returns an error message or null.
  const accountAction = (fn) => staffOnly(async (request, response) => {
    const body = await readBody(request);
    if (needsElevation(request, response, '/admin/comptes')) return;
    const id = field(body, 'id');
    if (!/^\d{1,18}$/.test(id)) return refuse(response, 400, 'Compte inconnu.', '/admin/comptes');
    const problem = await transact(async (client) => {
      const { target, lastAdmin } = await lockAccounts(client, id);
      if (!target) return 'Compte inconnu.';
      return fn({ client, request, body, id, target, lastAdmin });
    });
    return problem ? refuse(response, 409, problem, '/admin/comptes') : redirect(response, '/admin/comptes');
  });

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
<ul>
<li><a href="/admin/invitations">Invitations</a></li>
<li><a href="/admin/comptes">Comptes</a></li>
<li><a href="/admin/journal">Journal</a></li>
</ul>
<p><a href="/">Retour à l'accueil</a></p>`)),

    'GET /static/fdl-copy.js': (request, response) => {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' });
      response.end(copyScript);
    },

    'GET /admin/invitations': staffOnly(async (request, response) => {
      const { rows } = await pool.query(
        `SELECT encode(token_hash, 'hex') AS id, note, role, created_at, expires_at,
                CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN used_at IS NOT NULL THEN 'used'
                     WHEN expires_at <= now() THEN 'expired' ELSE 'pending' END AS state
         FROM access_links WHERE kind = 'invitation' ORDER BY created_at DESC`);
      sendPage(response, 200, 'Invitations', html`<h1>Invitations</h1>
<form method="post" action="/admin/invitations">
<label>Rôle <select name="role">${ROLES.map((r) => html`<option value="${r}">${r}</option>`)}</select></label>
<label>Note <input name="note" maxlength="200"></label>
<button type="submit">Créer une invitation</button>
</form>
<table>
<tr><th>Note</th><th>Rôle</th><th>Créée le</th><th>Expire le</th><th>État</th><th></th></tr>
${rows.map((r) => html`<tr><td>${r.note}</td><td>${r.role ?? 'member'}</td><td>${when(r.created_at)}</td><td>${when(r.expires_at)}</td><td>${STATES[r.state]}</td>
<td>${r.state === 'pending' ? html`<form method="post" action="/admin/invitations/revoquer"><input type="hidden" name="id" value="${r.id}"><button type="submit">Révoquer</button></form>` : ''}</td></tr>`)}
</table>
<p><a href="/admin">Retour</a></p>`);
    }),

    'POST /admin/invitations': staffOnly(async (request, response) => {
      const body = await readBody(request);
      const role = field(body, 'role');
      if (!ROLES.includes(role)) return refuse(response, 400, 'Rôle inconnu.', '/admin/invitations');
      if ((role === 'moderator' || role === 'admin') && needsElevation(request, response, '/admin/invitations')) return;
      const note = field(body, 'note').trim().slice(0, 200) || null;
      const token = await createLink(pool, { kind: 'invitation', role, note, createdBy: request.session.accountId });
      showLink(response, 'Invitation créée', '/inscription', token);
    }),

    'POST /admin/invitations/revoquer': staffOnly(async (request, response) => {
      const id = field(await readBody(request), 'id');
      if (/^[0-9a-f]{64}$/.test(id)) {
        await pool.query(
          `UPDATE access_links SET revoked_at = now()
           WHERE token_hash = $1 AND kind = 'invitation' AND used_at IS NULL AND revoked_at IS NULL`, [Buffer.from(id, 'hex')]);
      }
      redirect(response, '/admin/invitations');
    }),

    'GET /admin/comptes': staffOnly(async (request, response) => {
      const { rows } = await pool.query(
        `SELECT id, display_name, email, role, banned_at IS NOT NULL AS banned, created_at,
                EXISTS (SELECT 1 FROM totp_secrets t WHERE t.account_id = a.id AND t.confirmed_at IS NOT NULL) AS mfa
         FROM accounts a ORDER BY created_at, id`);
      sendPage(response, 200, 'Comptes', html`<h1>Comptes</h1>
<table>
<tr><th>Nom</th><th>E-mail</th><th>Rôle</th><th>Double auth</th><th>Banni</th><th>Créé le</th><th>Actions</th></tr>
${rows.map((r) => html`<tr><td>${r.display_name}</td><td>${r.email}</td><td>${r.role}</td><td>${r.mfa ? 'oui' : 'non'}</td><td>${r.banned ? 'oui' : 'non'}</td><td>${when(r.created_at)}</td>
<td><form method="post" action="/admin/comptes/role"><input type="hidden" name="id" value="${r.id}"><select name="role">${ROLES.map((x) => html`<option value="${x}"${x === r.role ? raw(' selected') : ''}>${x}</option>`)}</select><button type="submit">Changer le rôle</button></form>
<form method="post" action="/admin/comptes/${r.banned ? 'debannir' : 'bannir'}"><input type="hidden" name="id" value="${r.id}"><button type="submit">${r.banned ? 'Débannir' : 'Bannir'}</button></form>
<form method="post" action="/admin/comptes/reinitialiser"><input type="hidden" name="id" value="${r.id}"><button type="submit">Réinitialiser l'accès</button></form></td></tr>`)}
</table>
<p><a href="/admin">Retour</a></p>`);
    }),

    'POST /admin/comptes/role': accountAction(async ({ client, request, body, id, target, lastAdmin }) => {
      const role = field(body, 'role');
      if (!ROLES.includes(role)) return 'Rôle inconnu.';
      if (lastAdmin && role !== 'admin') return 'Impossible : il doit rester au moins un administrateur.';
      await client.query('UPDATE accounts SET role = $2 WHERE id = $1', [id, role]);
      await record(client, request, 'role_changed', id, { from: target.role, to: role });
      return null;
    }),

    'POST /admin/comptes/bannir': accountAction(async ({ client, request, id, lastAdmin }) => {
      if (id === String(request.session.accountId)) return 'Vous ne pouvez pas vous bannir vous-même.';
      if (lastAdmin) return 'Impossible : il doit rester au moins un administrateur.';
      await client.query('UPDATE accounts SET banned_at = COALESCE(banned_at, now()) WHERE id = $1', [id]);
      await client.query('DELETE FROM sessions WHERE account_id = $1', [id]);
      await record(client, request, 'account_banned', id, {});
      return null;
    }),

    'POST /admin/comptes/debannir': accountAction(async ({ client, request, id }) => {
      await client.query('UPDATE accounts SET banned_at = NULL WHERE id = $1', [id]);
      await record(client, request, 'account_unbanned', id, {});
      return null;
    }),

    'POST /admin/comptes/reinitialiser': staffOnly(async (request, response) => {
      const id = field(await readBody(request), 'id');
      if (needsElevation(request, response, '/admin/comptes')) return;
      if (!/^\d{1,18}$/.test(id)) return refuse(response, 400, 'Compte inconnu.', '/admin/comptes');
      const token = await transact(async (client) => {
        const { rowCount } = await client.query('SELECT 1 FROM accounts WHERE id = $1', [id]);
        if (!rowCount) return null;
        const created = await createLink(client, { kind: 'reset', accountId: id, createdBy: request.session.accountId });
        await record(client, request, 'access_reset', id, {});
        return created;
      });
      return token
        ? showLink(response, 'Lien de réinitialisation', '/reinitialisation', token)
        : refuse(response, 400, 'Compte inconnu.', '/admin/comptes');
    }),

    'GET /admin/journal': staffOnly(async (request, response) => {
      const { rows } = await pool.query(
        `SELECT l.at, l.action, l.target, l.detail, a.display_name AS actor
         FROM admin_log l LEFT JOIN accounts a ON a.id = l.actor_id ORDER BY l.id DESC LIMIT 100`);
      sendPage(response, 200, 'Journal', html`<h1>Journal</h1>
<table>
<tr><th>Date</th><th>Acteur</th><th>Action</th><th>Cible</th><th>Détail</th></tr>
${rows.map((r) => html`<tr><td>${when(r.at)}</td><td>${r.actor}</td><td>${r.action}</td><td>${r.target}</td><td>${r.detail ? JSON.stringify(r.detail) : ''}</td></tr>`)}
</table>
<p><a href="/admin">Retour</a></p>`);
    }),

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
