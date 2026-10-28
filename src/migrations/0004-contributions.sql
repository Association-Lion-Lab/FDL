-- Versions get a moderation status; only published ones carry published_at.
ALTER TABLE recipe_versions
  ADD COLUMN status text NOT NULL DEFAULT 'published' CHECK (status IN ('private', 'pending', 'published', 'rejected')),
  -- Reasons of the automatic filters.
  ADD COLUMN flags text[] NOT NULL DEFAULT '{}',
  ALTER COLUMN published_at DROP NOT NULL,
  ADD CONSTRAINT recipe_versions_published_at_check CHECK ((status = 'published') = (published_at IS NOT NULL));

-- draft is the author's free-form work in progress, not validated.
ALTER TABLE recipes
  ADD COLUMN draft jsonb CHECK (pg_column_size(draft) <= 262144),
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN removed_reason text;

-- version NULL means a decision on the whole recipe. moderator_id has no foreign key, like admin_log.actor_id.
CREATE TABLE moderation_decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipe_id bigint NOT NULL REFERENCES recipes ON DELETE CASCADE,
  version integer,
  moderator_id bigint,
  decision text NOT NULL CHECK (decision IN ('accepted', 'rejected', 'removed', 'report_dismissed')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipe_id bigint NOT NULL REFERENCES recipes ON DELETE CASCADE,
  reporter_id bigint REFERENCES accounts ON DELETE SET NULL,
  category text NOT NULL CHECK (category IN ('illegal', 'copyright', 'off_topic', 'spam', 'other')),
  detail text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  decision_id bigint REFERENCES moderation_decisions
);

CREATE UNIQUE INDEX reports_open_idx ON reports (recipe_id, reporter_id) WHERE closed_at IS NULL;

CREATE TABLE ratings (
  recipe_id bigint REFERENCES recipes ON DELETE CASCADE,
  account_id bigint REFERENCES accounts ON DELETE CASCADE,
  stars smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipe_id, account_id)
);
