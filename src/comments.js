import { isTrusted, textFlags } from './contributions.js';
import { VISIBLE } from './recipes.js';

export const COMMENT_INVALID = 'Le commentaire doit faire de 1 à 1 000 caractères.';
export const COMMENT_TRUST = 3;

const fail = (code, message) => Object.assign(new Error(message), { code });
const notFound = () => fail('not_found', 'Commentaire introuvable.');

function clean(body) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (text.length < 1 || text.length > 1000) throw fail('invalid_comment', COMMENT_INVALID);
  return text;
}

async function recipeVisible(db, recipeId) {
  const { rowCount } = await db.query(`SELECT 1 ${VISIBLE} AND r.id = $1`, [recipeId]);
  return rowCount > 0;
}

async function isCommentTrusted(db, accountId) {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM comments WHERE author_id = $1 AND status = 'published'", [accountId]);
  return rows[0].n >= COMMENT_TRUST || isTrusted(db, accountId);
}

async function statusFor(db, accountId, text, dataDir) {
  const flags = await textFlags([text], dataDir);
  const status = !flags.length && (await isCommentTrusted(db, accountId)) ? 'published' : 'pending';
  return { status, flags };
}

export async function addComment(db, { recipeId, authorId, body, dataDir }) {
  const text = clean(body);
  if (!(await recipeVisible(db, recipeId))) throw fail('not_found', 'Recette introuvable.');
  const { status, flags } = await statusFor(db, authorId, text, dataDir);
  const { rows } = await db.query(
    'INSERT INTO comments (recipe_id, author_id, body, status, flags) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [recipeId, authorId, text, status, flags]
  );
  return { id: Number(rows[0].id), status };
}

export async function editComment(db, { commentId, authorId, body, dataDir }) {
  const text = clean(body);
  const { rows: [row] } = await db.query(
    "SELECT recipe_id FROM comments WHERE id = $1 AND author_id = $2 AND status <> 'removed'",
    [commentId, authorId]
  );
  if (!row || !(await recipeVisible(db, row.recipe_id))) throw notFound();
  const { status, flags } = await statusFor(db, authorId, text, dataDir);
  // Re-check the status in the UPDATE: a moderator may have removed it meanwhile.
  const { rowCount } = await db.query(
    "UPDATE comments SET body = $3, status = $4, flags = $5, reason = NULL, edited_at = now() WHERE id = $1 AND author_id = $2 AND status <> 'removed'",
    [commentId, authorId, text, status, flags]
  );
  if (!rowCount) throw notFound();
  return { status };
}

export async function deleteComment(db, { commentId, authorId }) {
  const { rowCount } = await db.query('DELETE FROM comments WHERE id = $1 AND author_id = $2', [commentId, authorId]);
  return rowCount > 0;
}

export async function listComments(db, { recipeId, viewerId = null }) {
  const { rows } = await db.query(
    `SELECT c.id, c.author_id, a.display_name AS author, c.body, c.status, c.reason, c.created_at, c.edited_at
     FROM comments c JOIN accounts a ON a.id = c.author_id
     WHERE c.recipe_id = $1 AND (c.author_id = $2 OR (c.status = 'published' AND a.banned_at IS NULL))
     ORDER BY c.id`,
    [recipeId, viewerId]
  );
  return rows.map((r) => ({
    id: Number(r.id), author: r.author, body: r.body, status: r.status, reason: r.reason,
    createdAt: r.created_at, editedAt: r.edited_at, mine: viewerId !== null && Number(r.author_id) === Number(viewerId),
  }));
}

export async function visibleComment(db, commentId) {
  const { rows: [row] } = await db.query(
    `SELECT c.id, c.recipe_id FROM comments c JOIN accounts ca ON ca.id = c.author_id
     WHERE c.id = $1 AND c.status = 'published' AND ca.banned_at IS NULL`,
    [commentId]
  );
  if (!row || !(await recipeVisible(db, row.recipe_id))) return null;
  return { id: Number(row.id), recipeId: Number(row.recipe_id) };
}
