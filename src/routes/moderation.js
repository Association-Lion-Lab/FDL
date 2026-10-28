import { decide, getVersion, listQueue } from '../moderation.js';
import { html, readBody, redirect } from '../web.js';
import { field } from './auth.js';
import { recipeArticle, show } from './catalogue.js';

const MAX_ID = 9223372036854775807n;
const CATEGORIES = { illegal: 'Contenu illicite', copyright: "Droit d'auteur", off_topic: 'Hors sujet', spam: 'Spam', other: 'Autre' };
const FLAGS = { link: 'lien', banned_word: 'mot interdit', duplicate: 'doublon' };
const parseId = (value) => (/^\d{1,19}$/.test(value) && BigInt(value) <= MAX_ID ? value : null);
const parseVersion = (value) => (/^\d{1,9}$/.test(value) ? value : null);

const when = (date) => date.toISOString().slice(0, 16).replace('T', ' ');

const deny = (response) => show(response, 403, 'Accès refusé', html`<h1>Accès refusé</h1>
<p>Cette page est réservée à l'équipe de modération.</p>`);

const message = (response, status, title) => show(response, status, title, html`<h1>${title}</h1>
<p><a href="/moderation">Retour à la file</a></p>`);

// One decision form: the reason is required, the rest rides in hidden fields.
const decisionForm = (kind, label, ids) => html`<form method="post" action="/moderation/decision">
<input type="hidden" name="kind" value="${kind}">
${Object.entries(ids).map(([name, value]) => html`<input type="hidden" name="${name}" value="${value ?? ''}">`)}
<label>Motif <input name="motif" required maxlength="500"></label>
<button type="submit">${label}</button>
</form>`;

export function moderationRoutes(pool) {
  const staffOnly = (handler) => (request, response) =>
    request.session.role === 'moderator' || request.session.role === 'admin' ? handler(request, response) : deny(response);

  return {
    'GET /moderation': staffOnly(async (request, response) => {
      const { pending, reports } = await listQueue(pool);
      show(response, 200, 'Modération', html`<h1>Modération</h1>
<h2>Versions en attente</h2>
${pending.length ? html`<ul>${pending.map((p) => html`<li><a href="/moderation/version?id=${p.id}&version=${p.version}">${p.title}</a>
par ${p.author ?? 'Auteur anonyme'}, soumise le ${when(p.submitted_at)}
${p.flags.length ? html`<span>Signalée automatiquement : ${p.flags.map((f) => FLAGS[f] ?? f).join(', ')}</span>` : ''}
${decisionForm('accept', 'Accepter', { id: p.id, version: p.version })}
${decisionForm('reject', 'Refuser', { id: p.id, version: p.version })}</li>
`)}</ul>` : html`<p>Aucune version en attente.</p>`}
<h2>Signalements</h2>
${reports.length ? html`<ul>${reports.map((p) => html`<li>${CATEGORIES[p.category]} : ${p.detail}
sur ${p.version === null ? p.title : html`<a href="/moderation/version?id=${p.recipeId}&version=${p.version}">${p.title}</a>`}
par ${p.reporter ?? 'un compte supprimé'}, le ${when(p.created_at)}
${decisionForm('remove', 'Retirer la recette', { id: p.recipeId, report: p.id })}
${decisionForm('dismiss', 'Classer le signalement', { id: p.recipeId, report: p.id })}</li>
`)}</ul>` : html`<p>Aucun signalement ouvert.</p>`}`);
    }),

    'GET /moderation/version': staffOnly(async (request, response) => {
      const params = new URL(request.url, 'http://x').searchParams;
      const id = parseId(params.get('id') ?? '');
      const version = parseVersion(params.get('version') ?? '');
      const found = id && version && await getVersion(pool, id, version);
      if (!found) return message(response, 404, 'Version introuvable');
      const state = found.removed ? 'recette retirée' : found.status;
      show(response, 200, found.title, recipeArticle(found, html`<p role="status">Version ${found.version} : ${state}. <a href="/moderation">Retour à la file</a></p>`));
    }),

    'POST /moderation/decision': staffOnly(async (request, response) => {
      const body = await readBody(request);
      const id = parseId(field(body, 'id'));
      const version = field(body, 'version') === '' ? null : parseVersion(field(body, 'version'));
      const reportId = field(body, 'report') === '' ? null : parseId(field(body, 'report'));
      const kind = field(body, 'kind');
      const needsVersion = kind === 'accept' || kind === 'reject';
      if (!id || (needsVersion && !version) || (kind === 'dismiss' && !reportId)) return message(response, 404, 'Élément introuvable');
      const result = await decide(pool, { moderatorId: request.session.accountId, kind, recipeId: id, version, reportId, reason: field(body, 'motif') });
      if (result.ok) return redirect(response, '/moderation');
      if (result.error === 'already_done') return message(response, 409, 'Déjà traitée');
      if (result.error === 'not_found') return message(response, 404, 'Élément introuvable');
      return show(response, 400, 'Motif obligatoire', html`<h1>Motif obligatoire</h1>
<p class="error" role="alert">Le motif doit faire de 1 à 500 caractères.</p>
<p><a href="/moderation">Retour à la file</a></p>`);
    }),
  };
}
