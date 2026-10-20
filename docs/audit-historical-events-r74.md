# ONB-02 R7.4 — contratos históricos e evidência PROD-1.1

Base: main 8398ecb4 / conteúdo revisado 1c7ae385 do PR #246.
A 074 já está no ledger produtivo; este PR acrescenta a 075, sem reescrevê-la.
Não há merge, deploy, backfill ou correção de dados autorizados por este PR.

## Escritores e contexto preservado

| Evento/entidade | Origem inspecionada | Campos preservados |
| --- | --- | --- |
| MERGE_RFB_NORMAS_DOU_HISTORICAL / publication | [PR operacional #60, SHA 672204c](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/blob/672204c284ea408853852db7231649285e69793f/src/infrastructure/database/repair-rfb-normas-cross-source.ts) | before: douPublicationId, rfbPublicationId, douIdentityHash, rfbIdentityHash; after: publicationId, identityHash, rfbExternalId, douExternalId, origins |
| TAXONOMY_CURATION_SECTOR_ALIASES_CLEARED / taxonomy_curation | [PR operacional #145, SHA 1a36d29](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/blob/1a36d297180439018dce73c9c1e30f567c94bbc6/src/modules/taxonomy/curation/curation.clear-sector-aliases.ts) | after: removedSynonyms, rowsAffected; entity_id da release no cabeçalho |
| TAXONOMY_DRAFT_ORPHAN_RELATIONS_REMOVED / taxonomy_release | Reparo inline TAX-12: [recibo Issue #90](https://github.com/fabiojuniort-cyber/tribusca-control/issues/90#issuecomment-6050516506) e estrutura real conferida em READ ONLY no PROD-1.1 | before SQL NULL; after: removedCount, removedRelationIds, preservedHistory; entity_id da release no cabeçalho |

Os dois PRs operacionais não foram incorporados à main. Não importar nem reativar
seus escritores antigos, atores ou comandos. O reparo de relações foi executado
por Custom Start Command; seu código integral original não foi recuperado em
GitHub, branches, registro de governança ou logs históricos. **Não alegar inspeção
do código original desse terceiro produtor.** A regra foi definida com base no
recibo da operação e no esquema efetivamente armazenado, sem inferir nomes de campos.

A leitura limitada aos 13 eventos retornou apenas chaves/tipos: 11 merges RFB,
1 limpeza de aliases e 1 remoção de relações. Não retornou IDs, autores, valores
de aliases/justificativas ou qualquer payload. O runner foi restaurado ao comando
inerte após a consulta. Snapshot anterior ao backfill, que continua proibido.

O merge RFB usa publicações globais e aborta caso existam company_publications.
Os IDs de publicação são UUIDs tipados; hashes são SHA-256; external IDs só
aceitam os valores explícitos dos 11 pares oficiais listados no produtor.
origins admite exclusivamente o par ordenado [dou, rfb-normas], sem lista livre.

A limpeza de aliases gravava before.concepts[].code/aliases[].text/aliasType e
after.justification; o reparo de relações gravava after.reason. Esses snapshots e
textos livres **não** integram o contexto permitido. Não há prova de que todo texto
livre histórico esteja livre de dado privado; eles são tratados como não confiáveis
e removidos pela política aprovada, inclusive a antiga cópia de recuperação dos
aliases. Contagens e IDs operacionais tipados permanecem. O backfill não altera
as tabelas de taxonomia, publicações ou cadastro.

## Migration 074: origem e conteúdo revisado

Veio do PR #246, iniciada no commit f233944ea2641494faf4133a99d52cb5475d907e (R7),
ajustada no R7.1/R7.2/R7.3 e presente integralmente no HEAD revisado
1c7ae385feb60c04dcc5ec895283f926b8fd465a (PASS #5579902999).
O merge 8398ecb4 tem árvore idêntica à desse HEAD. SHA-256 do arquivo:
975e9a1235efe4b4cf16b3d5a63113bf692ecae59225fd46a0e808e733ca383e.
Ledger produtivo confirmou aplicação em 20/10/2026 02:09:12.723 UTC.

Instala marcador audit_policy_version, índices, política por evento, projeção
tipada, validação de IDs/autores e aliases históricos fechados; trigger de
INSERT/UPDATE; checkpoint e função de lote restritos ao operador. Também adapta
funções existentes de concessão/revogação de papéis e de edição/purga L17/coleta
para escrever apenas contexto permitido. **Não executa o backfill** nem limpa os
registros históricos durante sua instalação. CREATE OR REPLACE das funções de
negócio preserva suas guardas/locks, substituindo as escritas de auditoria.
A 075 altera apenas política/projetor, preservando OIDs, owners e ACLs, sem DML.

## 500 de lock: ponto preciso e limites da evidência

Em 20/10/2026 02:33:44.170 UTC (19/10 23:33:44 BRT), POST
/api/v1/admin/collection-filter/direct-rule/save retornou 500 / SQLSTATE 55P03.
O stack aponta dist/modules/collection/collection-filter.direct.js:296.
Recompilar o arquivo do merge com TypeScript 7.0.2, NodeNext e type=module
reproduz nessa linha a chamada a pg_advisory_xact_lock da chave
collection-filter-direct-rule (src/modules/collection/collection-filter.direct.ts:330).

As duas instruções anteriores configuram SET LOCAL statement_timeout=11000ms e
SET LOCAL lock_timeout=2500ms. A espera ocorre **antes** de candidates() e antes
de qualquer escrita de auditoria. O arquivo é byte-idêntico ao de main anterior
6b461ce. Logo, a exceção observada é aquisição concorrente de advisory lock do
filtro, não validação da allowlist ou INSERT no audit_log. Não é o timeout de
5s da purga ONB-02: esse método define explicitamente 2,5s na própria transação.
withUserContext usa Kysely transaction().execute; falha faz rollback e devolve
a conexão ao pool. O teste PG18 novo reproduz a contenção na função real,
comprova zero alterações de auditoria/checkpoint e restauração do mesmo pool
após rollback e após commit. As regressões R6 continuam provando rollback da purga.

Não foi identificado retrospectivamente o PID/SQL do detentor do lock.
Portanto, não afirmar que toda participação indireta de um scheduler/worker está
descartada só por esse stack. Não há evidência de vazamento de timeout da ONB-02
ou de falha da allowlist como causa desta requisição.
A requisição seguinte ao mesmo endpoint retornou 200 às 02:36:11 UTC; mais quatro
200 foram observados até 02:40:00 UTC. Nenhuma mudança de runtime neste PR.

## Validação e operação

- PG18 real: reproduzir falta das 3 regras na política da 074; instalar/reinstalar
  a 075 sem alterar auditorias/checkpoint ou contratos anteriores.
- Cada evento: before/after do contrato histórico, canários privados removidos,
  cabeçalhos preservados, outra auditoria/tabelas globais intactas, idempotência.
- Escrita nova: campo privado, external ID fora do enum ou origem arbitrária
  rejeitados. Evento futuro sem regra continua abortando antes de escrever.
- Lock: contenção real na função de salvamento, SQLSTATE 55P03 e configuração
  restaurada na conexão reutilizada.
- Rodar a suíte nova no job ONB PG18 da CI; não executar esses fixtures em produção.
- [Bloco único do operador: PITR e 409](../ops/onb02/PROD1_OPERATOR_CHECKS.md).
