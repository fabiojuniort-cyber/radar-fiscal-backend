FROM node:24-bookworm

# PostgreSQL client must be >= the production PostgreSQL 18 server.
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl gnupg awscli python3; \
  install -d -m 0755 /usr/share/keyrings; \
  curl --fail --silent --show-error https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor > /usr/share/keyrings/postgresql.gpg; \
  echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends postgresql-client-18; \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=test \
    F2_PROOF_ENABLED=false \
    F2_IMPORT_SCOPE=ISOLATED_POSTGRES18_ONLY
# This start is inert with F2_PROOF_ENABLED=false. No backend/worker/scheduler.
CMD ["bash", "ops/f2-t03-proof/run.sh"]
