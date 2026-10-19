# ANAT-04 — matriz de cobertura e lacunas do gold para a futura medição

Origem: COORD → CLAUDE-EXEC, depois da R3, [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116), PR #244 (draft). Situação em 18/10/2026.

**Este documento não mede nada.** Ele registra o que o gold atual permite medir, o que não permite e por quê. `BLOCK_CORPUS_INPUTS_AND_GOLD` continua de pé: faltam os 18 originais, o gold das demais entradas e as métricas finais.

## 1. Situação das 30 publicações

| Partição | IDs | Representação | Gold |
|---|---|---|---|
| Desenvolvimento, com gold aprovado | 01, 02 (CONFAZ); 03, 05, 07, 10, 11 (DOU) | Congelada | **7/7 `reviewed`**, todas aprovadas por GPT/Codex em 18/10/2026 no hash exato: 02–11 na R2 (`c8ee0fe4…`) e 01 na R3 (`04d896e5…`) |
| Desenvolvimento, sem original | 13, 15, 17, 19, 20, 21, 22 (DOE-SP); 23, 25, 26, 27, 29, 30 (RFB) | **Ausente**; recaptura sem autorização | Não iniciado |
| Reserva, disponível | 04, 06, 08, 09, 12 (DOU) | Congelada, **não aberta** | Não iniciado; protocolo separado |
| Reserva, sem original | 14, 16, 18 (DOE-SP); 24, 28 (RFB) | **Ausente** | Não iniciado |

Resumo: 7/20 entradas de desenvolvimento e 0/10 da reserva têm gold. As fontes DOE-SP e RFB não têm **nenhum** gold.

## 2. O que o gold aprovado cobre, por dimensão

| Dimensão | Entradas com gold | Volume | Pode ser medida em |
|---|---|---|---|
| Partes, hierarquia e ordem | 7/7 | 01: 6.918 partes · 02: 216 · 10: 789 · 11: 45 · 03, 05, 07: ≤ 8 cada | CONFAZ e DOU |
| Contexto (`operative_candidate`, `historical`, `prohibited`) | 7/7 | Histórico só em 01 (4.096 partes) e 02 (73) | CONFAZ (histórico); DOU (proibido: epígrafe, ementa, assinatura, redação citada) |
| Tabelas e células (geometria) | 01 (6 tabelas, 4.682 células) e 10 (5 tabelas, 537 células) | 5.219 células, conferidas pelo revisor contra as fontes | CONFAZ e DOU |
| Redação citada e retificação | 11 (25 `quoted_text`) e 03 (2) | — | DOU |
| NCM em contexto operativo candidato | **somente 01** | 655 | **somente CONFAZ** |
| NCM e NBM em contexto histórico | 01 | NCM 722, NBM 625 | CONFAZ |
| NBM operativo | 02 | 1 (`3507.90.4`) | CONFAZ |
| Faixas M01 (`range`) | 01 | 72 | CONFAZ |
| Exceções M02 (`exception`) | 01 | 17 | CONFAZ |
| Citações de atos | 7/7 | 01: 207 · 02: 125 · 03, 05, 07, 10, 11: 1–8 cada | CONFAZ e DOU |
| Negativos com cara de NCM (`OTHER`: SIGTAP, CBO, CID, habilitação `NN.NN`, regras de 4 dígitos, números de requerimento) | 10 (210), 03 (3), 05 (1) | 214 | DOU (falso positivo) |
| Processo e CNPJ | 03, 05, 07 | 2 processos e 1 CNPJ | DOU |

**Consequências para a medição:**
1. **Recall de NCM só pode ser medido no CONFAZ (01).** As entradas DOU aprovadas não têm nenhum NCM verdadeiro. Elas servem para precisão e falso positivo, não para recall.
2. **Faixas e exceções têm amostra de uma só publicação (01).** Qualquer meta sobre M01 e M02 terá baixa diversidade até existir gold de DOE-SP/RFB.
3. **Nada de DOE-SP ou RFB é mensurável hoje.** As preparações dessas fontes ainda são provisórias e só foram testadas com dados sintéticos.
4. As métricas precisam ser **estratificadas por fonte e por partição**. Somar os números do 01 com os demais deixaria o resultado dominado por uma única publicação.

## 3. Lacunas declaradas dentro do gold aprovado

| ID | Lacuna | Efeito na medição |
|---|---|---|
| 01 | Linhas logo depois de "Redação anterior" nas tabelas vigentes foram marcadas como históricas pela leitura da nota, porque não têm classe histórica própria (29 linhas). Casos de vários itens dependem de revisão. | Contexto histórico de linha é um julgamento do anotador, aprovado na R3 |
| 01 | Escopo de códigos definido explicitamente (ver seção 4) | Ocorrências fora do escopo não são omissões |
| 10 | Tabelas do Anexo I e do Anexo III continuam entre arquivos (t1→t2, t4→t5). A geometria segue a tabela física. | A continuidade lógica não é medida como uma tabela só |
| 10 | Linhas `<tr/>` vazias da fonte viram linhas sem células | Não contam como erro estrutural |
| 11 | Bloco citado do art. 143-L sem aspas de fechamento na fonte; o gold fecha a citação no `(NR)` | Exige a mesma convenção do motor |
| 11 | A estrutura interna das redações citadas não foi anotada (zona proibida) | Não mede artigos e parágrafos dentro de citações |

## 4. Fora do escopo por definição (não são ocorrências omitidas)

Definido antes de qualquer medição, em [GOLD-01.md](GOLD-01.md) ("Escopo de entidades v1"):
- datas e anos;
- valores monetários e percentuais;
- números de item e subitem das tabelas;
- remissões internas ao próprio ato;
- identificação do próprio ato no título.

Também fora, por camada:
- **situação jurídica e vigência:** o gold é estrutural, e `legalStatus` não é anotado;
- **conteúdo de anexos não lidos** (PDF, `arquivoBinario`);
- **imagens e OCR**.

## 5. O que ainda falta para medir as metas

1. **Recaptura dos 18 originais**, com autorização expressa do Fábio. Depois, conferir os hashes e as preparações provisórias DOE-SP/RFB contra os originais e congelar o texto real.
2. **Gold das 13 entradas de desenvolvimento restantes**, com revisão independente.
3. **Gold da reserva (10)** em protocolo separado, por anotador que não ajusta regras, sem exposição ao executor.
4. **Congelamento conjunto** de gold, regras, preparações e partição. Só então medir, executar a reserva uma única vez e fazer a regressão completa, a revisão final e o gate do COORD.

Até lá, nenhum número de precisão ou recall deve ser apresentado como resultado das metas.
