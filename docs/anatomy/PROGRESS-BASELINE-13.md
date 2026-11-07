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

## 4. Matriz E9 — Cobertura oficial (peso 15), reconciliada com o critério do COORD (07/11)

**Critério (COORD, registrado em `STATUS-MATRIX-02-COMPOSITION.md` §9; #116 c.6665613810):** "completar e demonstrar a matriz oficial de cobertura — fontes, tipos e portes (pequeno, médio, grande, quando aplicável), incluindo as categorias ainda ausentes. **Sem pontuação fracionária.** A promoção é registrada à parte e não é condição dos marcos offline."

**Variedade oficial aprovada:** a lista M1–M10 de `OFFICIAL-ARQUIVOS-MANUAIS.md`, mais as fontes acrescentadas depois por decisão (portal Sefaz-SP, L14–L17). Cada marco de E9 só conta quando **todas** as células obrigatórias estão concluídas.

### 4.1 Células da matriz

| Célula (fonte × tipo × porte) | Situação | Evidência | Lacuna |
|---|---|---|---|
| RFB × IN × grande (M6) | ✅ concluída | IN 2.005/2021, idAto 115131 (57.179 caracteres); lote de 7 INs (`official-lot-rfb.json`) | — |
| RFB × IN × médio (M7) | ✅ concluída | IN 2.237/2024, idAto 141910 (31.389 caracteres) | — |
| RFB × IN × pequeno (M8) | ✅ concluída | IN 1.932/2020, idAto 108391 (2.003 caracteres) | — |
| RFB × IN × muito grande (extra) | ✅ concluída | IN 2.121/2022, 127905 (1.009.001); IN 1.911/2019, 104314 (809.136); anexo HTML embutido (#300); sinal L20 (#302) | Anexos PDF da RFB ficam `missing_no_content` (registrado, não bloqueia a célula) |
| RFB × IN × médio/pequeno (extras) | ✅ concluída | IN 2.021/2021, 116968 (151.963); IN 2.162/2023, 133898 (4.540) | — |
| Sefaz-SP portal × RICMS × artigos/anexos | ✅ concluída | 6 páginas (`doesp-ricms/`: art. 7º, 8º, 9º; anexo I art. 41; anexo II arts. 3º e 39); L14–L17 e L21 | — |
| **Planalto × Lei × grande (M1, M2)** | ❌ pendente | — | O portal recusa a conexão deste ambiente (07/11: *empty reply from server*); depende dos arquivos manuais M1 e M2 |
| **CONFAZ × Convênio (M3, M4)** | ❌ pendente | — | A origem recusa a conexão (07/11); depende de M3 e M4 |
| **CONFAZ × Ajuste SINIEF × pequeno (M5)** | ❌ pendente | — | Depende de M5 |
| **DOU × ato com cabeçalho/rodapé (M9)** | ❌ pendente | — | A origem recusa a conexão (07/11); depende de M9. Também alimenta E4 |
| DOE-SP × diário (M10) | ⏸ fora desta fase | — | Opcional; lote 2, depois de M9 |

### 4.2 Marcos de E9

| Marco (fração) | Concluído? | Motivo |
|---|---|---|
| Implementado (0,40) | **Não** | 4 células obrigatórias pendentes (M1–M5, M9) |
| Testado (0,20) | **Não** | Segue o anterior. As células concluídas têm testes: ANAT 329/329 no #302, lote de 7 INs, PG16 12/12 |
| Revisão aceita (0,20) | **Não** | Segue o anterior. Aceites parciais: #288–#292, #299, #300 R3 (PASS técnico offline), #293 §17 (APPROVED documental) |
| Integrado (0,10) | **Não** | Nada em `main` (herda #285, congelado) |
| Liberado (0,10) | **Não** | Sem homologação nem ativação (E13) |

**Pontos E9 contabilizados: 0** (sem fração, conforme o critério). **Frente 1 = 50,2%, delta 0 p.p.** Os pesos originais ficam preservados. O recálculo será submetido ao COORD depois do fechamento dos marcos.

### 4.3 Próximo pacote executável para reduzir as lacunas

1. **P1 — arquivos manuais (Fábio, cerca de 15 min):** salvar M1–M5 e M9 pelo navegador, seguindo `OFFICIAL-ARQUIVOS-MANUAIS.md`. É a única via, porque as origens recusam este ambiente. Não enviar o 52/91 nem o 100/97.
2. **P2 — ingestão (EXEC, depois de P1):**
   - registrar URL, data, SHA-256 e origem "reprodução salva pelo navegador";
   - validar o título de cada arquivo (recusa registrada se não bater);
   - rodar o leitor (HTML: Planalto → nova família de leitura a definir; CONFAZ e DOU já são fontes do leitor);
   - incluir as amostras num lote oficial reprodutível com baseline e teste de não piora, como o lote RFB;
   - manter `promoted:false`.
3. **P3 — demonstração da matriz completa:** quando todas as células obrigatórias estiverem ✅, submeter ao COORD o fechamento dos marcos Implementado e Testado de E9, com revisão independente para o marco Revisão aceita. Depois, recálculo pela fórmula vigente.
4. **P4 — DOE-SP diário (M10):** lote 2, depois de M9.

## 5. Registro de 06/11 (fora do cálculo)

- **#300 R3 @9a6a9ec9 — PASS técnico offline.** Delta do lote de 7 INs: contra a base, entram `inlineAttachments` com o `referenceContext` (R2) e muda o `outputHash`; o R3 sozinho muda só o `outputHash`.
- **#293 §17 (L20) — APPROVED documental.** Classificação `prohibited` mantida; `rfb_quote_unclosed_resume_candidate` apenas para revisão humana; L20 segue em desenho.
- **COLL-TEST-ISO-01 (#301)** é tarefa de Backend/CI, fora do cálculo da ANAT.

## 6. Registro de 07/11 (fora do cálculo)

- **COLL-TEST-ISO-01 @`3f7564e4` — aprovada tecnicamente** (COORD): `verify` 2× PASS (run 42168045517), LOTE-2 PG18 PASS. Merge e deploy aguardam a decisão do Fábio.
- **#300 @`22e8cc48` — mantém o PASS técnico offline** (COORD). O R3 continua sendo o de `9a6a9ec9`; o merge de COLL-TEST-ISO-01 não altera nenhum arquivo de anatomia (identidade `04af1bfd`).
- **L20 implementada no #302** (só o sinal, conforme §17), aguardando revisão. Identidade `0e009431`.
- **E9 reconciliada** com o critério do COORD (§4): 0 pontos; 4 células obrigatórias pendentes (M1–M5, M9).

**Percentual mantido:** **Frente 1 = 50,2%**, delta 0 p.p. Frente 2 = 10%.
