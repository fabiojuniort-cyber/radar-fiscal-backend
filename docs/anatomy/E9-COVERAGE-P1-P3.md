# E9 — cobertura oficial: P1 a P3 (07/11/2026, depois da R2 do #303)

**Critério** (aprovado pelo Fábio em #116 c.6514510003; E9 em `STATUS-MATRIX-02-COMPOSITION.md` §9): cobertura **fonte × tipo de ato × variação de layout × porte**, completa e demonstrada, incluindo as categorias ausentes. **Sem fração.**

**R2 do COORD** (#303 c.6701945748) e **decisões** (#116 c.6701950134): corrigidas neste PR.

## 1. Como a matriz é calculada (`ops/anatomy/official-coverage-matrix.ts`)

- **Uma única grade** (`GRID`, 61 células, todas obrigatórias) é a fonte das categorias obrigatórias. Pendências e completude derivam dela; categoria ausente é célula pendente.
  - A E9 só fica completa com a grade **aprovada pelo COORD** e **todas** as células com amostra validada.
  - Hoje a grade é proposta do EXEC, então `e9MatrixComplete = false` por construção.
- **Predicados completos:** uma amostra só cobre a célula se fonte, tipo, layout **e** porte forem iguais, **e** se estiver no estágio `validated`. Um eixo divergente não cobre (testado eixo a eixo).
  - **M3/M4:** são **duas amostras** de Convênio ICMS. Cada uma cobre só a célula do próprio porte medido; uma nunca vale pela outra (não há OR entre itens).
  - Porte "n/a" só existe na célula da página do DOU em PDF, com justificativa escrita.
- **Estágios separados:**
  - `captured`: SHA-256 e tamanho conferidos antes de qualquer uso; divergência recusa a matriz.
  - `identified`: título ou idAto conferido nos bytes.
  - `read`: perfil **próprio** da fonte.
  - `validated`: invariantes conservadores (`legalStatus` `unknown`; citação nunca operativa; não identificado nunca `complete`) e saída travada em baseline rodada por teste de CI.
  - `accepted`: revisão independente; **nenhuma ainda**, porque aceite de coleta não é aceite de anatomia.
- **Fontes com identidade própria:**
  - Planalto e normas.leg.br são **células distintas**, e a lacuna do layout Planalto continua visível.
  - normas.leg.br fica `captured` + `identified`, sem `read` (não tem perfil próprio). A leitura com o perfil DOU é **só diagnóstico** e não fecha célula.
- **Porte:** caracteres do texto canônico. Pequeno < 10.000; médio 10.000–49.999; grande ≥ 50.000. O porte medido decide: o M5, listado como "pequeno", mede **119.687** (grande).
- **Baselines:** RFB → `docs/anatomy/official-lot-rfb.json` (teste do lote); demais fontes → `docs/anatomy/official-samples-baseline.json` (teste da cobertura).
- **CI:** `npm run test:anatomy` passa a rodar **8 testes de anatomia que estavam fora do comando** (ext, rfb-anexo, rfb-parte, rfb-quote-resume, sefaz-sp-l17, sefaz-sp-l21, sefaz-sp-portal, official-coverage): 315/315.

## 2. Estado da matriz (`docs/anatomy/official-coverage-matrix.json`)

**10 de 61 células cobertas; E9 incompleta.**

| Célula coberta | Amostras validadas |
|---|---|
| RFB × Instrução Normativa × pequeno | 108391, 133898 |
| RFB × Instrução Normativa × médio | 141910 |
| RFB × Instrução Normativa × grande | 115131, 127905, 104314, 116968 |
| RFB × Portaria × pequeno | 142967 (Portaria RFB 514/2025, P2-c) |
| RFB × Ato Declaratório Interpretativo × pequeno | 37103 (ADI RFB 18/2011, P2-c) |
| RFB × Resolução × pequeno | 122645 (Resolução CGSN 164/2022, P2-c) |
| CONFAZ × Convênio ICMS × grande | http:M3 (Convênio ICMS 142/18, 922.008 caracteres), http:M4 (Convênio ICMS 190/17, 82.809) |
| CONFAZ × Ajuste SINIEF × grande | M5 (navegador) e http:M5 (HTTP) — Ajuste SINIEF 7/05 |
| Sefaz-SP portal × RICMS × pequeno | art. 8º, art. 9º |
| Sefaz-SP portal × RICMS × médio | art. 7º; anexo I art. 41; anexo II arts. 3º e 39 |

**Pendentes (52):**
- RFB: Portaria, ADI e Resolução médias/grandes; ADE e Solução de Consulta (3 portes cada).
- Planalto Lei (3 portes); normas.leg.br Lei (3 portes, sem perfil próprio).
- CONFAZ: Convênio ICMS pequeno e médio, Ajuste SINIEF pequeno e médio, Protocolo ICMS (3 portes).
- DOU: IN, Decreto, Portaria, Resolução e Despacho (3 portes cada), mais a página PDF.
- Sefaz-SP RICMS grande.
- DOE-SP: Decreto, Resolução e Portaria CAT (3 portes cada).

## 3. P2 — arquivos manuais (`ops/anatomy/official-manual-ingest.ts`)

- Os bytes ficam como recebidos, com criação **exclusiva**; o estado parcial (bytes sem meta) é **recusado**.
- O arquivo é decodificado com o **encoding declarado** (não suportado ou inválido → recusa).
- A nota `saved from url` que o navegador grava precisa bater com a URL informada.
- Hora do salvamento não informada → `receivedAt` como limite superior, com a nota escrita.
- **M5 recebido (07/11):**
  - arquivo `.html` e o mesmo arquivo dentro de `1231.zip`, bytes idênticos `e4481fcd…`;
  - URL `…/ajustes/2005/AJ007_05` (endereço corrigido);
  - título "AJUSTE SINIEF 7/05"; validado.
- **No ZIP:** M4 veio só com a pasta de recursos, **sem a página**. M3, M9 e o pacote da outra sessão (`cce00c19…`) não chegaram aqui.

## 3-b. Pacote HTTP da outra sessão (`ops/anatomy/official-http-ingest.ts`; `official-identification/e9-http/`)

- **Origem:** tribusca-control@`fe60728d`, branch `evidence/e9-official-inputs-20261107`, ZIP SHA-256 `cce00c19…` (conferido). Seis arquivos conferidos contra o manifesto (hash e tamanho).
- **Natureza:** respostas HTTP da origem oficial (não é captura manual nem reprodução do navegador); a meta diz isso.
- **M1, M2 (Planalto):** não declaram charset, e o charset do cabeçalho HTTP não foi preservado. **Não inferido.** Identificados só pelas partes ASCII do título; ficam *captured + identified*, sem leitura (decisão pendente). A célula Planalto × Lei continua pendente.
- **M3, M4, M5 (CONFAZ):** UTF-8 declarado; lidos com o perfil CONFAZ; invariantes válidos; validados. M3 (922.008) e M4 (82.809) cobrem Convênio × grande; nenhum cobre pequeno ou médio.
- **M9 (PDF, página 57 do DOU de 05/12/2024):**
  - **Identificado:** cabeçalho "Seção 1 · ISSN 1677-7042 · Nº 234, quinta-feira, 5 de dezembro de 2024"; rodapé com código de autenticidade `05152024120500057`; epígrafe da IN 2.237.
  - **Alcance:** uma página. O ato **começa** nela (arts. 1º–6º) e **continua** nas seguintes; o topo traz o fim de outra publicação.
  - **Leitura:** a extração mistura colunas, então a anatomia **não** é validada.
  - **Conta só como evidência de cabeçalho/rodapé (E4).** As células de E9 (página PDF e IN em HTML no DOU) continuam pendentes.

## 4. P2-c — RFB (`ops/anatomy/collect-p2c.ts`; inventário em `official-identification/rfb-p2c/inventory.json`)

**Limites:** até 5 requisições por tipo e 25 no pacote (busca, captura e redirect contam); até 1 ato por porte; até 15 atos. Atos reservados conferidos antes da captura; atos de 2026 excluídos por margem.

| Tipo | Requisições | Resultado |
|---|---|---|
| Portaria | 5 | pequeno (142967); 3 outras capturas também pequenas, descartadas; médio e grande não encontrados no limite |
| ADI | 5 | pequeno (37103); idem |
| Resolução | 5 | pequeno (122645, CGSN 164/2022); idem |
| ADE | 2 | rodada 1: só atos de 2026 (margem); rodada 2: falha de rede (registrada) |
| Solução de Consulta | 2 | a busca devolve primeiro os atos de 2026 (98 de 100), excluídos pela margem |

**Total: 19 de 25.** O EXEC parou de propósito: uma 3ª busca teria a mesma ordenação. "Não encontrado no limite" ≠ "inexistente".

**Decisão pedida:** aceitar atos de 2026 não reservados (a lista de reservados continua sendo o filtro) ou usar o filtro de ano (formato desconhecido; descobrir custa uma requisição).

Os 3 atos entraram no lote reproduzível. Os 7 atos anteriores ficam **idênticos**.

## 5. DOE-SP / M10

Incluído e pendente (decisão do COORD, c.6701950134 §4). **P2-d só depois da validação de M9.** O M9 chegou em PDF e teve a identidade validada (cabeçalho, rodapé e epígrafe), mas a anatomia não foi validada. O EXEC **não iniciou o P2-d** e pede ao COORD que diga se a validação de identidade (alcance E4) satisfaz o gate.

## 6. L-LEG-01

Desenho e contracasos em `docs/anatomy/L-LEG-01-DESIGN.md`. Nenhuma classificação do motor foi alterada.

## 7. P1 — o que ainda depende de captura manual

| # | Ato | URL | Observação |
|---|---|---|---|
| M9 (HTML) | IN RFB 2.237/2024 no DOU | https://www.in.gov.br/consulta → resultado de 05/12/2024 | O PDF da página 57 chegou, mas só vale para E4; a célula de E9 pede a página HTML do ato |
| M1/M2 (charset) | Leis 10.637/2002 e 10.833/2003 (Planalto) | — | Os bytes HTTP chegaram sem charset declarado; para ler, é preciso decidir a fonte do charset (por exemplo, recapturar guardando o cabeçalho HTTP) |

M3, M4 e M5 estão resolvidos. Não pedir de novo.

**Como salvar:** Ctrl+S → **"Página da Web, somente HTML"**, sem renomear. Envie o `.html`; a pasta `_files` não é necessária.
