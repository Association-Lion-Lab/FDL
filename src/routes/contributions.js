import { getOwnRecipe, listMine, saveDraft, submitVersion } from '../contributions.js';
import { DIETS, SEASONS, VISIBLE, listUniverses } from '../recipes.js';
import { savePhoto, stripJpeg, sweepPhotos } from '../photos.js';
import { html, readBody, readForm, redirect } from '../web.js';
import { clientIp, field, tooMany } from './auth.js';
import { DIET_LABELS, SEASON_LABELS, STATE_LABELS, STEP_LABELS, show } from './catalogue.js';

const MAX_ID = 9223372036854775807n;
const PREPARATION_OPTIONS = { unknown: 'non précisée', raw: 'cru', cooked: 'cuit' };
const REPORT_CATEGORIES = {
  illegal: 'Contenu illégal', copyright: "Atteinte aux droits d'auteur", off_topic: 'Hors sujet', spam: 'Publicité ou spam', other: 'Autre',
};
const ATTEST_PHOTO = "J'ai pris cette photo ou j'ai le droit de la publier";
const PHOTO_INVALID = 'La photo doit être une image JPEG de 8 000 pixels de côté au plus.';
const PHOTO_TOO_BIG = "La photo dépasse 1 Mo. Activez JavaScript pour qu'elle soit réduite automatiquement, ou envoyez une image plus petite.";
const MAX_PHOTO = 1024 * 1024;
const ATTEST = "Je suis l'auteur de ce texte ou j'ai le droit de le publier sous licence CC BY-SA 4.0";

const notFound = (response) => show(response, 404, 'Recette introuvable', html`<h1>Recette introuvable</h1>
<p>Cette recette n'existe pas ou n'est plus visible.</p>`);

const option = (value, label, selected) => html`<option value="${value}"${selected ? html` selected` : ''}>${label}</option>`;

// A number typed with a comma is still a number; anything unreadable stays text for checkFields to refuse.
function number(value) {
  const text = value.trim();
  if (text === '') return null;
  const n = Number(text.replace(',', '.'));
  return Number.isNaN(n) ? text : n;
}

function draftFrom(body) {
  const all = (name) => (body instanceof URLSearchParams ? body.getAll(name) : []);
  // Read each column once: getAll per row is quadratic and lets one request stall the server.
  const rows = (names) => {
    const columns = names.map(all);
    return columns[0].map((_, i) => columns.map((column) => column[i] ?? ''));
  };
  const text = (name) => field(body, name).trim();
  return {
    title: text('title'),
    minutes: number(field(body, 'minutes')),
    servings: number(field(body, 'servings')),
    diet: text('diet'),
    seasons: all('season'),
    universe: text('universe') || null,
    tags: text('tags').split(',').map((t) => t.trim()).filter(Boolean),
    provenance: text('provenance'),
    sourceUrl: text('source_url') || null,
    ingredients: rows(['ingredient_name', 'ingredient_amount', 'ingredient_unit', 'ingredient_preparation'])
      .filter(([name, amount, unit]) => (name + amount + unit).trim())
      .map(([name, amount, unit, preparation]) => ({ name: name.trim(), amount: number(amount), unit: unit.trim(), preparation: preparation || 'unknown' })),
    steps: rows(['step_kind', 'step_instruction', 'step_minutes'])
      .filter(([, instruction, minutes]) => (instruction + minutes).trim())
      .map(([kind, instruction, minutes]) => ({ kind, instruction: instruction.trim(), minutes: number(minutes) })),
  };
}

const parseId = (value) => (/^\d{1,19}$/.test(value) && BigInt(value) <= MAX_ID ? value : null);

// `more` adds the 5 ingredient and 3 step lines of the "Ajouter des lignes" button.
function formPage(response, { id, draft, universes, error = null, status = 200, more = false }) {
  const ingredients = [...(draft.ingredients ?? []), ...Array(more ? 10 : 5).fill({})];
  const steps = [...(draft.steps ?? []), ...Array(more ? 6 : 3).fill({})];
  const seasons = draft.seasons ?? [];
  show(response, status, 'Écrire une recette', html`<h1>Écrire une recette</h1>
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<form method="post" action="/mes-recettes/edition" enctype="multipart/form-data">
<input type="hidden" name="id" value="${id ?? ''}">
<label>Titre <input name="title" value="${draft.title ?? ''}"></label>
<label>Durée (minutes) <input name="minutes" value="${draft.minutes ?? ''}"></label>
<label>Portions <input name="servings" value="${draft.servings ?? ''}"></label>
<label>Régime <select name="diet">${DIETS.map((d) => option(d, DIET_LABELS[d], draft.diet === d))}</select></label>
<fieldset><legend>Saisons</legend>
${SEASONS.map((s) => html`<label><input type="checkbox" name="season" value="${s}"${seasons.includes(s) ? html` checked` : ''}> ${SEASON_LABELS[s]}</label>`)}
</fieldset>
${universes.length ? html`<label>Univers <select name="universe">${option('', 'Aucun', !draft.universe)}
${universes.map((u) => option(u.slug, u.label, draft.universe === u.slug))}</select></label>` : ''}
<label>Étiquettes (séparées par des virgules) <input name="tags" value="${(draft.tags ?? []).join(', ')}"></label>
<label>Provenance <input name="provenance" value="${draft.provenance ?? ''}"></label>
<label>Lien source <input name="source_url" value="${draft.sourceUrl ?? ''}"></label>
${draft.photo ? html`<p><img src="/photo?f=${draft.photo.file}" alt="Photo actuelle" class="preview">
<label><input type="checkbox" name="retirer_photo" value="1"> Retirer la photo</label></p>` : ''}
<label>Photo (JPEG) <input type="file" name="photo" accept="image/jpeg"></label>
<label>Auteur de la photo <input name="photo_credit" maxlength="80" value="${draft.photo?.credit ?? ''}"></label>
<fieldset><legend>Ingrédients</legend>
${ingredients.map((i) => html`<p><label>Nom <input name="ingredient_name" value="${i.name ?? ''}"></label>
<label>Quantité <input name="ingredient_amount" value="${i.amount ?? ''}"></label>
<label>Unité <input name="ingredient_unit" value="${i.unit ?? ''}"></label>
<label>Préparation <select name="ingredient_preparation">${Object.entries(PREPARATION_OPTIONS).map(([v, l]) => option(v, l, (i.preparation ?? 'unknown') === v))}</select></label></p>
`)}</fieldset>
<fieldset><legend>Étapes</legend>
${steps.map((s) => html`<p><label>Type <select name="step_kind">${Object.entries(STEP_LABELS).map(([v, l]) => option(v, l, (s.kind ?? 'prep') === v))}</select></label>
<label>Instruction <textarea name="step_instruction">${s.instruction ?? ''}</textarea></label>
<label>Minutes <input name="step_minutes" value="${s.minutes ?? ''}"></label></p>
`)}</fieldset>
<label><input type="checkbox" name="atteste_texte" value="1"> ${ATTEST}</label>
<label><input type="checkbox" name="atteste_photo" value="1"> ${ATTEST_PHOTO}</label>
<button type="submit" name="action" value="lignes">Ajouter des lignes</button>
<button type="submit" name="action" value="brouillon">Enregistrer le brouillon</button>
<button type="submit" name="action" value="privee">Garder privée</button>
<button type="submit" name="action" value="publier">Publier</button>
</form>
<script src="/static/fdl-photo.js"></script>`);
}

function reportPage(response, id, { error = null, status = 200 } = {}) {
  show(response, status, 'Signaler une recette', html`<h1>Signaler une recette</h1>
${error ? html`<p class="error" role="alert">${error}</p>` : ''}
<form method="post" action="/recette/signaler">
<input type="hidden" name="id" value="${id}">
<label>Catégorie <select name="category">${Object.entries(REPORT_CATEGORIES).map(([v, l]) => option(v, l, false))}</select></label>
<label>Détail (facultatif, 1 000 caractères au plus) <textarea name="detail"></textarea></label>
<button type="submit">Signaler</button>
</form>`);
}

export function contributionRoutes(pool, config, { limiter }) {
  const visible = async (id) => id && (await pool.query(`SELECT 1 ${VISIBLE} AND r.id = $1`, [id])).rowCount > 0;
  return {
    'GET /recette/signaler': async (request, response) => {
      const id = parseId(new URL(request.url, 'http://x').searchParams.get('id') ?? '');
      if (!await visible(id)) return notFound(response);
      reportPage(response, id);
    },

    'POST /recette/signaler': async (request, response) => {
      const { accountId } = request.session;
      if (limiter.hit(`report:${accountId}`, { scope: 'report', accountId, ip: clientIp(request) })) return tooMany(response);
      const body = await readBody(request);
      const id = parseId(field(body, 'id'));
      if (!await visible(id)) return notFound(response);
      const category = field(body, 'category');
      const detail = field(body, 'detail').trim();
      if (!Object.hasOwn(REPORT_CATEGORIES, category)) return reportPage(response, id, { error: 'Choisissez une catégorie.', status: 400 });
      if (detail.length > 1000) return reportPage(response, id, { error: 'Le détail est limité à 1 000 caractères.', status: 400 });
      // A second open report of the same account is the unique index's conflict: same answer, no row.
      await pool.query('INSERT INTO reports (recipe_id, reporter_id, category, detail) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [id, accountId, category, detail]);
      show(response, 200, 'Signalement envoyé', html`<h1>Signalement envoyé</h1>
<p>Merci, votre signalement sera examiné.</p>`);
    },

    'POST /recette/note': async (request, response) => {
      const { accountId } = request.session;
      const body = await readBody(request);
      const id = parseId(field(body, 'id'));
      if (!await visible(id)) return notFound(response);
      const stars = field(body, 'etoiles');
      if (!/^[1-5]$/.test(stars)) return show(response, 400, 'Note invalide', html`<h1>Note invalide</h1>
<p>Choisissez une note de 1 à 5.</p>`);
      // The author's own recipe is refused in the statement itself, so no race with a check.
      const { rowCount } = await pool.query(
        `INSERT INTO ratings (recipe_id, account_id, stars) SELECT r.id, $2, $3 FROM recipes r WHERE r.id = $1 AND r.author_id IS DISTINCT FROM $2
         ON CONFLICT (recipe_id, account_id) DO UPDATE SET stars = EXCLUDED.stars, updated_at = now()`,
        [id, accountId, stars]
      );
      if (!rowCount) return show(response, 403, 'Note refusée', html`<h1>Note refusée</h1>
<p>Vous ne pouvez pas noter votre propre recette.</p>`);
      redirect(response, `/recette?id=${id}`);
    },

    'GET /mes-recettes': async (request, response) => {
      const items = await listMine(pool, request.session.accountId);
      show(response, 200, 'Mes recettes', html`<h1>Mes recettes</h1>
<p><a href="/mes-recettes/edition">Écrire une recette</a></p>
${items.length ? html`<ul>${items.map((r) => html`<li>${r.state === 'removed' ? r.title : html`<a href="/mes-recettes/edition?id=${r.id}">${r.title}</a>`}
<span>${STATE_LABELS[r.state]}</span>
${r.lastDecision ? html`<p>Motif : ${r.lastDecision.reason}</p>` : ''}</li>
`)}</ul>` : html`<p>Vous n'avez pas encore de recette.</p>`}`);
    },

    'GET /mes-recettes/edition': async (request, response) => {
      const value = new URL(request.url, 'http://x').searchParams.get('id');
      let id = null;
      let draft = {};
      if (value !== null) {
        id = parseId(value);
        const own = id && await getOwnRecipe(pool, { recipeId: id, authorId: request.session.accountId });
        if (!own || own.state === 'removed') return notFound(response);
        draft = own.draft && Object.keys(own.draft).length ? own.draft : own.latest ?? {};
      }
      formPage(response, { id, draft, universes: await listUniverses(pool) });
    },

    'POST /mes-recettes/edition': async (request, response) => {
      let form;
      try {
        form = await readForm(request, { max: 256 * 1024 + 8 * 1024 * 1024 });
      } catch (error) {
        if (error.code !== 'payload_too_large') throw error;
        return show(response, 413, 'Photo trop lourde', html`<h1>Photo trop lourde</h1>
<p class="error" role="alert">La photo dépasse 8 Mo et le texte saisi n'a pas été enregistré. Choisissez une image plus petite, ou activez JavaScript pour que la photo soit réduite automatiquement.</p>
<p><a href="/mes-recettes">Retour à mes recettes</a></p>`);
      }
      const { body, files } = form;
      const authorId = request.session.accountId;
      const action = field(body, 'action');
      let id = null;
      let previous = null;
      if (field(body, 'id') !== '') {
        id = parseId(field(body, 'id'));
        if (!id) return notFound(response);
        // The previous photo comes from the stored recipe, never from the form.
        const own = await getOwnRecipe(pool, { recipeId: id, authorId });
        if (!own || own.state === 'removed') return notFound(response);
        // Same draft-or-latest rule as GET: a draft without photo means the photo was removed.
        previous = (own.draft && Object.keys(own.draft).length ? own.draft.photo : own.latest?.photo) ?? null;
      }
      const draft = draftFrom(body);
      let file = previous?.file ?? null;
      let photoError = null;
      const upload = files.get('photo');
      if (upload) {
        if (limiter.hit(`photo:${authorId}`, { scope: 'photo', accountId: authorId, ip: clientIp(request) })) return tooMany(response);
        const stripped = upload.length > MAX_PHOTO ? null : stripJpeg(upload);
        if (stripped) file = await savePhoto(config.dataDir, stripped);
        else photoError = upload.length > MAX_PHOTO ? PHOTO_TOO_BIG : PHOTO_INVALID;
      }
      const removing = field(body, 'retirer_photo') === '1';
      draft.photo = !removing && file ? { file, credit: field(body, 'photo_credit').trim() } : null;
      try {
        ({ id } = await saveDraft(pool, { recipeId: id, authorId, draft }));
        // The draft is saved; a failed sweep must not turn that into a 500.
        if (upload || removing) await sweepPhotos(pool, config.dataDir).catch((e) => console.error(`photos : nettoyage impossible (${e.code ?? 'inconnu'})`));
        const again = async (error, status = 400, more = false) => formPage(response, { id, draft, universes: await listUniverses(pool), error, status, more });
        if (photoError) return await again(photoError);
        if (action === 'lignes') return await again(null, 200, true);
        if (action === 'brouillon') return redirect(response, '/mes-recettes');
        if (action !== 'privee' && action !== 'publier') return await again('Action inconnue.');
        if (action === 'publier' && field(body, 'atteste_texte') !== '1') return await again(`Cochez la case : ${ATTEST}.`);
        if (action === 'publier' && draft.photo && field(body, 'atteste_photo') !== '1') return await again(`Cochez la case : ${ATTEST_PHOTO}.`);
        try {
          await submitVersion(pool, { recipeId: id, authorId, mode: action === 'publier' ? 'public' : 'private', dataDir: config.dataDir });
        } catch (error) {
          if (error.code === 'invalid_recipe' || error.code === 'already_public') return await again(error.message);
          throw error;
        }
        return redirect(response, '/mes-recettes');
      } catch (error) {
        if (error.code === 'not_found') return notFound(response);
        if (error.code === 'draft_too_large') return show(response, 413, 'Brouillon trop volumineux', html`<h1>Brouillon trop volumineux</h1>
<p>${error.message}</p>`);
        throw error;
      }
    },
  };
}
