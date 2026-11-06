# ANAT — memória de cálculo do percentual (13 entregas, 100 pontos)

**Origem dos pesos:** COORD, #293 c.6660098953 ("versionar a baseline original de 13 entregas e pesos… sem inventar critérios ou pesos"). Autorização do Fábio: "autorizo a composição e os demais itens do COORD". **Pesos copiados, não criados.** O EXEC prepara esta memória; **o recálculo é do COORD**.

**Fórmula vigente:** peso × (0,40 implementado + 0,20 testado + 0,20 revisão aceita + 0,10 integrado + 0,10 liberado).

## 1. Pesos originais

| # | Entrega | Peso |
|---|---|---|
| E1 | CONFIG | 15 |
| E2 | STRUCT-01 | 8 |
| E3 | STRUCT-02 | 5 |
| E4 | Cabeçalho/rodapé | 5 |
| E5 | PDF | 8 |
| E6 | EXT | 6 |
| E7 | NAV | 6 |
| E8 | Preparação OFICIAL | 6 |
| E9 | Cobertura oficial | 15 |
| E10 | Desenho REL | 4 |
| E11 | Implementação REL | 10 |
| E12 | Inventário seguro | 2 |
| E13 | Homologação/ativação | 10 |
| | **Total** | **100** |

## 2. Reconstrução dos 50,2% registrados (marcos por entrega)

Os totais registrados por etapa (24,0 / 11,2 / 12,0 / 1,5 / 1,5) são reproduzidos **exatamente** pela atribuição abaixo. Ela é uma **reconstrução** a partir dos aceites registrados, a ser validada pelo COORD.

| Entrega | Impl. | Testado | Aceito | Integrado | Liberado | Pontos | Evidência |
|---|---|---|---|---|---|---|---|
| E1 CONFIG (15) | ✔ | ✔ | ✔ | ✔ | ✔ | 15,0 | Produção com flags desligadas (31/10); ANAT-CONFIG-01 PASS |
| E2 STRUCT-01 (8) | ✔ | ✔ | ✔ | — | — | 6,4 | #280 `7ac0542f` aceito |
| E3 STRUCT-02 (5) | ✔ | ✔ | ✔ | — | — | 4,0 | #281 `7bcf114b` aceito |
| E5 PDF (8) | ✔ | ✔ | ✔ | — | — | 6,4 | #283 `433212f8` aceito |
| E6 EXT (6) | ✔ | ✔ | ✔ | — | — | 4,8 | #284 `df54d62e` aceito |
| E7 NAV (6) | ✔ | ✔ | ✔ | — | — | 4,8 | web#140 `8b034230` aceito |
| E8 Preparação OFICIAL (6) | ✔ | ✔ | ✔ | — | — | 4,8 | #279 (R2-03/R2-04; D03 `103639d8`) aceito |
| E10 Desenho REL (4) | ✔ | — | ✔ | — | — | 2,4 | #282 `8e8deff4` aceito (só documento) |
| E12 Inventário seguro (2) | ✔ | ✔ | ✔ | — | — | 1,6 | tribusca-control#122 `e37e959` aceito |
| E4, E9, E11, E13 | — | — | — | — | — | 0 | — |
| **Total** | **24,0** | **11,2** | **12,0** | **1,5** | **1,5** | **50,2** | |

**Premissa a validar:** E10 (desenho, só documento) sem o marco "testado". Com "testado" marcado, o total seria 51,0, que diverge do registrado.

## 3. Aceites do ciclo 04–05/11 × entregas (sem peso próprio)

| Aceite | Entrega relacionada | Efeito possível (decisão do COORD) |
|---|---|---|
| #288 D04/D05; #289 lote RFB; #290 L11; #291 L14–L16; #292 L17 | **E9 Cobertura oficial (15)** e/ou **E8** | E8 já tem impl./testado/aceito. Em E9 os pacotes cobrem fontes oficiais (RFB 5 INs; Sefaz-SP 2 páginas) com testes e revisão aceita, mas **sem promoção (L3), sem Planalto/CONFAZ/DOU (M1–M5, M9) e sem homologação**. Se o COORD considerar cumpridos os marcos impl./testado/aceito de E9, o ganho seria 15 × 0,8 = 12,0 pontos (total 62,2%). **O EXEC não marca isso:** o critério de conclusão de E9 não está escrito e não deve ser inventado. |
| #293 matriz; #294 COMPOSE-01 | Nenhuma entrega própria | Composição não é integração (herda #285, sem `main`) |

## 4. Matriz E9 — Cobertura oficial (peso 15)

Critério aplicado: a fórmula vigente (§ topo). Cada marco só conta com uma evidência aceita pelo COORD. **Nenhum marco de E9 é contabilizado hoje.** Uma célula "parcial" registra evidência e lacuna, mas não soma pontos.

| Marco (fração) | Situação | Evidência | Lacuna |
|---|---|---|---|
| Implementado (0,40) | Parcial | RFB: lote de 7 INs (#289; coleta 02), anexo HTML embutido como recurso separado (#300, 1 de 31 anexos da IN 2.121); Sefaz-SP portal: 2 páginas (#291 L14–L16, #292 L17); D04/D05 (#288); L11 (#290) | Planalto, CONFAZ e DOU (M1–M5, M9) sem cobertura; anexos PDF da RFB ficam `missing_no_content`; promoção L3 não autorizada (`promoted:false`) |
| Testado (0,20) | Parcial (offline) | Testes ANAT 320/320 no #300 @9a6a9ec9; COMPOSE-02 #299 PASS offline; PG16 12/12; LOTE-2 PG18 PASS no #300 (run 42159441668) | Sem teste em fonte oficial além de RFB e Sefaz-SP; `verify` do CI vermelho por uma corrida externa à ANAT (COLL-TEST-ISO-01, #301) |
| Revisão aceita (0,20) | Parcial | Aceites de #288–#292; #299 PASS offline; **#300 R3 PASS técnico offline** (COORD, 06/11); **#293 §17 APPROVED documental** (COORD, 06/11) | Critério de conclusão de E9 ainda não escrito pelo COORD |
| Integrado (0,10) | Não | — | Nenhum incremento em `main` (herda #285, congelado) |
| Liberado (0,10) | Não | — | Sem homologação nem ativação (E13) |

**Pontos E9 contabilizados:** 0. **Projeção (não validada):** impl., testado e aceito completos dariam 15 × 0,8 = 12,0 p.p. (62,2%). Isso depende de o COORD escrever o critério de conclusão de E9 e de as lacunas acima serem aceitas ou fechadas.

## 5. Registro de 06/11 (fora do cálculo)

- **#300 R3 @9a6a9ec9 — PASS técnico offline.** Delta do lote de 7 INs: contra a base, entram `inlineAttachments` com o `referenceContext` (R2) e muda o `outputHash`; o R3 sozinho muda só o `outputHash`.
- **#293 §17 (L20) — APPROVED documental.** Classificação `prohibited` mantida; `rfb_quote_unclosed_resume_candidate` apenas para revisão humana; L20 segue em desenho.
- **COLL-TEST-ISO-01 (#301)** é tarefa de Backend/CI, fora do cálculo da ANAT.

**Percentual mantido:** **Frente 1 = 50,2%**, delta 0 p.p., até validação do COORD. Frente 2 = 10%.
