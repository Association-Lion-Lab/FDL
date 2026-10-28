import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import * as OTPAuth from 'otpauth';
import { renderSVG } from 'uqr';

import { hashToken } from './accounts.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;

export function encryptSecret(key, accountId, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(accountId)));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64'))).join(':');
}

export function decryptSecret(key, accountId, stored) {
  const [version, iv, tag, data] = String(stored).split(':');
  if (version !== 'v1' || !data) throw new Error('Secret illisible.');
  const tagBytes = Buffer.from(tag, 'base64');
  if (tagBytes.length !== 16) throw new Error('Secret illisible.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(String(accountId)));
  decipher.setAuthTag(tagBytes);
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

const makeTotp = (label, secret) => new OTPAuth.TOTP({
  issuer: 'Faim de Lion', label, algorithm: 'SHA1', digits: 6, period: PERIOD, secret,
});

// Replaces an unconfirmed secret; a confirmed one is left alone and the call throws.
export async function startTotp(db, key, accountId, label) {
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = makeTotp(label, secret);
  const { rowCount } = await db.query(
    `INSERT INTO totp_secrets (account_id, secret) VALUES ($1, $2)
     ON CONFLICT (account_id) DO UPDATE SET secret = EXCLUDED.secret, last_step = NULL
     WHERE totp_secrets.confirmed_at IS NULL`,
    [accountId, encryptSecret(key, accountId, secret.base32)]
  );
  if (!rowCount) throw Object.assign(new Error('Le code à 6 chiffres est déjà activé.'), { code: 'totp_confirmed' });
  const uri = totp.toString();
  return { secret: secret.base32, uri, qrSvg: renderSVG(uri) };
}

// Sign-in only accepts a confirmed secret; `activate` lets the first good code confirm a pending one.
export async function verifyTotp(db, key, accountId, code, { activate = false } = {}) {
  const token = String(code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(token)) return false;
  const { rows: [row] } = await db.query('SELECT secret, confirmed_at FROM totp_secrets WHERE account_id = $1', [accountId]);
  if (!row || (!activate && !row.confirmed_at)) return false;
  const totp = makeTotp('x', OTPAuth.Secret.fromBase32(decryptSecret(key, accountId, row.secret)));
  const timestamp = Date.now();
  const delta = totp.validate({ token, timestamp, window: 1 });
  if (delta === null) return false;
  const step = Math.floor(timestamp / 1000 / PERIOD) + delta;
  // One statement: a replayed step, even from a concurrent request, updates no row.
  const { rowCount } = await db.query(
    `UPDATE totp_secrets SET last_step = $2, confirmed_at = COALESCE(confirmed_at, now())
     WHERE account_id = $1 AND (last_step IS NULL OR last_step < $2)`,
    [accountId, step]
  );
  return rowCount > 0;
}

const normalizeCode = (code) => String(code).replace(/[\s-]/g, '').toUpperCase();

export async function createRecoveryCodes(db, accountId) {
  const codes = Array.from({ length: 10 }, () =>
    Array.from(randomBytes(10), (b) => BASE32[b & 31]).join(''));
  // Delete and insert in one statement so a failure never leaves the account without codes.
  await db.query(
    `WITH gone AS (DELETE FROM recovery_codes WHERE account_id = $1)
     INSERT INTO recovery_codes (account_id, code_hash) SELECT $1, unnest($2::bytea[])`,
    [accountId, codes.map(hashToken)]
  );
  return codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`);
}

export async function useRecoveryCode(db, accountId, code) {
  const { rowCount } = await db.query(
    'UPDATE recovery_codes SET used_at = now() WHERE account_id = $1 AND code_hash = $2 AND used_at IS NULL',
    [accountId, hashToken(normalizeCode(code))]
  );
  return rowCount > 0;
}

export async function hasSecondFactor(db, accountId) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM totp_secrets WHERE account_id = $1 AND confirmed_at IS NOT NULL
     UNION ALL SELECT 1 FROM passkeys WHERE account_id = $1`,
    [accountId]
  );
  return rowCount > 0;
}
