# Portal SPED — Conector Radar Fiscal

## Escopo

Conector único `sped` para quatro módulos oficiais:

- EFD ICMS/IPI
- EFD-Contribuições
- EFD-Reinf
- DeRE — Declaração de Regimes Específicos

Não cobre ECD, ECF, e-Financeira, eSocial, CT-e, MDF-e, NF-e/NFC-e ou NFS-e nesta frente.

## Decisão arquitetural vigente

A coleta corrente usa como origem produtiva primária:

- `https://www.gov.br/sped/pt-br/` — `PRIMARY`

O portal histórico:

- `https://sped.rfb.gov.br` — `LEGACY / ENRICHMENT / BACKFILL`

não é usado como canal recorrente de produção.

Decisões explícitas:

- não usar HTTP/80 em produção;
- não introduzir relay externo;
- preservar o legado somente para histórico/enriquecimento quando necessário;
- não criar migration nova para esta mudança;
- usar o mesmo Motor de Coleta, fila PostgreSQL, Worker e Scheduler já existentes.

## Componentes

- `sped.client.ts`: HTTPS, redirects, limites, arquivos, SHA-256 e conditional GET.
- `sped.parser.ts`: HTML + hidratação Volto `window.__data`, classificação, versões e arquivos.
- `sped.connector.ts`: crawl por módulo, descoberta, downloads e incremental.
- `sped-source-state.repository.ts`: checkpoint somente de attempts pertencentes a runs bem-sucedidos.
- `ensure-sped-source.ts`: provisionamento da fonte `sped` com gov.br como `base_url`.

## Entradas gov.br

### EFD ICMS/IPI

- `/assuntos/escrituracoes-digitais/efd-icms-ipi`
- `/assuntos/escrituracoes-digitais/efd-icms-ipi/manuais-e-documentos-tecnicos`
- `/assuntos/comunicados/efd-icms-ipi`

### EFD-Contribuições

- `/assuntos/escrituracoes-digitais/efd-contribuicoes`
- `/assuntos/escrituracoes-digitais/efd-contribuicoes/documentos-tecnicos`
- `/assuntos/comunicados/efd-contribuicoes`

### EFD-Reinf

- `/assuntos/escrituracoes-digitais/efd-reinf`
- `/assuntos/escrituracoes-digitais/efd-reinf/manuais-e-documentos-tecnicos`
- `/assuntos/comunicados/efd-reinf`

O portal também contém a árvore atual em `documento-tecnicos/versao-atual`; ela é descoberta pelo crawl técnico do módulo.

### DeRE

- `/assuntos/documentos-fiscais/dere`
- `/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versao-atual-1`
- `/assuntos/documentos-fiscais/dere/manuais-e-documentos-tecnicos/versoes-anteriores`
- `/assuntos/comunicados/dere`

## Hidratação Volto

O gov.br/SPED não pode ser tratado apenas como HTML estático. Parte relevante das listagens está no estado SSR:

`window.__data`

O parser usa apenas campos semânticos como `@id`, `href` e `url`. Links relativos legítimos são preservados.

Recursos internos do Volto não entram no crawl documental, incluindo:

- `@aliases`
- `@types`
- `@breadcrumbs`
- `@navigation`
- `@workflow`
- `@contextnavigation`
- `@querystring-search`
- `@@images/*`
- `object_copy`
- placeholders de schema como `URL`, `URI` e `HREF`

Arquivos oficiais são reconhecidos também por:

- `@@display-file/file`
- `@@download/file`

Redirects internos que terminam fora do boundary oficial do gov.br/SPED não são seguidos como conteúdo do módulo.

## Classificação

`metadata.documentKind`:

- `GUIDE`
- `TECHNICAL_NOTE`
- `ORIENTATION_NOTE`
- `LAYOUT`
- `XSD_SCHEMA`
- `TABLE`
- `SOFTWARE_RELEASE`
- `MANUAL`
- `EVOLUTION_DOCUMENT`
- `OPERATIONAL_NOTICE`

Também são preservados quando disponíveis:

- módulo;
- família documental;
- versão oficial;
- número do documento;
- tipo de revisão/republicação;
- status documental;
- data explicitamente publicada;
- data de criação editorial da página (`sourceCreatedAt`);
- atualização;
- tributos relacionados;
- registros afetados;
- URL oficial;
- ID externo da origem;
- SHA-256, MIME, tamanho, ETag e Last-Modified dos arquivos.

`Criado em` no gov.br não é automaticamente tratado como data normativa de publicação.

## Identidade, origem e versionamento

`externalId` continua representando a identidade específica da origem.

`identityKey` é uma chave canônica adicional usada pelo normalizador para correlacionar publicações equivalentes entre origens oficiais quando a equivalência documental é suficientemente forte.

Isso permite:

- uma publicação global;
- múltiplas `publication_origins`;
- URL/ID específico de cada origem preservado;
- gov.br como origem primária;
- legado como origem de enriquecimento;
- mudança de bytes criando nova `publication_version` por `content_hash`.

Não se força deduplicação quando número, família, versão ou natureza da revisão indicam documentos distintos.

## Inventário real gov.br — 22/09/2026

Validação usando a lógica produtiva do conector, com downloads substituídos por bytes sintéticos somente no inventário para evitar baixar em massa o acervo:

| Módulo | Publicações | Referências de arquivo |
| --- | ---: | ---: |
| EFD ICMS/IPI | 22 | 19 |
| EFD-Contribuições | 22 | 17 |
| EFD-Reinf | 68 | 60 |
| DeRE | 39 | 32 |
| **Total** | **151** | **128** |

Resultado operacional:

- 4/4 módulos consultados;
- 198 páginas/rotas conhecidas no checkpoint do inventário;
- 0 `partialFailures`;
- 0 páginas históricas faltantes nessa passagem;
- recursos internos do Volto não foram tratados como documentos.

Esses 151 itens representam o conteúdo técnico atualmente exposto/descoberto no gov.br pelo escopo aprovado. Não são equivalentes ao tamanho do acervo histórico legado.

## Gates oficiais HTTPS confirmados

Downloads reais efetuados contra `www.gov.br/sped`:

| Gate | Bytes | SHA-256 |
| --- | ---: | --- |
| Guia Prático EFD ICMS/IPI 3.2.4 | 6.557.945 | `01e76f177996cb11b1454cbf39f19ad8ce9577876cd8c222ddf3e4aa45b6f164` |
| EFD-Contribuições NT 11/2026 | 86.320 | `1eca9b37057ba71989e0813dc112df0b578e3ce74d44099f81b2c4f554202130` |
| EFD-Contribuições NT 12/2026 | 224.526 | `9ff91fc533ae9a7c5865dde4939dbcda717287fec2f7bf5b24af0a931b35b91b` |
| EFD-Reinf NT 1/2026 | 523.421 | `d827692f54643eca0aa08babe50723f5be676531c44d5a701d3f376e87ed7c05` |
| EFD-Reinf XSD v2.1.2 | 57.541 | `6e4076218f19615c737691d781c694a56f88f152ed8f8a49edb0b2e5fb49e4f1` |

A página DeRE 1.2.0 expõe oficialmente:

- Leiautes/Eventos;
- Anexo I — Tabelas;
- Anexo II — Regras de Validação;
- Histórico de Versões;
- arquivos XSD 1.2.0.

Os testes de rede usados para obter essa evidência são diagnósticos e não fazem parte da CI permanente.

## Baseline legado validado

O conector legado foi medido anteriormente com transporte diagnóstico, sem uso produtivo de HTTP/80.

Bootstrap lógico:

- duração aproximada: 410,6 s;
- 4/4 módulos;
- 524 publicações lógicas;
- 235 referências de arquivo;
- 0 falhas parciais;
- 1.427 rotas no checkpoint.

Métricas por módulo observadas no crawl legado:

| Módulo | Documentos processados no módulo |
| --- | ---: |
| EFD ICMS/IPI | 200 |
| EFD-Contribuições | 140 |
| EFD-Reinf | 217 |
| DeRE | 8 |

Os valores por módulo não devem ser somados para obter o total canônico, pois o legado possuía rotas/listagens correlacionadas e deduplicação lógica posterior.

Replay +1h:

- 123 requests HTML;
- 0 downloads;
- 0 publicações reemitidas;
- 643 rotas documentais reaproveitadas;
- 0 falhas parciais.

Teste +25h com lote diagnóstico de 32 rechecks:

- 32 documentos rechecados;
- 31 arquivos responderam 304;
- 1 arquivo foi baixado novamente;
- 0 falhas parciais.

O padrão produtivo continua limitado a 16 rechecks por run para preservar margem operacional.

## Matriz gov.br x legado

A comparação deve ser interpretada como **corrente x histórico**, não como duas listagens equivalentes.

| Módulo | gov.br PRIMARY atual | legado histórico | Uso do legado |
| --- | ---: | ---: | --- |
| EFD ICMS/IPI | 22 publicações | 200 docs processados no módulo | backfill/histórico |
| EFD-Contribuições | 22 | 140 | backfill + correlação |
| EFD-Reinf | 68 | 217 | backfill + versões históricas |
| DeRE | 39 | 8 | legado não representa toda a estrutura atual do gov.br |

Correlação comprovada por bytes:

- NT 11/2026 EFD-Contribuições: mesmo SHA-256 observado no gov.br e no legado;
- NT 12/2026 EFD-Contribuições: mesmo SHA-256 observado no gov.br e no legado.

Diferenças que devem ser preservadas, e não normalizadas à força:

- EFD-Reinf NT 01/2026: o legado validado possuía republicação explícita vinculada a artefato histórico; o gov.br atual expõe a NT corrente com bytes diferentes;
- pacote XSD EFD-Reinf v2.1.2: amostra histórica do legado e pacote atual do gov.br possuem tamanhos/hashes diferentes.

O inventário gov.br atual não expôs referências diretas ao host legado (`legacyReferences = 0`). O backfill legado é portanto uma operação separada, não uma dependência do crawl corrente.

## Incremental

Em execução normal:

- seeds/listagens correntes continuam sendo consultados;
- páginas documentais conhecidas são reaproveitadas via checkpoint;
- novo documento descoberto é processado imediatamente;
- alterações silenciosas entram no ciclo de recheck;
- padrão: elegibilidade após 24 h;
- padrão: máximo global de 16 documentos conhecidos rechecados por run;
- ETag/Last-Modified são usados quando disponíveis;
- SHA-256 é calculado em downloads reais.

## Falhas

Cada módulo é isolado.

- falha em um módulo pode gerar `partialFailures` sem descartar os demais;
- se nenhum módulo for consultado com sucesso, a fonte é tratada como indisponível/retryable;
- indisponibilidade nunca vira `SUCCESS_NO_RESULTS`;
- 404/410 históricos não-seed podem virar tombstones rechecáveis;
- recursos sistêmicos do Volto são ignorados antes de virarem requests documentais.

## Provisionamento e Scheduler

`npm run db:ensure-sped-source`:

- provisiona/atualiza a fonte;
- usa `https://www.gov.br/sped/pt-br/`;
- mantém `schedule_cron = NULL`.

`npm run db:ensure-sped-source -- --hourly` ativa:

- cron `0 * * * *`;
- timezone `America/Sao_Paulo`.

`npm run db:trigger-sped-run` cria run manual somente quando não existe run `PENDING`/`RUNNING` da fonte.

A agenda horária só deve ser ativada após:

1. merge/deploy;
2. bootstrap produtivo;
3. inspeção de publications/files/origins/checkpoints;
4. replay imediato idempotente;
5. medição da duração real;
6. definição do timeout operacional seguro;
7. confirmação da proteção contra overlap.

## Migrations

Nenhuma migration nova é necessária.

A infraestrutura existente de publications, publication_versions e publication_origins suporta a mudança de origem e a correlação PRIMARY/ENRICHMENT.

## Testes

A CI permanente usa testes determinísticos e cobre:

- gov.br como default;
- hidratação Volto;
- links relativos legítimos;
- exclusão de recursos internos/placeholders;
- Guia 3.2.4;
- NT 11/2026 e NT 12/2026;
- Reinf NT/XSD;
- DeRE 1.2.0;
- SHA-256;
- 304/conditional GET;
- checkpoint;
- idempotência;
- falha parcial e indisponibilidade;
- normalização com `identityKey`;
- persistência de múltiplas origins para uma publicação canônica.

Validações ao vivo permanecem disponíveis como ferramenta operacional fora da CI.

## Correção pós-ativação (2026-09-23): idempotência, identidade e checkpoint

Incidente: o bootstrap `bbff4796` (PARTIAL_SUCCESS, 131 publicações + 15 versions) e o replay `5471c622` (146 versions artificiais). O hourly não foi ativado.

Causas raiz confirmadas:

1. **content_hash instável.** O parser guardava todo o texto do HTML, inclusive o `<script>window.__data=…>` do Volto. Esse estado muda a cada requisição: `router.key` aleatória e serialização do redux em ordem variável. Os primeiros 12.000 caracteres viravam `publication.content`. Correção: o texto visível exclui `script`, `style`, `noscript` e `template`, e o conteúdo canônico (`documentText`) vem do objeto Volto (`content.data`: description, rich text, blocos slate na ordem de `blocks_layout`, filename). A versão inferida do corpo usa só esse conteúdo canônico.
2. **Colisões de identidade.**
   - comunicado × documento (a mesma NT 01/2026);
   - páginas sem número nem versão com o mesmo título ("Esquemas XSD" atual × histórico; manuais);
   - espelhos do mesmo arquivo com páginas diferentes, que alternavam o conteúdo.

   Correção (identity v2): `SPED|v2|módulo|carrier|kind|família/número|versão|revisão`. O `carrier` é DOCUMENT ou ANNOUNCEMENT. Quando não há número nem versão, entra o fallback `PATH:<caminho canônico>`. Há também uma guarda em runtime: só compartilha chave um espelho comprovado, isto é, o mesmo conjunto não vazio de SHA-256. Qualquer outra colisão é desambiguada de forma determinística, estável entre execuções, e registrada em `metadata.sped.identityAudit`. Espelhos emitem uma representação canônica única.
3. **Checkpoint.**
   - O estado de runs PARTIAL_SUCCESS não era reutilizado.
   - Um documento cujo arquivo falhou ficava marcado como DOCUMENT conhecido, mas sem ter sido emitido.

   Correção (state v2):
   - O documento só é emitido com todos os arquivos resolvidos; caso contrário fica adiado (`deferredDocuments`) e é refeito já no run seguinte.
   - PARTIAL_SUCCESS é reutilizável somente em estado v2.
   - Itens FAILED do run e páginas sem `publication_origin` persistida voltam a ser buscados.
   - Estados antigos (v1) são ignorados.
4. **Gate do Guia 3.2.4.** Não houve colisão. Os 5 documentos ausentes do ICMS/IPI no bootstrap são exatamente as 5 falhas de download; o replay os capturou. Além disso, o `inspect-sped` filtrava os guias apenas nas versões 3.2.1 e 3.2.2 e foi corrigido.
5. **Gate do XSD Reinf 2.1.2.** O arquivo oficial não mudou (`xsd-eventos`, 57.541 bytes, sha `6e4076…`); a inspeção só listava outro XSD. Surgiu um arquivo novo e legítimo: "XSD EFD-Reinf v2.1.2 - CNPJ Alfanumérico" (64.550 bytes, sha `26a82d…`).

Saneamento controlado: `npm run db:sanitize-sped` roda em modo dry-run por padrão. Para executar: `SPED_SANITIZE_CONFIRM=<token> npm run db:sanitize-sped -- --execute`. A execução:

- remove somente as publicações cujas origens são todas SPED, junto com versions, files e links de run (em cascata);
- preserva runs, attempts e items (em `collection_items.publication_id` o valor vira NULL);
- é bloqueada por cron ativo, run ativo, publicação compartilhada com outra fonte ou vínculo com empresas.
