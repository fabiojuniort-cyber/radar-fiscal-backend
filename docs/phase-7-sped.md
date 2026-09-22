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
- padrão: máximo global de 16 documentos conhecidos por run;
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


## Links históricos removidos

A validação real encontrou links antigos ainda referenciados por páginas do portal, mas que hoje retornam HTTP 404.

Esses casos não significam indisponibilidade da fonte inteira. O conector registra a rota como `MISSING` no checkpoint e:

- não converte o run em `PARTIAL_SUCCESS`;
- não repete o 404 a cada hora;
- revalida o tombstone pelo mesmo ciclo oldest-first;
- se a rota voltar a responder 200, ela retorna automaticamente ao fluxo normal.

Seeds estruturais continuam rigorosos: 404/410 em seed de módulo permanece falha real.

## Latência de recheck de alterações silenciosas

No bootstrap lógico validado em 22/09/2026, o conector produziu 524 publicações e 235 referências de arquivo.

Com o padrão de 16 documentos conhecidos rechecados por run horário e elegibilidade após 24 horas:

- novos IDs vistos nas listagens continuam sendo processados imediatamente;
- alterações silenciosas em documentos antigos entram no ciclo de recheck;
- o pool real observado contém cerca de 640 rotas documentais conhecidas; um ciclo completo exige cerca de 40 runs horários após a elegibilidade;
- portanto a detecção de uma alteração silenciosa muito antiga pode ocorrer aproximadamente entre 24 e 64 horas após o último check, conforme sua posição no ciclo.

Esse limite é deliberado para manter a coleta horária dentro do orçamento operacional do Worker.


## Margem operacional do recheck

Na validação real com transporte diagnóstico, a execução horária sem rechecks ficou em aproximadamente 68 s. Com 32 rechecks elegíveis, a execução chegou a aproximadamente 84 s, muito próxima do timeout operacional de 90 s do Worker.

Por segurança, o lote padrão foi reduzido para 16 documentos conhecidos por run. Novos IDs permanecem imediatos; somente a revalidação de alterações silenciosas antigas usa esse lote.


## Validação final do conector real

A validação de três passagens foi executada em 22/09/2026 usando o próprio `SpedConnector` atual. O transporte HTTP foi injetado somente no serviço isolado de validação para contornar o bloqueio de 443; URLs oficiais e lógica do conector permaneceram HTTPS.

### Bootstrap lógico

- duração: ~410,6 s;
- 4/4 módulos com sucesso;
- 524 publicações;
- 235 referências de arquivo;
- 0 falhas parciais;
- 1.427 rotas no checkpoint;
- 235 arquivos no state;
- republicação Reinf `pagina:8129` vinculada ao `arquivo:8070`, com SHA-256 do artefato.

### Execução +1 hora

- duração: ~36,4 s;
- 123 requisições HTML;
- 0 downloads;
- 0 publicações reemitidas;
- 643 documentos conhecidos reaproveitados;
- 0 falhas parciais.

### Execução +25 horas

Teste realizado inicialmente com lote 32 para medir o teto operacional:

- duração: ~45,5 s no transporte de validação;
- 32 documentos históricos rechecados;
- 31 arquivos responderam `304 Not Modified`;
- 1 arquivo exigiu novo download;
- 0 falhas parciais.

Validação adicional anterior no caminho completo chegou a ~84 s com lote 32, por isso o padrão produtivo foi reduzido para 16 para preservar margem sob o timeout de 90 s.

## Gates oficiais com SHA-256

Amostras reais confirmadas no Portal SPED:

- Guia Prático EFD ICMS/IPI 3.2.1: PDF, 6.362.216 bytes, SHA-256 `63fce839b01014f1924f8219cd4a0c20f4dd358c4931dcd28a58c3727fde4af9`;
- Guia Prático EFD ICMS/IPI 3.2.2: PDF, 6.064.212 bytes, SHA-256 `49d940a5f7cb209f0ddc8be094ea2e753ed0e2b1219200f4a3266e9b6972d22f`;
- EFD-Contribuições NT 11/2026: PDF, 86.320 bytes, SHA-256 `1eca9b37057ba71989e0813dc112df0b578e3ce74d44099f81b2c4f554202130`;
- EFD-Contribuições NT 12/2026: PDF, 224.526 bytes, SHA-256 `9ff91fc533ae9a7c5865dde4939dbcda717287fec2f7bf5b24af0a931b35b91b`;
- EFD-Reinf NT 01/2026 republicada: artefato oficial `arquivo:8070`, PDF, 523.421 bytes; a validação amostral confirmou o vínculo da republicação ao arquivo;
- EFD-Reinf XSD v2.1.2 CNPJ alfanumérico: ZIP, 64.550 bytes, SHA-256 `26a82d92bdccc4dddc56150e08080e60043315964b9f7e6800a3402f6218d4b9`.

A página histórica original da NT Reinf 01/2026 hoje retorna 404 no portal. A republicação permanece publicada e vinculada ao artefato atual. O conector preserva o tombstone da rota histórica sem transformar a fonte inteira em falha.

## Peso de arquivos

A inspeção real encontrou aproximadamente 201 arquivos físicos únicos, totalizando ~264,88 MiB. Nenhum arquivo individual ultrapassou o limite configurado de 160 MiB.

## Matriz de conectividade HTTPS

Testes TCP diretos para `sped.rfb.gov.br:443`:

- Railway US East: timeout;
- Railway US West: timeout;
- Railway EU West: timeout;
- Railway Asia Southeast/Singapore: timeout;
- Railway Static Outbound IP: timeout;
- proxy legado CONFAZ: timeout;
- GitHub Actions: timeout.

Em todas as regiões Railway testadas, `sped.rfb.gov.br:80` respondeu normalmente e o DNS resolveu para `200.198.239.243`.

O problema ocorre antes de TLS/HTTP e não é provocado pelo parser, pelo cliente HTTP do conector ou pelo Motor de Coleta.

## Estado produtivo atual

- conector SPED presente na `main`;
- CI da `main` verde;
- backend, Worker e Scheduler saudáveis no Railway;
- fonte `sped` provisionada no PostgreSQL;
- `schedule_cron = NULL`;
- nenhuma coleta produtiva executada;
- nenhuma publicação SPED persistida em produção;
- Scheduler SPED não ativado;
- `sped-validation` restaurado a serviço auxiliar sem cron e sem Static Outbound IP.

## DECISÕES PARA O GERENTE GERAL

A implementação funcional está pronta, mas os gates de ativação produtiva O/P/Q não podem ser concluídos enquanto o HTTPS oficial permanecer inacessível a partir do egress do ambiente.

Nenhuma das opções abaixo deve ser aplicada silenciosamente:

1. **Aguardar/cobrar correção do HTTPS do Portal SPED para egress de datacenter.**
   - Mantém arquitetura atual e origem HTTPS oficial.
   - É a opção com menor mudança arquitetural.

2. **Autorizar um relay HTTPS externo controlado.**
   - O relay acessaria `https://sped.rfb.gov.br` e entregaria os bytes ao Worker.
   - Exige nova dependência operacional, autenticação do relay, observabilidade e validação de que o provedor consegue abrir o 443.
   - Deve preservar URL oficial, headers relevantes e bytes exatos; o SHA-256 continua calculado pelo Radar Fiscal.

3. **Autorizar HTTP/80 direto do mesmo host oficial.**
   - Tecnicamente funcionou em todas as validações.
   - Não é recomendado como decisão implícita porque remove autenticação/integridade TLS no transporte.
   - Só deve ser considerado mediante decisão arquitetural explícita e controles compensatórios.

Até essa decisão, manter `schedule_cron = NULL` e não iniciar coleta produtiva.
