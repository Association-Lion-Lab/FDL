CREATE TABLE accounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('member', 'adherent', 'moderator', 'admin')),
  banned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX accounts_email_lower_key ON accounts (lower(email));

-- created_by has no foreign key so the log of who issued a link survives account deletion.
CREATE TABLE access_links (
  token_hash bytea PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('invitation', 'reset')),
  -- Only an invitation carries a role (NULL means member); a reset link has none.
  role text CHECK (role IN ('member', 'adherent', 'moderator', 'admin')),
  account_id bigint REFERENCES accounts ON DELETE CASCADE,
  note text,
  created_by bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  CHECK (kind = 'invitation' OR role IS NULL)
);

CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts ON DELETE CASCADE,
  mfa_ok boolean NOT NULL DEFAULT false,
  challenge text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  elevated_until timestamptz
);

CREATE INDEX sessions_account_id_idx ON sessions (account_id);

CREATE TABLE totp_secrets (
  account_id bigint PRIMARY KEY REFERENCES accounts ON DELETE CASCADE,
  secret text NOT NULL,
  confirmed_at timestamptz,
  last_step bigint
);

CREATE TABLE passkeys (
  id text PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL,
  transports text[],
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX passkeys_account_id_idx ON passkeys (account_id);

CREATE TABLE recovery_codes (
  account_id bigint REFERENCES accounts ON DELETE CASCADE,
  code_hash bytea,
  used_at timestamptz,
  PRIMARY KEY (account_id, code_hash)
);

-- actor_id has no foreign key so entries survive the deletion of the actor's account.
CREATE TABLE admin_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id bigint,
  action text NOT NULL,
  target text,
  detail jsonb
);
