export async function hasSecondFactor(db, accountId) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM totp_secrets WHERE account_id = $1 AND confirmed_at IS NOT NULL
     UNION ALL SELECT 1 FROM passkeys WHERE account_id = $1`,
    [accountId]
  );
  return rowCount > 0;
}
