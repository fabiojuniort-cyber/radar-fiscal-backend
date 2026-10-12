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

**Percentual do checkpoint anterior T01–T03:** aproximadamente **70%** (UI, dimensão Atuação em rascunho, importador read-only e testes; ainda falta persistência dos vínculos de CNAE, resolução das anomalias e validação integral).

## CI de 12/10/2026 no PR #216 (HEAD `38817d59ee4ee445a794defdb6073f9a7362ccbe`)

- **Typecheck, build, testes unitários gerais, 6 testes do F2, RFB news e NCM parser/detector: PASS.** Evidência: CI run [38317303817](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/actions/runs/38317303817), job `verify` #115036925304.
- **LOTE-2 Isolated PostgreSQL 18: PASS.** Evidência: run [38317303703](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/actions/runs/38317303703).
- **CI geral final: FAILURE PREVISTO POR POLÍTICA DE PR DRAFT**, step `Require full regression before merge`. Logs exibem `CI_DRAFT: true` e instrução para não interpretar quick checks como liberação. **Não retirar DRAFT sem gate de revisão/autorização.**
- O HEAD documentado acima é anterior a esta atualização textual. O commit documental novo acionará checks próprios.

## F2-T02 — Persistência de relações CNAE entregue no código (12/10/2026)

- Migration **064**: `taxonomy_release_actuacao_cnae_origins` referencia os conceitos de Atuação da **mesma release**, preserva CNAE de sete dígitos, linha original, SHA-256 de fonte, unicidade e integridade referencial; trigger impede mutação em releases publicadas.
- `src/modules/taxonomy/curation/curation.actuacao.ts`: importa **somente a projeção autenticada** dos 1.332 pares CNAE–Atuação da Segmento v1.7.3; exige SHA original `588a8987…d6440cd` e também o digest da projeção `79436022…9da65`, valida 7 categorias, frequências, CNAEs únicos e linhas na ordem original. Mesma importação é idempotente; regravação divergente é recusada.
- `curation.draft.ts`: cópia dos vínculos de origem para um futuro rascunho da mesma taxonomia, com novo vínculo ao conceito da release destino.
- `taxonomy-admin.route.ts`: endpoint admin **/drafts/current/actuacao/origins**, protegido por role e transação de curadoria. **Não publica**, não reclassifica nem altera Segmento.
- **Frontend PR #103:** permite enviar o JSON do relatório de dry-run do importador; o servidor confirma o hash da projeção antes de persistir no rascunho. Não é carga produtiva T03 de produtos/NCM.
- **Teste real PG18 isolado: PASS.** [Run 38319587922](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/actions/runs/38319587922): `test/taxonomy.actuacao.integration.test.ts` — persistência, unicidade, isolamento no rascunho, dados adulterados rejeitados e imutabilidade depois da publicação.
- **Ainda pendente:** execução positiva de todos os **1.332 vínculos em conjunto** a partir dos binários finais recebidos no GitHub, revisão independente, regressão integral e gates para qualquer merge/deploy. O teste PG18 não realizou carga produtiva.

## F2-T00/T03 — entrega dos novos XLSX ainda NÃO confirmada remotamente

A verificação final da branch do PR de governança **#105** continua mostrando **apenas `docs/reference-data/f2/README.md`**. Não existe objeto XLSX para calcular o SHA remoto de Produto v1.7.1 ou Segmento v1.7.3. Os arquivos locais disponíveis nesta execução são **Produto v1.7.0** e **Segmento v1.7.3** anteriores. Portanto **não declarar dry-run v1.7.1 com zero erros**: é `NOT_RUN — SOURCE_MISSING`. Os 442 alertas de cardinalidade são **aceitos como ESPERADO** e não causam associação por índice. Atualizar manifesto e pins **somente após verificar arquivos novos**, sem contornar anomalias no importador.

**Avanço estimado do lote T01–T03:** 80% (implementação T01/T02, testes PG18 + CI rápido; novo XLSX/dry-run e revisão final pendentes). Ambos os PRs continuam DRAFT.

## F2-T03 — nova regra NCM, 12/10/2026

- **Formato canônico:** 2, 4, 6 ou 8 dígitos, aceitando pontos como máscara opcional; **somente dígitos e pontos** por código. O novo `normalizeProductNcm` do importador recusa vírgulas, barra, hífen, letras e comprimentos estranhos — sem remover silenciosamente caracteres inválidos. O campo **Produto.NCM** usa separador de múltiplos códigos `;`; cada token é validado individualmente.
- **Segmento.NCMs (sugeridos)** não é um campo de mapeamento oficial: permanece como texto informativo não pareado. Na fonte v1.7.3 há **18 tokens com lista separada por vírgula** (ex. `61, 62`), que exigem revisão se a coluna vier a ser transformada em vínculo, mas **não são promovidos automaticamente pelo importador** e não bloqueiam T03 enquanto forem mera sugestão.
- **Norma × NCM:** dois prefixos são compatíveis se `norma.startsWith(perfil)` **ou** `perfil.startsWith(norma)`, após remover pontos e validar comprimento. Correspondência de prefixo significa **relevância potencial**, nunca incidência/benefício fiscal comprovado.
- **Verificação do código anterior:** `classification.curated.ts` usava `code.startsWith(prefix)` (somente código legal mais específico); `publication-affinity.ts` usava `companyNcms.has(ncm.code)` (igualdade exata). **Antes deste PR o motor NÃO possuía prefixo bidirecional completo.**
- **Atualização no DRAFT #216:** `src/modules/taxonomy/ncm/ncm-prefix.ts`, classificação curada (`CURATED_ENGINE_VERSION` **2.3.0**, `policyVersion` 3), afinidade de perfil e `ops/taxonomy/f2-xlsx-dry-run.mjs`, com testes novos de normalização, comparações cruzadas e rejeição de códigos malformados.
- **T00:** por nova decisão do CLAUDE-COORD, a **entrega dos XLSX no GitHub será no fechamento da F2**, T00 permanece **90%**, e **não bloqueia a continuidade de T01–T03**. Hash/manifesto do Produto 1.7.1 não deve ser inventado antes de receber o binário.
- **Dry-run solicitado Produto v1.7.1:** **NOT_RUN / INPUT_NOT_AVAILABLE**, pois o único Produto XLSX acessível nesta execução é a versão **1.7.0**, cujo SHA-256 é `35e886e711f0c1c793daaa6a5e61c5500f3ab235913b9bc8e026ea8d8fc0db49`. Segmento 1.7.3 local: `588a89871044a1ca67036fb5c17cdba3ba70f447bd1412fc476f14bb1d6440cd`. Não confundir com 0 erros comprovados.
- **442 diferenças cardinalidade:** **ESPERADO / ACEITO**; listas de produto e NCM sugeridos são independentes, sem pareamento 1:1.
- **Gates inalterados:** #216 e web #103 seguem DRAFT, nenhum merge/deploy; T03 produtiva requer dry-run positivo v1.7.1, backup verificado, OK explícito do Fábio e OK CLAUDE-COORD para código.

## Limitação distinta — detector de NCM de normas (não resolvida por comparador)

**Descoberta:** `src/modules/taxonomy/ncm/publication-ncm.detector.ts` extrai atualmente **apenas NCM de oito dígitos** e `migrations/026_company_product_ncm.sql` define `publication_ncm_mentions.ncm_code CHAR(8)` com restrição `^[0-9]{8}$`. O novo comparador **bidirecional** de classificação e afinidade passa a tratar com segurança os NCMs de 2/4/6/8 já fornecidos como entrada, mas **não faz a norma com NCM de 2/4/6 no texto ingressar automaticamente no ledger de menções**.

**Risco R3:** estender regex para capturar números curtos em textos legais geraria falsos positivos (artigo, número da lei, alíquota) e exigiria redesign de proveniência, detector/catálogo, migrar restrição `CHAR(8)`, revisão TAX13 e testes de vigência por dispositivo. Esta frente **não amplia o detector/ledger sem gate e sem revisão independente**. Portanto **não declarar suporte ponta a ponta para menções textuais de 2/4/6 dígitos**, nem antecipar deploy.

## Auditoria adicional da fonte antiga após regra estrita

Validação offline com as fontes locais **Produto v1.7.0** e **Segmento v1.7.3** (não é v1.7.1): na coluna Produto.NCM, há seis valores com vírgula anteriormente não apontados pelo importador antigo (linhas **31, 34, 43, 81, 166 e 180**). Com a validação nova e mais as cinco anomalias conhecidas, a versão antiga apresenta **11 ocorrências**. Ver [quadro detalhado](F2-T03-ANOMALIAS-ALERTAS.md). **A versão v1.7.1 pode ter resolvido essas linhas, mas não foi recebida/validada neste ambiente; zero erros segue NÃO COMPROVADO.**
