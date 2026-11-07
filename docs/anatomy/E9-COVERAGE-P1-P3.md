# E9 — cobertura oficial: P1 a P3 (07/11/2026)

**Critério** (aprovado pelo Fábio em #116 c.6514510003; critério de E9 em `STATUS-MATRIX-02-COMPOSITION.md` §9): cobertura **fonte × tipo de ato × variação de layout × porte**, completa e demonstrada, incluindo as categorias ainda ausentes. **Sem fração.** A promoção é registrada à parte.

**Matriz calculada:** `docs/anatomy/official-coverage-matrix.json`, gerada por `ops/anatomy/official-coverage-matrix.ts --write` a partir das amostras do repositório. O teste `test/anatomy.official-coverage.unit.test.ts` a regenera e falha em qualquer divergência.

**Critério de porte:** caracteres do texto canônico do motor. Pequeno < 10.000; médio 10.000–49.999; grande ≥ 50.000. Ele reproduz os portes escolhidos para M6/M7/M8 (OFFICIAL-COLETA-01).

## 1. Acessos esgotados (07/11, sem contornar nenhum controle)

| Item | Rota tentada | Resultado |
|---|---|---|
| M1, M2 (Planalto) | `www.planalto.gov.br`, `www4.planalto.gov.br`, `legislacao.presidencia.gov.br` | Recusam a conexão (*empty reply*) |
| M1, M2 | **`normas.leg.br` (Congresso Nacional)**, achado pela API de dados abertos do Senado | ✅ **Obtidos:** texto original e versão atualizada das Leis 10.637/2002 e 10.833/2003 (`ops/anatomy/official-identification/leg-normas/`) |
| M1, M2 | Senado `legis.senado.leg.br/norma/<id>/publicacao/<id>` | PDF vazio (0 bytes) |
| M1, M2 | LexML | Responde, mas não é necessário: normas.leg.br já traz o texto |
| M3, M4, M5 (CONFAZ) | `www.confaz.fazenda.gov.br` | Recusa a conexão |
| M3, M4, M5 | `www.gov.br/confaz` | Exige login (não usado) |
| M3, M4, M5 | API de busca da RFB | Os convênios e ajustes só aparecem citados em atos da RFB; não há o texto |
| M9 (DOU) | `www.in.gov.br`, `pesquisa.in.gov.br` | Recusam a conexão |

**Decisão do EXEC (a confirmar pelo COORD):** M1/M2 pedem "lei de PIS/Cofins, porte grande, texto compilado com notas de redação". O normas.leg.br é fonte oficial e entrega exatamente isso, então **a célula Lei × grande fica coberta pela fonte alternativa**. O Planalto continua indisponível. Se o COORD exigir o Planalto especificamente, M1 e M2 voltam à lista manual.

## 2. P1 — lista única para o Fábio (o que só a captura manual resolve)

**Como salvar (vale para todos):**
1. Abra o link no navegador do computador.
2. Aperte **Ctrl+S** (no Mac, **Cmd+S**) e escolha **"Página da Web, somente HTML"**.
3. **Não renomeie** o arquivo.
4. Envie o arquivo e escreva, ao lado, o **link** e a **data e hora** em que salvou.

**Não envie o 52/91 nem o 100/97.**

| # | Ato | URL | Arquivo esperado | O que deve aparecer |
|---|---|---|---|---|
| M3 | Convênio ICMS 142/18 | https://www.confaz.fazenda.gov.br/legislacao/convenios/2018/CV142_18 | `CV142_18.html` (ou o nome que o navegador der) | "CONVÊNIO ICMS 142/18" |
| M4 | Convênio ICMS 190/17 | https://www.confaz.fazenda.gov.br/legislacao/convenios/2017/CV190_17 | `CV190_17.html` | "CONVÊNIO ICMS 190/17" |
| M5 | Ajuste SINIEF 07/05 | https://www.confaz.fazenda.gov.br/legislacao/ajustes/2005/AJ_007_05 | `AJ_007_05.html` | "AJUSTE SINIEF 07/05" |
| M9 | IN RFB nº 2.237/2024 no DOU | https://www.in.gov.br/consulta → pesquise `Instrução Normativa RFB nº 2.237`, abra o resultado de **05/12/2024** e salve a página do ato | página do ato (`.html`) | "Publicado em: … Edição … Seção 1 … Página …", o texto da IN e o rodapé |

## 3. P2 — ingestão (pronta)

`ops/anatomy/official-manual-ingest.ts --item <M#> --file <arquivo> --url <link> --saved-at <data/hora>`:
- **Confere:** o item da lista; o host oficial da fonte; o título esperado no próprio arquivo; a recusa de atos reservados (corpus/gold: 52/91, 100/97…).
- **Guarda:** os bytes como recebidos (SHA-256 conferido depois da cópia) e um `.meta.json` com URL, data em que foi salvo, data da ingestão, bytes, charset declarado, origem "obtido manualmente pelo Fábio — reprodução salva pelo navegador", `original: false` e `promoted: false`.
- **Recusa e registra** em `refusals.jsonl`: título divergente, host estranho, item desconhecido, PDF (o título não é lido aqui) e reingestão (bytes nunca são sobrescritos).

Executado agora para M1/M2 pela fonte alternativa (procedência própria em `leg-normas/README.md`).

## 4. P3 — matriz demonstrada (estado em 07/11)

| Célula | Situação | Amostras |
|---|---|---|
| RFB × IN × JSON × pequeno | ✅ | 108391, 133898 |
| RFB × IN × JSON × médio | ✅ | 141910 |
| RFB × IN × JSON × grande | ✅ | 104314, 115131, 116968, 127905 |
| Legislação federal × Lei × HTML × grande | ✅ (fonte alternativa) | Leis 10.637/2002 e 10.833/2003, original e atualizada |
| Sefaz-SP portal × RICMS (artigo) × HTML SharePoint × médio | ✅ | art. 7º; anexo I art. 41; anexo II arts. 3º e 39 (os arts. 8º e 9º são pequenos) |
| CONFAZ × Convênio ICMS × HTML | ❌ | M3, M4 |
| CONFAZ × Ajuste SINIEF × HTML × pequeno | ❌ | M5 |
| DOU × página de ato (cabeçalho/rodapé) × HTML | ❌ | M9 |
| DOE-SP × publicação do diário × JSON API v2 | ❌ | ver §5 |

**Categorias ainda ausentes** (tipos presentes nas fontes do projeto sem nenhuma amostra; a matriz lista a rota de cada uma):

| Fonte | Tipos ausentes | Rota |
|---|---|---|
| RFB | Portaria, Ato Declaratório (ADI/ADE), Solução de Consulta, Resolução | API acessível |
| DOU | Decreto, Portaria, Resolução, Despacho | Arquivo manual |
| CONFAZ | Protocolo ICMS | Arquivo manual |
| DOE-SP | Decreto, Resolução, Portaria CAT | Acessível |

**E9:** matriz incompleta → **0 pontos** (sem fração). **Frente 1 = 50,2%, delta 0 p.p.** O fechamento dos marcos e o recálculo serão submetidos depois que `requiredPending` ficar vazio, com revisão independente.

## 5. DOE-SP / M10: posição na matriz aprovada

- **Evidência para incluir:**
  - O direcionamento aprovado pelo Fábio (c.6514510003) manda "examinar os tipos de ato presentes nas **fontes do projeto**". O DOE-SP é fonte do projeto: tem conector de coleta (`src/modules/collection/doe-sp.*`) e é aceito pelo gate OFFICIAL-01 (`docs/anatomy/OFFICIAL-01.md`).
  - O critério de E9 inclui "as categorias ainda ausentes".
- **Evidência para adiar (não para excluir):**
  - "M10 — Cabeçalho do DOE-SP: opcional nesta fase, lote 2, depois de M9" está num documento do EXEC (`OFFICIAL-ARQUIVOS-MANUAIS.md`, #279). Refere-se à **amostra de cabeçalho** (E4), não à cobertura de E9.
  - O COORD registrou "L7 DOE-SP (lote 2): não iniciado, depois de M9" (c.6647087145). É uma ordem de execução, não uma exclusão.
- **Conclusão:** não há decisão que exclua o DOE-SP de E9. **A célula DOE-SP fica pendente e obrigatória** para o fechamento de E9, até reconciliação do COORD. O `doe.sp.gov.br` responde a este ambiente, então a coleta é executável assim que for autorizada, depois de M9, conforme a ordem registrada.

## 6. Próximos pacotes

| Pacote | Depende de |
|---|---|
| **P1-b** M3, M4, M5 e M9 (lista do §2) | Fábio |
| **P2-b** Ingestão de cada arquivo recebido e regeneração da matriz | — (pronto) |
| **P2-c** Coleta finita RFB das categorias ausentes (1 ato pequeno, médio e grande por tipo, se existirem), pela API acessível, sem promover | Decisão do COORD |
| **P2-d** DOE-SP: amostras do diário pela API v2, depois de M9 | Decisão do COORD |
| **P3** Demonstração final e pedido de fechamento dos marcos de E9, com revisão independente, e recálculo pela fórmula vigente | P1-b a P2-d |
| **L-LEG-01** Notas de redação/revogação da versão atualizada do normas.leg.br | Decisão (perfil de leitura próprio para esta fonte) |
