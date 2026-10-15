# F2-DRAFT-01 — importação explícita de staging ao rascunho (REVISÃO)

**Isolado do F2-LOAD-10. Não executar em produção antes de revisão COORD.** Não há automação, cron, endpoint, merge, deploy ou publicação neste PR.

## Contrato
- Fonte imutável: somente o par aprovado Segmento v5.1 (1.332 linhas, SHA 695b0df…) e Produto v5 (4.225, SHA 261da490…), batch `f4ab4f0c-9755-4957-9b51-826aeddb4bca`. O conteúdo e o hash de cada linha são recalculados. Exige 448 avisos documentais. O `plan` consulta `taxonomy_f2_import_batches.status` e rejeita qualquer status diferente de `STAGED`.
- Contrato do schema: migration 066 cria `taxonomy_f2_import_batches.status TEXT NOT NULL DEFAULT 'STAGED' CHECK(status = 'STAGED')`; migration 068 atualiza as contagens para 1.332/4.225. O log de produção `F2_LOAD_ALL_RESULT` confirmou batch/contagens/readback, mas **não exibiu a coluna status**; portanto só a consulta SQL do `plan` à produção comprova o valor efetivo. Nenhuma confirmação SQL direta de produção foi executada nesta revisão.
- Alvo: **um** rascunho CURATED em status `DRAFT`. Nunca cria rascunho sem ação do curador, nunca publica e nunca toca empresas, publicações, links legais ou classificações históricas.
- O `plan` é READ ONLY e retorna `draftId`, `batchId`, hash de conteúdo e, separadamente para Segmento e Produto, criados (código ausente), atualizados (mesmo código com campos divergentes), iguais (sem divergência), existentes no rascunho fora do lote (total e até 10 exemplos com código/CNAE/NCM/status) e CNAEs/NCMs exatos presentes em **mais de um conceito** (total e até 10 exemplos com códigos de conceitos). Conceitos aposentados aparecem como fora do lote, mas não geram conflito ativo. Campos confrontados: descrição, definição, grupo, CNAE/NCM, sinônimos, visibilidade, classificação, ordem e status.
- Os exemplos são limitados apenas na apresentação: o `exceptionsApprovalSha256` incorpora a lista **integral** de exceções. Se houver fora do lote ou CNAE/NCM duplicado, `requiresCoordApproval=true`. O `apply` exige OK expresso do COORD **e** `--coord-approval-exceptions-sha256=<hash_do_plan>`; o flag sem aprovação documental não constitui autorização. Se o rascunho ou as exceções mudarem, um novo `plan` gera outro hash e bloqueia o anterior. Nenhum item fora do lote é removido automaticamente.
- O `apply` exige confirmação explícita do UUID do lote e hash do conteúdo apresentados no `plan`. Todo o bloco usa o login mínimo `radar_taxonomy_curator_runtime`, `SET LOCAL ROLE radar_taxonomy_curator`, transação única e lock compartilhado com curadoria.
- Segmento: CNAE oficial preservado, item = descrição do CNAE, grupo = Segmento – Sub Segmento, código TriFaros explícito/fallback determinístico. Produto: item/grupo e NCM de 2/4/5/6/7/8 dígitos aceitos na curadoria, inclusive zeros à esquerda; 3 dígitos inválido (F2-DRAFT-12). Sinônimos são mesclados sem descartar os existentes. Nenhum vínculo produto × CNAE é inventado por posição.
- **T07/T08:** as sugestões de Produto e NCM **por CNAE** da planilha Segmento ficam preservadas exclusivamente no staging (`taxonomy_f2_import_segment_rows.raw_cells`, campos sugeridos); este importador não cria vínculos produto×CNAE com base nessas sugestões. A vinculação dependerá de regra específica, evidência e aprovação nas etapas T07/T08.
- Atuação: cria a dimensão com 12 categorias aprovadas e grava 1.332 relações fonte CNAE/Atuação com a prova de projeção oficial existente. Tudo no mesmo COMMIT.
- Livro de idempotência: chave única (release, batch); segunda execução relê e reconcilia os dados do rascunho, sem executar importação de novo. Divergência de hash ou de campos importados bloqueia.
- Qualquer falha reverte **todas** as alterações do rascunho da execução; staging e versões publicadas não são modificados.

## Execução (não executar sem gate)
```bash
npm run build
npm run taxonomy:f2-import-draft -- --mode=plan
npm run taxonomy:f2-import-draft -- --mode=apply --confirm-batch-id=<UUID_DO_PLAN> --confirm-content-sha256=<SHA256_DO_PLAN> [--coord-approval-exceptions-sha256=<HASH_DO_PLAN_APROVADO_PELO_COORD>]
```

Credencial de escrita: `DATABASE_CURATOR_URL` (login dedicado), ou combinação `DATABASE_URL` + `DB_CURATOR_RUNTIME_PASSWORD`. CLI verifica `session_user` e rejeita administrador. Nunca imprimir senhas/URLs.

## Gates pré-produção
1. Migration 070 avaliada quanto à concorrência e permissões; nenhum `GRANT` para app/worker.
2. CI integral, PG18 isolado e simulação com cópia do lote real. Confirmar mapeamento de código/grupo de CNAE e produto; 1.332/4.225 linhas. Revisar colisões.
3. Autorização expressa do COORD/Fábio para importar ao DRAFT, separada do OK do staging; se o plan identificar itens fora do lote ou duplicidade de CNAE/NCM, exige aprovação expressa da lista de exceções e hash correspondente.
4. Executar plan, confrontar contagens e SHA, somente então apply. Confirmar `readback=PASS`, `published=false`; segunda execução idempotente.


## F2-DRAFT-12 — domínio validado antes de qualquer gravação

- Base de implementação: `fix/f2-draft-11-group-slug@421ae6c05bd38f735d41ce0ccf72eed20b521b32`; destino do PR: `ops/f2-draft-10-runner`. Preserva a correção dos grupos por slug.
- O `CODE_SHAPES.NCM` compartilhado pela curadoria aceita somente 2, 4, 5, 6, 7 ou 8 dígitos. Três dígitos permanece inválido. `formatOfficialCode` exibe cinco dígitos como `0101.2` e sete como `0101.21.0`, sem ponto final ou perda de zeros.
- O parser mantém o contrato estrutural e a integridade do staging (array JSONB de strings com 2–8 dígitos). Isso não é aprovação de domínio: após o parse, o plan executa `normalizeCodes` sobre TODOS os conceitos, inclusive iguais/atualizados, usando o tipo oficial real de cada dimensão da release. Um NCM de três dígitos é rejeitado nessa etapa, sem alterar o staging.
- O preflight também verifica rótulo e definição com o mesmo validador puro de create/update (apenas exportado, sem mudar o comportamento CRUD), tipos de alias novos e preservados, grupo sem rótulo/slug, código canônico e titularidade de conceito em outra dimensão. As verificações de existência/identidade usam apenas SELECT; existência de rascunho editável, lote, ledger e dimensões continuam sendo conferidas pelo fluxo anterior.
- Plan válido apresenta `invalidOfficialCodes: {count: 0, examples: []}` e `invalidConceptInputs` equivalente. Se houver código inválido, falha com `F2_DRAFT_OFFICIAL_CODE_INVALID`; demais entradas inválidas geram `F2_DRAFT_CONCEPT_INPUT_INVALID`. O erro sanitizado inclui os dois relatórios em `validation=...`, com contagem integral e até dez exemplos por relatório contendo somente dimensão, linha de origem e motivo. Não imprime códigos oficiais, rótulos, aliases, SQL, URLs ou mensagens internas. Não há saída de plan aprovado quando a contagem é positiva.
- O apply refaz o mesmo `currentDraftPlan` antes de grupos/conceitos/Atuação/ledger. Código inválido impede o início das escritas, mesmo que uma confirmação antiga seja fornecida. Os testes exercitam o caminho real de plan/apply com um cliente que recusa qualquer comando diferente de SELECT.
- Limites: dependências de banco que só podem ser confirmadas no instante da escrita continuam protegidas pela transação única, lock e rollback. O preflight não é autorização de apply/publicação.

### Impacto NCM (somente leitura; módulos preservados)
O detector em publicações continua extraindo/validando 2/4/6/8 dígitos; não passa a detectar 5/7 por esta correção.
O helper de matching por prefixo continua rejeitando 5/7, inclusive na classificação curada e afinidade: esses códigos passam na curadoria, mas não participam desse matching até uma mudança específica autorizada pelo COORD. Nenhum desses módulos foi alterado.

### CI e entrega
O workflow padrão só dispara PRs cuja base é `main`. Como no #234, o PR usa `main` temporariamente para executar CI completo e é retargetado para `ops/f2-draft-10-runner` após o PASS; a revisão do delta deve comparar o head com o pai `421ae6c0`. Nenhum merge, deploy, comando Railway ou carga faz parte desta entrega.
