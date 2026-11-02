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
  if (!(await recipeVisible(db, recipeId))) throw fail('not_found', 'Recette introuvable.');
  const text = clean(body);
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
  const { rows: [row] } = await db.query('DELETE FROM comments WHERE id = $1 AND author_id = $2 RETURNING recipe_id', [commentId, authorId]);
  return row ? Number(row.recipe_id) : null;
}

const DECISIONS = {
  accept: ['accepted', 'comment_accepted', 'pending', 'published'],
  reject: ['rejected', 'comment_rejected', 'pending', 'rejected'],
  remove: ['removed', 'comment_removed', 'published', 'removed'],
};

// Same shape as moderation.decide: lock the row, check its state, write the decision, then the log.
export async function decideComment(db, { moderatorId, kind, commentId, reason }) {
  const [decision, action, from, to] = Object.hasOwn(DECISIONS, kind) ? DECISIONS[kind] : [];
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!decision || text.length < 1 || text.length > 500) return { error: 'bad_reason' };
  const client = await db.connect();
  const end = async (error) => { await client.query('ROLLBACK'); return { error }; };
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      'SELECT c.recipe_id, c.status, r.removed_at FROM comments c JOIN recipes r ON r.id = c.recipe_id WHERE c.id = $1 FOR UPDATE OF c', [commentId]);
    if (!row) return await end('not_found');
    if (row.status !== from || row.removed_at) return await end('already_done');
    const { rows: [{ id }] } = await client.query(
      'INSERT INTO moderation_decisions (recipe_id, comment_id, moderator_id, decision, reason) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [row.recipe_id, commentId, moderatorId, decision, text]);
    // An accepted comment keeps no reason; a refused or removed one shows it to its author.
    await client.query('UPDATE comments SET status = $2, reason = $3 WHERE id = $1', [commentId, to, kind === 'accept' ? null : text]);
    if (kind === 'remove') await client.query('UPDATE reports SET closed_at = now(), decision_id = $2 WHERE comment_id = $1 AND closed_at IS NULL', [commentId, id]);
    await client.query('INSERT INTO admin_log (actor_id, action, target, detail) VALUES ($1, $2, $3, $4)',
      [moderatorId, action, String(commentId), JSON.stringify({ recipeId: Number(row.recipe_id), commentId: Number(commentId), reason: text })]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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

// The author's own comment for the edit form; null when foreign or removed.
export async function getOwnComment(db, { commentId, authorId }) {
  const { rows: [row] } = await db.query(
    "SELECT id, recipe_id, body, status FROM comments WHERE id = $1 AND author_id = $2 AND status <> 'removed'",
    [commentId, authorId]
  );
  return row ? { id: Number(row.id), recipeId: Number(row.recipe_id), body: row.body, status: row.status } : null;
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
