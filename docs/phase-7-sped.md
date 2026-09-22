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

- `/item/show/274`
- `/item/show/1573`
- destaques globais `/destaques/show/7`, com filtro obrigatório de módulo.

### EFD-Contribuições

- `/item/show/268`
- `/item/show/1545`
- destaques do módulo `/destaques/show/285`
- destaques globais `/destaques/show/7`, com filtro obrigatório.

### EFD-Reinf

- `/item/show/1196`
- destaques do módulo `/destaques/show/1199`
- `/item/show/2270` para esquemas XSD.

### DeRE

- `/item/show/7950`
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

Cada execução refaz a descoberta das páginas do portal para identificar itens novos rapidamente.

Arquivos:

- item novo: download imediato;
- checkpoint recente: reutilizado;
- checkpoint vencido: revalidado oldest-first;
- padrão: recheck depois de 24 horas;
- padrão: máximo de 32 rechecks de arquivos conhecidos por run;
- ETag/Last-Modified são usados quando o portal os fornece.

Isso evita redownload integral do acervo em cada execução e ainda permite detectar alteração silenciosa de arquivo antigo.

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

Na inspeção inicial, requisições Node no Railway para `sped.rfb.gov.br:443` falharam antes de HTTP com `UND_ERR_CONNECT_TIMEOUT`.

O serviço isolado `sped-validation` foi usado para o diagnóstico, sem alterar backend, Worker ou Scheduler produtivos.

O plano Railway atual suporta Static Outbound IP, porém a integração Railway disponível nesta sessão não expõe a ação de habilitá-lo. O teste com Static Outbound IP é um gate operacional antes da primeira coleta produtiva.

## Migrations

Nenhuma migration é necessária para esta frente.
