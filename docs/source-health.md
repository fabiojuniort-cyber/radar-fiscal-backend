# Saúde das fontes — watchdog e diagnóstico

Data: 2026-09-29. Governança: tribusca-control Issue #35.

## Motivação

O Motor registra cada run corretamente, mas nada observava esses registros. Em setembro de 2026:

- o run DOU ficou cerca de 6 dias em retry persistente (9.651 tentativas, `INLABS_INVALID_DOWNLOAD`) sem persistir nada;
- um item SPED falhou em todas as execuções horárias (`Publication origin is already linked to another publication identity.`).

Nenhum dos dois gerou alerta.

## Watchdog no Scheduler

`src/modules/operations/source-health.ts`, chamado pelo Scheduler a cada `SOURCE_HEALTH_INTERVAL_MS` (padrão 1 h). Somente leitura; isolado da criação de runs (falha do watchdog nunca afeta o agendamento).

Avalia fontes com `is_active = TRUE` e `schedule_cron` definido:

| Alerta | Condição (padrão) |
|---|---|
| `STALE_SOURCE` | nenhum run que consultou a fonte (`SUCCESS`, `SUCCESS_NO_RESULTS` ou `PARTIAL_SUCCESS`) nas últimas **24 h**; para fonte nova, conta a partir da criação |
| `STUCK_RUN` | run aberto (`PENDING`/`RUNNING` já iniciado) com **≥ 20 tentativas** ou aberto há **≥ 6 h** |
| `PERSISTENT_PARTIAL` | os **6** últimos runs finalizados foram todos `PARTIAL_SUCCESS` |

Cada alerta é registrado em log **nível error** com a mensagem `Source health alert` e os campos `alertKind`, `sourceCode`, `sourceId` e detalhes (último erro truncado, horas, tentativas). O mesmo `fonte:tipo` só é repetido após `SOURCE_HEALTH_REALERT_MS` (padrão 6 h); se a condição se resolver e voltar, alerta imediatamente. Um resumo `Source health check completed` é registrado a cada avaliação.

Variáveis (Scheduler):

- `SOURCE_HEALTH_ENABLED` (padrão `true`);
- `SOURCE_HEALTH_INTERVAL_MS` (padrão 3.600.000, mínimo 60.000);
- `SOURCE_HEALTH_REALERT_MS` (padrão 21.600.000, mínimo 60.000).

Estado conhecido: o portal CONFAZ, bloqueado na rede (ver `phase-4-confaz-connector.md`), gera `STALE_SOURCE` a cada 6 h. É um alerta verdadeiro — os atos CONFAZ chegam pelo DOU.

Canal: por ora o alerta é o log estruturado (pesquisável no Railway por `"Source health alert"`). Encaminhar para e-mail/Slack é evolução separada.

## Comandos manuais (somente leitura)

- `npm run db:source-health` — relatório `SOURCE_HEALTH=` de todas as fontes ativas agendadas; código de saída 2 quando há alerta.
- `npm run db:diagnose-collection -- [horas]` — `COLLECTION_DIAGNOSTICS=` com:
  - falhas de item por fonte, agrupadas por erro (padrão últimas 48 h);
  - conflitos de origem/identidade: a publicação e a `identity_basis` já vinculadas à origem que falha, com metadata de forma do item (sem texto integral);
  - DOU: `partialFailures` e pacotes não processados da última tentativa bem-sucedida.

Ambos usam `DATABASE_URL` (role de runtime) e não alteram dados.
