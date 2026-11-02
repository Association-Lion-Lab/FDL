import { apiRecipe, recipeStates } from '../api.js';
import { listMine } from '../contributions.js';
import { searchRecipes } from '../recipes.js';
import { sendError, sendJson } from '../http.js';
import { readFilters } from './catalogue.js';

const MAX_ID = 9223372036854775807n;
const validId = (value) => /^\d{1,19}$/.test(value) && BigInt(value) <= MAX_ID;
const params = (request) => new URL(request.url, 'http://x').searchParams;

export function apiRoutes(pool, config) {
  return {
    'GET /api/v1/recettes': async (request, response) => {
      const query = params(request);
      const limite = query.get('limite');
      const limit = /^\d{1,2}$/.test(limite ?? '') ? Number(limite) : 20;
      let result;
      try {
        result = await searchRecipes(pool, readFilters(query), { limit: limit >= 1 && limit <= 50 ? limit : 20, after: query.get('apres') });
      } catch (error) {
        if (error.code !== 'bad_cursor') throw error;
        return sendError(response, 400, 'bad_cursor', 'Curseur invalide.');
      }
      sendJson(response, 200, { items: result.items.map(({ id, title, minutes, diet, author }) => ({ id, title, minutes, diet, author })), next: result.next });
    },

    'GET /api/v1/recette': async (request, response) => {
      const id = params(request).get('id') ?? '';
      const { state, recipe } = validId(id) ? await apiRecipe(pool, id, request.session.accountId, config.origin) : { state: 'not_found' };
      if (recipe) return sendJson(response, 200, recipe);
      if (state === 'removed') return sendError(response, 410, 'removed', 'Recette retirée par la modération.');
      sendError(response, 404, 'not_found', 'Recette introuvable.');
    },

    'GET /api/v1/etat': async (request, response) => {
      const ids = (params(request).get('ids') ?? '').split(',');
      if (ids.length > 100 || new Set(ids).size !== ids.length || !ids.every(validId)) {
        return sendError(response, 400, 'bad_request', 'Liste d\'identifiants invalide.');
      }
      const states = await recipeStates(pool, ids, request.session.accountId);
      sendJson(response, 200, Object.fromEntries(ids.map((id) => [id, states.get(Number(id))])));
    },

    'GET /api/v1/mes-recettes': async (request, response) => {
      const { accountId } = request.session;
      const mine = await listMine(pool, accountId);
      const states = await recipeStates(pool, mine.map(({ id }) => String(id)), accountId);
      // listMine's state and title are the latest version's: take both from the version we report.
      const found = mine.filter(({ id }) => states.get(id).version != null);
      const { rows } = await pool.query(
        'SELECT v.recipe_id, v.title FROM unnest($1::bigint[], $2::int[]) AS t(id, version) JOIN recipe_versions v ON v.recipe_id = t.id AND v.version = t.version',
        [found.map(({ id }) => id), found.map(({ id }) => states.get(id).version)]
      );
      const titles = new Map(rows.map((row) => [Number(row.recipe_id), row.title]));
      const items = found.map(({ id }) => ({ id, title: titles.get(id), state: states.get(id).state, version: states.get(id).version }));
      sendJson(response, 200, { items });
    },
  };
}
