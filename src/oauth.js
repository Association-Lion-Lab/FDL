import { createHash, randomBytes } from 'node:crypto';

import { hashToken } from './accounts.js';

const CODE_MINUTES = 5;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

function validClient(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.pathname === '/' && !url.search && !url.hash
      && !url.username && !url.password && url.origin === value;
  } catch {
    return false;
  }
}

function validRedirect(value, clientId) {
  try {
    const url = new URL(value);
    return value.length <= 2000 && !value.includes('#') && url.href === value && url.origin === clientId;
  } catch {
    return false;
  }
}

export function parseAuthorization(params) {
  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';
  const state = params.get('state');
  if (!validClient(clientId) || !validRedirect(redirectUri, clientId)) return { ok: false, redirectUri: null, error: 'invalid_request', state };
  const challenge = params.get('code_challenge') ?? '';
  const fail = (error) => ({ ok: false, redirectUri, error, state });
  if (params.get('response_type') !== 'code') return fail('unsupported_response_type');
  if (!CHALLENGE.test(challenge) || params.get('code_challenge_method') !== 'S256' || (state ?? '').length > 500) return fail('invalid_request');
  return { ok: true, clientId, redirectUri, challenge, state };
}

export async function createCode(db, { accountId, clientId, redirectUri, challenge }) {
  const code = randomBytes(32).toString('base64url');
  await db.query('DELETE FROM oauth_codes WHERE expires_at < now()');
  await db.query(
    `INSERT INTO oauth_codes (code_hash, account_id, client_id, redirect_uri, challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + $6 * interval '1 minute')`,
    [hashToken(code), accountId, clientId, redirectUri, challenge, CODE_MINUTES]
  );
  return code;
}

export async function exchangeCode(db, { code, clientId, redirectUri, verifier }) {
  if (typeof code !== 'string' || typeof verifier !== 'string') return null;
  const { rows: [row] } = await db.query(
    `DELETE FROM oauth_codes WHERE code_hash = $1
     RETURNING account_id, client_id, redirect_uri, challenge, expires_at > now() AS fresh,
       (SELECT banned_at IS NULL FROM accounts WHERE id = account_id) AS active`,
    [hashToken(code)]
  );
  if (!row || !row.fresh || !row.active || row.client_id !== clientId || row.redirect_uri !== redirectUri) return null;
  if (!VERIFIER.test(verifier) || createHash('sha256').update(verifier).digest('base64url') !== row.challenge) return null;
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO oauth_tokens (token_hash, account_id, client_id) VALUES ($1, $2, $3)
     ON CONFLICT (account_id, client_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now()`,
    [hashToken(token), row.account_id, clientId]
  );
  return token;
}

export async function loadToken(db, token) {
  if (typeof token !== 'string' || !token) return null;
  const { rows: [row] } = await db.query(
    `SELECT a.id, a.role, a.display_name, t.client_id FROM oauth_tokens t JOIN accounts a ON a.id = t.account_id
     WHERE t.token_hash = $1 AND a.banned_at IS NULL`,
    [hashToken(token)]
  );
  return row ? { accountId: row.id, role: row.role, displayName: row.display_name, mfaOk: true, clientId: row.client_id } : null;
}

export async function listLinks(db, accountId) {
  const { rows } = await db.query(
    'SELECT client_id, created_at FROM oauth_tokens WHERE account_id = $1 ORDER BY created_at, client_id',
    [accountId]
  );
  return rows.map((r) => ({ clientId: r.client_id, createdAt: r.created_at }));
}

export async function revokeLink(db, accountId, clientId) {
  await db.query('DELETE FROM oauth_tokens WHERE account_id = $1 AND client_id = $2', [accountId, clientId]);
  await db.query('DELETE FROM oauth_codes WHERE account_id = $1 AND client_id = $2', [accountId, clientId]);
}
