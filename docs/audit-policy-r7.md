# Auditoria R7.1 — política aprovada em 19/10/2026

## Contrato

Todas as escritas em audit_log têm validação no banco: evento/tipo não registrado,
campo fora da allowlist, valor incompatível ou identificador não UUID são rejeitados
com 23514. Mensagens, justificativas, snapshots de formulários, nomes, CNPJ e chaves
JSON livres não são campos de auditoria. Payloads são objetos planos tipados.

Os adaptadores dos escritores preexistentes projetam somente o contexto declarado
abaixo. Não são gravados os snapshots/justificativas livres desses adaptadores.
Novos eventos exigem uma política explícita; não se deve usar a projeção para evitar
definir o contrato de um novo evento. O teste de inserção inválida protege a fronteira.

Ação, data, autor, tenant, ID do evento e correlação continuam na trilha.
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
da primeira escrita do lote, inclusive em chamadas diretas. Um lock de tabela
SHARE ROW EXCLUSIVE, limitado a cada lote, impede escritores concorrentes durante
essa verificação e UPDATE; SELECTs continuam disponíveis. O lock termina no commit
ou rollback do lote. Se um tipo novo aparecer entre lotes, o próximo lote aborta;
lotes conhecidos já confirmados permanecem confirmados e retomáveis.

Cada lote confirma alteração das linhas e checkpoint na mesma transação. O marcador por linha é a verdade para retomada:
UUID aleatório, timestamps antigos e novas inserções não causam saltos. Falha no lote
não avança o checkpoint. Linhas v1 não são reprocessadas. Um novo processo/conexão
retoma os lotes restantes; execução repetida sem pendência faz zero alterações.

## Purga e implantação

073 não procura texto, chaves, CNPJ, nomes nem IDs históricos em auditorias. Preserva
guardas de tenant/admin, concorrência e a identidade legada compartilhada já existente,
apaga o grafo e grava COMPANY_PURGED. Timeouts no serviço: statement 30s, lock 5s.
O header permanent-v1 e a confirmação digitada são mantidos.

Enquanto houver qualquer auditoria legada v0, a purga retorna conflito, por verificação
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
