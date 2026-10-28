import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkFields, insertVersion, VISIBLE } from './recipes.js';

export const TRUST_THRESHOLD = 3;

const fail = (code, message) => Object.assign(new Error(message), { code });
const notFound = () => fail('not_found', 'Recette introuvable.');

// Lowercase without accents, so "Pâtes" and "pates" compare equal.
const fold = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export async function saveDraft(db, { recipeId = null, authorId, draft }) {
  try {
    if (recipeId === null) {
      const { rows } = await db.query(
        "INSERT INTO recipes (author_id, visibility, draft) VALUES ($1, 'draft', $2) RETURNING id",
        [authorId, JSON.stringify(draft)]
      );
      return { id: Number(rows[0].id) };
    }
    const { rowCount } = await db.query(
      'UPDATE recipes SET draft = $3 WHERE id = $1 AND author_id = $2 AND removed_at IS NULL',
      [recipeId, authorId, JSON.stringify(draft)]
    );
    if (!rowCount) throw notFound();
    return { id: Number(recipeId) };
  } catch (error) {
    // The CHECK on the stored (jsonb) size can fail even when the request body was under its cap.
    if (error.code === '23514') throw fail('draft_too_large', 'Brouillon trop volumineux.');
    throw error;
  }
}

export async function isTrusted(db, authorId) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM recipes WHERE author_id = $1 AND published_version IS NOT NULL AND removed_at IS NULL',
    [authorId]
  );
  return rows[0].n >= TRUST_THRESHOLD;
}

async function bannedWords(dataDir) {
  try {
    return (await readFile(join(dataDir, 'mots-interdits.txt'), 'utf8')).split(/\r?\n/).map((w) => fold(w.trim())).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function autoFlags(db, fields, { recipeId = null, dataDir }) {
  const flags = [];
  const texts = [fields.title, ...fields.ingredients.map((i) => i.name), ...fields.steps.map((s) => s.instruction), fields.provenance];
  if (texts.some((t) => /https?:\/\/|www\./i.test(t))) flags.push('link');
  const banned = new Set(await bannedWords(dataDir));
  if (banned.size && texts.some((t) => fold(t).split(/[^\p{L}\p{N}]+/u).some((w) => banned.has(w)))) flags.push('banned_word');
  // ponytail: compares in JS against every visible title; move to a normalized column if the catalogue grows past a few thousand.
  const { rows } = await db.query(`SELECT v.title ${VISIBLE} AND r.id IS DISTINCT FROM $1`, [recipeId]);
  const title = fold(fields.title);
  if (rows.some((r) => fold(r.title) === title)) flags.push('duplicate');
  return flags;
}

export async function submitVersion(db, { recipeId, authorId, mode, dataDir }) {
  if (mode !== 'public' && mode !== 'private') throw fail('invalid_mode', 'Mode inconnu.');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Lock first: two concurrent submissions queue up, and the second replaces the first.
    const { rows: [recipe] } = await client.query(
      'SELECT draft, published_version FROM recipes WHERE id = $1 AND author_id = $2 AND removed_at IS NULL FOR UPDATE',
      [recipeId, authorId]
    );
    if (!recipe) throw notFound();
    const fields = checkFields(recipe.draft ?? {});
    if (mode === 'private' && recipe.published_version !== null) {
      throw fail('already_public', 'Une recette publiée ne redevient pas privée.');
    }
    let status = 'private';
    let flags = [];
    if (mode === 'public') {
      flags = await autoFlags(client, fields, { recipeId, dataDir });
      status = flags.length || !(await isTrusted(client, authorId)) ? 'pending' : 'published';
    }
    const { rows: replaced } = await client.query(
      "UPDATE recipe_versions SET status = 'rejected' WHERE recipe_id = $1 AND status = 'pending' RETURNING version",
      [recipeId]
    );
    for (const { version } of replaced) {
      await client.query(
        "INSERT INTO moderation_decisions (recipe_id, version, decision, reason) VALUES ($1, $2, 'rejected', 'Remplacée par une version plus récente.')",
        [recipeId, version]
      );
    }
    const { rows: [{ version }] } = await client.query(
      'SELECT coalesce(max(version), 0) + 1 AS version FROM recipe_versions WHERE recipe_id = $1',
      [recipeId]
    );
    await insertVersion(client, recipeId, version, fields, status, flags);
    if (status === 'published') {
      await client.query(
        "UPDATE recipes SET visibility = 'public', published_version = $2, published_at = coalesce(published_at, now()) WHERE id = $1",
        [recipeId, version]
      );
    } else if (status === 'private') {
      await client.query("UPDATE recipes SET visibility = 'private' WHERE id = $1 AND published_version IS NULL", [recipeId]);
    }
    await client.query('COMMIT');
    return { version, status, flags };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23503' || error.code === '23514') throw fail('invalid_recipe', 'Recette invalide.');
    throw error;
  } finally {
    client.release();
  }
}

const STATE = `CASE
  WHEN r.removed_at IS NOT NULL THEN 'removed'
  WHEN r.published_version IS NOT NULL THEN
    CASE WHEN EXISTS (SELECT 1 FROM recipe_versions p WHERE p.recipe_id = r.id AND p.status = 'pending') THEN 'published_pending' ELSE 'published' END
  WHEN l.status IS NULL THEN 'draft'
  ELSE l.status END`;

// Newest first; l is the latest version, d the latest decision.
const OWN = `SELECT r.id, r.draft, ${STATE} AS state, l.version, l.status, l.flags, l.title AS version_title, l.minutes, l.servings, l.diet,
    l.tags, l.seasons, l.universe, l.ingredients, l.steps, l.provenance, l.source_url, d.decision, d.reason, d.at
  FROM recipes r
  LEFT JOIN LATERAL (SELECT * FROM recipe_versions WHERE recipe_id = r.id ORDER BY version DESC LIMIT 1) l ON true
  LEFT JOIN LATERAL (SELECT * FROM moderation_decisions WHERE recipe_id = r.id ORDER BY at DESC, id DESC LIMIT 1) d ON true
  WHERE r.author_id = $1`;

export async function listMine(db, authorId) {
  const { rows } = await db.query(`${OWN} ORDER BY r.id DESC`, [authorId]);
  return rows.map((row) => ({
    id: Number(row.id),
    title: row.version_title || row.draft?.title || 'Sans titre',
    state: row.state,
    lastDecision: row.decision ? { decision: row.decision, reason: row.reason, at: row.at } : null,
  }));
}

export async function getOwnRecipe(db, { recipeId, authorId }) {
  const { rows } = await db.query(`${OWN} AND r.id = $2`, [authorId, recipeId]);
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: Number(row.id),
    draft: row.draft,
    state: row.state,
    latest: row.version === null ? null : {
      version: row.version, status: row.status, flags: row.flags, title: row.version_title, minutes: row.minutes,
      servings: row.servings, diet: row.diet, tags: row.tags, seasons: row.seasons, universe: row.universe,
      ingredients: row.ingredients, steps: row.steps, provenance: row.provenance, sourceUrl: row.source_url,
    },
  };
}
