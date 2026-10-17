# ANAT-04 — GOLD-01: anotação por span das 7 entradas de desenvolvimento

Origem: COORD → EXEC, autorização do Fábio para anotar as 7 entradas de desenvolvimento, [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116), PR #244 (draft). Anotador: CLAUDE-EXEC, em 17/10/2026.

**Estado: `prepared` em 7/7, `reviewed` em 0/7.** Todas as entradas aguardam a revisão independente do GPT Astra (`review.status: requested`). Isto não é gold homologado nem análise jurídica, e não libera medição: os 18 originais DOE-SP/RFB continuam ausentes e a reserva não foi aberta.

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
- fora do escopo, sem anotação: datas, valores monetários, percentuais, remissões internas ao próprio ato e anos de 4 dígitos.

**Situação jurídica:** fica fora do gold. `context` descreve só posição: `operative_candidate`, `historical`, `prohibited` ou `unknown`.

## Resultado por entrada

| ID | Partes | Contexto (operativo candidato / histórico / proibido) | Entidades | Faixas | Lacunas |
|---|---|---|---|---|---|
| 01 Conv. 52/91 | 6.918 (6 tabelas, 4.682 células) | 2.633 / 4.096 / 188 | 2.067: NCM 1.311 (602 operativos candidatos), NBM 594, citações 162 | 67 | 2 |
| 02 Conv. 100/97 | 216 | 69 / 73 / 73 | 98: citações 97, NCM 1 (`3507.90.4`) | 0 | 0 |
| 03 Retificação MDHC | 5 | 1 / 0 / 3 | 5: citação 1, processo 1, OTHER 3 | 0 | 0 |
| 05 ADE Coana 119 | 8 | 3 / 0 / 4 | 4: citações 2, CNPJ 1, OTHER 1 | 0 | 0 |
| 07 Despacho MF | 8 | 1 / 0 / 6 | 5: citações 4, processo 1 | 0 | 0 |
| 10 Portaria SAES 4.940 | 789 (5 tabelas, 537 células) | 784 / 0 / 4 | 211: citação 1, OTHER 210 (SIGTAP, CBO, CID, habilitação `NN.NN`, regras de 4 dígitos) | 0 | 2 |
| 11 IN RFB 2.342 | 45 | 15 / 0 / 29 | 8 citações | 0 | 2 |

**Conferência cruzada:** as duas ocorrências de `8450.11.00` em 01, que o contrato registra como históricas, saíram no gold como `historical`. Uma está numa linha de redação anterior da tabela vigente; a outra está no Anexo I anterior.

## Pontos para a revisão do Astra

Estes são os itens em que a decisão do anotador é mais discutível.

1. **01, linhas de "Redação anterior" nas tabelas vigentes.** A linha seguinte à nota `RemissoAnt`, com o mesmo número de item, foi marcada `historical` (29 linhas, `previous_wording_after_note`), porque a fonte não marca essas linhas com classe histórica. Conferir os casos com mais de uma linha ou com mudança de item.
2. **01, anexos históricos.** As versões anteriores e originais dos Anexos I e II ficaram como irmãs no nível do documento, e não aninhadas no anexo vigente, porque estão separadas no texto.
3. **01, NCM:** 4 códigos no formato `dddd.dddd` (assim na fonte) foram anotados como NCM com nota. Códigos de 4 dígitos sem ponto e listas sem separador não foram enumerados; ver as lacunas.
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

**Vínculo da aprovação ao conteúdo.** `goldContentSha256` é o SHA-256 da serialização canônica do gold inteiro, exceto `status` e `review`. A validação recusa uma aprovação cujo hash não seja igual ao do conteúdo atual. Assim, qualquer alteração posterior na anotação invalida a aprovação, e o trecho alterado precisa ser conferido de novo. Os hashes abaixo são os do conteúdo entregue para revisão; o Astra deve aprovar exatamente esses valores ou os da versão corrigida.

| ID | `goldContentSha256` submetido à revisão |
|---|---|
| 01 | `3ad3fabb1f913e939d3be44e6666156f7f5a79f7bff6cb68af664fe249169c0e` |
| 02 | `3b92ef2c5d5a6b80aaa1a732a441a57f5631542e1b7990a590277d368c164ced` |
| 03 | `a4c9e445b71772064298afab7edc18fa7dc4a36804c7926a24a57806aed6b48b` |
| 05 | `44c6407dc014d399e977e15315b3d4e46d82a0c2d77b6dbe595ee43dcdf1c2e7` |
| 07 | `59867895a15ab35d4cec3612430da22d9896c7ebd7b7846d9a27daed69e1687d` |
| 10 | `c4602fddaecf5ba89c77a38d1e9c23ef2d2b89205061910ebf2f21d10df43083` |
| 11 | `678bf7e0823ac148a55da75c5f5c681ebb3571d8fd298ea7e5bdbc5858c6ad79` |

## Não executado

Coleta, abertura ou avaliação da reserva, execução do motor sobre o corpus para medição, carga do dossiê ANAT-03, alteração de taxonomia, classificação ou produção, Ready for review, merge e deploy.
