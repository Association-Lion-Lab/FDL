import { randomBytes } from 'node:crypto';

import { createPool } from '../../src/db.js';

export async function createTestDatabase() {
  if (!process.env.PGHOST) {
    throw new Error('Tests base : lancez npm run test:docker.');
  }
  const database = `fdl_test_${randomBytes(8).toString('hex')}`;
  const admin = createPool();
  try {
    await admin.query(`CREATE DATABASE ${database}`);
  } finally {
    await admin.end();
  }
  const pool = createPool({ database });
  // drop() ends the pool, then DROP ... FORCE can still reach a backend that is closing: the FATAL 57P01
  // lands on a client the pool already forgot and would crash the test as an uncaught error.
  pool.on('connect', (client) => client.on('error', () => {}));
  return {
    pool,
    database,
    async drop() {
      await pool.end();
      const adminPool = createPool();
      try {
        await adminPool.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      } finally {
        await adminPool.end();
      }
    }
  };
}
