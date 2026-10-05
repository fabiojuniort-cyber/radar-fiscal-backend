# DOE-SP legacy PDF: decisão de carregamento sob demanda

Data: 2026-10-05. Validação exclusivamente local, sem banco, rede, PDFs oficiais ou produção.

## Decisão

Adotar importação dinâmica de `pdfjs-dist/legacy/build/pdf.mjs` com cache da **promise em andamento**, do módulo resolvido e do conjunto de operações de imagem. O ganho medido é no processo que **ainda não usou o extrator PDF**: aproximadamente **36,5 MiB de RSS e 3,6 MiB de heap retido** no bootstrap isolado deste módulo.

Isto **não reduz permanentemente o custo do PDF em workers que o utilizam**. O primeiro PDF passa a pagar a carga da biblioteca; depois disso o módulo permanece no cache ESM. Não há promessa de redução equivalente no RSS total da API, do worker ou do serviço em produção.

A cópia `new Uint8Array(bytes)` foi mantida intencionalmente: o pdf.js pode transferir/destacar o buffer recebido. Removê-la alteraria a propriedade dos dados do chamador, inclusive em chamadas concorrentes.

## Método reproduzível

```sh
npm run build
node scripts/benchmark-doe-sp-pdf.ts --runs=7
node --import tsx --test --test-isolation=none test/doe-sp-legacy.text.unit.test.ts
```

- Ambiente medido: Linux x64, Node v24.19.0, `pdfjs-dist` 6.3.289.
- 7 subprocessos **novos por variante**, em ordem alternada; nenhum usa loader tsx. O Node 24 remove nativamente os tipos do harness, mas o extrator testado é o JavaScript de `dist`, como em produção.
- `current`: importa o extrator compilado, usa o mesmo PDF sintético duas vezes.
- `eager-control`: pré-carrega explicitamente pdf.js durante o bootstrap, depois usa exatamente o mesmo extrator/PDF. Reproduz o custo da dependência eager sem manter um segundo parser divergente; não representa byte a byte o grafo de importação anterior.
- Antes de modificar o extrator, 3 repetições do código original compilado confirmaram equivalência aproximada com o controle eager: RSS bootstrap mediano 90.460.160 contra 90.566.656 bytes; heap 13.085.592 contra 13.094.592 bytes; tempo 297,52 contra 307,37 ms.
- Baseline, bootstrap, primeiro uso e segundo uso são medidos separadamente. Cada snapshot aplica duas GCs fora do intervalo de tempo medido.
- `rss`, `heapUsed`, `heapTotal`, `external` e `arrayBuffers` são snapshots **retidos após GC**, não picos. `processMaxRss` vem do high-water mark do processo (`resourceUsage().maxRSS`), convertido de KiB para bytes.
- O script retorna todas as amostras e medianas em JSON; inclui URL e SHA-256 do extrator compilado. Pode apontar para um build preservado com `--module=file:///caminho/para/doe-sp-legacy.text.js`. É necessário compilar antes de medir mudanças no source.
- Uma medição exploratória com tsx no subprocesso foi **descartada**: o loader inflava o heap/RSS da dependência. Não foi usada para a decisão.

Identidade do extrator da medição principal:

```text
source SHA-256: f0712e9fde7138e747f86e62bd8cd89de72236e075f1dd7cdc8f6584ada1cf58
dist SHA-256:   c56205a3b8f476824d3c1034716cc92afe647654ecd2a9fd6c58063776455382
```

## Resultado principal

Medianas de 7 execuções por variante. MiB = 1.048.576 bytes.

| Fase / medida | Eager-control | Lazy atual |
| --- | ---: | ---: |
| Baseline RSS (bytes) | 52.551.680 | 52.555.776 |
| Bootstrap RSS (MiB) | 86,602 | 50,121 |
| Bootstrap heapUsed (MiB) | 12,569 | 8,992 |
| Bootstrap high-water RSS (MiB) | 86,770 | 50,121 |
| Bootstrap tempo (ms) | 279,19 | 0,97 |
| Primeiro uso RSS (MiB) | 105,832 | 103,750 |
| Primeiro uso tempo (ms) | 70,83 | 360,62 |
| Segundo uso RSS (MiB) | 105,977 | 104,000 |
| Segundo uso heapUsed (MiB) | 16,042 | 16,036 |
| Segundo uso external (MiB) | 16,744 | 16,744 |
| Segundo uso arrayBuffers (MiB) | 0,278 | 0,278 |
| Segundo uso tempo (ms) | 3,75 | 3,73 |

O deslocamento aproximado de 290 ms para o primeiro uso é esperado. As pequenas diferenças de RSS após uso não são tratadas como economia permanente; heap/external/arrayBuffers convergem. As diferenças do segundo uso estão na escala de ruído de execução local. Uma rodada anterior, antes de adicionar as importações usadas para identificar o build por SHA no harness, mostrou 38,5 MiB / 4,1 MiB no bootstrap; a tabela abaixo corresponde à versão final do script e não mistura as rodadas.

Amostras da execução principal, na ordem interna de cada variante (tempos em ms; RSS em bytes). A ordem global alterna eager/lazy e lazy/eager a cada repetição.

| Variante | N | Bootstrap ms | 1º uso ms | 2º uso ms | RSS bootstrap | RSS 1º uso | RSS 2º uso |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Eager | 1 | 284,333 | 74,263 | 3,886 | 90.808.320 | 110.862.336 | 111.124.480 |
| Eager | 2 | 279,194 | 75,731 | 4,096 | 90.882.048 | 111.067.136 | 111.329.280 |
| Eager | 3 | 287,549 | 74,381 | 4,801 | 90.771.456 | 110.825.472 | 111.087.616 |
| Eager | 4 | 268,951 | 66,336 | 3,331 | 90.906.624 | 110.829.568 | 111.091.712 |
| Eager | 5 | 273,025 | 65,826 | 3,577 | 91.070.464 | 110.993.408 | 111.386.624 |
| Eager | 6 | 265,652 | 66,875 | 3,477 | 90.787.840 | 110.972.928 | 111.104.000 |
| Eager | 7 | 287,772 | 70,833 | 3,746 | 90.693.632 | 111.009.792 | 111.271.936 |
| Lazy | 1 | 1,105 | 389,382 | 4,731 | 52.555.776 | 108.945.408 | 109.207.552 |
| Lazy | 2 | 0,973 | 363,539 | 3,793 | 52.797.440 | 108.904.448 | 109.297.664 |
| Lazy | 3 | 0,842 | 408,287 | 3,319 | 52.690.944 | 108.478.464 | 108.609.536 |
| Lazy | 4 | 0,829 | 344,273 | 3,581 | 52.555.776 | 108.765.184 | 109.027.328 |
| Lazy | 5 | 0,770 | 341,832 | 3,682 | 52.293.632 | 108.789.760 | 109.051.904 |
| Lazy | 6 | 0,998 | 360,623 | 3,731 | 52.166.656 | 108.965.888 | 109.096.960 |
| Lazy | 7 | 1,115 | 348,123 | 3,794 | 52.817.920 | 108.638.208 | 108.769.280 |

## Regressões verificadas

Cinco testes passaram, usando o pdf.js real e PDFs sintéticos gerados em memória:

1. Texto nativo em duas páginas, remoção do carimbo de certificação, buffer original intacto e reutilizável.
2. OCR embutido com raster 1.500 × 1.500 (2.250.000 pixels), classificação e texto preservados.
3. PDF válido vazio e PDF somente imagem: classificação `EMPTY`, com sinalização correta de scan.
4. PDF inválido e entrada de zero bytes: `ConnectorError`, `DOE_SP_LEGACY_INVALID_PDF`, não retentável; chamada válida posterior funciona.
5. Nova instância do wrapper via URL com query única: zero resoluções de pdf.js no bootstrap do wrapper; **uma única resolução** em oito primeiras extrações concorrentes e no uso seguinte; buffer compartilhado intacto. Um hook de resolução filtrado pela URL do wrapper conta solicitações de importação, não somente a avaliação do módulo que o próprio ESM já deduplicaria. Esse teste não precisa de subprocesso nem de cache ESM global vazio; as medidas de memória usam subprocessos realmente novos.

O sandbox padrão deste ambiente recusou `spawnSync` com `EPERM`. A medição principal e uma versão inicial do teste concorrente rodaram com a execução local escalada autorizada pelo mecanismo de aprovação. O teste de regressão final usa a instância por URL acima, sem exigir essa permissão. Se subprocessos estiverem indisponíveis no runner, os casos de benchmark podem ser iniciados individualmente como execuções novas com `node --expose-gc scripts/benchmark-doe-sp-pdf.ts --child current` e `--child eager-control`; não se deve reutilizar um processo e apresentá-lo como cold start.

`npm run build` também passou. Esta validação não cobre download, OCR externo, desempenho de documentos reais/grandes, volume histórico, rede, banco ou aplicação completa. A mudança não implementa descarregamento da biblioteca, prewarm ou worker dedicado.
