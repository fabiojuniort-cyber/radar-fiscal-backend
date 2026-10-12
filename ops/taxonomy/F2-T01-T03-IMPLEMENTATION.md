# F2-T01–T03 — lote de implementação (checkpoint seguro)

**Estado:** implementação iniciada, **ainda não completa**. Este PR contém um importador **DRY_RUN_ONLY**, testes unitários e documentação. **Sem alterações produtivas, banco de dados, migrations, frontend ou autorização para merge/deploy.**

## O que já foi codificado

- **T01 (preparação de contrato):** helper puro \`segmentSubsegmentLabel(segmento, subsegmento)\` que gera "Segmento – Subsegmento" para apresentação, **sem criar identidade nova**. **Interface integrada no [PR web #103](https://github.com/fabiojuniort-cyber/radar-fiscal-web/pull/103), ainda DRAFT e sem deploy.**
- **T02 (preparação da fonte inicial):** derivação das categorias de **Atuação** a partir da coluna "Atuação" da aba Segmento; frequência e origem CNAE preservadas; sinônimos \`[]\` por padrão, sem herdar aliases de Segmento; **Nova dimensão persistente e os 7 conceitos iniciais no rascunho implementados em `curation.actuacao.ts` e rota admin; frontend de curadoria em PR web #103.** Ainda faltam a persistência das relações por CNAE (1.332 origens), integração e revisão de evidências/classificação antes de publicar. O importador recusa fontes com nova categoria inesperada.
- **T03 (fase 1):** importador XLSX read-only \`ops/taxonomy/f2-xlsx-dry-run.mjs\` com hashes SHA-256 *exatos* do manifesto, cabeçalhos e contagens de linha congelados, prevenção de escrita/confirm, sem download de rede ou extração de arquivos ZIP. Produz um plano em JSON e lista anomalias. **Não faz carga no PostgreSQL**. Reaproveita \`yauzl\`, dependência já existente no backend. Testes em \`test/f2-xlsx-dry-run.unit.test.mjs\`.

## Comando para dry-run, sem banco

\`\`\`sh
node ops/taxonomy/f2-xlsx-dry-run.mjs \
  --segmento='/caminho/taxonomia-v1_7_3-segmento(1)(2).xlsx' \
  --produto='/caminho/taxonomia-v1_7_0-produto(1)(2).xlsx' \
  --out=./f2-t03-dry-run.json
\`\`\`

**\`--confirm\`, \`--apply\`, \`--write\` e \`--deploy\` são recusados por desenho.** O resultado sempre é DRY_RUN_ONLY. Não passar \`--out\` para somente ver resumo em stdout; \`--out\` escreve relatório local novo, nunca dados no BD.

## Resultado da inspeção independente dos arquivos anexados (12/10/2026)

Os arquivos XLSX enviados na conversa foram examinados com um leitor de planilha independente. Não houve conexão com PostgreSQL, escrita, deploy ou publicação.

| Checagem | Resultado |
| --- | --- |
| Segmento SHA-256 | \`588a89871044a1ca67036fb5c17cdba3ba70f447bd1412fc476f14bb1d6440cd\` — PASS |
| Produto SHA-256 | \`35e886e711f0c1c793daaa6a5e61c5500f3ab235913b9bc8e026ea8d8fc0db49\` — PASS |
| Segmento | 1.332 linhas, 223 pares Segmento/Subsegmento, 1.332 CNAEs distintos |
| Produto | 3.793 linhas, 3.793 códigos de produto distintos |
| Atuação | 7 categorias únicas; Serviço 583, Indústria 380, Comércio atacadista 116, Produção agropecuária 108, Comércio varejista 89, Extração mineral 41, Representação comercial 15 |
| **Erros bloqueantes detectados** | **5 ocorrências** (ver tabela abaixo) |
| Cardinalidade Produto(s) × NCM(s) sugeridos | **442 alertas**; não inferir ligação posicional 1:1 |

### Incidências e decisão de segurança

| Aba/linha Excel | Problema | Decisão |
| --- | --- | --- |
| Produto / **333** | Valor NCM \`9001.10, 8544.70\` (vírgula, dois valores na mesma célula) | **Bloquear** e pedir curadoria/normalização explícita antes de gravar; não concatenar como NCM único |
| Produto / **340–342** | Segmento e Grupo vazios (3 itens classificados como \`Sugestão IBGE\`) | **Bloquear** e pedir associação curada; não herdar automaticamente do item anterior |
| Produto / **3788** | Lista NCM termina com texto \`Vazio\` | **Bloquear** e pedir decisão sobre sentinela; nunca converter em código NCM |

A cardinalidade distinta não é erro em si: sugestões independentes podem referir grupos com quantidades diferentes. Não construir \`Produto × NCM\` por índice da lista.

> **Observação de evidência:** o *resultado de 5 erros* foi obtido por inspeção independente offline dos XLSX locais. **Os seis testes unitários do novo importador foram executados e passaram no CI rápido do GitHub**, incluindo recusa de hash incorreto e flags de carga; a execução integral do comando Node contra os dois XLSX reais **ainda não foi comprovada**, nem houve ensaio contra uma base de testes. Portanto, não confundir a inspeção offline com teste integrado do importador.

## Gates de T00 e T03

- **T00 documental / PR 105:** as árvores GitHub de \`tribusca-control/main\` e branch \`docs/f2-t00-reconciliacao-20261012\` **ainda não mostram os dois XLSX**: constam localmente no ChatGPT, mas **não há SHA remoto confirmável**. Não marcar PR #105 ready nem fazer merge. A aprovação funcional da DEF-01 já foi registrada.
- **T03 produtiva, ainda NÃO autorizada:** exigir (1) correção ou aceite curado das anomalias, (2) validação de fonte remota; (3) testes do importador em ambiente isolado; (4) **dry-run completo de banco, sem persistir**; (5) **backup verificado** e plano de rollback; (6) **OK explícito do Fábio**; (7) gates de segurança/CI/revisão e **OK de CLAUDE-COORD** para qualquer merge/deploy de código.
- **T01/T02:** execução integral ainda requer mudanças coordenadas no \`radar-fiscal-web\` e no modelo global de curadoria. **Não dizer que estão entregues nesta primeira branch**.

## Acompanhamento e coordenação

Lote coordenado em dois PRs (um por repositório): backend **#216** e frontend **#103**, ambos DRAFT. **Ordem de merge futura autorizada: backend primeiro, frontend depois**, somente após OK de CLAUDE-COORD e gates de CI e revisão. Nenhum merge/deploy nesta execução.

**Percentual atual T01–T03:** aproximadamente **70%** (UI, dimensão Atuação em rascunho, importador read-only e testes; ainda falta persistência dos vínculos de CNAE, resolução das anomalias e validação integral).

## CI de 12/10/2026 no PR #216 (HEAD `38817d59ee4ee445a794defdb6073f9a7362ccbe`)

- **Typecheck, build, testes unitários gerais, 6 testes do F2, RFB news e NCM parser/detector: PASS.** Evidência: CI run [38317303817](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/actions/runs/38317303817), job `verify` #115036925304.
- **LOTE-2 Isolated PostgreSQL 18: PASS.** Evidência: run [38317303703](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/actions/runs/38317303703).
- **CI geral final: FAILURE PREVISTO POR POLÍTICA DE PR DRAFT**, step `Require full regression before merge`. Logs exibem `CI_DRAFT: true` e instrução para não interpretar quick checks como liberação. **Não retirar DRAFT sem gate de revisão/autorização.**
- O HEAD documentado acima é anterior a esta atualização textual. O commit documental novo acionará checks próprios.
