-- A version's photo: file name in <dataDir>/photos (sha256 of the stripped JPEG) and its author.
ALTER TABLE recipe_versions
  ADD COLUMN photo text CHECK (photo ~ '^[0-9a-f]{64}$'),
  ADD COLUMN photo_credit text CHECK (char_length(photo_credit) BETWEEN 1 AND 80),
  ADD CONSTRAINT recipe_versions_photo_pair CHECK ((photo IS NULL) = (photo_credit IS NULL));
