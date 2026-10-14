# F2-DRAFT-01 — importação explícita de staging ao rascunho (REVISÃO)

**Isolado do F2-LOAD-10. Não executar em produção antes de revisão COORD.** Não há automação, cron, endpoint, merge, deploy ou publicação neste PR.

## Contrato
- Fonte imutável: somente o par aprovado Segmento v5.1 (1.332 linhas, SHA 695b0df…) e Produto v5 (4.225, SHA 261da490…). O conteúdo e o hash de cada linha são recalculados. Exige 448 avisos documentais.
- Alvo: **um** rascunho CURATED em status `DRAFT`. Nunca cria rascunho sem ação do curador, nunca publica e nunca toca empresas, publicações, links legais ou classificações históricas.
- O `plan` é READ ONLY e retorna `draftId`, `batchId`, hash de conteúdo, contagens de novos/atualizados e os totais de origem.
- O `apply` exige confirmação explícita do UUID do lote e hash do conteúdo apresentados no `plan`. Todo o bloco usa o login mínimo `radar_taxonomy_curator_runtime`, `SET LOCAL ROLE radar_taxonomy_curator`, transação única e lock compartilhado com curadoria.
- Segmento: CNAE oficial preservado, item = descrição do CNAE, grupo = Segmento – Sub Segmento, código TriFaros explícito/fallback determinístico. Produto: item/grupo e NCM de 2 a 8 dígitos preservados, inclusive zeros à esquerda. Sinônimos são mesclados sem descartar os existentes. Nenhum vínculo produto × CNAE é inventado por posição.
- Atuação: cria a dimensão com 12 categorias aprovadas e grava 1.332 relações fonte CNAE/Atuação com a prova de projeção oficial existente. Tudo no mesmo COMMIT.
- Livro de idempotência: chave única (release, batch); segunda execução relê e reconcilia os dados do rascunho, sem executar importação de novo. Divergência de hash ou de campos importados bloqueia.
- Qualquer falha reverte **todas** as alterações do rascunho da execução; staging e versões publicadas não são modificados.

## Execução (não executar sem gate)
```bash
npm run build
npm run taxonomy:f2-import-draft -- --mode=plan
npm run taxonomy:f2-import-draft -- --mode=apply --confirm-batch-id=<UUID_DO_PLAN> --confirm-content-sha256=<SHA256_DO_PLAN>
```

Credencial de escrita: `DATABASE_CURATOR_URL` (login dedicado), ou combinação `DATABASE_URL` + `DB_CURATOR_RUNTIME_PASSWORD`. CLI verifica `session_user` e rejeita administrador. Nunca imprimir senhas/URLs.

## Gates pré-produção
1. Migration 070 avaliada quanto à concorrência e permissões; nenhum `GRANT` para app/worker.
2. CI integral, PG18 isolado e simulação com cópia do lote real. Confirmar mapeamento de código/grupo de CNAE e produto; 1.332/4.225 linhas. Revisar colisões.
3. Autorização expressa do COORD/Fábio para importar ao DRAFT, separada do OK do staging.
4. Executar plan, confrontar contagens e SHA, somente então apply. Confirmar `readback=PASS`, `published=false`; segunda execução idempotente.
