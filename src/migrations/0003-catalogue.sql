CREATE TEXT SEARCH CONFIGURATION fdl_fr (COPY = french);
ALTER TEXT SEARCH CONFIGURATION fdl_fr ALTER MAPPING FOR hword, hword_part, word WITH unaccent, french_stem;

CREATE TABLE universes (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z0-9-]{1,40}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40)
);

-- author_id NULL is shown as "Auteur anonyme" (deleted account).
CREATE TABLE recipes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_id bigint REFERENCES accounts ON DELETE SET NULL,
  visibility text NOT NULL DEFAULT 'draft' CHECK (visibility IN ('draft', 'private', 'public')),
  published_version integer,
  -- First publication, never changed by later versions.
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recipes_published_idx ON recipes (published_at DESC, id DESC);

-- A version is never updated after insertion; search is computed by publishVersion.
CREATE TABLE recipe_versions (
  recipe_id bigint REFERENCES recipes ON DELETE CASCADE,
  version integer CHECK (version > 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  minutes integer NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  servings integer NOT NULL CHECK (servings BETWEEN 1 AND 100),
  diet text NOT NULL CHECK (diet IN ('vegan', 'vegetarian', 'pescetarian', 'omnivore')),
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  seasons text[] NOT NULL DEFAULT '{}' CHECK (seasons <@ ARRAY['spring', 'summer', 'autumn', 'winter']),
  universe text REFERENCES universes,
  ingredients jsonb NOT NULL CHECK (jsonb_typeof(ingredients) = 'array' AND jsonb_array_length(ingredients) BETWEEN 1 AND 100),
  steps jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 50),
  provenance text NOT NULL CHECK (char_length(provenance) BETWEEN 1 AND 200),
  source_url text CHECK (source_url ~ '^https?://' AND char_length(source_url) <= 2000),
  text_licence text NOT NULL DEFAULT 'CC-BY-SA-4.0' CHECK (text_licence IN ('CC-BY-SA-4.0')),
  search tsvector NOT NULL,
  submitted_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL,
  PRIMARY KEY (recipe_id, version)
);

CREATE INDEX recipe_versions_search_idx ON recipe_versions USING gin (search);
