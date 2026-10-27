import { randomBytes } from 'node:crypto';

import { hashToken } from './accounts.js';

const COOKIE = 'fdl_session';
const STAFF_HOURS = 12;
const MEMBER_HOURS = 30 * 24;

export async function openSession(db, accountId, { mfaOk }) {
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (token_hash, account_id, mfa_ok, expires_at)
     SELECT $1, a.id, $3,
            now() + make_interval(hours => CASE WHEN a.role IN ('moderator', 'admin') THEN $4::int ELSE $5::int END)
     FROM accounts a WHERE a.id = $2`,
    [hashToken(token), accountId, mfaOk, STAFF_HOURS, MEMBER_HOURS]
  );
  return token;
}

export async function loadSession(db, token) {
  if (typeof token !== 'string' || token === '') return null;
  const tokenHash = hashToken(token);
  const { rows } = await db.query(
    `SELECT s.account_id, s.mfa_ok, s.elevated_until, s.expires_at <= now() AS expired,
            a.role, a.display_name, a.banned_at IS NOT NULL AS banned
     FROM sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = $1`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row) return null;
  if (row.expired || row.banned) {
    await closeSession(db, tokenHash);
    return null;
  }
  return {
    tokenHash,
    accountId: row.account_id,
    role: row.role,
    displayName: row.display_name,
    mfaOk: row.mfa_ok,
    elevatedUntil: row.elevated_until,
  };
}

export async function closeSession(db, tokenHash) {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

export const sessionCookie = (token, maxAgeSeconds) =>
  `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;

export const clearSessionCookie = () => sessionCookie('', 0);
