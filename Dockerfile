FROM node:22-bookworm-slim AS dev

# Client PostgreSQL 18 (pg_dump, pg_restore) depuis apt.postgresql.org,
# selon la méthode documentée sur postgresql.org.
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-common ca-certificates \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
  && apt-get install -y --no-install-recommends postgresql-client-18 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
