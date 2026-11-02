// Read-only projection of recipes for Manger! servers. `ids` are strings already validated by the caller.
export async function recipeStates(db, ids, accountId) {
  const { rows } = await db.query(
    `SELECT r.id, CASE
         WHEN (r.removed_at IS NOT NULL AND (r.published_version IS NOT NULL OR r.author_id = $2)) OR (a.banned_at IS NOT NULL AND r.published_version IS NOT NULL) THEN 'removed'
         WHEN r.visibility = 'public' THEN 'published'
         WHEN r.visibility = 'private' AND r.author_id = $2 THEN 'private'
         ELSE 'not_found' END AS state,
       CASE WHEN r.visibility = 'public' THEN r.published_version
         ELSE (SELECT max(p.version) FROM recipe_versions p WHERE p.recipe_id = r.id AND p.status = 'private') END AS version
     FROM recipes r LEFT JOIN accounts a ON a.id = r.author_id
     WHERE r.id = ANY($1::bigint[])`,
    [ids, accountId]
  );
  const states = new Map(ids.map((id) => [Number(id), { state: 'not_found' }]));
  for (const row of rows) {
    states.set(Number(row.id), row.state === 'published' || row.state === 'private'
      ? { state: row.state, version: row.version }
      : { state: row.state });
  }
  return states;
}

export async function apiRecipe(db, id, accountId, origin) {
  const entry = (await recipeStates(db, [id], accountId)).get(Number(id));
  if (entry.version === undefined) return { state: entry.state };
  const { rows: [v] } = await db.query(
    `SELECT v.title, v.minutes, v.servings, v.diet, v.tags, v.seasons, v.ingredients, v.steps, v.provenance,
       v.source_url, v.text_licence, a.display_name, r.published_at
     FROM recipes r
     JOIN recipe_versions v ON v.recipe_id = r.id AND v.version = $2
     LEFT JOIN accounts a ON a.id = r.author_id
     WHERE r.id = $1`,
    [id, entry.version]
  );
  return {
    state: entry.state,
    recipe: {
      id: Number(id), version: entry.version, visibility: entry.state === 'published' ? 'public' : 'private',
      title: v.title, minutes: v.minutes, servings: v.servings, diet: v.diet, tags: v.tags, seasons: v.seasons,
      ingredients: v.ingredients, steps: v.steps, provenance: v.provenance, sourceUrl: v.source_url,
      licence: v.text_licence, author: v.display_name ?? null,
      publishedAt: entry.state === 'published' && v.published_at ? v.published_at.toISOString() : null,
      url: `${origin}/recette?id=${id}`,
    },
  };
}
