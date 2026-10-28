export const DIETS = ['vegan', 'vegetarian', 'pescetarian', 'omnivore'];
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
const PREPARATIONS = ['raw', 'cooked', 'unknown'];
const STEP_KINDS = ['prep', 'cook', 'rest', 'serve'];
// "Suitable for": a vegan recipe suits a vegetarian, and so on. Omnivore needs no filter.
const SUITABLE = { vegan: ['vegan'], vegetarian: ['vegan', 'vegetarian'], pescetarian: ['vegan', 'vegetarian', 'pescetarian'] };

const invalid = (message) => Object.assign(new Error(message), { code: 'invalid_recipe' });
const badCursor = () => Object.assign(new Error('Lien de page invalide.'), { code: 'bad_cursor' });

const text = (value, max, min = 1) => typeof value === 'string' && value.length >= min && value.length <= max;
const int = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const list = (value, min, max) => Array.isArray(value) && value.length >= min && value.length <= max;

function safeUrl(value) {
  if (!text(value, 2000)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

// Limits of docs/CONTRATS.md "Projection compatible avec Manger!". Returns the normalized fields.
function checkFields(fields) {
  const { title, minutes, servings, diet, tags = [], seasons = [], universe = null, ingredients, steps, provenance, sourceUrl = null } = fields;
  if (!text(title, 120)) throw invalid('Le titre doit faire de 1 à 120 caractères.');
  if (!int(minutes, 1, 1440)) throw invalid('La durée doit être un nombre entier de minutes, de 1 à 1 440.');
  if (!int(servings, 1, 100)) throw invalid('Le nombre de portions doit être un entier de 1 à 100.');
  if (!DIETS.includes(diet)) throw invalid('Régime inconnu.');
  if (!list(tags, 0, 20) || !tags.every((tag) => text(tag, 40))) throw invalid('20 étiquettes au plus, de 40 caractères au plus.');
  if (!list(seasons, 0, 4) || !seasons.every((s) => SEASONS.includes(s)) || new Set(seasons).size !== seasons.length) {
    throw invalid('Saisons invalides.');
  }
  if (universe !== null && !text(universe, 40)) throw invalid('Univers invalide.');
  if (!list(ingredients, 1, 100)) throw invalid('De 1 à 100 ingrédients.');
  const cleanIngredients = ingredients.map(({ name, amount, unit = '', preparation = 'unknown' } = {}) => {
    if (!text(name, 80) || !text(unit, 24, 0) || !(typeof amount === 'number' && amount > 0 && amount <= 1_000_000)
      || !PREPARATIONS.includes(preparation)) {
      throw invalid('Ingrédient invalide.');
    }
    return { name, amount, unit, preparation };
  });
  if (!list(steps, 1, 50)) throw invalid('De 1 à 50 étapes.');
  const cleanSteps = steps.map(({ kind, instruction, minutes: stepMinutes = null } = {}) => {
    if (!STEP_KINDS.includes(kind) || !text(instruction, 2000) || !(stepMinutes === null || int(stepMinutes, 0, 1440))) {
      throw invalid('Étape invalide.');
    }
    return { kind, instruction, minutes: stepMinutes };
  });
  if (!text(provenance, 200)) throw invalid('La provenance doit faire de 1 à 200 caractères.');
  if (sourceUrl !== null && !safeUrl(sourceUrl)) throw invalid('Lien source invalide.');
  return { title, minutes, servings, diet, tags, seasons, universe, ingredients: cleanIngredients, steps: cleanSteps, provenance, sourceUrl };
}

export async function publishVersion(db, { recipeId = null, authorId = null, fields }) {
  const f = checkFields(fields);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let id = recipeId;
    let version = 1;
    if (id === null) {
      ({ rows: [{ id }] } = await client.query('INSERT INTO recipes (author_id) VALUES ($1) RETURNING id', [authorId]));
    } else {
      // Lock first, so two concurrent publications cannot pick the same version number.
      const { rowCount } = await client.query('SELECT 1 FROM recipes WHERE id = $1 FOR UPDATE', [id]);
      if (!rowCount) throw invalid('Recette inconnue.');
      ({ rows: [{ version }] } = await client.query(
        'SELECT coalesce(max(version), 0) + 1 AS version FROM recipe_versions WHERE recipe_id = $1',
        [id]
      ));
    }
    const words = [...f.ingredients.map((i) => i.name), ...f.tags].join(' ');
    await client.query(
      `INSERT INTO recipe_versions (recipe_id, version, title, minutes, servings, diet, tags, seasons, universe,
         ingredients, steps, provenance, source_url, search, submitted_at, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         setweight(to_tsvector('fdl_fr', $3), 'A') || setweight(to_tsvector('fdl_fr', $14), 'B'), now(), now())`,
      [id, version, f.title, f.minutes, f.servings, f.diet, f.tags, f.seasons, f.universe,
        JSON.stringify(f.ingredients), JSON.stringify(f.steps), f.provenance, f.sourceUrl, words]
    );
    await client.query(
      "UPDATE recipes SET visibility = 'public', published_version = $2, published_at = coalesce(published_at, now()) WHERE id = $1",
      [id, version]
    );
    await client.query('COMMIT');
    return { id: Number(id), version };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    // An unknown universe (23503) or a CHECK the JS missed (23514) is still the caller's mistake.
    if (error.code === '23503' || error.code === '23514') throw invalid('Recette invalide.');
    throw error;
  } finally {
    client.release();
  }
}

// Joins shared by the listing and the recipe page: only public, published, from a non-banned author.
const VISIBLE = `FROM recipes r
  JOIN recipe_versions v ON v.recipe_id = r.id AND v.version = r.published_version
  LEFT JOIN accounts a ON a.id = r.author_id
  LEFT JOIN universes u ON u.slug = v.universe
  WHERE r.visibility = 'public' AND (a.id IS NULL OR a.banned_at IS NULL)`;

export async function getRecipe(db, id) {
  const { rows } = await db.query(
    `SELECT r.id, v.*, u.label AS universe_label, a.display_name AS author ${VISIBLE} AND r.id = $1`,
    [id]
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: Number(row.id),
    version: row.version,
    title: row.title,
    minutes: row.minutes,
    servings: row.servings,
    diet: row.diet,
    tags: row.tags,
    seasons: row.seasons,
    universe: row.universe ? { slug: row.universe, label: row.universe_label } : null,
    ingredients: row.ingredients,
    steps: row.steps,
    provenance: row.provenance,
    sourceUrl: row.source_url,
    licence: row.text_licence,
    author: row.author,
    submittedAt: row.submitted_at,
    publishedAt: row.published_at,
  };
}

function readCursor(after) {
  let value;
  try {
    value = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
  } catch {
    throw badCursor();
  }
  // Only the exact format searchRecipes writes; Date.parse alone accepts strings PostgreSQL refuses.
  const validTime = typeof value?.t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.t)
    && new Date(value.t).toISOString().slice(0, 19) === value.t.slice(0, 19);
  if (!value || typeof value !== 'object' || !validTime || !Number.isSafeInteger(value.i) || value.i <= 0) {
    throw badCursor();
  }
  return value;
}

export async function searchRecipes(db, { q = '', maxMinutes = null, diet = null, universe = null, seasons = [] } = {}, { limit = 20, after = null } = {}) {
  const size = Math.min(50, Math.max(1, Math.trunc(limit) || 20));
  const params = [];
  const where = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (q.trim()) add("v.search @@ websearch_to_tsquery('fdl_fr', ?)", q);
  if (maxMinutes !== null) add('v.minutes <= ?', maxMinutes);
  if (SUITABLE[diet]) add('v.diet = ANY(?)', SUITABLE[diet]);
  if (universe !== null) add('v.universe = ?', universe);
  if (seasons.length) add('v.seasons && ?::text[]', seasons);
  if (after !== null) {
    const { t, i } = readCursor(after);
    params.push(t, i);
    where.push(`(r.published_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length})`);
  }
  params.push(size + 1);
  // The cursor keeps PostgreSQL's microseconds, which a JS Date would round away.
  const { rows } = await db.query(
    `SELECT r.id, v.title, v.minutes, v.diet, a.display_name AS author,
       to_char(r.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t
     ${VISIBLE} ${where.map((w) => `AND ${w}`).join(' ')}
     ORDER BY r.published_at DESC, r.id DESC LIMIT $${params.length}`,
    params
  );
  const page = rows.slice(0, size);
  const last = page.at(-1);
  const next = rows.length > size ? Buffer.from(JSON.stringify({ t: last.t, i: Number(last.id) })).toString('base64url') : null;
  return { items: page.map(({ id, title, minutes, diet: d, author }) => ({ id: Number(id), title, minutes, diet: d, author })), next };
}

export async function listUniverses(db) {
  const { rows } = await db.query('SELECT slug, label FROM universes ORDER BY label');
  return rows;
}

export function currentSeason(date = new Date()) {
  const month = date.getUTCMonth();
  if (month >= 2 && month <= 4) return 'spring';
  if (month >= 5 && month <= 7) return 'summer';
  if (month >= 8 && month <= 10) return 'autumn';
  return 'winter';
}
