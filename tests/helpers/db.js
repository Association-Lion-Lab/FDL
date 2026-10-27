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
