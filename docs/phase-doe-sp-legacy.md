# Fase DOE-SP (acervo legado): Diário Oficial de São Paulo, 1988 – 30/06/2023

Governança: tribusca-control Issue #20 (DOE-SP-LEGACY-01/02/03; correção da revisão DOE-SP-LEGACY-04 em DOE-SP-LEGACY-05). Este conector é **separado** do `doe-sp`. O `doe-sp` cobre a plataforma atual (doe.sp.gov.br, a partir de 01/07/2023) e não é alterado aqui. A arquitetura é a do Motor de Coleta, sem componente novo. O acervo é **finito**: quando o backfill termina e é comprovado, a fonte é desativada.

## 1. Decisões do responsável (2026-09-29)

1. **Escopo:** só as **páginas com termos fiscais**.
2. **Sem guardar PDF:** a página é baixada em memória, convertida em texto e descartada. Em `publication_files` ficam só o SHA-256 e o tamanho, como proveniência (`versionRole: PROVENANCE`, `metadata.stored: false`).
3. **Link preservado:** `officialUrl` é o visualizador público da página no portal.
4. **OCR autorizado** para páginas escaneadas.

## 2. Fonte (medida em 09/2026, sondagens #6–#13)

| Item | Valor |
|---|---|
| Portal | https://www.imprensaoficial.com.br/DO/ (ASP.NET WebForms, sem autenticação, sem robots.txt) |
| Cadernos do dia | `POST /ajax/ImprensaOficial.PortalIO.DODigitalAjax,PortalIO.ashx?_method=GetCadernos&_session=no`, corpo `strData=DD/MM/AAAA\r\nstrBuscaEsp=true`. Devolve `[{'ID':'ex1','texto':'Executivo I'},…]`; `[]` = sem edição |
| Lista de resultados | `GET /DO/BuscaDO2001Resultado_11_3.aspx?…` com 15 páginas por tela, paginada por `xhitlist_vpc=first\|2\|3…` |
| Sem resultado | redireciona para `BuscaDO2001ResultadoNegativo_11_3a.aspx` |
| Visualizador (link preservado) | `BuscaDO2001Documento_11_4.aspx?link=<caminho>&pagina=&data=&caderno=&paginaordenacao=` |
| PDF da página | `GatewayPDF.aspx` com os mesmos parâmetros; devolve `application/pdf` direto, sem cookie |

O PDF *certificado* (`GatewayCertificaPDF`) é só imagem. O `GatewayPDF` traz a camada de texto (nativa ou OCR da digitalização) e é o que o conector usa.

### Formato por época (página 1 do Executivo I)

| Período | Página | Texto |
|---|---|---|
| 1988 – ~2001 | scan 1-bit (CCITT, 200–250 dpi) | camada OCR da digitalização (iTextSharp em 1988, ABBYY FineReader 9 em 1995); qualidade de ruim a média |
| ~2002 – 2023 | PDF nativo (QuarkXPress/Distiller, PDFSplit, iTextSharp) | texto nativo |

As páginas `pagnot_*` (noticiário do governo no Executivo I, ~2004–2015) são jornalismo, não atos oficiais, e são ignoradas.

## 3. Descoberta

| Datas | Modo | Como |
|---|---|---|
| 1988-01-01 … 2002-12-31 | **BROWSE** (por data) | A busca por palavra não responde para essas edições (medido: negativa de 1988 a 2002). Para cada data: `GetCadernos`; se houver **Executivo I** (Seção I, onde saem os atos normativos), lista a edição inteira (`FE`, palavra vazia) e **lê todas as páginas** |
| 2003-01-01 … 2023-06-30 | **SEARCH** (por mês) | Índice de palavra-chave do portal (`UP`): **uma consulta por termo** de `DOE_SP_LEGACY_SEARCH_TERMS` × caderno (Executivo I, II e III). O índice casa palavras, então os termos vão separados e os resultados são unidos por página. Uma consulta de várias palavras funciona como E, o que só amplia os resultados. Resultados fora do período pedido são descartados |

### Vocabulário fiscal único (revisão DOE-SP-LEGACY-04, B1)

Um só vocabulário, `DOE_SP_LEGACY_TAX_VOCABULARY` (58 termos), define as consultas e o filtro local:

- **Consultas** (`DOE_SP_LEGACY_SEARCH_TERMS`, 85): cada termo, mais a grafia sem acento e sem hífen quando for diferente ("tributação"/"tributacao", "NFC-e"/"NFCe"). O índice pode não tratar essas grafias como a mesma palavra.
- **Filtro local** (`DOE_SP_LEGACY_TAX_PATTERN`): gerado desses mesmos termos. Palavra inteira, sem diferença de caixa nem de acento, hífen opcional.

Assim, **toda página mantida contém um termo que foi consultado**: a descoberta é um superconjunto do que se guarda. O teste `rules (B1)` exige amostras para cada família de `DOE_SP_TAX_TERMS` (o vocabulário do `doe-sp`) e verifica que cada uma é aceita localmente e alcançada por uma consulta. Se uma família nova entrar no `doe-sp`, o teste falha até o vocabulário do acervo cobri-la.

O vocabulário cobre:
- ICMS, ICM, IPVA, ITCMD/ITCD, IPI, IBS, CBS, RICMS, CONFAZ, DIFAL, Simples Nacional;
- tributo/tributos/tributar/tributação/tributações/tributária(s)/tributário(s), imposto(s);
- nota(s) fiscal(is), NF-e, NFC-e, CT-e, MDF-e, EFD, SPED, documento(s) fiscal(is), obrigação(ões) acessória(s);
- benefício(s)/incentivo(s) fiscal(is), crédito(s) outorgado(s)/presumido(s)/acumulado(s), dívida ativa, cadastro de contribuintes, Receita Estadual;
- da administração anterior: Portaria(s) CAT e taxa(s) estadual(is)/judiciária(s)/de fiscalização/de polícia.

"Substituição tributária", "Administração Tributária", "Tribunal de Impostos e Taxas" e "contribuinte do ICMS" são alcançados pelos termos que contêm.

Palavras ambíguas sozinhas **não** tornam a página fiscal: um "taxa" isolado ("taxa de inscrição") ou "Secretaria da Fazenda" (atos de pessoal). A página sem nenhum termo é contada em `pagesWithoutTaxTerms` e não vira publicação.

O mesmo filtro vale para as páginas do BROWSE (antes de 2003).

**A confirmar no piloto:** o comportamento do índice com acentos e hífens foi coberto consultando as duas grafias, mas não foi medido. O piloto deve comparar, em alguns dias de 2003+, a listagem da edição inteira (BROWSE) com a busca (SEARCH) e confirmar que toda página mantida pelo filtro foi achada pela busca.

## 4. Modelo de publicação

A unidade é a **página** do Diário, não o ato. A separação de atos dentro da página fica para uma fase posterior.

| Campo | Valor |
|---|---|
| `title` | `Diário Oficial do Estado de São Paulo — <caderno> — DD/MM/AAAA — página <n>` |
| `externalId` | caminho canônico no acervo (`/1995/executivo secao i/setembro/06/pag_0001_<id>.pdf`) |
| `officialUrl` | visualizador público da página (link preservado) |
| `content` | texto da página (nativo ou camada OCR) |
| `contentHashPolicy` | `HTML_PRIMARY_MATERIAL_FILES`: a versão é o texto; o PDF é só proveniência |
| `files[0]` | URL do `GatewayPDF`, SHA-256 e tamanho; `versionRole: PROVENANCE`, `stored: false` |
| `metadata` | `sourceRole: LEGACY_ARCHIVE`, `caderno`, `doeDate`, `pagina`, `paginaOrdenacao`, `archiveLink`, `discovery` (`EDITION_BROWSE`/`KEYWORD_SEARCH`), `textExtraction` (`PDF_NATIVE_TEXT`/`PDF_EMBEDDED_OCR`), `scanned`, `textChars`, `matchedTaxTerms` |

Uma página escaneada **sem nenhuma camada de texto** não pode ser filtrada. Ela vai para `needsOcr` no checkpoint, para uma passada de OCR (Tesseract `por`) em fase posterior. As amostras medidas já trazem camada OCR.

A fila `needsOcr` guarda até 5.000 referências. Quando está cheia, a próxima página sem texto **não é descartada**: ela continua pendente e o run para com `DOE_SP_LEGACY_NEEDS_OCR_FULL`, que é um gate. A coleta só volta depois que a passada de OCR esvaziar a fila.

## 5. Checkpoint e retomada

Estado (`collection_checkpoints`, `connector_key = doe-sp-legacy`, versão 1; nenhum estado existe em produção, a fonte nunca foi ativada):
- `cursor`: próxima data (BROWSE) ou primeiro dia do mês (SEARCH); `null` = acervo todo listado;
- `listing`: o período em listagem, retomável (revisão DOE-SP-LEGACY-04, B3):
  - `mode`, `from`, `to`, `next`;
  - `vocabularyVersion`;
  - no BROWSE, `browseCaderno` (o caderno encontrado pelo `GetCadernos`);
  - `query`, o índice da consulta: no SEARCH, caderno × termo, 3 × 85 = 255 por mês; no BROWSE, uma;
  - `screen`, a próxima tela, e `screens`, o total da consulta;
  - `found`, as páginas achadas até ali, unidas por link;
  - `attempts`;
- `pending`: páginas de um período já listado, ainda não lidas;
- `retry`: páginas cuja persistência falhou no motor, reabertas de `collection_items` FAILED do run que produziu o checkpoint;
- `needsOcr`, `totals`.

Ordem de cada run:
1. lê `retry` e depois `pending`;
2. só lista quando `pending` está vazio. Retoma o `listing` em curso ou abre o período do `cursor`;
3. o **time budget** (e o orçamento de bytes) é checado **antes de cada requisição** da listagem. Ao parar, a consulta e a tela ficam no checkpoint, e o próximo run segue dali sem repetir telas;
4. quando todas as consultas do período foram listadas, as páginas achadas vão para `pending`, o `cursor` avança e o `listing` é apagado.

Se o vocabulário mudar no meio de um mês (`vocabularyVersion`), as consultas do mês recomeçam, mantendo as páginas já achadas.

Falhas:
- **Fonte indisponível** (5xx, 429, rede, HTML no lugar do PDF): o run para e tudo fica pendente (páginas e listagem). Se nada foi lido nem listado, o run falha (nunca "0 resultados").
- **Página com erro de processamento** (PDF inválido): continua pendente com `attempts`. Com 3 tentativas é abandonada e registrada (`DOE_SP_LEGACY_PAGE_ABANDONED`).
- **Tela de resultado que não pode ser lida por inteiro** (revisão DOE-SP-LEGACY-04, B2), em qualquer tela:
  - item malformado (`DOE_SP_LEGACY_MALFORMED_RESULT_ITEM`);
  - tela vazia antes da última (`DOE_SP_LEGACY_EMPTY_RESULT_SCREEN`);
  - tela 2+ respondendo "sem resultados" (`DOE_SP_LEGACY_RESULT_SCREEN_MISSING`);
  - página desconhecida (`DOE_SP_LEGACY_INVALID_RESULT_PAGE`).

  O **período fica bloqueado** nessa tela: o `listing` é mantido, o `cursor` não avança e o run termina com `PARTIAL_FAILURE_RETRY_REQUIRED`. Cada run tenta a mesma tela de novo. A partir da 3ª falha seguida, o código passa a ser `DOE_SP_LEGACY_LISTING_BLOCKED` e pede correção do parser. Nenhuma página é perdida em silêncio.

## 6. Limites (educação com a fonte)

| Variável | Padrão | Efeito |
|---|---|---|
| `DOE_SP_LEGACY_MIN_REQUEST_INTERVAL_MS` | 1000 | espaçamento mínimo entre requisições |
| `DOE_SP_LEGACY_MAX_DOWNLOAD_BYTES_PER_RUN` | 200 MiB (0 = sem limite) | para de ler páginas novas no run. Checado só depois da primeira página, para que todo run avance |
| `DOE_SP_LEGACY_START_DATE` | 1988-01-01 | primeira data do acervo coberta |

Além disso vale o time budget do executor, com parada segura entre páginas e entre telas da listagem.

**Estimativa:**
- BROWSE (1988–2002): ~15 anos × ~250 edições × ~40–70 páginas ≈ 150–250 mil páginas lidas em memória (~40 GB trafegados, nada armazenado).
- SEARCH (2003–06/2023): ~246 meses × 85 consultas × 3 cadernos ≈ 63 mil consultas (~17 h a 1 req/s), mais as telas adicionais e as páginas encontradas.
- A 1 requisição/s, ~6–8 dias de runs contínuos.

### Dependência `pdfjs-dist` (6.3.289, fixada)

- Extrai o texto em memória, sem `eval` e sem fontes do sistema.
- O pacote opcional `@napi-rs/canvas` só serve para renderizar, e o conector não renderiza. Sem ele, o pdf.js carrega, emite um aviso e os testes do conector passam (medido com `npm ci --omit=optional`).
- `--omit=optional` não serve para o build do repositório: o próprio `tsc` depende de um pacote opcional de plataforma (`@typescript/typescript-linux-x64`), com ou sem este PR.
- **Impacto na imagem**, medido no `npm ci` padrão do Railpack: `pdfjs-dist` 35 MB; `@napi-rs/canvas` ~64 MB (binários glibc e musl).

## 7. Operação

- Fonte: `npm run db:ensure-doe-sp-legacy-source`, com código `doe-sp-legado` e conector `doe-sp-legacy`. É criada **inativa**; `--activate` e `--hourly` exigem autorização.
- Run manual: `npm run db:trigger-doe-sp-legacy-run`.
- Métricas do run em `metadata.doeSpLegacy`:
  - `periods`;
  - `listing` (período, consulta atual/total, tela, páginas achadas, tentativas);
  - `pendingPages`, `needsOcr`, `ocrGate`, `totals`;
  - `counters` (requisições, bytes, telas, páginas lidas, mantidas, sem termos, escaneadas, nativas);
  - `sourceLimits`.
- **Fim:** com `cursor = null`, sem `listing` e sem pendências, o run fica completo e sem publicações. Depois da validação do backfill, a fonte é desativada. O conector e a fonte podem ser removidos em PR posterior.
