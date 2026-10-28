import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// One JSON line per event in <dataDir>/logs/securite.log. Callers pass account ids, IPs and
// (for failures only) an e-mail: never a password, token, cookie or code.
// Without a data directory (unit tests) it does nothing.
// Failure events never change the response they accompany: a write error goes to stderr
// (without the fields) and the caller carries on. Other events fail closed (they throw).
const BEST_EFFORT = new Set(['login_failed', 'mfa_failed', 'rate_limited']);

export function createSecurityLog(dataDir) {
  return (event, fields = {}) => {
    if (!dataDir) return;
    try {
      const dir = join(dataDir, 'logs');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(join(dir, 'securite.log'), `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 });
    } catch (error) {
      if (!BEST_EFFORT.has(event)) throw error;
      console.error(`journal de sécurité : écriture impossible (${event}, ${error?.code ?? 'inconnu'})`);
    }
  };
}
