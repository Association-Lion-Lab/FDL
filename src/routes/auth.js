import { checkPassword, hashPassword, hashToken, redeemInvitation, redeemReset, verifyPassword } from '../accounts.js';
import { hasSecondFactor, useRecoveryCode, verifyTotp } from '../mfa.js';
import { clearSessionCookie, closeSession, openSession, sessionCookie } from '../sessions.js';
import { html, readBody, redirect, sendPage } from '../web.js';

const LINK_GONE = "Ce lien n'est plus valable. Demandez-en un nouveau.";
const TOO_MANY = 'Trop de tentatives. Réessayez dans 15 minutes.';
const BAD_LOGIN = 'E-mail ou mot de passe incorrect.';
const SIGNUP_ERRORS = {
  email_taken: 'Cette adresse e-mail est déjà utilisée.',
  invalid_email: 'Adresse e-mail invalide.',
  invalid_name: 'Le nom affiché est obligatoire (60 caractères au plus).',
};
const MEMBER_COOKIE_SECONDS = 30 * 24 * 3600;
const STAFF_COOKIE_SECONDS = 12 * 3600;
// Verified when the email is unknown, so the answer takes as long as for a real account.
const dummyHash = await hashPassword('mot de passe factice');

// ponytail: falsifiable si l'app est exposée sans proxy ; la limite par e-mail tient quand même.
export function clientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  const last = typeof forwarded === 'string' ? forwarded.split(',').at(-1).trim() : '';
  if (last) return last;
  return request.socket.remoteAddress ?? 'inconnue';
}

export const field = (body, name) => String((body instanceof URLSearchParams ? body.get(name) : body[name]) ?? '');

const input = (label, name, type, value = '') => html`<label>${label}
<input name="${name}" type="${type}" value="${value}" required></label>`;

export function form(response, { status = 200, title, action, button, error, fields }) {
  sendPage(response, status, title, html`<h1>${title}</h1>
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<form method="post" action="${action}">
${fields}
<button type="submit">${button}</button>
</form>`);
}

const gone = (response) => sendPage(response, 410, 'Lien expiré', html`<h1>Lien expiré</h1>
<p>${LINK_GONE}</p>`);

export const tooMany = (response) => sendPage(response, 429, 'Trop de tentatives', html`<h1>Trop de tentatives</h1>
<p>${TOO_MANY}</p>`);

const passwordFields = (code) => html`<input type="hidden" name="code" value="${code}">
${input('Mot de passe (12 caractères au moins)', 'password', 'password')}
${input('Confirmation du mot de passe', 'confirm', 'password')}`;

const signupPage = (response, code, values = {}, error = null, status = 200) => form(response, {
  status,
  title: 'Créer mon compte',
  action: '/inscription',
  button: 'Créer mon compte',
  error,
  fields: html`${input('Nom affiché', 'displayName', 'text', values.displayName ?? '')}
${input('Adresse e-mail', 'email', 'email', values.email ?? '')}
${passwordFields(code)}`,
});

const resetPage = (response, code, error = null, status = 200) => form(response, {
  status,
  title: 'Nouveau mot de passe',
  action: '/reinitialisation',
  button: 'Changer mon mot de passe',
  error,
  fields: passwordFields(code),
});

const loginPage = (response, email = '', error = null, status = 200) => form(response, {
  status,
  title: 'Connexion',
  action: '/connexion',
  button: 'Me connecter',
  error,
  fields: html`${input('Adresse e-mail', 'email', 'email', email)}
${input('Mot de passe', 'password', 'password')}`,
});

function passwordProblem(body) {
  const password = field(body, 'password');
  if (password !== field(body, 'confirm')) return 'Les mots de passe ne correspondent pas.';
  return checkPassword(password);
}

const queryCode = (request) => new URL(request.url, 'http://x').searchParams.get('code') ?? '';

// Read-only check so the form is not offered for a dead link; redemption still decides.
async function linkIsLive(pool, code, kind) {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM access_links WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()',
    [hashToken(code), kind]
  );
  return rowCount > 0;
}

const verificationPage = (response, error = null, status = 200) => form(response, {
  status,
  title: 'Vérification en deux étapes',
  action: '/connexion/verification',
  button: 'Vérifier',
  error,
  fields: html`<button type="button" id="passkey-login">Utiliser ma clé d'accès</button>
<p id="passkey-message" role="alert"></p>
<script src="/static/simplewebauthn.js"></script>
<script src="/static/fdl-passkeys.js"></script>
${input('Code à 6 chiffres ou code de récupération', 'code', 'text')}`,
});

// Replaces a half session with a full one and returns its cookie.
export async function promoteSession(pool, session) {
  await closeSession(pool, session.tokenHash);
  const token = await openSession(pool, session.accountId, { mfaOk: true });
  const staff = session.role === 'moderator' || session.role === 'admin';
  return sessionCookie(token, staff ? STAFF_COOKIE_SECONDS : MEMBER_COOKIE_SECONDS);
}

export function authRoutes(pool, config, { limiter }) {
  const limited = (request, name) => limiter.hit(`${name}:${clientIp(request)}`);

  return {
    'GET /': (request, response) => sendPage(response, 200, 'Faim de Lion', html`<h1>Faim de Lion</h1>
<p>Bienvenue ${request.session.displayName}, le catalogue arrive bientôt.</p>
<p><a href="/compte/securite">Sécurité du compte</a></p>
<form method="post" action="/deconnexion"><button type="submit">Me déconnecter</button></form>`),

    'GET /inscription': async (request, response) => {
      const code = queryCode(request);
      return code && (await linkIsLive(pool, code, 'invitation')) ? signupPage(response, code) : gone(response);
    },

    'POST /inscription': async (request, response) => {
      if (limited(request, 'inscription')) return tooMany(response);
      const body = await readBody(request);
      const code = field(body, 'code');
      const values = { displayName: field(body, 'displayName'), email: field(body, 'email') };
      const problem = passwordProblem(body);
      if (problem) return signupPage(response, code, values, problem, 400);
      const result = await redeemInvitation(pool, { token: code, ...values, password: field(body, 'password') });
      if (result.error === 'link_invalid') return gone(response);
      if (result.error) return signupPage(response, code, values, SIGNUP_ERRORS[result.error], 400);
      const { rows: [account] } = await pool.query('SELECT role FROM accounts WHERE id = $1', [result.accountId]);
      const staff = account.role === 'moderator' || account.role === 'admin';
      if (request.session) await closeSession(pool, request.session.tokenHash);
      const token = await openSession(pool, result.accountId, { mfaOk: true });
      redirect(
        response,
        staff ? '/compte/securite?obligatoire=1' : '/compte/securite',
        sessionCookie(token, staff ? STAFF_COOKIE_SECONDS : MEMBER_COOKIE_SECONDS)
      );
    },

    'GET /reinitialisation': async (request, response) => {
      const code = queryCode(request);
      return code && (await linkIsLive(pool, code, 'reset')) ? resetPage(response, code) : gone(response);
    },

    'POST /reinitialisation': async (request, response) => {
      if (limited(request, 'reinitialisation')) return tooMany(response);
      const body = await readBody(request);
      const code = field(body, 'code');
      const problem = passwordProblem(body);
      if (problem) return resetPage(response, code, problem, 400);
      const result = await redeemReset(pool, { token: code, password: field(body, 'password') });
      if (result.error) return gone(response);
      redirect(response, '/connexion');
    },

    'GET /connexion': (request, response) => loginPage(response),

    'POST /connexion': async (request, response) => {
      const body = await readBody(request);
      const email = field(body, 'email').trim();
      const password = field(body, 'password');
      const ipKey = `connexion:${clientIp(request)}`;
      // Every attempt is counted up front, so a correct password cannot slip past a tripped limit.
      // IP first and short-circuit: a tripped IP adds no email key to the limiter.
      if (limiter.hit(ipKey)) return tooMany(response);
      if (email.length > 254) return loginPage(response, '', BAD_LOGIN);
      const emailKey = `connexion-email:${email.toLowerCase()}`;
      if (limiter.hit(emailKey)) return tooMany(response);

      const { rows: [account] } = await pool.query(
        'SELECT id, role, password_hash, banned_at FROM accounts WHERE lower(email) = lower($1)',
        [email]
      );
      const valid = await verifyPassword(password, account?.password_hash ?? dummyHash);
      if (!account || !valid || account.banned_at) return loginPage(response, email, BAD_LOGIN);

      limiter.reset(emailKey); // never the IP key: it must not be clearable by an account holder
      if (request.session) await closeSession(pool, request.session.tokenHash);
      const mfaOk = !(await hasSecondFactor(pool, account.id));
      const token = await openSession(pool, account.id, { mfaOk });
      const staff = account.role === 'moderator' || account.role === 'admin';
      redirect(
        response,
        mfaOk ? '/' : '/connexion/verification',
        sessionCookie(token, staff ? STAFF_COOKIE_SECONDS : MEMBER_COOKIE_SECONDS)
      );
    },

    'GET /connexion/verification': (request, response) => {
      if (!request.session) return redirect(response, '/connexion');
      return request.session.mfaOk ? redirect(response, '/') : verificationPage(response);
    },

    'POST /connexion/verification': async (request, response) => {
      const session = request.session;
      if (!session) return redirect(response, '/connexion');
      if (session.mfaOk) return redirect(response, '/');
      const key = `verification:${session.accountId}`;
      if (limiter.hit(key)) return tooMany(response);
      const code = field(await readBody(request), 'code');
      const ok = /^\d{6}$/.test(code.replace(/\s/g, ''))
        ? await verifyTotp(pool, config.secretKey, session.accountId, code)
        : await useRecoveryCode(pool, session.accountId, code);
      if (!ok) return verificationPage(response, 'Code incorrect.', 400);
      limiter.reset(key);
      redirect(response, '/', await promoteSession(pool, session));
    },

    'POST /deconnexion': async (request, response) => {
      if (request.session) await closeSession(pool, request.session.tokenHash);
      redirect(response, '/connexion', clearSessionCookie());
    },
  };
}
