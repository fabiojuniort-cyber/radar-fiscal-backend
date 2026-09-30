# Agenda de coleta — D-056

Data: 2026-09-30. Governança: tribusca-control Issue #35. Decisão: D-056 (`DECISIONS.md` do tribusca-control).

## Regra

Motores finalizados rodam em quatro ciclos diários: **06h, 10h, 14h e 18h (Brasília)**. O backfill histórico é fluxo separado e não é tratado aqui.

A política está em `src/modules/collection/schedule-policy.ts`. Cada fonte tem um minuto próprio dentro da hora do ciclo, para não iniciar todos os conectores no mesmo instante:

| Fonte | Cron (`America/Sao_Paulo`) | Agenda anterior |
|---|---|---|
| `dou` | `0 6,10,14,18 * * *` | `0 8,12,16,20 * * *` |
| `sped` | `5 6,10,14,18 * * *` | `0 * * * *` |
| `nfe-encat` | `10 6,10,14,18 * * *` | `0 * * * *` |
| `cgibs` | `15 6,10,14,18 * * *` | `0 * * * *` |
| `rfb-normas` | `20 6,10,14,18 * * *` | `0 * * * *` |
| `confaz` | `35 6,10,14,18 * * *` | `35 * * * *` |

`doe-sp` e `doe-sp-legado` ficam com a frente DOE-SP e não são alterados.

## Aplicação (R3)

`npm run db:align-schedules` (após `npm run build`), com `DATABASE_ADMIN_URL` ou `DATABASE_URL`:

- sem argumentos: **dry-run**, só imprime `SCHEDULE_ALIGNMENT=` com agenda atual e alvo;
- `--apply`: grava a agenda D-056, em uma transação, apenas nas fontes **ativas e já agendadas** cuja agenda difere; é idempotente;
- `--restore-previous`: **rollback**, grava a agenda anterior da tabela acima.

Fonte inativa ou sem agenda é reportada como `SKIPPED_NOT_SCHEDULED` e não é tocada: ativar é gate de cada fonte.

Os scripts `db:ensure-*-source` usam a mesma política: `--scheduled` aplica a agenda D-056 (SPED, NF-e/ENCAT, CGIBS, RFB normas); CONFAZ e DOU já usam a D-056 como padrão (as variáveis `CONFAZ_SCHEDULE_CRON`/`DOU_SCHEDULE_CRON` continuam podendo sobrescrever). `--hourly` permanece só como exceção explícita e registrada.

## Efeito no watchdog

Com quatro ciclos por dia, `STALE_SOURCE` (24 h sem consulta) continua válido. `PERSISTENT_PARTIAL` (6 runs finalizadas parciais) passa a corresponder a cerca de um dia e meio.
