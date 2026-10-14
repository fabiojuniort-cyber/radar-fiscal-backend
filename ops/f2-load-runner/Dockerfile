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

RUN install -d -m 0700 /app/f2-inputs && \
    base64 -d Radar_Fiscal_Carga_Segmento_Revisada_v5.1.xlsx.b64 > /app/f2-inputs/segmento.xlsx && \
    base64 -d Radar_Fiscal_Carga_Produto_Revisada_v5.xlsx.b64 > /app/f2-inputs/produto.xlsx && \
    echo "695b0df85339ec60a2b1bc8b88b842ac09a55e71d90c3f7eb2443f1709c6af67  /app/f2-inputs/segmento.xlsx" | sha256sum -c - && \
    echo "261da490a5a030e698d43030c6a552cf39cc3f025f0249f71ffff1001b57051a  /app/f2-inputs/produto.xlsx" | sha256sum -c -

# Safe offline gates at image build: no production database is contacted.
RUN node --check ops/f2-load-runner/f2-load-all.mjs && \
    node --check ops/f2-load-runner/f2-load08-verify.mjs && \
    node --test test/f2-load09-guard.test.mjs

ENV NODE_ENV=test \
    F2_PROOF_ENABLED=false \
    F2_IMPORT_SCOPE=ISOLATED_POSTGRES18_ONLY
# This start is inert with F2_PROOF_ENABLED=false. No backend/worker/scheduler.
CMD ["node", "-e", "console.log('F2_LOAD05_INERT_WAITING_FOR_ROLE_AND_VERIFIED_BACKUP')"]
