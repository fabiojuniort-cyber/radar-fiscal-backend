# E9-PLAN — complemento (decisão do Fábio, tribusca-control#116 c.6997715188)

**Escopo:** só planejamento. Nenhuma requisição a fonte oficial, nenhuma ativação de grant, nenhuma coleta.
Base: main `d53fb3e2`, motor `4b96f977…`.

## 0. Correção do E9-PLAN

O E9-PLAN apontava que quatro atos do corpus de teste poderiam cobrir células, dependendo de decisão (classe `a?`):
- 02: CV100/97;
- 07: fonte 24382325;
- 10: Portaria 4.940/26;
- 11: IN 2.342/26.

**Isso estava errado.** Esses atos são reservados do corpus: estão em `RESERVED_ACT_KEYS` e `RESERVED_SOURCE_IDS` (`src/modules/anatomy/config/reserved-act-keys.ts`), e o `official-manual-ingest.ts` os recusa.

Correções feitas:
- `E9-PLAN.md` e `e9-plan-inventory.json`: as quatro células passam à classe `c` (insumo manual).
- Etapa 3 do plano: retirada.
- Teto sem insumos: cai de cerca de 19 para cerca de **15 de 61**.

## 1. Grants autorizados e ainda não executados: alvos exatos

**Saldo publicado** (`rfb-p2c/budget-state.json`):
- E9-P2c-G1: 16 no total, 4 usados, saldo **12**.
  - Por tipo: Resolução 3 · Portaria 2 · ADI 2 · ADE 2 · SC 3.
- E9-P2c-PDF83325-G1: **1**, só Solução de Consulta, conforme `rfb-p2c-attachment/PROTOCOL.md`.

> ⚠️ **Os dois grants vencem em `2026-11-21T23:59:59Z`** (`expiresAt`). Execução depois dessa data exige grant novo.

**Limites do que se sabe offline:**
- O porte só é conhecido depois da captura. As buscas salvas (`search-*.json`) não trazem o texto.
- O CSV de candidatos de 10/11 (`#308`, `candidates-b-rfb-2026-11-10.csv`) traz caracteres medidos no banco só para atos de 2025, de porte pequeno ou médio.
- Por isso, cada alvo abaixo é **direto, por `idAto`**, como em `--targets`, sem busca. Os alvos sem `idAto` conhecido precisam ser **identificados antes pelo Fábio, navegando no site**. Essa navegação é ação humana, não usa grant e não envolve esta sessão.

| # | Grant / tipo | Alvo (`idAto`) | Ato | Porte esperado | Célula que destrava | Observação |
|---|---|---|---|---|---|---|
| 1 | G1 / Resolução | **a identificar** | Res. CGSN nº 140/2018 (texto multivigente) | grande | `rfb--resolucao--grande` | O ato-base do Simples Nacional; o Fábio obtém o `idAto` no normasinternet2 |
| 2 | G1 / Resolução | 146769 | Res. CGSN nº 182/2025 (altera o Anexo XI) | médio? | `rfb--resolucao--medio` | Porte não medido |
| 3 | G1 / Resolução | 141973 | Res. CGSN nº 178/2024 (altera o Anexo XI) | médio? | `rfb--resolucao--medio` (reserva do #2) | Usar só se o #2 cair em outro porte |
| 4 | G1 / Portaria | **a identificar** | Portaria RFB com 50 mil caracteres ou mais | grande | `rfb--portaria--grande` | O Fábio escolhe pelo tamanho visível no site |
| 5 | G1 / Portaria | **a identificar** | 2ª opção do #4 | grande | `rfb--portaria--grande` | Usar só se o #4 sair parcial ou cair em outro porte |
| 6 | G1 / ADI | 148121 | ADI RFB nº 3/2025 (3.630 chars no banco) | pequeno | `rfb--ato-declaratorio-interpretativo--pequeno` (amostra alternativa à 37103) | A falha da 37103 era a assinatura de tipo 1000; um ADI recente pode sair completo |
| 7 | G1 / ADI | **a identificar** | ADI de 10–50 mil caracteres (ex.: os ADIs de convenções internacionais) | médio | `rfb--ato-declaratorio-interpretativo--medio` | Para ADI grande, a proposta é N/A em vez de coleta |
| 8 | G1 / ADE | 148386 | ADE nº 87/2025 (2.573 chars no banco) | pequeno | `rfb--ato-declaratorio-executivo--pequeno` (alternativa à 148629) | Pode repetir o preâmbulo de tipo 999; é uma aposta |
| 9 | G1 / ADE | **a identificar** | ADE com tabela inline extensa | grande | `rfb--ato-declaratorio-executivo--grande` | Possível N/A |
| 10–12 | G1 / SC (3) | **não gastar agora** | — | — | `rfb--solucao-de-consulta--*` | O corpo da SC vem em anexo PDF (`bodyAbsent`), então capturar o JSON não destrava nada sem a rota do PDF e o leitor |
| 13 | PDF83325-G1 / SC | anexo 83325 | PDF da SC 258/2025 (rfb:148681) | — | `rfb--solucao-de-consulta--pequeno` | Depende também do motor/ferramenta para ler o corpo do PDF; nunca pedir o PDF tachado 82416 |

**Consumo proposto:** G1 de 6 a 9 requisições (Resolução 2–3, Portaria 1–2, ADI 2, ADE 2), SC 0. PDF: 1.
**Células que podem ser destravadas:**
- até 5 novas coberturas: Resolução médio e grande, Portaria grande, ADI médio, ADE grande;
- até 2 alternativas para células parciais: ADI pequeno e ADE pequeno;
- 1 SC pequeno, condicionada ao PDF e ao leitor.

**Fora destes grants:**
- o Anexo Único do ADE Corat 33/2025 (148516);
- o IN médio alternativo à 141910.

**Execução:** em mandato próprio, com dono único e um só checkout. O ledger é ativado e publicado antes e consumido e suspenso depois, conforme o protocolo. Local provável: o computador do Fábio.

## 2. Insumos manuais: planilha

A planilha é `manual-inputs.csv` (UTF-8): **28 linhas**, uma por ato, cobrindo **24 células**. São 20 primárias, 4 reservas e 4 de seleção pelo Fábio.

Colunas: `item_sugerido, celula, fonte, ato, link, formato_esperado, arquivo_sugerido, porte_estimado, prioridade, data_hora_download, observacao`. As colunas `data_hora_download` e `observacao` estão vazias, para o Fábio preencher.

**Links:**
- **Planalto e CONFAZ:** link direto do arquivo oficial, no padrão das URLs já preservadas (M1/M2 e M3–M5). Se o link não abrir, registrar o motivo em `observacao` e usar a reserva.
- **DOU:** as páginas do in.gov.br têm *slug* opaco e não dá para obter o link offline. O link indicado é a busca oficial (`https://www.in.gov.br/consulta`) com o ato exato, e o Fábio registra a URL final em `observacao`.

**Formato:**
- Planalto, CONFAZ e DOU: **HTML, "Salvar como → Página da Web, somente HTML"**, como no M5.
- Planalto: preferir o **texto compilado** quando a página oferecer, porque a grade usa o layout "HTML compilado do Planalto".

**Porte:** é estimado. O porte medido pelo motor decide a célula: se um arquivo cair em outro porte, ele serve à célula medida.

**Células possivelmente N/A** (Protocolo grande, Despacho médio e grande): só baixar se o COORD mantiver a célula na grade.

Nenhum ato da planilha é reservado do corpus (conferido contra `RESERVED_ACT_KEYS`).

## 3. Entrega e verificação

**Pasta de entrega:** `ops/anatomy/official-identification/manual-inbox/`, num ramo próprio `evidence/e9-manual-<AAAAMMDD>`, nunca na main. Dentro dela:
- os arquivos com o nome sugerido (`M10.html` … `M37.html`);
- a planilha preenchida (`manual-inputs.csv`, com data/hora e observações).

**Ingestão:** `ops/anatomy/official-manual-ingest.ts`, que grava em `official-identification/manual/` com meta. Antes, um mandato EXEC precisa acrescentar os itens M10–M37 a `MANUAL_ITEMS`, com título esperado e host oficial. Essa lista é fechada: o ingestor recusa itens desconhecidos.

**Verificações automáticas do ingestor**, todas com recusa registrada em `refusals.jsonl`:
1. **Hash e tamanho:** SHA-256 e bytes gravados no meta. Os bytes nunca são reescritos e a criação é exclusiva, então nada é sobrescrito.
2. **Origem:** o host da URL tem de estar na lista oficial do item (`www.planalto.gov.br`, `www.confaz.fazenda.gov.br` ou `www.in.gov.br`). A nota "saved from url" do navegador, quando existe, tem de citar a mesma URL.
3. **Identidade:** o título esperado precisa aparecer no texto decodificado com a codificação que o próprio arquivo declara. Codificação não suportada é recusada, nunca adivinhada.
4. **Reserva:** atos e IDs reservados do corpus são recusados.
5. **Proveniência:** o meta registra `origin = "obtido manualmente pelo Fábio — reprodução salva pelo navegador"`, `original: false` e `promoted: false`. A data/hora vem da planilha (`--saved-at`) ou, na falta dela, da recepção, declarada como limite superior.

**Depois da ingestão:** leitura pelo perfil da fonte, medição do porte e entrada na matriz pelo caminho já existente.
- O aceite segue o rito do E9-A1: prova reprodutível, revisão independente e registro autorizado pelo COORD.
- Para CONFAZ, Planalto e DOU, depende também da ferramenta E9-M1 e das frentes de motor do E9-PLAN.

## 4. As 18 capturas originais DOE-SP/RFB pendentes desde outubro

**O que são:** as 18 entradas do corpus de avaliação (`test/fixtures/anatomy/corpus-manifest.json`) sem `inputs`.
- Fontes: 10 DOE-SP e 8 RFB.
- 5 delas estão na reserva final.
- Origem: `docs/anatomy/CHECKPOINT-02.md`, bloqueio `BLOCK_CORPUS_INPUTS_AND_GOLD`.

**Para a E9 (matriz de cobertura):** **não são necessárias.**
- Os atos do corpus são reservados por regra anti-contaminação e não podem servir de amostra de cobertura.
- A E9 se fecha com amostras próprias: o acervo, os grants e os insumos manuais.

**Para outras frentes da F1:** **continuam necessárias.**
- **Gold e avaliação:** são 18 de 30 publicações sem insumo. O bloqueio vale até recuperar os originais; o CHECKPOINT-02 pede recuperar as capturas originais com hash, sem nova coleta e sem variantes truncadas.
- **Preparação JSON do DOE-SP:** continua provisória e precisa ser conferida contra os originais (`docs/anatomy/json-preparation.md`).
- **Preparação RFB:** já está validada em capturas reais do lote, então nesse ponto as 8 RFB são menos críticas.

**Recomendação:** manter as 18 fora do caminho da E9 e tratá-las numa decisão separada do COORD (recuperação dos originais ou redefinição do corpus). Elas não entram nos grants nem na planilha.
