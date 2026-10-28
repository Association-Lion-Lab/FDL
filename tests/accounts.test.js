import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  checkPassword, createLink, hashPassword, hashToken, redeemInvitation, redeemReset, verifyPassword
} from '../src/accounts.js';
import { migrate } from '../src/db.js';
import { createTestDatabase } from './helpers/db.js';

const PASSWORD = 'correct horse battery';
let testDb;
let pool;

before(async () => {
  testDb = await createTestDatabase();
  pool = testDb.pool;
  await migrate(pool);
});

after(async () => {
  await testDb.drop();
});

const count = async (sql, params) => Number((await pool.query(sql, params)).rows[0].n);
const accountCount = () => count('SELECT count(*) AS n FROM accounts');
const person = (token, n, extra = {}) => ({
  token, email: `user${n}@example.org`, displayName: `User ${n}`, password: PASSWORD, ...extra
});
const invitation = (role = 'member') => createLink(pool, { kind: 'invitation', role });

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    assert.match(a, /^scrypt\$32768\$8\$1\$[^$]+\$[^$]+$/);
    assert.notEqual(a, b);
    assert.equal(await verifyPassword(PASSWORD, a), true);
    assert.equal(await verifyPassword('another password!', a), false);
  });

  it('returns false, without throwing, for malformed stored hashes', async () => {
    const good = await hashPassword(PASSWORD);
    const [, , , , salt, hash] = good.split('$');
    const bad = [
      'scrypt$32768$8$1$c2FsdA==$!!!', 'scrypt$32768$8$1$c2FsdA==$=', 'scrypt$32768$8$1$c2FsdA==$AA',
      `scrypt$abc$8$1$${salt}$${hash}`, `scrypt$1048576$8$1$${salt}$${hash}`, `scrypt$32768$8$1$${salt}`,
      `bcrypt$32768$8$1$${salt}$${hash}`, `scrypt$32768$8$1$${salt}$${hash}x`, '', 'scrypt'
    ];
    for (const stored of bad) assert.equal(await verifyPassword('', stored), false, stored);
    assert.equal(await verifyPassword(PASSWORD, good), true);
  });

  it('checks length', () => {
    assert.match(checkPassword('court'), /12/);
    assert.match(checkPassword('x'.repeat(257)), /256/);
    assert.equal(checkPassword('x'.repeat(12)), null);
    assert.equal(checkPassword('x'.repeat(256)), null);
  });
});

describe('invitations', () => {
  it('creates the account with the invitation role and never stores the token', async () => {
    const token = await invitation('moderator');
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const { rows } = await pool.query("SELECT token_hash, expires_at > now() + interval '13 days' AS long FROM access_links");
    assert.ok(rows.some((r) => r.token_hash.equals(hashToken(token)) && r.long));
    assert.ok(rows.every((r) => !r.token_hash.equals(Buffer.from(token))));
    const result = await redeemInvitation(pool, person(token, 1));
    assert.ok(result.accountId);
    const { rows: [account] } = await pool.query('SELECT role, password_hash FROM accounts WHERE id = $1', [result.accountId]);
    assert.equal(account.role, 'moderator');
    assert.equal(await verifyPassword(PASSWORD, account.password_hash), true);
  });

  it('refuses a second use', async () => {
    const before = await accountCount();
    const token = await invitation();
    assert.ok((await redeemInvitation(pool, person(token, 2))).accountId);
    assert.deepEqual(await redeemInvitation(pool, person(token, 3)), { error: 'link_invalid' });
    assert.equal(await accountCount(), before + 1);
  });

  it('lets exactly one of two parallel redemptions win', async () => {
    const before = await accountCount();
    const token = await invitation();
    const results = await Promise.all([
      redeemInvitation(pool, person(token, 4)),
      redeemInvitation(pool, person(token, 5))
    ]);
    assert.equal(results.filter((r) => r.accountId).length, 1);
    assert.equal(results.filter((r) => r.error === 'link_invalid').length, 1);
    assert.equal(await accountCount(), before + 1);
  });

  it('refuses expired, revoked and unknown links', async () => {
    const expired = await invitation();
    await pool.query("UPDATE access_links SET expires_at = now() - interval '1 second' WHERE token_hash = $1", [hashToken(expired)]);
    const revoked = await invitation();
    await pool.query('UPDATE access_links SET revoked_at = now() WHERE token_hash = $1', [hashToken(revoked)]);
    assert.deepEqual(await redeemInvitation(pool, person(expired, 6)), { error: 'link_invalid' });
    assert.deepEqual(await redeemInvitation(pool, person(revoked, 7)), { error: 'link_invalid' });
    assert.deepEqual(await redeemInvitation(pool, person('unknown', 8)), { error: 'link_invalid' });
  });

  it('refuses a taken email in another case and keeps the link usable', async () => {
    await redeemInvitation(pool, person(await invitation(), 9));
    const token = await invitation();
    assert.deepEqual(await redeemInvitation(pool, person(token, 10, { email: 'USER9@Example.org' })), { error: 'email_taken' });
    assert.ok((await redeemInvitation(pool, person(token, 10))).accountId);
  });

  it('validates input without burning the link', async () => {
    const token = await invitation();
    assert.deepEqual(await redeemInvitation(pool, person(token, 11, { email: 'nope' })), { error: 'invalid_email' });
    assert.deepEqual(await redeemInvitation(pool, person(token, 11, { displayName: '   ' })), { error: 'invalid_name' });
    assert.deepEqual(await redeemInvitation(pool, person(token, 11, { displayName: 'x'.repeat(61) })), { error: 'invalid_name' });
    assert.deepEqual(await redeemInvitation(pool, person(token, 11, { password: 'short' })), { error: 'invalid_password' });
    assert.ok((await redeemInvitation(pool, person(token, 11))).accountId);
  });

  it('does not accept a reset link as an invitation', async () => {
    const { accountId } = await redeemInvitation(pool, person(await invitation(), 12));
    const reset = await createLink(pool, { kind: 'reset', accountId });
    assert.deepEqual(await redeemInvitation(pool, person(reset, 13)), { error: 'link_invalid' });
  });
});

describe('redeemReset', () => {
  it('changes the password and clears every second factor and session', async () => {
    const { accountId } = await redeemInvitation(pool, person(await invitation(), 14));
    await pool.query("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ('\\x01', $1, now() + interval '1 day')", [accountId]);
    await pool.query("INSERT INTO totp_secrets (account_id, secret) VALUES ($1, 's')", [accountId]);
    await pool.query("INSERT INTO passkeys (id, account_id, public_key, counter, name) VALUES ('p', $1, '\\x01', 0, 'k')", [accountId]);
    await pool.query("INSERT INTO recovery_codes (account_id, code_hash) VALUES ($1, '\\x01')", [accountId]);

    const token = await createLink(pool, { kind: 'reset', accountId });
    assert.deepEqual(await redeemReset(pool, { token, password: 'a brand new password' }), { accountId });
    const { rows: [account] } = await pool.query('SELECT password_hash FROM accounts WHERE id = $1', [accountId]);
    assert.equal(await verifyPassword('a brand new password', account.password_hash), true);
    for (const table of ['sessions', 'totp_secrets', 'passkeys', 'recovery_codes']) {
      assert.equal(await count(`SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [accountId]), 0, table);
    }
    assert.deepEqual(await redeemReset(pool, { token, password: 'a brand new password' }), { error: 'link_invalid' });
  });

  it('constrains the kind and role of a link', async () => {
    const insert = (kind, role) => pool.query(
      "INSERT INTO access_links (token_hash, kind, role, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')",
      [hashToken(`constraint-${kind}-${role}`), kind, role]);
    await assert.rejects(insert('invitation', 'boss'), { code: '23514' });
    await assert.rejects(insert('reset', 'admin'), { code: '23514' });
    await assert.rejects(insert(null, null), { code: '23502' });
    await insert('invitation', null);
  });

  it('refuses a reset link without account and does not create one', async () => {
    await assert.rejects(createLink(pool, { kind: 'reset' }));
    const token = 'orphan-reset-token';
    await pool.query("INSERT INTO access_links (token_hash, kind, expires_at) VALUES ($1, 'reset', now() + interval '1 day')", [hashToken(token)]);
    assert.deepEqual(await redeemReset(pool, { token, password: PASSWORD }), { error: 'link_invalid' });
    const { rows: [link] } = await pool.query('SELECT used_at FROM access_links WHERE token_hash = $1', [hashToken(token)]);
    assert.equal(link.used_at, null);
  });

  it('refuses an invitation token and a weak password without burning the link', async () => {
    const { accountId } = await redeemInvitation(pool, person(await invitation(), 15));
    assert.deepEqual(await redeemReset(pool, { token: await invitation(), password: PASSWORD }), { error: 'link_invalid' });
    const token = await createLink(pool, { kind: 'reset', accountId });
    assert.deepEqual(await redeemReset(pool, { token, password: 'short' }), { error: 'invalid_password' });
    assert.deepEqual(await redeemReset(pool, { token, password: PASSWORD }), { accountId });
  });
});
