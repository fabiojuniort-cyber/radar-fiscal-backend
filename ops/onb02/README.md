# ONB-02-R3 — Exclusão definitiva de empresa (REVIEW/NO-PROD)

Issue: https://github.com/fabiojuniort-cyber/tribusca-control/issues/118

## Escopo
- A ação DELETE autenticada remove **fisicamente** a empresa, suas unidades e
  registros diretamente vinculados via FKs CASCADE (CNAE, perfis tributários,
  produtos, NCMs, monitoramento, matches), em transação única.
- Publicações oficiais, textos legais, taxonomia e catálogos globais continuam
  preservados e compartilhados; nenhum DELETE em publicações.
- Limpar dados cadastrais legados do onboarding daquele CNPJ no tenant, mantendo
  o aceite de privacidade/termos do usuário.
- Logs de autenticação e auditoria de segurança são registros independentes e
  exigem verificação de minimização e retenção. **Não afirmar apagamento de
  backups ou de histórico/auditoria antes de comprovar as políticas pertinentes.**
- A operação não poderá ser liberada enquanto houver dados privados da empresa
  em referências sem cobertura identificadas pelo preflight.

## Parecer independente — BLOCK (17/10/2026)

O parecer no HEAD `2dc7a525` identificou B1–B4, e continua BLOCK
até uma **nova revisão independente** do SHA corrigido. CI verde é condição
necessária, não autoriza merge/deploy.

**B1:** a função verifica vínculos de matches com origens em empresas
diferentes nos dois sentidos e bloqueia novas referências com locks
`FOR UPDATE` sobre empresa, perfis de monitoramento e relacionamentos com
publicações. A prova de concorrência é executada no teste adversarial.

**B2:** o legado de signup só é associado à empresa mediante CNPJ; o nome
da conta só é redefinido automaticamente quando coincide com o nome guardado
nesse legado comprovadamente associado. Nomes coincidentes mas sem vínculo
confiável provocam `company_purge_legacy_identity_ambiguous` e cancelamento
atômico, para não apagar nome personalizado da conta. A limpeza do nome do
tenant não é permitida por mera coincidência sem prova.

**B3:** `test/onb02-company-purge-graph.integration.test.ts` semeia linhas
não vazias das dependências, publicação e versão compartilhadas, perfis
históricos, NCMs, empresas em dois tenants e duas empresas no mesmo tenant,
vínculos cruzados normais e inconsistentes, rollback após falha auditada,
concorrência e recadastro novo. O teste é gate em PostgreSQL 16 e 18.

**B4:** o script `ops/onb02/preflight-readonly.sql` prepara inventário
read-only de grafo recursivo FK, policies, owner, grants, triggers e possíveis
anomalias. **Não executado em produção nesta entrega.**

### Estado Railway observado (somente metadata, sem SQL)

Consulta read-only ao ambiente production em 17/10/2026:
- serviços `Postgres`, `radar-fiscal-backend`, `radar-fiscal-worker`
  e `radar-fiscal-scheduler` estavam com último deploy SUCCESS;
- há volume `postgres-volume`, bucket `Postgres-PITR` e serviços
  de restauração usados em outras frentes; **nenhum constitui por si
  backup/restore comprobatório desta operação**;
- nenhum deploy do ONB-02 ou exclusão de empresa foi executado neste trabalho.

### Evidências ainda ausentes — mantenha BLOCK

- Inventário efetivo do PostgreSQL produtivo + referências sem FK (textos,
  JSONB, cache, nomes/slugs da conta, auditoria e arquivos externos), obtido
  por canal autorizado, com saída sanitizada e comparação com o schema;
- ID/data/hash de backup **específico ONB-02**, integridade, restauração testada
  em PostgreSQL isolado dentro da Railway e consistência antes/depois;
- dry-run no restore do **SHA exato** em cenário representativo, com manifesto
  de objetos próprios, contas não relacionadas e publicações globais;
- simulação de rollback de deployment compatível com migration; se dados
  já foram eliminados, recuperação seletiva ensaiada (não é rollback de código);
- parecer independente PASS, autorização R3 explícita e LOCK válido.

## Gates antes de produção — NÃO EXECUTAR SEM PROVAS
1. Confirmar autorização R3 vigente, LOCK e ausência de outra execução.
2. Revisão independente adversarial do SHA exato da migration/função, endpoint,
   permissões, RLS, FKs e tratamento de erros; validar impacto nos testes de
   reativação legados.
3. Obter via canal Railway **não-AI** o schema real e inventário read-only das
   referências: `pg_constraint` (FKs de company/establishments/monitoring);
   triggers; grants; `pg_policies`; referências em audit_log, onboarding,
   caches, tenant memberships, object storage e jobs.
4. Verificar backup e restore TESTADO em PostgreSQL temporário isolado dentro
   da Railway, dry-run sem alterações produtivas e plano de rollback do código;
   não usar rollback de schema ou restore de DB automaticamente.
5. Executar suíte PG18 isolada com duas contas, CNPJ repetido, perfil com
   produtos/CNAEs/NCMs, publicações compartilhadas, fail-closed de cross-tenant
   e idempotência. CI integral PASS no HEAD final, revisão independente PASS.
6. Backend PR aprovado e publicação controlada ANTES da UI que comunica
   exclusão permanente. Conferir migração, funções e privileges no banco real;
   smoke com dados de teste apenas se expressamente autorizado.
7. Confirmar pós-execução sem empresa/perfis/vínculos, outra conta inalterada,
   novo CNPJ começa do zero, logs sem dados pessoais.

## Esquema
- Migration 073 cria `app_purge_company(UUID)` sem apagar dados no momento de
  sua aplicação. Nenhum `GRANT DELETE ON companies` ao runtime.
- A função SECURITY DEFINER revalida user/tenant/admin, usa FOR UPDATE, impede
  vínculos de matching entre companhias e efetua DELETE da company + cascatas.
- Os grants e RLS para dados empresariais continuam restritos.
- `audit_log` do evento mantém somente ação sem CNPJ ou ID da empresa.

## STOP / rollback
Se uma FK ausente, falha RLS, privilégio inesperado, dado fora do tenant,
execução concorrente, divergência de contagens, incompatibilidade em versões do
app, backup/restore não comprovado ou revisão pendente: **HOLD**. Nenhuma
exclusão física em PR, merge, migration ou deploy por inferência. Reverter
código para versão anterior se necessário, depois de verificar compatibilidade
com schema; dados purgados exigem restauração individual autorizada.


## R5 — complemento ao R4 (sem liberação produtiva)

- Não há reativação de matriz, filial ou empresa; inativas preexistentes permanecem intocadas até exclusão explícita.
- A auditoria histórica só é minimizada quando o evento é inequivocamente atribuível; nomes exatos normalizados por caixa/acentos são mascarados dentro do tenant se não existirem homônimos nele. A contagem de outras empresas homônimas é registrada sem nome no evento `COMPANY_PURGED`.
- `audit_log` mantém ação/data/usuário/tipo de entidade; menções a empresa-alvo em auditorias de outra entidade do tenant não autorizam editar esse histórico.
- A migration 073 deve estar ausente do ledger antes do rollout: checksum divergente proíbe sobrescrever migração já aplicada. O gate permanece BLOCK; `statement_timeout` da função = 30s e índice composto `ix_audit_r5_tenant_entity`. Benchmark de 50 mil auditorias somente em PG18 isolado (CI).
- R5 exige revisão independente de novo HEAD e CI integral verde. Não executar DDL/DELETE/EXPLAIN em produção para validação.

## R6 — implementação para revisão, sem produção

- Nome exato digitado no diálogo de exclusão definitiva. Header versionado de intenção impede purga por abas antigas que ainda prometam desativação; backend primeiro passa a bloquear essas abas com 409 até atualizar o web.
- O serviço company-purge.service aplica SET LOCAL statement_timeout='30s' e lock_timeout='5s' no transaction antes do SELECT, não como SET na função.
- IDs históricos privados são recuperados por tipo de entidade privado e campos top-level explícitos de propriedade (company_id/companyId e pais privados conhecidos), somente no mesmo tenant. Menção livre, nome/CNPJ ou tipo de produto global não comprovam propriedade. Contradição com entidade atual de outra empresa aborta.
- Nomes são normalizados por normalize(..., NFC) antes da remoção de acentos e comparação exata nos dois lados.
- Testes PG18: filial e perfil previamente eliminados, auditoria remota intacta, nomes NFD/homônimos, cliente antigo bloqueado, statement_timeout após cascata com rollback total e lock_timeout com rollback.
- Benchmark PG18 descartável: 41.000 auditorias, 420.000 collection_items globais preservados por contagem/hash, grafo 1+2+11+35+47+5+2+13=116; monitoring/matches/company_publications=0 conforme inventário comunicado. Dados são sintéticos com igualdade de contagens, não réplica da distribuição/tamanho de JSON nem do hardware produtivo.
- Medição opcional via app.onb02_measure=on retorna somente tempos em app.onb02_purge_metrics da mesma transação: locks/guards, legado, identidade/histórico, auditoria, matches, cascatas, evento e total. Sem identificadores/nomes.
- Produção permanece proibida. O preflight do ledger 073 e índice/owner/ACL continua obrigatório para eventual pacote posterior. ACCEPTED_RISK de recuperação é preservado.
