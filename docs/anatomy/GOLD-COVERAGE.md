# ANAT-04 — matriz de medição: cobertura, fórmulas e lacunas do gold

Origem: COORD → CLAUDE-EXEC, [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116), PR #244 (draft). Revisão de 18/10/2026, depois do fechamento do GOLD-01 (7/7 aprovados). Ajuste do protocolo pedido pelo COORD (casamento um a um, tabela de decisão de P, R e F1, N/A por denominador efetivo e M02 decomposta), sem alterar os golds aprovados.

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

**Convenções** (protocolo ajustado em 18/10/2026; os sete golds aprovados não mudam):

- **Chave de casamento:** tipo (parte) ou domínio (entidade) e span exato `[início, fim)` em UTF-16 no texto canônico congelado. A raiz `document` fica fora. Relações têm chave própria (M1, M2).
- **Casamento um a um.** Cada item do gold casa com no máximo uma predição, e cada predição com no máximo um item do gold:
  - itens com a mesma chave são pareados em ordem de ocorrência;
  - **uma predição duplicada (mesma chave) não gera outro acerto**: o excedente é FP;
  - um item do gold repetido só conta como acerto se houver predições suficientes.

  `TP` = número de pares; `FP` = predições sem par; `FN` = itens do gold sem par.
- **P** = TP / previstos; **R** = TP / gold; **F1** = 2·P·R / (P + R).
- **Tabela de decisão** (`G` = itens do gold da classe; `Pr` = predições da classe):

  | Situação | P | R | F1 |
  |---|---|---|---|
  | `G = 0` e `Pr = 0` | N/A | N/A | N/A |
  | `G = 0` e `Pr > 0` | 0 (só FP) | N/A | N/A |
  | `G > 0` e `Pr = 0` | **N/A** (sem predições) | 0 | N/A |
  | `G > 0`, `Pr > 0` e `TP = 0` | **0** | **0** | **0** |
  | `G > 0`, `Pr > 0` e `TP > 0` | TP/Pr | TP/G | 2PR/(P+R) |

- **Razões sobre casamentos (E2, E3, E4, R3):** a métrica é N/A sempre que o **denominador efetivo**, calculado sobre os casamentos de fato obtidos, for zero. **S1 é diferente:** o denominador vem do gold e não depende de casamento (ver a linha S1). Nunca substituir N/A por 0 ou por 1.
- Toda métrica é reportada **por entrada e por fonte** (CONFAZ, DOU). Somas entre fontes só aparecem junto com o resultado estratificado. Uma soma também segue a tabela de decisão sobre os totais e não é média de razões.

| ID | Métrica | Fórmula | Denominador do gold, por entrada (01 / 02 / 03 / 05 / 07 / 10 / 11) | N/A |
|---|---|---|---|---|
| E1 | Partes (tipo + span) | P, R e F1, casamento um a um | 6.917 / 215 / 4 / 7 / 7 / 788 / 44 | pela tabela de decisão |
| E2 | Hierarquia | partes casadas cujo pai previsto é o par do pai do gold ÷ partes casadas cujo pai no gold não é a raiz e também foi casado | efetivo: depende de E1 | **N/A se o denominador efetivo for 0** |
| E3 | Ordem entre irmãos | pares de irmãos do gold, ambos casados, com a mesma ordem relativa na predição ÷ esses pares | efetivo: depende de E1 | **N/A se não houver pares** |
| E4 | Contexto | partes casadas com o mesmo `context` ÷ partes casadas; também matriz de confusão por classe | `historical`: 4.096 / 73 / 0 / 0 / 0 / 0 / 0 | N/A sem partes casadas; recall da classe `historical` é N/A nas DOU |
| E5 | Geometria de tabela | P, R e F1 de células com chave estendida (span e linha/coluna/rowSpan/colSpan iguais), casamento um a um | 4.682 / 0 / 0 / 0 / 0 / 537 / 0 | pela tabela de decisão; entradas sem tabela têm R N/A |
| R1 | Reconhecimento NCM (todas as ocorrências, qualquer contexto, sem capítulos) | P e R por domínio e span exatos | 1.374 / 0 / 0 / 0 / 0 / 0 / 0 | pela tabela de decisão. Em 02–11 (G = 0), R e F1 são N/A; P é 0 se houver NCM previsto (todo previsto é FP) e **N/A sem predições** |
| R2 | Reconhecimento NBM | idem | 623 / 1 / 0 / 0 / 0 / 0 / 0 | R é N/A em 03–11 |
| R3 | Confusão NCM × NBM | códigos casados **só por span** (um a um, ignorando o domínio) com domínio trocado ÷ códigos casados só por span | efetivo: até 2.002 (01, todos os códigos, inclusive capítulos) / 1 (02) | **N/A se não houver código casado por span**; sempre N/A em 03–11 |
| R4 | Capítulos informativos | P e R da classe capítulo de 2 dígitos | 5 (3 operativos e 2 históricos) / 0 / … | R é N/A fora do 01 |
| R5 | Falso NCM sobre outros domínios | spans de entidade não-código (CITATION, OTHER, PROCESS, CNPJ) com NCM previsto sobreposto ÷ esses spans | 207 / 125 / 5 / 4 / 5 / 211 / 8 (565 no total; 214 são `OTHER`, com cara de NCM) | — |
| R6 | Citações | P e R da classe CITATION | 207 / 125 / 1 / 2 / 4 / 1 / 8 | — |
| M1 | Faixas M01 | P, R e F1 com chave = span do operador e as duas pontas casadas como entidades; um a um | 72 / 0 / … | pela tabela de decisão; R é N/A fora do 01 |
| M2a | Exceção, alvos | P, R e F1 com chave = span do operador e **conjunto** de alvos igual; um a um | 17 / 0 / … | pela tabela de decisão |
| M2b | Exceção, escopo | entre os pares de M2a: `scopeSpan` previsto igual ao do gold ÷ pares de M2a. Convenção do gold: o escopo vai do início do operador ao fim do último alvo. **Escopo ampliado ou reduzido é erro** | efetivo: pares de M2a | N/A sem pares em M2a |
| M2c | Exceção, condição | — | — | **N/A nesta etapa.** No gold, `condition: null` **não comprova ausência de condição**: a condição semântica (por exemplo, "salvo se…") não foi anotada. Condições previstas são listadas sem pontuação |
| M2 | Exceção **completa** | — | — | **N/A nesta etapa**, porque depende de M2c. M2a (alvos) e M2b (escopo) são reportadas como **resultado estrutural parcial**, nunca como acerto completo. Alvos certos com escopo ampliado ou reduzido não contam como acerto em M2b |
| S1 | Exclusão estrutural (o que **pode** ser medido sobre elegibilidade) | **S1a (taxa):** spans de não candidatos do gold atingidos por pelo menos uma seleção `ncm` positiva ÷ não candidatos do gold. Cada span conta **uma vez**, mesmo atingido por várias seleções. **S1b (emissões):** total bruto de seleções `ncm` positivas sobre spans de não candidatos, reportado à parte, sem dividir. **Meta: 0 em ambos.** | denominador **do gold**, independente de casamento: 1.362 / 1 / 0 / 0 / 0 / 0 / 0 | S1a é N/A em 03–11 (denominador do gold igual a 0); S1b é sempre reportado, e qualquer valor acima de 0 é violação |
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
| Condição semântica das exceções não anotada | 01 (17 exceções, `condition: null`) | `null` não prova que não há condição; M2c e M2 completa ficam N/A, e só alvos e escopo são medidos |
| Fora do escopo por definição | todas | Datas e anos, valores, percentuais, números de item/subitem, remissões internas, identificação do próprio ato e situação jurídica não são ocorrências omitidas |
| Fontes sem gold | DOE-SP e RFB | **Nenhuma métrica disponível**; preparações só provisórias e sintéticas |
| Amostra concentrada | NCM, faixas e exceções só no 01 | Baixa diversidade; não generalizar para outras fontes |

## 5. O que falta para medir as metas

1. Recaptura dos 18 originais, que depende de autorização expressa do Fábio. Depois, conferir hashes e preparações provisórias e congelar o texto real.
2. Gold das 13 entradas de desenvolvimento restantes, com revisão independente.
3. Gold da reserva, em protocolo separado, sem exposição ao executor.
4. Congelamento conjunto de gold, regras, preparações, partição e **desta matriz**. Só então medir, executar a reserva uma única vez e fazer a regressão completa, a revisão final e o gate do COORD.

Até lá, nenhum número de precisão ou recall deve ser apresentado como resultado das metas.
