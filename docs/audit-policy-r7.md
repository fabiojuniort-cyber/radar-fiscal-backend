# Auditoria R7.4 — política aprovada em 19/10/2026

## Contrato

Todas as escritas em audit_log têm validação no banco: evento/tipo não registrado,
campo fora da allowlist, valor incompatível ou identificador não UUID são rejeitados
com 23514. Mensagens, justificativas, snapshots de formulários, nomes, CNPJ e chaves
JSON livres não são campos de auditoria. Payloads são objetos planos tipados.

Os adaptadores dos escritores preexistentes projetam somente o contexto declarado
abaixo. Não são gravados os snapshots/justificativas livres desses adaptadores.
Novos eventos exigem uma política explícita; não se deve usar a projeção para evitar
definir o contrato de um novo evento. O teste de inserção inválida protege a fronteira.

Ação, data, tenant, ID do evento e correlação continuam na trilha.
Autor é preservado quando atende ao contrato abaixo. No backfill, um autor privado
é substituído por NULL e after_data recebe actor_redacted=true; nunca copiar o valor
rejeitado para outro campo.
entity_id e request_id são UUID ou NULL; IDs de empresa não são hashes de CNPJ.
São identificadores pseudônimos: não se deve prometer anonimização absoluta enquanto
houver possibilidade de correlação. COMPANY_PURGED retém o UUID da empresa para
comprovar a exclusão, sem snapshot cadastral. Não existe FK da auditoria ao grafo.

| Evento | Tipo | Identificadores retidos | Contexto tipado permitido |
| --- | --- | --- | --- |
| COMPANY_CREATED | company | UUID da entidade; company_id | is_active, version |
| COMPANY_UPDATED | company | UUID da entidade; company_id | is_active, version |
| COMPANY_PURGED | company | UUID da entidade | purged |
| ESTABLISHMENT_CREATED | establishment | UUID da entidade; company_id | is_active |
| ESTABLISHMENT_UPDATED | establishment | UUID da entidade; company_id | is_active |
| ESTABLISHMENT_DELETED | establishment | UUID da entidade; company_id | is_active |
| COMPANY_TAX_PROFILE_UPDATED | company_tax_profile | UUID da entidade; company_id | version |
| COMPANY_PRODUCT_PROFILE_UPDATED | company_product_profile | UUID da entidade; company_id | is_active |
| PLATFORM_ROLE_GRANTED | platform_user_role | UUID da entidade | role |
| PLATFORM_ROLE_REVOKED | platform_user_role | UUID da entidade | role |
| PLATFORM_ROLE_GRANTED | app_user | UUID da entidade | role |
| PLATFORM_ROLE_REVOKED | app_user | UUID da entidade | role |
| COLLECTION_FILTER_DRAFT_SAVED | collection_filter_policy | UUID da entidade | version, revision |
| COLLECTION_FILTER_SIMULATION_REQUESTED | collection_filter_simulation | UUID da entidade; policyId | version, revision, scope, reviewMode |
| COLLECTION_FILTER_POLICY_APPROVED | collection_filter_policy | UUID da entidade; simulationId | version, revision |
| COLLECTION_FILTER_DIRECT_ADMIN_EDIT | collection_filter_policy | UUID da entidade | policyRevision, action |
| COLLECTION_FILTER_DIRECT_RULE_CHANGED | collection_filter_type_rule | UUID da entidade | policyRevision, mode |
| COLLECTION_FILTER_DIRECT_PURGE | collection_filter_type_rule | UUID da entidade; deletedIds | deletedCount, mode |
| L17_HIDDEN_PURGE | publications | UUID da entidade; deletedIds, policyId | deletedCount, policyRevision, mode |
| L17_RULE_PURGE | publications | UUID da entidade; deletedIds, policyId | deletedCount, policyRevision, mode |
| L18_PRESERVATION_RULES | collection_filter_policy | UUID da entidade; policyId | policyRevision, changedRuleCount, addedStrongTerms |
| BASELINE_IMPORT_STARTED | taxonomy_baseline | UUID da entidade | manifestSha256, derivationFingerprint, status |
| BASELINE_IMPORT_FAILED | taxonomy_baseline | UUID da entidade | manifestSha256, derivationFingerprint, status |
| BASELINE_IMPORT_VALIDATED | taxonomy_baseline | UUID da entidade | manifestSha256, derivationFingerprint, status |
| BASELINE_IMPORT_COMMITTED | taxonomy_baseline | UUID da entidade | manifestSha256, derivationFingerprint, status |
| TAXONOMY_RELEASE_CREATED | taxonomy_baseline | UUID da entidade | manifestSha256, derivationFingerprint, status |
| TAXONOMY_SUCCESSOR_CREATED | taxonomy_release | UUID da entidade; sourceReleaseId | manifestSha256, snapshotSha256, status |
| TAXONOMY_RELEASE_CREATED | taxonomy_release | UUID da entidade; sourceReleaseId | manifestSha256, snapshotSha256, status |
| TAXONOMY_RELEASE_PUBLISHED | taxonomy_release | UUID da entidade; sourceReleaseId | manifestSha256, snapshotSha256, status |
| TAXONOMY_SUCCESSOR_PUBLISHED | taxonomy_release | UUID da entidade; sourceReleaseId | manifestSha256, snapshotSha256, status |
| TAXONOMY_RELEASE_VALIDATED | taxonomy_release | UUID da entidade; sourceReleaseId | manifestSha256, snapshotSha256, status |
| TAXONOMY_CURATION_DRAFT_CREATED | taxonomy_curation | UUID da entidade; sourceReleaseId | initialCuration |
| TAXONOMY_CURATION_DIMENSION_UPDATED | taxonomy_curation | UUID da entidade | — |
| TAXONOMY_CURATION_DIMENSION_RETIRED | taxonomy_curation | UUID da entidade | — |
| TAXONOMY_CURATION_CONCEPT_CREATED | taxonomy_curation | UUID da entidade | — |
| TAXONOMY_CURATION_CONCEPT_UPDATED | taxonomy_curation | UUID da entidade | — |
| TAXONOMY_RUNTIME_SETTING_UPDATED | taxonomy_curation | UUID da entidade | — |
| TAXONOMY_CURATION_GROUP_CREATED | taxonomy_curation | UUID da entidade; groupId | — |
| TAXONOMY_CURATION_GROUP_UPDATED | taxonomy_curation | UUID da entidade; groupId | — |
| TAXONOMY_CURATION_GROUP_DELETED | taxonomy_curation | UUID da entidade; groupId | — |
| TAXONOMY_CURATION_IMPORT | taxonomy_curation | UUID da entidade | rows, created, updated, errors |
| TAXONOMY_CURATION_GRID_SAVE | taxonomy_curation | UUID da entidade | created, updated, retired, groupsCreated, groupsUpdated |
| TAXONOMY_CURATION_PUBLISHED | taxonomy_curation | UUID da entidade | snapshotSha256 |
| F2_T02_ACTUACAO_INITIALIZED | taxonomy_curation | UUID da entidade | seedSha256 |
| F2_T02_ACTUACAO_CNAE_ORIGINS_IMPORTED | taxonomy_curation | UUID da entidade | sourceSha256, projectionSha256, originCount, publicationRequested |
| TAXONOMY_F2_SUGGESTIONS_CHANGED | taxonomy_curation | UUID da entidade | productsCount, ncmsCount |
| F2_TAB03_CNAE_ACTUACOES_CHANGED | taxonomy_curation | UUID da entidade | published |
| OFFICIAL_CATALOG_IMPORTED | official_catalog_edition | UUID da entidade; editionId | inserted, updated, total, sourceSha256 |
| PUBLICATION_TAG_CURATED | publication | UUID da entidade | action |
| PUBLICATION_PRESENTATION_REFRESHED | publication_version | UUID da entidade | savedPageSha256, htmlChars, effectiveUntil |
| TAXONOMY_V1_1_DRAFT_CREATED | taxonomy_release | UUID da entidade; sourceReleaseId | — |
| TAXONOMY_V1_1_PUBLISHED | taxonomy_release | UUID da entidade | artifactSha256 |

UUIDs só são aceitos em campos declarados; int = inteiro não negativo com até 12
dígitos; bool = JSON boolean; SHA-256 = 64 hex; data = formato ISO; enums têm lista
fechada na função audit_event_policy. Nenhum objeto/lista livre é aceito. A lista
deletedIds só permite UUIDs de publicações da operação global correspondente.

## Legado e backfill

A migration 074 apenas instala a política, guardas, marcador por linha e checkpoint.
Ela NÃO executa o backfill. Auditorias legadas têm audit_policy_version=0; novas têm 1.
O backfill aplica a política explícita de cada par ação/tipo conhecido aos snapshots;
chaves não permitidas, valores fora do tipo e texto livre são descartados somente
depois dessa validação. **R7.1 substitui o fallback do R7: evento sem regra nunca
tem seu payload esvaziado.** A projeção também rejeita evento desconhecido, inclusive
com payload NULL. Novas escritas de evento não registrado continuam proibidas.

O inventário [audit-event-inventory-r7.json](audit-event-inventory-r7.json) identifica
40 pares emitidos pelo código e migrations existentes, com arquivos de origem.
Todos têm regra explícita na tabela acima e em audit_event_policy. As 12 políticas
adicionais do contrato legado continuam explícitas; nenhuma regra genérica é usada
para aceitar tipos novos. O teste PG18 percorre todos os 40 pares do inventário,
confere as fontes e processa essas fixtures com o CLI real.

A regra é global para auditoria histórica, conforme autorização de produto. Não
altera companies, perfis, usuários, publicações ou qualquer tabela de outra entidade.
Contexto de outro tipo que já esteja permitido permanece idêntico. A alteração
histórica é única e irreversível, sem recuperação pelo produto.

Comandos preparados (NÃO executados em produção):

- node ops/onb02/audit-backfill.mjs --plan
- node ops/onb02/audit-backfill.mjs --apply --ack-irreversible-r7 --batch-size 5000
- interrupção controlada: acrescentar --max-batches 3; repetir o comando para retomar.

--plan é SELECT-only e lista **todos** os pares ação/tipo encontrados no audit_log,
inclusive registros já marcados: action, entityType, count, pending e ruleExists
(boolean: sim/não). Também retorna os totais pending e unregistered. Não mostra
payload, autor, identificadores de linha ou dados cadastrais e não cria checkpoint.

Se qualquer par não tiver regra, --apply termina com código 1 e relatório JSON
audit_backfill_unknown_events dos tipos/contagens sem regra, **antes de escrever
qualquer auditoria ou checkpoint**. Não há opção de ignorar/destruir desconhecidos.
O operador deve interromper e encaminhar os tipos para definição/revisão de regras;
depois roda --plan novamente. Não inventar regra apenas para liberar a execução.

--apply usa conexão de operador, sem permissão de execução para
radar_app/worker/curator. A função SQL de lote repete a verificação global antes
da primeira escrita do lote, inclusive em chamadas diretas. O lock comum de escrita
ROW EXCLUSIVE é adquirido antes da verificação: impede DDL que desabilite a guarda
durante o lote, sem bloquear INSERTs normais. A guarda rejeita novos tipos sem regra.
O lock termina no commit/rollback. Se um tipo novo aparecer entre lotes, o próximo lote aborta;
lotes conhecidos já confirmados permanecem confirmados e retomáveis.

Cada lote confirma alteração das linhas e checkpoint na mesma transação. O marcador por linha é a verdade para retomada:
UUID aleatório, timestamps antigos e novas inserções não causam saltos. Falha no lote
não avança o checkpoint. Linhas v1 com autor válido (ou NULL legado) não são reprocessadas.
R7.2 também seleciona linhas v1 com autor inválido: o marcador antigo não pode esconder
um vazamento de autor. O índice parcial ix_audit_r72_pending e a purga usam o mesmo
predicado audit_backfill_pending. NULL legado significa autor ausente e permanece NULL,
sem inventar uma identidade ou sinalizar dado privado que não existia. Um novo processo/conexão
retoma os lotes restantes; execução repetida sem pendência faz zero alterações.

## Purga e implantação

073 não procura texto, chaves, CNPJ, nomes nem IDs históricos em auditorias. Preserva
guardas de tenant/admin, concorrência e a identidade legada compartilhada já existente,
apaga o grafo e grava COMPANY_PURGED. Timeouts no serviço: statement 30s, lock 5s.
O header permanent-v1 e a confirmação digitada são mantidos.

Enquanto houver qualquer auditoria legada v0 ou autor não-NULL inválido, a purga retorna conflito, por verificação
indexada do marcador. Assim o deploy não permite exclusão antes do backfill separado.

Autorizações futuras independentes: (1) deploy; (2) apply do backfill. Na implantação,
pausar temporariamente escritores de auditoria/curadoria durante predeploy e troca
do backend: código TypeScript antigo pode receber rejeição da nova guarda até subir
os adaptadores R7. SQL writers são substituídos pela 074. Abas antigas não purgam.
Nenhuma dessas operações foi autorizada ou executada neste pacote de implementação.
O preflight do ledger/checksum 073/074 e owner/ACL continua obrigatório.

O histórico web resolve nome atual por join no mesmo tenant. Ausência do cadastro
só vira “Empresa excluída” com COMPANY_PURGED do mesmo tenant/UUID. Ausência sem
prova ou erro HTTP vira “Indisponível”. Não usa snapshots nem dados do onboarding.

## Testes

CI PG18 real: allowlist, referências inválidas, eventos novos não registrados,
150 mil auditorias legadas mistas, chave JSON privada/NFD, contexto permitido intacto,
falha atômica no lote, retomada com nova conexão, idempotência, preservação de cabeçalhos
e de outra entidade; purga sem varrer 150 mil auditorias, 420 mil collection_items
preservados e grafo inventariado de 116 linhas; timeouts/rollback. As fixtures legadas
são inseridas com a guarda desabilitada apenas dentro de transação administrativa
descartável de teste. Não há flag de bypass no runtime.

## Evidência R7.1

O teste test/onb02-r71-backfill.integration.test.ts usa o executável CLI compilado
em processos Node reais no PG18 descartável. Tipo desconhecido (ação nova ou entidade
sem regra, inclusive linha já marcada) aparece no --plan; --apply retorna erro/relatório
e os fingerprints globais das auditorias e checkpoint permanecem iguais.
A chamada SQL direta também é bloqueada antes de escrever. Após remover somente as
fixtures desconhecidas do teste, apply funciona. Os 40 tipos inventariados são
processados em lotes pelo CLI e a repetição altera zero linhas.
A massa de 150 mil registros usa exclusivamente tipos conhecidos; desconhecidos
ficam no teste de aborto e não recebem uma política artificial.

## R7.2 — identidade do autor e simulações históricas

A guarda do banco rejeita INSERT sem actor_id, com string vazia ou com qualquer
valor fora de UUID integral e da lista fechada abaixo (23514 audit_invalid_actor).
UUID é uma referência opaca no formato validado; não se infere identidade por texto.
Não há aceite por prefixo. Os identificadores operacionais preexistentes são
enumerados individualmente para manter os escritores existentes compatíveis:

| Identidade de sistema aceita | Escritor |
| --- | --- |
| system:f2-draft-01 | importação F2 em rascunho |
| system:f2-tab-02 | reparo explícito dos grupos F2 em rascunho |
| system:grant-platform-admin | concessão/revogação operacional de administrador |
| system:grant-taxonomy-curator | concessão/revogação operacional de curador |
| system:import-confaz-act | importação operacional de ato CONFAZ |
| system:l17-scheduler | limpeza global L17 executada pelo worker/scheduler |
| system:scheduler | agendamento com identidade explícita |
| system:taxonomy-baseline-importer | importação da baseline |
| system:taxonomy-load-products | carga da planilha de produtos |
| system:taxonomy-merge-dimension | unificação explícita de dimensões |
| system:taxonomy-publish-draft | comando operacional de publicação do rascunho |
| system:taxonomy-retire-dimensions | retirada explícita de dimensões |
| system:taxonomy-retire-legacy-segments | retirada explícita dos segmentos legados |
| system:taxonomy-v1.1-publisher | publicação TAX-10: biblioteca e entrypoint documentado |
| system:taxonomy-v1.1-successor | criação da sucessora TAX-10 |
| system:worker | trabalho de sistema com identidade explícita |

options.actor da publicação também passa por essa guarda: texto livre é rejeitado
e a transação falha, sem substituir silenciosamente um autor fornecido.
Novas identidades de sistema exigem mudança explícita da lista e testes.

actor_redacted é booleano reservado, declarado nas 52 políticas. INSERT não pode
fornecer essa chave em before_data nem after_data. Só a transformação canônica do
backfill pode sinalizar a redação histórica, inclusive quando o payload era NULL.
O UPDATE autorizado só permite o autor canônico e o payload canônico do registro
original; ação, data e demais cabeçalhos não podem ser alterados. O backfill não
altera tabelas de usuários nem outras entidades de negócio.

A regra COLLECTION_FILTER_SIMULATION_REQUESTED/collection_filter_simulation preserva
policyId, version, revision, scope e reviewMode. Os valores históricos são exatamente:

| scope | reviewMode |
| --- | --- |
| FULL_ARCHIVE | ALL |
| FULL_ARCHIVE | SAMPLE |
| FULL_ARCHIVE | NONE |
| RECENT | ALL |
| RECENT | SAMPLE |
| RECENT | NONE |

São os enums emitidos pela migration 039; funções aposentadas pela 051 não são
recriadas. Seis testes PG18 comparam before_data e after_data antes/depois e exigem
igualdade semântica dos cinco campos, retirando apenas campos não permitidos.
O teste de autores cobre INSERT inválido, e-mail/CNPJ/nome sintéticos no legado,
linhas v0 e v1, payload NULL, retomada, cabeçalhos, registros válidos intactos e
idempotência. Toda essa execução é em PostgreSQL 18 descartável da CI.

## R7.3 — inventário operacional e prova do entrypoint

[Inventário de atores](audit-actors-r73.json) registra os 16 IDs canônicos, seus
escritores e os nomes anteriores. Só UUID e esses IDs são aceitos em INSERT;
não existe autorização por prefixo nem alias antigo aceito em nova escrita.
No backfill, os nomes anteriores explicitamente reconhecidos são convertidos pelo
mapa fechado audit_historical_actor_reference ao ID canônico, preservando a autoria
de sistema e sem acrescentar redação indevida. O plano inclui essas linhas v0/v1.
Autor não reconhecido fora do formato/lista continua virando NULL com
actor_redacted=true. O mapa histórico não permite aliases em novas escritas.

O inventário cobre src, scripts, package.json, jobs, worker/scheduler, CLIs e
docs/runbooks, incluindo TAX-10, F2, DOE, DOU e RFB.
publication_scope_events.actor_ref e os manifests R3 DOU têm contratos próprios;
as referências operacionais desses históricos não são autores de audit_log.
Elas são inventariadas com fonte e contrato, sem ampliar a allowlist da auditoria
ou alterar manifests/contratos produtivos anteriores. Histórico de migrations
001–073 é preservado e conferido por hash; as definições SQL ativas são as da 074.

npm run test:audit-actors varre recursivamente os arquivos operacionais/documentais,
compara o registro com a lista SQL real e rejeita declarações estáticas desconhecidas,
atores antigos em instruções ativas, flags/env, defaults, referências constantes,
SQL literal e o adaptador SQL array.join da baseline. Diagnósticos mostram só
arquivo/linha/tipo de falha, sem ecoar o conteúdo do autor.
Casos negativos provam a detecção de um arquivo novo e do autor exato que quebrava
o TAX-10. Valores dinâmicos autenticados continuam sujeitos à guarda do banco.

A CI PG18 executa o Node compilado indicado no runbook TAX-10, desde uma origem
sintética publicada e uma sucessora DRAFT em banco adicional descartável.
O primeiro comando deve retornar PUBLISHED; uma nova conexão precisa observar a
release e a auditoria confirmadas, com o ator canônico e hash do artefato.
A repetição retorna ALREADY_PUBLISHED e não duplica o evento.
Nenhuma taxonomia real é publicada por esse teste.

## R7.4 — três operadores históricos fora da main

A migration 075 estende os 52 contratos anteriores com três pares explícitos,
sem modificar a 074 já aplicada e sem executar o backfill. As 40 origens do código
original continuam no inventário; três contratos históricos adicionais apontam à
075 e à evidência detalhada em [audit-historical-events-r74.md](audit-historical-events-r74.md).
São 43 entradas no inventário e 55 políticas totais; não são 43 escritores ativos.

| Evento | Entidade | IDs/contexto retidos |
| --- | --- | --- |
| MERGE_RFB_NORMAS_DOU_HISTORICAL | publication | IDs das duas publicações e da resultante; hashes das identidades; external IDs em enum fechado dos 11 pares; origins exatamente [dou, rfb-normas] |
| TAXONOMY_CURATION_SECTOR_ALIASES_CLEARED | taxonomy_curation | ID da release no cabeçalho; removedSynonyms, rowsAffected |
| TAXONOMY_DRAFT_ORPHAN_RELATIONS_REMOVED | taxonomy_release | ID da release no cabeçalho; removedRelationIds (UUIDs), removedCount, preservedHistory |

Todos admitem actor_redacted, metadado reservado exclusivamente ao backfill.
Listas de aliases/snapshots e justification/reason livres não são permitidos;
a remoção histórica também elimina a antiga cópia de recuperação de aliases na
auditoria. Não confundir essa trilha minimizada com backup da curadoria.
A enumeração de external IDs e a constante origins não abrem texto/listas livres.
Eventos futuros sem política continuam bloqueados antes de qualquer escrita.

PROD-1.1 prepara a 075 e os testes; não a aplica em produção, não executa --apply
e não autoriza merge. A origem inline do reparo de relações não foi recuperada:
seu contrato foi conferido por chaves/tipos em leitura produtiva e recibo histórico,
conforme as limitações explicitadas na evidência. Não atribuir a ele código inventado.
