# ANAT-04 — matriz de medição: cobertura, fórmulas e lacunas do gold

Origem: COORD → CLAUDE-EXEC, [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116), PR #244 (draft). Revisão de 18/10/2026, depois do fechamento do GOLD-01 (7/7 aprovados).

**Este documento não mede nada e não traz números de desempenho.** Ele define o que pode ser medido com o gold aprovado, como medir e onde não se aplica. Os denominadores vêm só do gold; as contagens de códigos são travadas por `test/anatomy.gold.unit.test.ts` ("measurement matrix counts…"), que usa `ops/anatomy/gold-stats.ts`. `BLOCK_CORPUS_INPUTS_AND_GOLD` continua de pé: 7/20 entradas de desenvolvimento aprovadas, reserva fechada e 18 originais ausentes.

## 1. Situação das 30 publicações

| Partição | IDs | Representação | Gold |
|---|---|---|---|
| Desenvolvimento, com gold aprovado | 01, 02 (CONFAZ); 03, 05, 07, 10, 11 (DOU) | Congelada | **7/7 `reviewed`**, aprovação de GPT/Codex em 18/10/2026 no hash exato (02–11 na R2, 01 na R3) |
| Desenvolvimento, sem original | 13, 15, 17, 19, 20, 21, 22 (DOE-SP); 23, 25, 26, 27, 29, 30 (RFB) | **Ausente** | Não iniciado |
| Reserva, disponível | 04, 06, 08, 09, 12 (DOU) | Congelada, **não aberta** | Não iniciado; protocolo separado |
| Reserva, sem original | 14, 16, 18 (DOE-SP); 24, 28 (RFB) | **Ausente** | Não iniciado |

## 2. Reconhecimento de código ≠ seleção positiva

O gold anota **ocorrências** de códigos de nomenclatura. Isso **não** equivale a seleção positiva. O contrato ANAT→TAX exige, para a seleção positiva:
- resultado completo;
- contexto permitido e situação jurídica corrente;
- evidência aprovada cobrindo o alvo;
- NCM de catálogo de 4 a 8 dígitos;
- não ser membro de faixa nem alvo de exceção.

O gold não tem a camada de evidência nem a de situação jurídica: elas são do ANAT-06. Decomposição dos códigos do 01:

| Grupo (01) | Ocorrências | Pode ser candidato estrutural positivo? |
|---|---|---|
| Total de códigos NCM e NBM | **2.002** | — |
| Em contexto `historical` | 1.347 (NCM 722, NBM 625) | Não: histórico |
| Em contexto `operative_candidate` | **655** | Só em parte, conforme as linhas abaixo |
| ↳ capítulos de 2 dígitos | 3 | Não: só informativos |
| ↳ pontas de faixa M01 | 4 (2 delas também são alvo de exceção) | Não: membros de faixa não são seleções independentes |
| ↳ alvos de exceção M02 (sem faixa) | 8 | Não: excluídos |
| ↳ **códigos isolados** | **640** (591 na coluna NCM/SH e 49 no texto: 39 posições de 4 dígitos, 6 subposições, 4 códigos de 8 dígitos) | **Sim, como teto estrutural.** Continua exigindo evidência aprovada, ausente no ANAT-04 |
| **Não candidatos** (histórico + capítulo + faixa + exceção) | **1.362** | — |

Entrada 02: um código, `3507.90.4`, que é **NBM** e operativo. Não é NCM de catálogo, portanto não entra no canal `ncm` (0 candidatos NCM). Entradas 03, 05, 07, 10 e 11: **nenhum** código de nomenclatura.

Ordem de prioridade dos papéis, usada na contagem: capítulo > ponta de faixa > alvo de exceção > código isolado.

## 3. Métricas, fórmulas e denominadores

**Convenções:**
- **Casamento:** a parte ou entidade prevista e a do gold têm o mesmo tipo (ou domínio) e o mesmo span `[início, fim)` UTF-16 no texto canônico congelado. A raiz `document` fica fora.
- **P** = TP / previstos; **R** = TP / gold; **F1** = 2PR / (P + R).
- **N/A:**
  - P é N/A quando não há nada previsto;
  - R é N/A quando o gold tem 0 itens da classe;
  - F1 é N/A quando P ou R for N/A.

  Nunca substituir N/A por 0 ou por 1.
- Toda métrica é reportada **por entrada e por fonte** (CONFAZ, DOU). Somas entre fontes só aparecem junto com o resultado estratificado.

| ID | Métrica | Fórmula | Denominador do gold, por entrada (01 / 02 / 03 / 05 / 07 / 10 / 11) | N/A |
|---|---|---|---|---|
| E1 | Partes (tipo + span) | P, R e F1 sobre as partes casadas | 6.917 / 215 / 4 / 7 / 7 / 788 / 44 | — |
| E2 | Hierarquia | partes casadas cujo pai também casa ÷ partes casadas cujo pai no gold não é a raiz | depende do casamento E1 | quando E1 não tem partes casadas |
| E3 | Ordem entre irmãos | pares de irmãos casados com a mesma ordem relativa ÷ pares de irmãos casados | depende de E1 | sem pares |
| E4 | Contexto | partes casadas com o mesmo `context` ÷ partes casadas; também matriz de confusão | `historical`: 4.096 / 73 / 0 / 0 / 0 / 0 / 0 | recall da classe `historical` é N/A nas DOU (sem histórico no gold) |
| E5 | Geometria de tabela | células com span e linha/coluna/rowSpan/colSpan iguais ÷ células do gold | 4.682 / 0 / 0 / 0 / 0 / 537 / 0 | entradas sem tabela (02, 03, 05, 07, 11) |
| R1 | Reconhecimento NCM (todas as ocorrências, qualquer contexto, sem capítulos) | P e R por domínio e span exatos | 1.374 / 0 / 0 / 0 / 0 / 0 / 0 | R é N/A em 02–11; P continua definida (todo NCM previsto é FP) |
| R2 | Reconhecimento NBM | idem | 623 / 1 / 0 / 0 / 0 / 0 / 0 | R é N/A em 03–11 |
| R3 | Confusão NCM × NBM | códigos casados por span com domínio trocado ÷ códigos casados por span | 01 e 02 | demais entradas |
| R4 | Capítulos informativos | P e R da classe capítulo de 2 dígitos | 5 (3 operativos e 2 históricos) / 0 / … | R é N/A fora do 01 |
| R5 | Falso NCM sobre outros domínios | spans de entidade não-código (CITATION, OTHER, PROCESS, CNPJ) com NCM previsto sobreposto ÷ esses spans | 207 / 125 / 5 / 4 / 5 / 211 / 8 (565 no total; 214 são `OTHER`, com cara de NCM) | — |
| R6 | Citações | P e R da classe CITATION | 207 / 125 / 1 / 2 / 4 / 1 / 8 | — |
| M1 | Faixas M01 | faixas previstas com as duas pontas casadas e o operador no mesmo span ÷ (previstas; gold) | 72 / 0 / … | R é N/A fora do 01 |
| M2 | Exceções M02 | exceções com o mesmo operador e o mesmo **conjunto** de alvos ÷ (previstas; gold) | 17 / 0 / … | R é N/A fora do 01 |
| S1 | Exclusão estrutural (o que **pode** ser medido sobre elegibilidade) | seleções `ncm` positivas emitidas sobre não candidatos ÷ não candidatos. **Meta: 0** | 1.362 / 1 / 0 / … | 03–11 (0 códigos); para elas, qualquer positiva é registrada como violação absoluta |
| S2 | Seleção positiva (precisão e recall) | — | teto estrutural: 640 (01) | **N/A no ANAT-04.** Exige evidência jurídica aprovada (ANAT-06); o gold só dá o teto, não o gabarito |
| C1 | Cobertura do motor | `recognizedLength` ÷ comprimento do texto e fração `unidentified` | comprimento UTF-16 de cada texto | descritiva: **não** conta como acerto |

## 4. Limitações de cobertura (sempre visíveis no relatório de medição)

| Limitação | Onde | Efeito |
|---|---|---|
| Anexos não lidos (PDF, `arquivoBinario`) | Nas 7 aprovadas, nenhum anexo foi lido. Entre os ausentes há pelo menos um conhecido: o PDF do ID 21. A RFB pode ter tabelas só em anexo. | O conteúdo dos anexos não tem gold; as métricas não falam sobre ele |
| Imagens e OCR | Nenhuma entrada aprovada depende de OCR | Fora do escopo; não medir |
| Estrutura interna de redação citada | 11 (25 blocos) | E1–E4 não avaliam artigos e parágrafos dentro de citações |
| Continuidade de tabela entre arquivos | 10 (t1→t2, t4→t5) | E5 avalia tabelas físicas, não a tabela lógica |
| Linhas `<tr/>` vazias | 10 | Linhas sem células; não contam como erro |
| Linhas de redação anterior por leitura de nota | 01 (29 linhas) | Contexto histórico de linha é julgamento aprovado do anotador |
| Fechamento de citação sem aspas | 11 (art. 143-L) | Convenção: fechar no `(NR)` |
| Fora do escopo por definição | todas | Datas e anos, valores, percentuais, números de item/subitem, remissões internas, identificação do próprio ato e situação jurídica não são ocorrências omitidas |
| Fontes sem gold | DOE-SP e RFB | **Nenhuma métrica disponível**; preparações só provisórias e sintéticas |
| Amostra concentrada | NCM, faixas e exceções só no 01 | Baixa diversidade; não generalizar para outras fontes |

## 5. O que falta para medir as metas

1. Recaptura dos 18 originais, que depende de autorização expressa do Fábio. Depois, conferir hashes e preparações provisórias e congelar o texto real.
2. Gold das 13 entradas de desenvolvimento restantes, com revisão independente.
3. Gold da reserva, em protocolo separado, sem exposição ao executor.
4. Congelamento conjunto de gold, regras, preparações, partição e **desta matriz**. Só então medir, executar a reserva uma única vez e fazer a regressão completa, a revisão final e o gate do COORD.

Até lá, nenhum número de precisão ou recall deve ser apresentado como resultado das metas.
