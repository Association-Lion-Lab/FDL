-- A comment belongs to one recipe; reason is the latest moderation reason shown to its author.
CREATE TABLE comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipe_id bigint NOT NULL REFERENCES recipes ON DELETE CASCADE,
  author_id bigint NOT NULL REFERENCES accounts ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  status text NOT NULL CHECK (status IN ('pending', 'published', 'rejected', 'removed')),
  flags text[] NOT NULL DEFAULT '{}',
  reason text CHECK (char_length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz
);
CREATE INDEX comments_recipe_idx ON comments (recipe_id, id);

-- A report or a decision with comment_id targets that comment of recipe_id.
ALTER TABLE reports ADD COLUMN comment_id bigint REFERENCES comments ON DELETE CASCADE;
DROP INDEX reports_open_idx;
CREATE UNIQUE INDEX reports_open_idx ON reports (recipe_id, coalesce(comment_id, 0), reporter_id) WHERE closed_at IS NULL;
ALTER TABLE moderation_decisions ADD COLUMN comment_id bigint REFERENCES comments ON DELETE SET NULL;
