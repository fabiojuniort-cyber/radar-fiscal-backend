# Fase DOE-SP (acervo legado): Diário Oficial de São Paulo, 1988 – 30/06/2023

Governança: tribusca-control Issue #20 (DOE-SP-LEGACY-01/02/03). Este conector é **separado** do `doe-sp`. O `doe-sp` cobre a plataforma atual (doe.sp.gov.br, a partir de 01/07/2023) e não é alterado aqui. A arquitetura é a do Motor de Coleta, sem componente novo. O acervo é **finito**: quando o backfill termina e é comprovado, a fonte é desativada.

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
| 2003-01-01 … 2023-06-30 | **SEARCH** (por mês) | Índice de palavra-chave do portal (`UP`): **uma consulta por termo** de `DOE_SP_LEGACY_SEARCH_TERMS` × caderno (Executivo I, II e III). O índice casa palavras, então os termos vão separados e os resultados são unidos por página. Resultados fora do período pedido são descartados |

**Toda página baixada é confirmada localmente** com o vocabulário fiscal: `DOE_SP_TAX_TERMS`, o mesmo do `doe-sp`, mais os termos da administração da época (`DOE_SP_LEGACY_EXTRA_TAX_TERMS`):
- ICM, o imposto anterior ao ICMS;
- Portaria CAT;
- Coordenação da/Administração Tributária;
- Tribunal de Impostos e Taxas;
- taxas estaduais, judiciária, de fiscalização e de polícia.

Palavras ambíguas sozinhas **não** tornam a página fiscal: um "taxa" isolado ("taxa de inscrição") ou "Secretaria da Fazenda" (atos de pessoal). A página sem nenhum termo é contada em `pagesWithoutTaxTerms` e não vira publicação.

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

Uma página escaneada **sem nenhuma camada de texto** não pode ser filtrada. Ela vai para `needsOcr` no checkpoint (até 5.000 referências; o excedente é contado), para uma passada de OCR (Tesseract `por`) em fase posterior. As amostras medidas já trazem camada OCR.

## 5. Checkpoint e retomada

Estado (`collection_checkpoints`, `connector_key = doe-sp-legacy`, versão 1):
- `cursor`: próxima data (BROWSE) ou primeiro dia do mês (SEARCH); `null` = acervo todo listado;
- `pending`: páginas listadas ainda não lidas;
- `retry`: páginas cuja persistência falhou no motor, reabertas de `collection_items` FAILED do run que produziu o checkpoint;
- `needsOcr`, `totals`.

Ordem de cada run:
1. lê `retry` e depois `pending`;
2. só lista um novo período quando `pending` está vazio;
3. o cursor avança quando o período é listado. As páginas listadas ficam em `pending` até serem lidas.

Falhas:
- **Fonte indisponível** (5xx, 429, rede, HTML no lugar do PDF): o run para e tudo fica pendente. Se nada foi lido nem listado, o run falha (nunca "0 resultados").
- **Página com erro de processamento** (PDF inválido): continua pendente com `attempts`. Com 3 tentativas é abandonada e registrada (`DOE_SP_LEGACY_PAGE_ABANDONED`).
- **Tela de resultado desconhecida:** `DOE_SP_LEGACY_INVALID_RESULT_PAGE`. O período é listado de novo no próximo run.

## 6. Limites (educação com a fonte)

| Variável | Padrão | Efeito |
|---|---|---|
| `DOE_SP_LEGACY_MIN_REQUEST_INTERVAL_MS` | 1000 | espaçamento mínimo entre requisições |
| `DOE_SP_LEGACY_MAX_DOWNLOAD_BYTES_PER_RUN` | 200 MiB (0 = sem limite) | para de ler páginas novas no run. Checado só depois da primeira página, para que todo run avance |
| `DOE_SP_LEGACY_START_DATE` | 1988-01-01 | primeira data do acervo coberta |

Além disso vale o time budget do executor, com parada segura entre páginas.

**Estimativa:**
- BROWSE (1988–2002): ~15 anos × ~250 edições × ~40–70 páginas ≈ 150–250 mil páginas lidas em memória (~40 GB trafegados, nada armazenado).
- SEARCH (2003–06/2023): ~246 meses × 30 termos × 3 cadernos ≈ 22 mil consultas, mais as páginas encontradas.
- A 1 requisição/s, ~5–7 dias de runs contínuos.

## 7. Operação

- Fonte: `npm run db:ensure-doe-sp-legacy-source`, com código `doe-sp-legado` e conector `doe-sp-legacy`. É criada **inativa**; `--activate` e `--hourly` exigem autorização.
- Run manual: `npm run db:trigger-doe-sp-legacy-run`.
- Métricas do run em `metadata.doeSpLegacy`: `periods`, `pendingPages`, `needsOcr`, `totals`, `counters` (requisições, bytes, páginas lidas, mantidas, sem termos, escaneadas, nativas) e `sourceLimits`.
- **Fim:** com `cursor = null` e sem pendências, o run fica completo e sem publicações. Depois da validação do backfill, a fonte é desativada. O conector e a fonte podem ser removidos em PR posterior.
