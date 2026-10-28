const ACTIONS = {
  accept: ['accepted', 'recipe_accepted'],
  reject: ['rejected', 'recipe_rejected'],
  remove: ['removed', 'recipe_removed'],
  dismiss: ['report_dismissed', 'report_dismissed'],
};

export async function listQueue(db) {
  const { rows: pending } = await db.query(
    `SELECT v.recipe_id AS id, v.version, v.title, v.flags, v.submitted_at, a.display_name AS author
     FROM recipe_versions v JOIN recipes r ON r.id = v.recipe_id LEFT JOIN accounts a ON a.id = r.author_id
     WHERE v.status = 'pending' AND r.removed_at IS NULL ORDER BY v.submitted_at, v.recipe_id`
  );
  const { rows: reports } = await db.query(
    `SELECT p.id, p.recipe_id AS "recipeId", p.category, p.detail, p.created_at, r.published_version AS version,
       coalesce(v.title, 'Sans titre') AS title, a.display_name AS reporter
     FROM reports p JOIN recipes r ON r.id = p.recipe_id
     LEFT JOIN recipe_versions v ON v.recipe_id = r.id AND v.version = r.published_version
     LEFT JOIN accounts a ON a.id = p.reporter_id
     WHERE p.closed_at IS NULL AND r.removed_at IS NULL ORDER BY p.created_at, p.id`
  );
  return { pending, reports };
}

export async function getVersion(db, id, version) {
  const { rows } = await db.query(
    `SELECT v.*, u.label AS universe_label, a.display_name AS author, r.removed_at
     FROM recipe_versions v JOIN recipes r ON r.id = v.recipe_id
     LEFT JOIN accounts a ON a.id = r.author_id LEFT JOIN universes u ON u.slug = v.universe
     WHERE v.recipe_id = $1 AND v.version = $2`,
    [id, version]
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    version: row.version, status: row.status, flags: row.flags, removed: row.removed_at !== null,
    title: row.title, minutes: row.minutes, servings: row.servings, diet: row.diet, tags: row.tags, seasons: row.seasons,
    universe: row.universe ? { label: row.universe_label } : null, ingredients: row.ingredients, steps: row.steps,
    provenance: row.provenance, sourceUrl: row.source_url, author: row.author, publishedAt: row.published_at,
  };
}

export async function decide(db, { moderatorId, kind, recipeId, version = null, reportId = null, reason }) {
  const [decision, action] = ACTIONS[kind] ?? [];
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!decision || text.length < 1 || text.length > 500) return { error: 'bad_reason' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Lock the recipe before reading what decides: the second of two concurrent calls waits, then sees the first's outcome.
    const { rows: [recipe] } = await client.query('SELECT removed_at FROM recipes WHERE id = $1 FOR UPDATE', [recipeId]);
    if (!recipe) return await end(client, 'not_found');
    if (recipe.removed_at) return await end(client, 'already_done');
    if (kind === 'accept' || kind === 'reject') {
      const { rows: [row] } = await client.query(
        'SELECT status FROM recipe_versions WHERE recipe_id = $1 AND version = $2', [recipeId, version]);
      if (!row) return await end(client, 'not_found');
      if (row.status !== 'pending') return await end(client, 'already_done');
    } else if (kind === 'dismiss') {
      const { rows: [row] } = await client.query('SELECT closed_at FROM reports WHERE id = $1 AND recipe_id = $2', [reportId, recipeId]);
      if (!row) return await end(client, 'not_found');
      if (row.closed_at) return await end(client, 'already_done');
    }
    const { rows: [{ id }] } = await client.query(
      'INSERT INTO moderation_decisions (recipe_id, version, moderator_id, decision, reason) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [recipeId, kind === 'remove' || kind === 'dismiss' ? null : version, moderatorId, decision, text]);
    if (kind === 'accept') {
      await client.query("UPDATE recipe_versions SET status = 'published', published_at = now() WHERE recipe_id = $1 AND version = $2", [recipeId, version]);
      await client.query(
        "UPDATE recipes SET visibility = 'public', published_version = $2, published_at = coalesce(published_at, now()) WHERE id = $1",
        [recipeId, version]);
    } else if (kind === 'reject') {
      await client.query("UPDATE recipe_versions SET status = 'rejected' WHERE recipe_id = $1 AND version = $2", [recipeId, version]);
    } else if (kind === 'remove') {
      await client.query('UPDATE recipes SET removed_at = now(), removed_reason = $2 WHERE id = $1', [recipeId, text]);
      await client.query('UPDATE reports SET closed_at = now(), decision_id = $2 WHERE recipe_id = $1 AND closed_at IS NULL', [recipeId, id]);
    } else {
      await client.query('UPDATE reports SET closed_at = now(), decision_id = $2 WHERE id = $1', [reportId, id]);
    }
    await client.query('INSERT INTO admin_log (actor_id, action, target, detail) VALUES ($1, $2, $3, $4)',
      [moderatorId, action, String(recipeId), JSON.stringify({ recipeId: Number(recipeId), version: version === null ? null : Number(version), reason: text })]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function end(client, error) {
  await client.query('ROLLBACK');
  return { error };
}
