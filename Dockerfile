FROM node:22-bookworm-slim AS dev

# Client PostgreSQL 18 (pg_dump, pg_restore) depuis apt.postgresql.org,
# selon la méthode documentée sur postgresql.org.
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-common ca-certificates \
  && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
  && apt-get install -y --no-install-recommends postgresql-client-18 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM dev AS prod
ENV NODE_ENV=production HOST=0.0.0.0 FDL_DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
# Créés et attribués à node avant l'usage du volume : un volume nommé neuf en hérite.
RUN mkdir -p /data/backups && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
