# ONB-02 R3 — Consolidação do inventário real (somente leitura)

**Ambiente:** Railway / PostgreSQL 18 / `production`.
**Proveniência:** consultas SQL `SELECT` executadas pelo operador autorizado na interface Railway, com resultados agregados encaminhados ao projeto em 17/10/2026, e leitura de metadados Railway/GitHub pelas integrações. **O executor do PR não recebeu conexão SQL direta, não executou os SELECTs em primeira mão e não assinou uma reconciliação independente.**
**Rastreabilidade:** [tribusca-control issue #118](https://github.com/fabiojuniort-cyber/tribusca-control/issues/118). Confrontar este relatório com as evidências originais e scripts antes de declarar PASS.
**Proibição:** nunca executar purge/DELETE produtivo, DDL, migração 073, merge, deploy ou restore como parte do inventário.

## Evidências obtidas

| Verificação | Evidência da produção | Avaliação |
| --- | --- | --- |
| Objetos PostgreSQL | 98 objetos do schema `public` informados (tabelas e 3 views); núcleo ONB-02 presente. | Cobertura descritiva, não equivalência estrutural total |
| FKs empresa | 7 FKs diretas `CASCADE`; indiretas `company_product_ncms`, `establishment_cnaes` e dois caminhos em `publication_matches` (`CASCADE` e `NO ACTION`). 11 arestas, 10 tabelas-filhas distintas. | Coerente com as migrations versionadas; não cobre referências sem FK |
| ACLs das 14 tabelas privadas selecionadas | RLS e FORCE RLS habilitados nas 14. `radar_worker_runtime`: nenhuma exclusão direta; `radar_app_runtime`: exclusão direta apenas em cinco tabelas auxiliares (CNAE/produto/NCM). `companies`: sem privilégio direto. | Nenhuma divergência aparente; RLS efetivo depende das policies |
| Políticas RLS | 12 políticas em 6 tabelas, `radar_app` com predicados de tenant/membership e `radar_worker` SELECT por tenant. | Verificada amostra crítica, não todas as policies |
| Triggers customizados | 7 triggers nas 14 tabelas críticas, todos UPDATE ou INSERT/UPDATE, nenhum trigger customizado em evento de exclusão. | Nenhum trigger de DELETE encontrado nesse perímetro; mecanismos FK internos permanecem |
| Views privadas | Consulta `pg_depend` + `pg_rewrite`, com raízes em todo o grafo FK privado e travessia de views, devolveu **0 linhas**. | Sem view/materializada vinculada por esse catálogo; referências indiretas via função não comprovadas |
| Roles | `radar_app_runtime` e `radar_worker_runtime` não têm SUPERUSER, BYPASSRLS, CREATEROLE ou CREATEDB; herdam exclusivamente `radar_app` ou `radar_worker`, respectivamente. | Coerente; proprietário `postgres` é administrador |
| Funções | Sete funções de tenant/usuário inspecionadas. Cinco SECURITY DEFINER com `search_path=pg_catalog,public`. 19 concessões EXECUTE explícitas, **0 PUBLIC**. Worker não executa funções de administração. | Corpos SQL conferidos com código; confiança nas GUCs exige autenticação validada no backend |
| Backend/contexto | `auth.plugin.ts` valida JWT e sessão; `withTenantContext` valida membership e estado ACTIVE antes de definir `app.tenant_id` transacional. | Sem bypass evidente nos caminhos inspecionados; não é prova global de runtime |
| Função de purge no banco | `app_purge_company` não aparece, esperado: migration 073 **ainda não implantada**. | Não interpretar ausência como incidente |
| Colunas sem FK/JSONB | 37 relações candidatas levantadas. Auditoria, auth, onboarding e alguns metadados de coleta analisados; taxonomia e acervo global preservados. | Inventário de candidatos, **não** comprovação de ausência de resíduos |
| Audit log | 41.198 auditorias; busca por chaves `cnpj`, `company_id`, `establishment_id`, `profile_id` (e variantes) encontrou 0. `after_data.input`: 9.354 operações de curadoria da taxonomia, 0 termos cadastrais pesquisados. | Busca lexical não encontra necessariamente identificadores sob outras chaves, `entity_id`, JSON profundo ou formatação alternativa |
| Metadados de autenticação | `auth_sessions`: 109 registros, 0 metadados preenchidos. `auth_refresh_tokens`: 1.227 registros, 0 metadados preenchidos. | Não excluir sessões da conta compartilhada; demais colunas não avaliadas |
| Onboarding legado | Um registro sem CNPJ, com nome diferente de qualquer razão/nome fantasia no próprio tenant; tenant contém várias empresas; nome do perfil igual ao nome da conta. | **PRESERVAR** enquanto não houver prova de vínculo exclusivo. A migration 073 mantém esse caso sob essas condições |
| Infraestrutura Railway | 11 serviços, 5 volumes, 1 bucket Railway `Postgres-PITR`. Backend/worker/scheduler sem volume Railway montado; volumes adicionais estão em runners/serviços de backup, restore e PostgreSQL. | Não demonstra ausência de arquivos temporários, caches em processo, serviços externos ou dados do mesmo cliente em integrações |
| Recuperação | Snapshot de volume e opção de restore relatados; recuperabilidade não ensaiada. | **ACCEPTED_RISK**: responsável dispensou backup adicional e teste de restore; NÃO equivale a PASS de recuperação |

## Classificação de resíduos e dependências

1. **Dados exclusivos com FKs**: previstos para cascata ou limpeza explícita `publication_matches`; CI sintético testa preservação de outras empresas e globais. A SQL real não executou purge e portanto não comprova readback pós-purga.
2. **Dados compartilhados da conta**: preservar `tenants`, logins/sessões e cadastro inicial sem CNPJ descrito acima. Não usar igualdade de nome/tenant isoladamente como prova para apagar.
3. **Auditorias históricas**: as pesquisas até aqui são negativas para chaves cadastradas específicas. Existem caminhos documentados de audit por `entity_id`, CNPJ/UUID sob nomes genéricos; **retenção/minimização por empresa e escopo privado anterior ainda requerem classificação assinada**, sem exposição de identificadores nas Issues.
4. **Acervo, origens, anexos e taxonomia globais**: preservar, inclusive citações legais legítimas a CNPJs/nomes; nunca fazer limpeza por busca textual genérica.
5. **Caches e arquivos**: `src/infrastructure/cache/ttl-cache.ts` declara cache de agregados não específicos de tenant/usuário; o código possui cache transitório de inventário e spool de coleta em filesystem. Nenhum volume está montado nos três serviços principais segundo inventário Railway, mas não há prova de inexistência de arquivos efêmeros, integrações externas, outras rotinas ou tokens de serviços.

## O que falta para B4 PASS independente

- Conferir com o operador os resultados originais, ambiente, data/hora, identidade de inspeção e hashes dos scripts; a evidência veio em recortes agregados e não é atestação do inventário completo executado em uma única sessão.
- Inventariar efetivamente referências por **escopo privado pré-purga** (identificadores de company/establishment/tax/product/monitoring/company-publication/match e CNPJs) em tabelas históricas sem FK, com saída **somente de contagens** e política de retenção. Uma busca lexical genérica com resultado zero NÃO prova ausência desses dados.
- Classificar por escrito efeitos de caches/spool/arquivos/jobs e sistemas externos que guardem material cadastral exclusivo. Metadados Railway não comprovam ausência em serviços externos.
- Nova revisão adversarial no **HEAD exato** do PR, CI completo no mesmo SHA e comprovação de concorrência writer-after-lock; aceitar ou bloquear com achados reproduzíveis.

**PARECER CONTINUA BLOCK.** O registro do inventário NÃO autoriza merge, deploy, migration nem exclusão produtiva. A dispensa de novo backup e restore é exclusivamente **ACCEPTED_RISK**.
