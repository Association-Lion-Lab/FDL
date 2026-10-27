import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const LINK_LIFETIME_DAYS = 14;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [name, N, r, p, salt, hash] = String(stored).split('$');
  if (name !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem
  });
  return timingSafeEqual(actual, expected);
}

export function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 12) return 'Le mot de passe doit contenir au moins 12 caractères.';
  if (password.length > 256) return 'Le mot de passe doit contenir au plus 256 caractères.';
  return null;
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest();
}

export async function createLink(db, { kind, role = null, accountId = null, note = null, createdBy = null }) {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO access_links (token_hash, kind, role, account_id, note, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))`,
    [hashToken(token), kind, role, accountId, note, createdBy, LINK_LIFETIME_DAYS]
  );
  return token;
}

// Runs fn(client) in one transaction. The link is consumed by a single conditional UPDATE, so
// two parallel redemptions cannot both succeed; any later failure rolls the consumption back.
async function withLink(db, token, kind, fn) {
  if (typeof token !== 'string') return { error: 'link_invalid' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [link] } = await client.query(
      `UPDATE access_links SET used_at = now()
       WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       RETURNING role, account_id`,
      [hashToken(token), kind]
    );
    if (!link) {
      await client.query('ROLLBACK');
      return { error: 'link_invalid' };
    }
    const result = await fn(client, link);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return { error: 'email_taken' };
    throw error;
  } finally {
    client.release();
  }
}

export async function redeemInvitation(db, { token, email, displayName, password }) {
  email = String(email ?? '').trim();
  displayName = String(displayName ?? '').trim();
  if (!email.includes('@')) return { error: 'invalid_email' };
  if (!displayName || displayName.length > 60) return { error: 'invalid_name' };
  if (checkPassword(password)) return { error: 'invalid_password' };
  const passwordHash = await hashPassword(password); // before the transaction: no row lock held while hashing
  return withLink(db, token, 'invitation', async (client, link) => {
    const { rows: [account] } = await client.query(
      'INSERT INTO accounts (email, display_name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [email, displayName, passwordHash, link.role ?? 'member']
    );
    return { accountId: account.id };
  });
}

export async function redeemReset(db, { token, password }) {
  if (checkPassword(password)) return { error: 'invalid_password' };
  const passwordHash = await hashPassword(password);
  return withLink(db, token, 'reset', async (client, link) => {
    const id = link.account_id;
    await client.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [id, passwordHash]);
    for (const table of ['sessions', 'totp_secrets', 'passkeys', 'recovery_codes']) {
      await client.query(`DELETE FROM ${table} WHERE account_id = $1`, [id]);
    }
    return { accountId: id };
  });
}
