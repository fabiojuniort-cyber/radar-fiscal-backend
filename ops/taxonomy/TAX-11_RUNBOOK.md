# TAX-11 — ativação produtiva da curadoria

## Pré-requisitos

1. PR TAX-11 com CI verde e revisão registrada na Issue.
2. Variável nova no serviço **radar-fiscal-backend** (API; o pre-deploy
   `db:prepare` roda no mesmo serviço): `DB_CURATOR_RUNTIME_PASSWORD` —
   segredo aleatório (≥ 32 caracteres), diferente das senhas runtime.
   Não registrar o valor em Issue/PR/log.

## Passos

1. Configurar a variável **antes** do merge (sem redeploy manual).
2. Merge em `main`. O pre-deploy aplica a migration 031 e provisiona
   `radar_taxonomy_curator_runtime`; `db:verify-taxonomy-curator` valida o
   login (NOINHERIT, membro só do curador).
3. Confirmar API, Worker e Scheduler em SUCCESS no novo commit. Nos logs do
   Worker: `taxonomyIdleBatchSize` presente; nenhuma linha
   "Publication taxonomy classification batch completed" (interruptor
   desligado).
4. Conceder o papel ao usuário curador, num executor operacional com
   `DATABASE_ADMIN_URL`:
   `node dist/infrastructure/database/grant-taxonomy-curator.js --email=<e-mail> --dry-run`
   e, sem divergência, o mesmo comando sem `--dry-run`. Esperado
   `action=GRANTED` (ou `ALREADY_GRANTED`).
5. Validar read-only: `GET /api/v1/admin/me` com o usuário →
   `taxonomyCurator=true`, `curatorDatabase=true`.

## Estado esperado ao final

- `schema_migrations` até 031; `taxonomy_runtime_settings`:
  `classification_enabled=false`, `classification_excluded_sources=["doe-sp"]`.
- Nenhuma release nova criada pela ativação; nenhum run/scan de
  classificação.
- O rascunho v1.2.0 e a classificação são atos do curador na interface.

## Reversão

- Revogar acesso: `grant-taxonomy-curator.js --email=<e-mail> --revoke`.
- Remover `DB_CURATOR_RUNTIME_PASSWORD` desliga as rotas de curadoria (503)
  sem afetar o restante da API.
- A migration 031 é aditiva; releases publicadas não são alteradas.
