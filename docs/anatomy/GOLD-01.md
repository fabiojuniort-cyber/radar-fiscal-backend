# ANAT-04 — GOLD-01: anotação por span das 7 entradas de desenvolvimento

Origem: COORD → EXEC, autorização do Fábio para anotar as 7 entradas de desenvolvimento, [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116), PR #244 (draft). Anotador: CLAUDE-EXEC, em 17/10/2026.

**Estado: `reviewed` em 6/7 (02, 03, 05, 07, 10 e 11, aprovadas por GPT/Codex em 18/10/2026 na R2, cada uma no hash exato); 01 em `prepared`, com `changes_requested` na R2.** As correções do 01 estão aplicadas e o novo hash aguarda a rodada 3. O pacote como um todo continua com alterações solicitadas. Isto não é gold homologado nem análise jurídica, e não libera medição: os 18 originais DOE-SP/RFB continuam ausentes e a reserva não foi aberta.

## Método

**Arquivos:**
- especificações escritas pelo anotador: `ops/anatomy/gold-specs/<id>.json`;
- construtor determinístico: `ops/anatomy/gold-build.ts <id>`;
- saída: `test/fixtures/anatomy/gold/<id>.json`, verificada pelo schema `ANAT-GOLD/1.0.0`.

**Âncoras:** as especificações apontam para linhas ou literais do **texto canônico congelado**. O construtor converte para intervalos UTF-16 `[início, fim)` e confere o hash e o comprimento do texto.

**Independência do motor:** nenhuma parte, entidade ou elegibilidade do motor ANAT foi lida. As fontes de cada decisão foram:
- a leitura do texto canônico;
- as classes editoriais oficiais da representação original (CONFAZ `TextoAcordo/RedaoAnt/Remisso/RemissoAnt…`, DOU `identifica/ementa/assina/cargo`);
- a geometria `rowspan/colspan` da marcação original, lida por um caminhador próprio do construtor (`tablesOf`).

**CONFAZ (01, 02):** o rascunho procedimental (`gold-specs/confaz-draft.ts`) aplica as regras de leitura do anotador e é corrigido à mão (`<id>.tables.json`, com `overrides`). As regras são:
- redação anterior fica aninhada na versão vigente candidata do mesmo dispositivo;
- filhos vigentes nunca ficam sob uma redação histórica;
- notas de remissão e publicação são proibidas;
- fecho e local/data ficam em `footer`.

**Reprodutibilidade:** `test/anatomy.gold.unit.test.ts` reconstrói os 7 arquivos e exige igualdade exata.

**Escopo de entidades v1:**
- incluídos: NCM, NBM, faixas M01 (relação `range`, sem expansão), citações de atos externos, processos, CNPJ, e códigos com aparência de NCM que **não** são NCM (domínio `OTHER`, para medir falso positivo);
- exceções M02 (relação `exception`, para o código introduzido por "exceto/exclusive/salvo" na mesma parte e oração);
- **cobertura completa dentro do escopo** (definida antes da medição): todo código de nomenclatura com ponto (6, 8 e 10 dígitos, e o atípico `dddd.dddd`); toda posição introduzida por "posição/posições" nos formatos `NNNN` ou `NN.NN`, isolada ou em lista (vírgula, "a", "ou", "e"); referências a capítulo de 2 dígitos ("Capítulo 84"), como informativas; e cada número de uma lista de convênios como citação própria;
- uma relação `exception` por operador "exceto/exclusive/salvo", com todos os códigos excluídos como alvos, inclusive as duas pontas de uma faixa;
- **domínio NCM × NBM** pela qualificação explícita da fonte ("NBM/SH", "da NBM" ou cabeçalho "CÓDIGO DA NBM/SH"); sem qualificação, NCM. Nenhuma conversão entre nomenclaturas;
- fora do escopo, por definição (não são ocorrências omitidas): datas e anos, valores monetários, percentuais, números de item/subitem, remissões internas ao próprio ato e a identificação do próprio ato no título.

**Situação jurídica:** fica fora do gold. `context` descreve só posição: `operative_candidate`, `historical`, `prohibited` ou `unknown`.

## Resultado por entrada

| ID | Partes | Contexto (operativo candidato / histórico / proibido) | Entidades | Faixas | Lacunas |
|---|---|---|---|---|---|
| 01 Conv. 52/91 | 6.918 (6 tabelas, 4.682 células) | 2.633 / 4.096 / 188 | 2.209: NCM 1.377, NBM 625, citações 207 (após a correção da R2) | 72 faixas + 17 exceções | 2 |
| 02 Conv. 100/97 | 216 | 69 / 73 / 73 | 126: citações 125, NBM 1 (`3507.90.4`) | 0 | 0 |
| 03 Retificação MDHC | 5 | 1 / 0 / 3 | 5: citação 1, processo 1, OTHER 3 | 0 | 0 |
| 05 ADE Coana 119 | 8 | 3 / 0 / 4 | 4: citações 2, CNPJ 1, OTHER 1 | 0 | 0 |
| 07 Despacho MF | 8 | 1 / 0 / 6 | 5: citações 4, processo 1 | 0 | 0 |
| 10 Portaria SAES 4.940 | 789 (5 tabelas, 537 células) | 784 / 0 / 4 | 211: citação 1, OTHER 210 (SIGTAP, CBO, CID, habilitação `NN.NN`, regras de 4 dígitos) | 0 | 2 |
| 11 IN RFB 2.342 | 45 | 15 / 0 / 29 | 8 citações | 0 | 2 |

**Conferência cruzada:** as duas ocorrências de `8450.11.00` em 01, que o contrato registra como históricas, saíram no gold como `historical`. Uma está numa linha de redação anterior da tabela vigente; a outra está no Anexo I anterior.

## Rodada 1 de revisão: changes_requested

**Revisor:** GPT/Codex, em substituição nesta rodada; **não** é parecer do Astra. **Base revisada:** `8298900d8181a8c444088b4a85929b3e023729f2`. **Data:** 17/10/2026.

**Confirmado pelo revisor:**
- hashes de 02, 03, 05, 07, 10 e 11 iguais aos submetidos;
- alteração de conteúdo após aprovação é rejeitada;
- CI exclusivo ANAT passou nesse commit; o CI geral está em `failure`, e o revisor não o considerou aprovado.

**Limites declarados pelo revisor:** o hash do 01 não foi recalculado (JSON grande demais para o conector); a suíte não foi reexecutada; a conferência de todos os spans não foi concluída. Nenhum hash foi aprovado.

| Achado (verificado pelo revisor) | Correção relatada pelo executor | Verificação do revisor |
|---|---|---|
| Aprovação aceitava estados inconsistentes: anotador como revisor, revisor nulo, `prepared` com aprovação, `reviewed` sem data | `validateAnatomyGold` passou a exigir que `approved` ⇔ `reviewed`, com anotador e revisor identificados e distintos, data e hash igual ao do conteúdo. Todas as combinações têm teste | pendente (rodada 2) |
| 02: `3507.90.4` como NCM, embora a fonte o identifique como NBM/SH | Domínio corrigido para **NBM** na especificação, sem conversão | pendente (rodada 2) |
| Cobertura incompleta: listas de citações e códigos não enumerados | Cada número de lista virou citação (01: +45, 02: +28); posições de 4 dígitos enumeradas com o domínio da qualificação; domínio pelo cabeçalho da coluna; 9 exceções M02; escopo definido acima, antes da medição | pendente (rodada 2) |

> As correções acima foram **relatadas pelo executor** e ainda não foram verificadas pelo revisor.

**Mudaram de hash:** 01 e 02. Os demais continuam iguais aos conferidos na rodada 1, que não aprovou nenhuma entrada.

## Rodada 2 de revisão: 6 aprovadas, 01 com changes_requested

**Revisor:** GPT/Codex. **Base revisada:** `c8ee0fe4fca3a76cd0e216bb6e3a088c9cad0c17`. **Data:** 18/10/2026. **Parecer:** [PR #244, review 5563875392](https://github.com/fabiojuniort-cyber/radar-fiscal-backend/pull/244#pullrequestreview-5563875392); registro em [tribusca-control#116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-6252319710).

**Verificação declarada pelo revisor:** sete hashes confirmados; sete testes específicos PASS; geometria e texto das 5.219 células conferidos contra as fontes.

**Aprovadas no escopo estrutural v1 e no hash exato** (`review` gravado na especificação com `reviewer: GPT/Codex` e `reviewedAt: 2026-10-18`): 02 `256dfcb9…`, 03 `a4c9e445…`, 05 `44c6407d…`, 07 `59867895…`, 10 `c4602fdd…`, 11 `678bf7e0…`. Depois da reconstrução, os seis hashes de conteúdo continuam idênticos aos aprovados. O teste compara cada aprovação com o hash documentado.

**01 com `changes_requested`:** faltavam posições pontuadas (`84.02`, `85.14`), a faixa `84.56 A 84.65` e as relações de exclusão correspondentes.

| Achado R2 (01) | Correção relatada pelo executor | Verificação do revisor |
|---|---|---|
| Posições pontuadas `NN.NN` ausentes | Regra de posição passou a aceitar `NNNN` e `NN.NN`, isolados ou em lista ("84.44, 84.45, 84.46 OU 84.47"), com domínio NBM quando o texto diz "da NBM" | pendente (rodada 3) |
| Faixa `84.56 A 84.65` | Faixa M01 com as duas pontas, sem expansão | pendente (rodada 3) |
| Relações de exclusão | Uma relação `exception` por operador, com todos os alvos; o ponto dentro de um código (`84.56`) não encerra mais a oração. Total de 17 exceções; "EXCETO … 84.56 A 84.65" tem os dois códigos como alvo | pendente (rodada 3) |
| Escopo (complemento do executor) | Referências a capítulo de 2 dígitos ("Capítulo 84", "Capítulo 53") anotadas como informativas; "deste capítulo 60.1" é número de item e fica fora | pendente (rodada 3) |

**Varredura residual do executor:** os tokens `NN.NN` e `NNNN` perto de palavras de nomenclatura que ficaram fora do gold são só números de item ou subitem (por exemplo, "32.14", "55.10", "33.01"), fora do escopo por definição.

**Novo hash do 01 para a rodada 3:** `d6ba1bbf0bb1fe232df79337fcc87ed9576d024e92337d68e83acc833526b48a` (antes: `0909f12d…`).

## Pontos para a revisão

Estes são os itens em que a decisão do anotador é mais discutível.

1. **01, linhas de "Redação anterior" nas tabelas vigentes.** A linha seguinte à nota `RemissoAnt`, com o mesmo número de item, foi marcada `historical` (29 linhas, `previous_wording_after_note`), porque a fonte não marca essas linhas com classe histórica. Conferir os casos com mais de uma linha ou com mudança de item.
2. **01, anexos históricos.** As versões anteriores e originais dos Anexos I e II ficaram como irmãs no nível do documento, e não aninhadas no anexo vigente, porque estão separadas no texto.
3. **01, NCM/NBM:** 4 códigos no formato `dddd.dddd` (assim na fonte) foram anotados como NCM com nota. As posições de 4 dígitos ("posição 8436", "posições 8456 A 8465 da NBM") agora estão enumeradas, e as exceções estão registradas como relação. Os únicos tokens de 4 dígitos fora do gold são anos.
4. **02:** cada redação histórica fica sob a versão vigente candidata do mesmo dispositivo. O rodapé "·" com classe `Remisso` é nota editorial.
5. **03:** o bloco "Leia-se" inclui por inteiro "mantidas as demais condições" e o processo SEI, numa exclusão conservadora.
6. **07:** o cabeçalho (processo, interessado, assunto) é `publication_header`, em zona proibida; a decisão está no parágrafo 5.
7. **10:** os códigos `NN.NN` de habilitação têm o formato de uma posição NCM. Foram anotados como `OTHER` para medir falso positivo. As continuações t1→t2 e t4→t5 foram registradas como lacuna.
8. **11:** cada redação citada (de `"` até `(NR)`) é um único `quoted_text`, sem estrutura interna. O bloco do art. 143-L termina em `. (NR)` sem aspas.

**Protocolo da revisão:**
- registrar as divergências em `review.notes`;
- corrigir a especificação, nunca o JSON gerado, e reconstruir;
- a aprovação fica na especificação (`review` com `reviewer`, `reviewedAt`, `status: approved` e `approvedContentSha256`);
- o status `reviewed` exige um revisor diferente do anotador.

**Vínculo da aprovação ao conteúdo.** `goldContentSha256` é o SHA-256 da serialização canônica do gold inteiro, exceto `status` e `review`. A validação recusa uma aprovação cujo hash não seja igual ao do conteúdo atual. Assim, qualquer alteração posterior na anotação invalida a aprovação, e o trecho alterado precisa ser conferido de novo. Situação atual dos hashes:

| ID | `goldContentSha256` | Situação |
|---|---|---|
| 01 | `d6ba1bbf0bb1fe232df79337fcc87ed9576d024e92337d68e83acc833526b48a` | **submetido à rodada 3** (R2: `0909f12d…`, changes_requested) |
| 02 | `256dfcb9624069abeca683e7943799659f4196ec7fc1f368adebb12b69b47b8a` | **aprovado** (R2, GPT/Codex, 18/10/2026) |
| 03 | `a4c9e445b71772064298afab7edc18fa7dc4a36804c7926a24a57806aed6b48b` | **aprovado** (R2, GPT/Codex, 18/10/2026) |
| 05 | `44c6407dc014d399e977e15315b3d4e46d82a0c2d77b6dbe595ee43dcdf1c2e7` | **aprovado** (R2, GPT/Codex, 18/10/2026) |
| 07 | `59867895a15ab35d4cec3612430da22d9896c7ebd7b7846d9a27daed69e1687d` | **aprovado** (R2, GPT/Codex, 18/10/2026) |
| 10 | `c4602fddaecf5ba89c77a38d1e9c23ef2d2b89205061910ebf2f21d10df43083` | **aprovado** (R2, GPT/Codex, 18/10/2026) |
| 11 | `678bf7e0823ac148a55da75c5f5c681ebb3571d8fd298ea7e5bdbc5858c6ad79` | **aprovado** (R2, GPT/Codex, 18/10/2026) |

## Não executado

Coleta, abertura ou avaliação da reserva, execução do motor sobre o corpus para medição, carga do dossiê ANAT-03, alteração de taxonomia, classificação ou produção, Ready for review, merge e deploy.
