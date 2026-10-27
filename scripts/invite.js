import { fileURLToPath } from 'node:url';

import { createLink } from '../src/accounts.js';
import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';

const ROLES = ['member', 'adherent', 'moderator', 'admin'];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let pool;
  try {
    const role = process.argv[2] ?? 'member';
    if (!ROLES.includes(role)) throw new Error(`Usage : npm run invite -- <${ROLES.join('|')}>`);
    const config = loadConfig(process.env);
    pool = createPool();
    await migrate(pool);
    const token = await createLink(pool, { kind: 'invitation', role, note: 'script invite' });
    console.log(`${config.origin}/inscription?code=${token}`);
  } catch (error) {
    console.error(`Invitation impossible : ${String(error.message).trim().split('\n')[0]}`);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
