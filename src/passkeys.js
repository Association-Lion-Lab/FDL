import { readFileSync } from 'node:fs';

import * as simplewebauthnServer from '@simplewebauthn/server';

import { sendError, sendJson } from './http.js';
import { createRecoveryCodes, hasSecondFactor } from './mfa.js';
import { createLimiter } from './ratelimit.js';
import { clientIp, promoteSession } from './routes/auth.js';
import { elevateSession } from './sessions.js';
import { readBody } from './web.js';

const browserBundle = readFileSync(new URL('../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js', import.meta.url));
const clientScript = readFileSync(new URL('./static/fdl-passkeys.js', import.meta.url));
const FAILED = "La clé d'accès n'a pas été reconnue.";

const sendScript = (body) => (request, response) => {
  response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' });
  response.end(body);
};

export function passkeyRoutes(pool, config, lib = simplewebauthnServer, { limiter = createLimiter(), securityLog = () => {} } = {}) {
  const failed = (response) => sendError(response, 400, 'passkey_failed', FAILED);

  // Reads and clears the pending challenge in one statement, so it can be used once.
  async function takeChallenge(session) {
    const { rows: [row] } = await pool.query(
      `UPDATE sessions s SET challenge = NULL
       FROM (SELECT token_hash, challenge FROM sessions WHERE token_hash = $1 FOR UPDATE) old
       WHERE s.token_hash = old.token_hash RETURNING old.challenge`,
      [session.tokenHash]
    );
    return row?.challenge ?? null;
  }

  const saveChallenge = (session, options) =>
    pool.query('UPDATE sessions SET challenge = $2 WHERE token_hash = $1', [session.tokenHash, options.challenge]);

  const listKeys = async (accountId) =>
    (await pool.query('SELECT id, transports FROM passkeys WHERE account_id = $1 ORDER BY created_at', [accountId])).rows
      .map((k) => ({ id: k.id, transports: k.transports ?? undefined }));

  // `full` false serves the sign-in step (half session), true the re-authentication (full session).
  const authOptions = (full) => async (request, response) => {
    const session = request.session;
    if (!session || session.mfaOk !== full) return failed(response);
    const options = await lib.generateAuthenticationOptions({
      rpID: config.rpID,
      allowCredentials: await listKeys(session.accountId),
      userVerification: 'preferred',
    });
    await saveChallenge(session, options);
    sendJson(response, 200, options);
  };

  // Verifies the passkey assertion in the body against the pending challenge; true if it holds.
  async function assertKey(request) {
    const session = request.session;
    const expectedChallenge = await takeChallenge(session);
    const body = await readBody(request);
    const id = typeof body.response?.id === 'string' ? body.response.id : '';
    const { rows: [row] } = await pool.query(
      'SELECT id, public_key, counter, transports FROM passkeys WHERE id = $1 AND account_id = $2',
      [id, session.accountId]
    );
    if (!expectedChallenge || !row) return false;
    try {
      const result = await lib.verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge,
        expectedOrigin: config.origin,
        expectedRPID: config.rpID,
        requireUserVerification: false,
        credential: {
          id: row.id,
          publicKey: new Uint8Array(row.public_key),
          counter: Number(row.counter),
          transports: row.transports ?? undefined,
        },
      });
      if (!result.verified) return false;
      await pool.query('UPDATE passkeys SET counter = $2 WHERE id = $1', [row.id, result.authenticationInfo.newCounter]);
      return true;
    } catch {
      return false;
    }
  }

  const assertion = (full, succeed) => async (request, response) => {
    const session = request.session;
    if (!session || session.mfaOk !== full) return failed(response);
    // Sign-in shares its key with the TOTP step: switching method does not reset the count.
    const key = `${full ? 'elevation' : 'verification'}:${session.accountId}`;
    const who = { scope: full ? 'elevation' : 'verification', accountId: session.accountId, ip: clientIp(request) };
    if (limiter.hit(key)) {
      securityLog('rate_limited', who);
      return sendError(response, 429, 'too_many', 'Trop de tentatives. Réessayez dans 15 minutes.');
    }
    if (!(await assertKey(request))) {
      securityLog('mfa_failed', who);
      return failed(response);
    }
    limiter.reset(key);
    await succeed(request, response);
  };

  return {
    'GET /static/simplewebauthn.js': sendScript(browserBundle),
    'GET /static/fdl-passkeys.js': sendScript(clientScript),

    'POST /cles/inscription/options': async (request, response) => {
      const { accountId } = request.session;
      const { rows: [account] } = await pool.query('SELECT email FROM accounts WHERE id = $1', [accountId]);
      const options = await lib.generateRegistrationOptions({
        rpName: 'Faim de Lion',
        rpID: config.rpID,
        userName: account.email,
        userID: Buffer.from(String(accountId)),
        excludeCredentials: await listKeys(accountId),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      });
      await saveChallenge(request.session, options);
      sendJson(response, 200, options);
    },

    'POST /cles/inscription/verification': async (request, response) => {
      const { accountId } = request.session;
      const expectedChallenge = await takeChallenge(request.session);
      const body = await readBody(request);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!expectedChallenge || !name || name.length > 40) return failed(response);
      let info;
      try {
        const result = await lib.verifyRegistrationResponse({
          response: body.response,
          expectedChallenge,
          expectedOrigin: config.origin,
          expectedRPID: config.rpID,
          requireUserVerification: false,
        });
        if (!result.verified) return failed(response);
        info = result.registrationInfo.credential;
      } catch {
        return failed(response);
      }
      const firstFactor = !(await hasSecondFactor(pool, accountId));
      const { rowCount } = await pool.query(
        `INSERT INTO passkeys (id, account_id, public_key, counter, transports, name)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [info.id, accountId, Buffer.from(info.publicKey), info.counter, info.transports ?? null, name]
      );
      if (!rowCount) return failed(response);
      response.setHeader('cache-control', 'no-store');
      sendJson(response, 200, {
        ok: true,
        ...(firstFactor ? { recoveryCodes: await createRecoveryCodes(pool, accountId) } : {}),
      });
    },

    'POST /cles/connexion/options': authOptions(false),
    'POST /cles/connexion/verification': assertion(false, async (request, response) => {
      response.setHeader('set-cookie', await promoteSession(pool, request.session, request, securityLog));
      sendJson(response, 200, { ok: true });
    }),

    // Re-authentication of a full staff session (/admin/confirmation).
    'POST /cles/confirmation/options': authOptions(true),
    'POST /cles/confirmation/verification': assertion(true, async (request, response) => {
      await elevateSession(pool, request.session.tokenHash);
      sendJson(response, 200, { ok: true });
    }),
  };
}
