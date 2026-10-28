import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// One JSON line per event in <dataDir>/logs/securite.log. Callers pass account ids, IPs and
// (for failures only) an e-mail: never a password, token, cookie or code.
// Without a data directory (unit tests) it does nothing.
export function createSecurityLog(dataDir) {
  return (event, fields = {}) => {
    if (!dataDir) return;
    const dir = join(dataDir, 'logs');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, 'securite.log'), `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`, { mode: 0o600 });
  };
}
