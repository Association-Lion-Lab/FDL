import { readFileSync } from 'node:fs';

import { SEASONS, currentSeason, getRecipe, listUniverses, searchRecipes } from '../recipes.js';
import { html, sendPage } from '../web.js';

const printScript = readFileSync(new URL('../static/fdl-print.js', import.meta.url));

const DIET_LABELS = { vegan: 'Végétalien', vegetarian: 'Végétarien', pescetarian: 'Pescétarien', omnivore: 'Omnivore' };
const SEASON_LABELS = { spring: 'Printemps', summer: 'Été', autumn: 'Automne', winter: 'Hiver' };
const PREPARATION_LABELS = { raw: 'cru', cooked: 'cuit' };
const STEP_LABELS = { prep: 'Préparation', cook: 'Cuisson', rest: 'Repos', serve: 'Service' };
const DURATIONS = ['15', '30', '60'];
const FILTER_DIETS = ['vegan', 'vegetarian', 'pescetarian'];
const MAX_ID = 9223372036854775807n;
const author = (name) => name ?? 'Auteur anonyme';

const header = (q = '') => html`<header>
<a href="/">Faim de Lion</a>
<form method="get" action="/recherche" role="search">
<label>Rechercher une recette <input name="q" type="search" value="${q}"></label>
<button type="submit">Rechercher</button>
</form>
<a href="/compte/securite">Sécurité du compte</a>
<form method="post" action="/deconnexion"><button type="submit">Me déconnecter</button></form>
</header>`;

const show = (response, status, title, body, q) => sendPage(response, status, title, html`${header(q)}
${body}`);

const notFound = (response) => show(response, 404, 'Recette introuvable', html`<h1>Recette introuvable</h1>
<p>Cette recette n'existe pas ou n'est plus visible.</p>`);

const cards = (items) => html`<ul class="cards">
${items.map((card) => html`<li><a href="/recette?id=${card.id}">${card.title}</a>
<span>${card.minutes} min · ${DIET_LABELS[card.diet]} · ${author(card.author)}</span></li>
`)}</ul>`;

// Rows of the showcase: title, filters, "Tout voir" link.
const ROWS = (season) => [
  ['De saison', { seasons: [season] }, `/recherche?saison=${season}`],
  ['Récemment ajoutées', {}, '/recherche'],
  ['Rapides', { maxMinutes: 30 }, '/recherche?duree=30'],
  ['Végétariennes', { diet: 'vegetarian' }, '/recherche?regime=vegetarian'],
];

function readFilters(params) {
  const duree = params.get('duree');
  const regime = params.get('regime');
  const univers = params.get('univers');
  return {
    q: params.get('q') ?? '',
    maxMinutes: DURATIONS.includes(duree) ? Number(duree) : null,
    diet: FILTER_DIETS.includes(regime) ? regime : null,
    universe: univers ? univers : null,
    seasons: [...new Set(params.getAll('saison'))].filter((s) => SEASONS.includes(s)),
  };
}

const option = (value, label, selected) => html`<option value="${value}"${selected ? html` selected` : ''}>${label}</option>`;

const filterForm = (filters, universes) => html`<form method="get" action="/recherche" class="filters">
<input type="hidden" name="q" value="${filters.q}">
<label>Durée <select name="duree">${option('', 'Toutes', false)}
${DURATIONS.map((d) => option(d, `${d} min au plus`, filters.maxMinutes === Number(d)))}</select></label>
<label>Régime <select name="regime">${option('', 'Tous', false)}
${FILTER_DIETS.map((d) => option(d, DIET_LABELS[d], filters.diet === d))}</select></label>
${universes.length ? html`<label>Univers <select name="univers">${option('', 'Tous', false)}
${universes.map((u) => option(u.slug, u.label, filters.universe === u.slug))}</select></label>` : ''}
<fieldset><legend>Saisons</legend>
${SEASONS.map((s) => html`<label><input type="checkbox" name="saison" value="${s}"${filters.seasons.includes(s) ? html` checked` : ''}> ${SEASON_LABELS[s]}</label>`)}
</fieldset>
<button type="submit">Filtrer</button>
</form>`;

function ingredientLine({ name, amount, unit, preparation }) {
  const preparationLabel = PREPARATION_LABELS[preparation];
  return [amount.toLocaleString('fr-FR'), unit, name].filter(Boolean).join(' ') + (preparationLabel ? `, ${preparationLabel}` : '');
}

export function catalogueRoutes(pool) {
  return {
    'GET /': async (request, response) => {
      const rows = await Promise.all(ROWS(currentSeason()).map(async ([title, filters, link]) => [
        title, (await searchRecipes(pool, filters, { limit: 6 })).items, link,
      ]));
      const filled = rows.filter(([, items]) => items.length);
      show(response, 200, 'Faim de Lion', html`<h1>Faim de Lion</h1>
<p>Bienvenue ${request.session.displayName}.</p>
${filled.length ? filled.map(([title, items, link]) => html`<section>
<h2>${title}</h2>
${cards(items)}
<p><a href="${link}">Tout voir</a></p>
</section>`) : html`<p>Aucune recette publiée pour l'instant.</p>`}`);
    },

    'GET /recherche': async (request, response) => {
      const params = new URL(request.url, 'http://x').searchParams;
      const filters = readFilters(params);
      let result;
      try {
        result = await searchRecipes(pool, filters, { after: params.get('apres') });
      } catch (error) {
        if (error.code !== 'bad_cursor') throw error;
        return show(response, 400, 'Lien de page invalide', html`<h1>Lien de page invalide</h1>
<p><a href="/recherche">Recommencer la recherche</a></p>`, filters.q);
      }
      const nextParams = new URLSearchParams(params);
      nextParams.set('apres', result.next ?? '');
      show(response, 200, 'Recherche', html`<h1>Recherche</h1>
${filterForm(filters, await listUniverses(pool))}
${result.items.length ? cards(result.items) : html`<p>Aucune recette ne correspond.</p>`}
${result.next ? html`<p><a href="/recherche?${nextParams.toString()}">Page suivante</a></p>` : ''}`, filters.q);
    },

    'GET /recette': async (request, response) => {
      const id = new URL(request.url, 'http://x').searchParams.get('id') ?? '';
      if (!/^\d{1,19}$/.test(id) || BigInt(id) > MAX_ID) return notFound(response);
      const recipe = await getRecipe(pool, id);
      if (!recipe) return notFound(response);
      const published = recipe.publishedAt.toLocaleDateString('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' });
      show(response, 200, recipe.title, html`<article>
<h1>${recipe.title}</h1>
<p>Par ${author(recipe.author)}</p>
<ul class="facts">
<li>${recipe.minutes} min</li>
<li>${recipe.servings} portions</li>
<li>${DIET_LABELS[recipe.diet]}</li>
${recipe.seasons.length ? html`<li>${recipe.seasons.map((s) => SEASON_LABELS[s]).join(', ')}</li>` : ''}
${recipe.universe ? html`<li>${recipe.universe.label}</li>` : ''}
</ul>
<h2>Ingrédients</h2>
<ul>${recipe.ingredients.map((i) => html`<li>${ingredientLine(i)}</li>`)}</ul>
<h2>Étapes</h2>
<ol>${recipe.steps.map((s) => html`<li><strong>${STEP_LABELS[s.kind]}${s.minutes ? ` (${s.minutes} min)` : ''}</strong> ${s.instruction}</li>`)}</ol>
<p>Provenance : ${recipe.provenance}${recipe.sourceUrl ? html` (<a href="${recipe.sourceUrl}" rel="noopener noreferrer">source</a>)` : ''}</p>
<p>Texte sous licence CC BY-SA 4.0 (<a href="https://creativecommons.org/licenses/by-sa/4.0/deed.fr" rel="license">conditions</a>).</p>
<p>Version ${recipe.version}, publiée le ${published}</p>
<button type="button" id="print">Imprimer</button>
</article>
<script src="/static/fdl-print.js"></script>`);
    },

    'GET /static/fdl-print.js': (request, response) => {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' });
      response.end(printScript);
    },
  };
}
