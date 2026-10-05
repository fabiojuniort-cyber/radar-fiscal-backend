# DOE-SP legacy PDF: decisão de carregamento sob demanda

Data: 2026-10-05. Validação exclusivamente local, sem banco, rede, PDFs oficiais ou produção.

## Decisão

Adotar importação dinâmica de `pdfjs-dist/legacy/build/pdf.mjs` com cache da **promise em andamento**, do módulo resolvido e do conjunto de operações de imagem. O ganho medido é no processo que **ainda não usou o extrator PDF**: aproximadamente **36,5 MiB de RSS e 3,6 MiB de heap retido** no bootstrap isolado deste módulo.

Isto **não reduz permanentemente o custo do PDF em workers que o utilizam**. O primeiro PDF passa a pagar a carga da biblioteca; depois disso o módulo permanece no cache ESM. Não há promessa de redução equivalente no RSS total da API, do worker ou do serviço em produção.

Se a importação falhar, a promise rejeitada é removida do cache: chamadas concorrentes compartilham a falha, uma chamada posterior pode tentar novamente, e uma importação bem-sucedida permanece cacheada. O teste usa uma falha transitória de resolução; falhas permanentes de avaliação que o próprio cache ESM mantém não são declaradas recuperáveis.

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
source SHA-256: 90add1e43f860bf53efa3ac9c204e7a9073afb81cd0b11d317cdfab0a51e3446
dist SHA-256:   24d88872bbed1dab29181dea3cd9996c9eb44af56ddec264d49a0c03c7362038
```

## Resultado principal

Medianas de 7 execuções novas por variante, após a correção do cache de importação rejeitada. MiB = 1.048.576 bytes.

| Fase / medida | Eager-control | Lazy atual |
| --- | ---: | ---: |
| Baseline RSS (bytes) | 52.420.608 | 52.547.584 |
| Bootstrap RSS (MiB) | 86,617 | 50,117 |
| Bootstrap heapUsed (MiB) | 12,569 | 8,992 |
| Bootstrap high-water RSS (MiB) | 86,617 | 50,117 |
| Bootstrap tempo (ms) | 316,25 | 1,24 |
| Primeiro uso RSS (MiB) | 105,742 | 103,488 |
| Primeiro uso tempo (ms) | 76,21 | 393,92 |
| Segundo uso RSS (MiB) | 106,082 | 103,855 |
| Segundo uso heapUsed (MiB) | 16,042 | 16,036 |
| Segundo uso external (MiB) | 16,744 | 16,744 |
| Segundo uso arrayBuffers (MiB) | 0,278 | 0,278 |
| Segundo uso tempo (ms) | 4,29 | 4,12 |

O custo da importação é deslocado para o primeiro uso. As pequenas diferenças de RSS após uso não são tratadas como economia permanente; heap/external/arrayBuffers convergem. As diferenças do segundo uso estão na escala de ruído de execução local. Esta rodada foi repetida após corrigir o reset da promise rejeitada e corresponde aos hashes acima; não atribui ao código novo os tempos de versões anteriores.

Amostras desta execução principal (tempos em ms; RSS em bytes). Cada caso foi iniciado diretamente pelo runner em um processo novo, alternando a ordem eager/lazy e lazy/eager a cada repetição, sem depender de spawnSync bloqueado pelo sandbox.

| Variante | N | Bootstrap ms | 1º uso ms | 2º uso ms | RSS bootstrap | RSS 1º uso | RSS 2º uso |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Eager | 1 | 323,650 | 74,755 | 3,977 | 90.992.640 | 111.177.728 | 111.439.872 |
| Eager | 2 | 319,986 | 77,183 | 3,593 | 90.890.240 | 110.682.112 | 111.337.472 |
| Eager | 3 | 314,214 | 95,423 | 5,873 | 90.693.632 | 110.616.576 | 110.878.720 |
| Eager | 4 | 317,138 | 80,796 | 4,489 | 90.525.696 | 110.972.928 | 111.235.072 |
| Eager | 5 | 300,212 | 75,758 | 4,995 | 90.824.704 | 110.878.720 | 111.009.792 |
| Eager | 6 | 288,619 | 74,934 | 4,021 | 90.796.032 | 110.587.904 | 110.981.120 |
| Eager | 7 | 316,246 | 76,211 | 4,289 | 90.865.664 | 110.919.680 | 111.312.896 |
| Lazy | 1 | 1,126 | 451,036 | 4,097 | 52.551.680 | 108.560.384 | 108.953.600 |
| Lazy | 2 | 1,239 | 399,172 | 6,264 | 52.690.944 | 108.986.368 | 109.248.512 |
| Lazy | 3 | 1,238 | 377,872 | 3,645 | 52.547.584 | 108.507.136 | 108.900.352 |
| Lazy | 4 | 0,950 | 393,918 | 4,121 | 52.551.680 | 108.515.328 | 108.777.472 |
| Lazy | 5 | 0,915 | 374,498 | 3,904 | 52.551.680 | 107.790.336 | 108.183.552 |
| Lazy | 6 | 1,260 | 405,151 | 5,017 | 52.678.656 | 108.478.464 | 108.609.536 |
| Lazy | 7 | 2,515 | 374,083 | 4,475 | 52.551.680 | 108.941.312 | 109.203.456 |

## Regressões verificadas

Seis testes passaram, usando o pdf.js real e PDFs sintéticos gerados em memória:

1. Texto nativo em duas páginas, remoção do carimbo de certificação, buffer original intacto e reutilizável.
2. OCR embutido com raster 1.500 × 1.500 (2.250.000 pixels), classificação e texto preservados.
3. PDF válido vazio e PDF somente imagem: classificação `EMPTY`, com sinalização correta de scan.
4. PDF inválido e entrada de zero bytes: `ConnectorError`, `DOE_SP_LEGACY_INVALID_PDF`, não retentável; chamada válida posterior funciona.
5. Nova instância do wrapper via URL com query única: zero resoluções de pdf.js no bootstrap do wrapper; **uma única resolução** em oito primeiras extrações concorrentes e no uso seguinte; buffer compartilhado intacto. Um hook de resolução filtrado pela URL do wrapper conta solicitações de importação, não somente a avaliação do módulo que o próprio ESM já deduplicaria. Esse teste não precisa de subprocesso nem de cache ESM global vazio; as medidas de memória usam subprocessos realmente novos.

6. Uma falha única de resolução é compartilhada por oito chamadas; a próxima onda de oito chamadas resolve um único novo import, extrai o texto e mantém o resultado cacheado para o uso posterior.

O sandbox padrão deste ambiente recusou `spawnSync` com `EPERM`. A medição principal e uma versão inicial do teste concorrente rodaram com a execução local escalada autorizada pelo mecanismo de aprovação. O teste de regressão final usa a instância por URL acima, sem exigir essa permissão. Se subprocessos estiverem indisponíveis no runner, os casos de benchmark podem ser iniciados individualmente como execuções novas com `node --expose-gc scripts/benchmark-doe-sp-pdf.ts --child current` e `--child eager-control`; não se deve reutilizar um processo e apresentá-lo como cold start.

`npm run build` também passou. Esta validação não cobre download, OCR externo, desempenho de documentos reais/grandes, volume histórico, rede, banco ou aplicação completa. A mudança não implementa descarregamento da biblioteca, prewarm ou worker dedicado.
