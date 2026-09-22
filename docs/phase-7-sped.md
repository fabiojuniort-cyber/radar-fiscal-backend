# Portal SPED — Conector Radar Fiscal

## Escopo

Conector único `sped` para quatro módulos oficiais do Portal SPED:

- EFD ICMS/IPI
- EFD-Contribuições
- EFD-Reinf
- DeRE — Declaração de Regimes Específicos

Não cobre ECD, ECF, e-Financeira, eSocial, CT-e, MDF-e, NF-e/NFC-e ou NFS-e.

## Arquitetura

O conector usa o Motor de Coleta existente. Não cria fila, scheduler, tabelas ou fluxo paralelo.

Componentes:

- `sped.client.ts`: HTTP, redirects, retryability, arquivos, SHA-256 e conditional GET.
- `sped.parser.ts`: estrutura HTML, classificação, versões, famílias e republicações.
- `sped.connector.ts`: crawl por módulo, descoberta, downloads e incremental.
- `sped-source-state.repository.ts`: checkpoint lido exclusivamente de attempts bem-sucedidos pertencentes a runs `SUCCESS` / `SUCCESS_NO_RESULTS`.

## Pontos de entrada oficiais

### EFD ICMS/IPI

- `/projeto/show/274` (raiz canônica atual do módulo)
- `/item/show/1573` / redirecionamento equivalente de categoria
- destaques globais `/destaques/show/7`, com filtro obrigatório de módulo.

### EFD-Contribuições

- `/projeto/show/268` (raiz canônica atual do módulo)
- `/item/show/1545` / redirecionamento equivalente de categoria
- destaques do módulo `/destaques/show/285`
- destaques globais `/destaques/show/7`, com filtro obrigatório.

### EFD-Reinf

- `/projeto/show/1196` (raiz canônica atual do módulo)
- destaques do módulo `/destaques/show/1199`
- `/item/show/2270` / redirecionamento equivalente para esquemas XSD.

### DeRE

- `/pagina/show/7950` (documentação técnica oficial DeRE)
- destaques globais filtrados.

A DeRE é tecnicamente compatível com o mesmo conector: sua documentação oficial está publicada dentro do Portal SPED e possui o mesmo modelo de páginas/arquivos.

## Classificação estrutural

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

Também são preservados, quando disponíveis:

- `module`
- `documentFamily`
- `officialVersion`
- `documentNumber`
- `revisionKind`
- `republication`
- `documentStatus` (`DRAFT` somente quando a fonte indica minuta; `FINAL` somente quando indica oficial/definitivo; `UNKNOWN` nos demais casos)
- `updatedAt`
- `relatedTaxes`
- `affectedRecords`
- ID oficial do item
- IDs oficiais dos arquivos.

## Identidade e versionamento

Versões oficiais distintas são publicações distintas.

Exemplo:

- Guia Prático EFD ICMS/IPI 3.2.1
- Guia Prático EFD ICMS/IPI 3.2.2

Compartilham `documentFamily`, mas possuem identidade/publicação própria.

Republicação expressa também é preservada como publicação própria. Exemplo:

- EFD-Reinf Nota Técnica 01/2026
- EFD-Reinf Nota Técnica 01/2026 — REPUBLICAÇÃO

Uma mudança posterior dos bytes da mesma publicação, sem mudança de identidade oficial, altera o `content_hash` porque o SHA-256 do arquivo participa dele. O Motor cria então uma nova `publication_version`.

## Incremental

O bootstrap real medido em 22/09/2026 encontrou 716 páginas, 536 documentos e 203 arquivos no escopo inicial. Por isso o incremental não refaz o acervo inteiro em cada hora.

Em cada execução horária:

- containers/listagens (`projeto`, `pasta`, `destaques`) continuam sendo consultados;
- rotas canônicas conhecidas ficam em `spedState.pages`;
- páginas de documentos históricos recentes são puladas;
- qualquer ID/documento novo visto em listagem é lido imediatamente;
- documentos vencidos são rechecados oldest-first;
- padrão: recheck após 24 horas;
- padrão: máximo global de 32 documentos conhecidos por run;
- quando um documento é rechecado, seus arquivos usam ETag/Last-Modified quando disponíveis e SHA-256 sempre que houver download;
- linked artifacts, como o PDF apontado por uma página de republicação, são rechecados junto da publicação-pai.

O bootstrap permite até 600 páginas por módulo e profundidade 5. Em operação normal, o checkpoint reduz drasticamente o número de páginas documentais consultadas sem deixar de detectar novos itens.

## Falhas

Cada módulo é isolado operacionalmente.

- falha em um módulo gera `partialFailures`, preservando os outros;
- se nenhum módulo for consultado com sucesso, o conector lança `SPED_ALL_MODULES_FAILED` como indisponibilidade retryable;
- indisponibilidade nunca é convertida em `SUCCESS_NO_RESULTS`.

## Gates históricos automatizados

A suíte cobre:

- Guia Prático EFD ICMS/IPI 3.2.1;
- Guia Prático EFD ICMS/IPI 3.2.2;
- EFD-Reinf NT 01/2026;
- republicação da EFD-Reinf NT 01/2026;
- EFD-Contribuições NT 11/2026;
- EFD-Contribuições NT 12/2026;
- XSD EFD-Reinf;
- documentação técnica DeRE;
- exclusão de ECD/ECF em destaques globais;
- SHA-256;
- conditional 304;
- alteração silenciosa dos bytes;
- idempotência;
- falha parcial;
- indisponibilidade total;
- integração real com o Motor/PostgreSQL.

## Provisionamento

`npm run db:ensure-sped-source` provisiona a fonte sem agenda recorrente.

`npm run db:ensure-sped-source -- --hourly` define:

- cron `0 * * * *`
- timezone `America/Sao_Paulo`.

`npm run db:trigger-sped-run` cria run MANUAL somente quando não existe run PENDING/RUNNING da fonte.

`npm run db:inspect-sped` produz o relatório operacional de runs, módulos, tipos, gates históricos, hashes, duplicidades, checkpoint e migrations.

## Conectividade Railway

Na inspeção ao vivo, `sped.rfb.gov.br` resolveu para `200.198.239.243`.

O serviço isolado `sped-validation` comprovou:
- TCP/HTTP porta 80: acessível;
- páginas oficiais em HTTP: status 200;
- rotas antigas `/item/show/274`, `/268`, `/1196` e `/7950`: redirects internos para `/projeto/show/*` ou `/pagina/show/*`;
- TCP/HTTPS porta 443: timeout antes de TLS/HTTP;
- Static Outbound IP Railway: testado e não resolveu o timeout do 443;
- proxy legado do CONFAZ: testado e não resolveu o acesso SPED;
- GitHub Actions também apresentou bloqueio para o HTTPS ao vivo.

O HTTP/80 foi utilizado somente para análise técnica e medição de bootstrap. Ele **não** é considerado rota produtiva aprovada: o conector continua usando `https://sped.rfb.gov.br` como origem oficial.

A primeira coleta produtiva e o Scheduler permanecem bloqueados até existir um caminho HTTPS seguro aprovado.

## Migrations

Nenhuma migration é necessária para esta frente.


## Medição real do bootstrap

Validação estrutural via serviço isolado, sem persistência produtiva:

- EFD ICMS/IPI: 214 páginas, 198 documentos, 55 arquivos;
- EFD-Contribuições: 189 páginas, 132 documentos, 45 arquivos;
- EFD-Reinf: 293 páginas, 198 documentos, 97 arquivos;
- DeRE: 20 páginas, 8 documentos, 6 arquivos;
- total: 716 páginas, 536 documentos, 203 arquivos.

A porta 443 do host oficial permaneceu inacessível a partir dos egress de datacenter testados. A porta 80 respondeu e foi usada somente para diagnóstico estrutural e validação de hashes; o conector produtivo continua configurado para URLs oficiais HTTPS.
