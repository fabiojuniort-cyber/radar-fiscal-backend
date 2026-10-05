# DOU / INLABS — implementação e evidências

Atualizado em 2026-09-21. PR #16 implementa o conector DOU/INLABS para as **seis variantes XML documentadas oficialmente**: `DO1/DO1E`, `DO2/DO2E` e `DO3/DO3E`. A implementação foi validada com arquivos reais, sessão autenticada no Railway e gate CONFAZ completo. O conector permanece **desabilitado por padrão em produção**; ativação é uma etapa operacional controlada após merge e aplicação da migration 010.

## Diretrizes preservadas

ADR-042 recebida: DOU certificado é primário; INLABS é ingestão; portais dos órgãos são enriquecimento/validação.
Publicação global, sem duplicação por tenant, sem IA e sem Motor de Relevância. Migrations 001–009, algoritmo de identidade (incluindo `publishedOn`) e parser CONFAZ permanecem intactos. Nenhuma evidência justifica modificar a identidade normativa.
PRs 14/15, relay, Fly.io, Lightsail e proxies adicionais permanecem congelados. Nenhum outro conector foi iniciado.

## Fontes e acesso

- [Portal INLABS](https://inlabs.in.gov.br/acessar.php).
- [Código oficial](https://github.com/Imprensa-Nacional/inlabs), revisão consultada `b73795a16ecdf53d2f9f66de86a0e3c7aa087042`.
- [XML Python](https://github.com/Imprensa-Nacional/inlabs/blob/b73795a16ecdf53d2f9f66de86a0e3c7aa087042/public/python/inlabs-auto-download-xml.py) e [PDF Bash](https://github.com/Imprensa-Nacional/inlabs/blob/b73795a16ecdf53d2f9f66de86a0e3c7aa087042/public/bash/inlabs-auto-download-pdf.sh).
- Ajuda oficial copiada pelo usuário da sessão autenticada, recebida em 2026-09-21, com dicionário XML.
- ZIPs oficiais de 2026-09-18, normal e extra, baixados e enviados pelo usuário. Manifesto das fixtures registra hashes dos originais.

A captura anterior mostrou manutenção em `/registrar.php`. Depois o titular conseguiu entrar com conta existente e visualizar as pastas. Isso comprova acesso no navegador do titular, não acesso autenticado do Worker. A captura não comprova status HTTP, SLA ou indisponibilidade de todas as rotas.

| Tema | Evidência e implementação |
| --- | --- |
| Login | POST HTTPS `/logar.php`, email/password, cookie `inlabs_session_cookie`, header `origem`. Cookie privado em memória por tentativa; sem logs/código contendo credenciais. |
| XML | `index.php?p=AAAA-MM-DD&dl=AAAA-MM-DD-DOx.zip`. Em validação live no Railway, 2026-09-18 retornou com sucesso as seis variantes `DO1`, `DO1E`, `DO2`, `DO2E`, `DO3`, `DO3E`, todas sem falha de parsing. |
| Extra | DO1E contém várias edições: 177-A, B, C e D no mesmo ZIP. Não se assume ZIP = edição. |
| PDF | Convenção oficial normal `AAAA_MM_DD_ASSINADO_do1.pdf`; extras `..._do1_extra_A.pdf` e letras seguintes. Transporte implementado, sem captura/armazenamento de PDF nesta validação. |
| Suplementos | Convenção ainda não comprovada. Não inventamos DO1S; metadata informa `supplementsVerified=false`. |
| Disponibilidade | Ajuda permite disponibilizar XML até o quinto dia útil do mês seguinte. O aviso de publicação diária tem ressalva para XML. Não prometer ingestão XML em tempo real. |
| Quotas | Nenhuma quota formal identificada. Downloads sequenciais, lote limitado, timeout/cancelamento herdados do executor e retries centralizados no Motor. |
| Histórico | README menciona desde 2020; cobertura/retenção completa não verificada. Não foi executado backfill histórico. |

## Dicionário e parser

`article@id` é ID editorial GN4; não serve para inventar links no Portal. `idMateria` é o ID da matéria no Portal. `idOficio` identifica lote e não é identidade da matéria. `pdfPage` é referência certificada de página, compartilhada por várias matérias.

O parser valida UTF-8, estrutura XML, ausência de DTD, data, nome de arquivo, identificadores, seção e referência certificada. Bibliotecas fixadas em package-lock: sax, yauzl e htmlparser2. ZIP: CRC32/tamanho, 64 MiB comprimido, 128 MiB descomprimido, 8 MiB por entrada e até 5.000 entradas; leitura sequencial sem extrair caminhos no disco. Esses limites são operacionais provisórios, não limites publicados da fonte.

Continuações `idMateria-1.xml`, `-2.xml` etc. são reunidas em ordem numérica por jornal/idMateria, exigindo consistência dos metadados estruturais oficiais. Parte inválida ou lacuna observável rejeita a matéria inteira e conserva as outras. O formato observado não declara quantidade total de partes; não é possível detectar uma última parte ausente quando a sequência restante é contínua. O INLABS real demonstrou que `Identifica` pode estar vazio **ou mudar entre continuações do mesmo idMateria** (por exemplo, de “DESPACHOS...” para “RETIFICAÇÕES”); esses títulos de continuação são preservados em `metadata.dou.continuationTitles` e não invalidam a matéria. Texto HTML é convertido em texto; tabelas mantêm conteúdo textual, mas não diagramação. Imagens são contadas, não preservadas; conteúdo exclusivamente visual requer tratamento posterior.

Título, texto, órgão completo, unidade, tipo, número/ano, data de publicação, data do ato quando explícita, ementa, seção, edição, páginas, IDs e atributos originais são preservados, exceto bytes de highlightImage (somente indicador de presença, sem base64 no banco). Data de publicação vem de `pubDate`, não da data do ato. O dicionário menciona DOU1; a amostra usa DO1, respeitado pelo parser. Sem HTML oficial observado, `officialHtmlUrl=null`; nenhuma URL com slug é fabricada.

Identidade externa das matérias-fonte é composta pelos campos observados `data:seção:edição:idMateria`, com ID original preservado em metadata. Classificação CONFAZ exige órgão explícito e cabeçalho apropriado. Há uma exceção comprovada pelo XML oficial: o CONFAZ publica lotes de **Convênios ICMS, Ajustes SINIEF e Protocolos ICMS dentro de um DESPACHO agregador**. Nesses casos, o Despacho original é preservado e cada cabeçalho explícito, completo, datado e em caixa alta gera uma publicação filha normativa com `sourceRole=PRIMARY`, mesma página certificada e identidade forte por família/número/ano/data de publicação. Referências incidentais no corpo continuam sem gerar publicação filha. Isso permite deduplicação posterior com o portal CONFAZ.

## Evidência dos arquivos completos

| Arquivo | Bytes ZIP | XML | Mídias | Matérias reunidas | Falhas de parsing | Matérias CONFAZ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-09-18-DO1.zip | 2.409.302 | 358 | 6 | 351 | 0 | 0 |
| 2026-09-18-DO1E.zip | 52.506 | 14 | 0 | 12 | 0 | 0 |

As 363 matérias produziram 363 hashes de identidade distintos. Medição local de leitura/parsing/normalização: aproximadamente 342 ms normal e 13 ms extra; não inclui rede nem PostgreSQL e não dimensiona produção.
Normal: cerca de 4 MB descomprimidos; extra: 184.195 bytes. O volume PostgreSQL observado no Railway era 500 MB configurados, não espaço livre medido. Não extrapolar uma única data para backfill.

Fixtures versionadas: 12 XMLs originais, bytes e hashes preservados, representando dez matérias (incluindo três despachos da Fazenda na mesma página e uma portaria em três partes). Testes também têm alterações sintéticas identificadas para versionamento e cabeçalhos sintéticos CONFAZ.

### Gate CONFAZ live — concluído

A validação autenticada no Railway comprovou primeiro Despachos, Atos COTEPE/ICMS, atos declaratórios e retificações em 10/09, 14/09 e 15/09/2026. A investigação de julho revelou a estrutura oficial dos lotes agregados:

- **06/07/2026 — Protocolo ICMS:** o `DESPACHO Nº 27, DE 2 DE JULHO DE 2026` contém cabeçalhos explícitos como `PROTOCOLO ICMS Nº 53/2026`, `54/2026`, `55/2026` e seguintes;
- **08/07/2026 — Convênio ICMS:** o `DESPACHO Nº 28, DE 7 DE JULHO DE 2026` contém `CONVÊNIO ICMS Nº 63/2026`, `64/2026`, `65/2026` e seguintes;
- **09/07/2026 — Ajuste SINIEF:** o `DESPACHO Nº 30, DE 8 DE JULHO DE 2026` contém `AJUSTE SINIEF Nº 17/2026`, `18/2026`, `19/2026` e seguintes.

Após implementar a extração de atos embutidos e corrigir o tratamento de títulos de continuação, a execução live final autenticou na primeira tentativa e terminou com **zero falhas de parsing** nos três ZIPs. O resumo do gate foi: **36 ocorrências de Protocolo ICMS, 25 de Convênio ICMS e 12 de Ajuste SINIEF, `gatePassed=true`**. Os filhos normativos possuem título, família, número/ano, data de publicação no DOU, texto isolado, página certificada e vínculo com o Despacho pai.

Durante a frente, o INLABS também oscilou com HTTP 502. O cliente classificou corretamente o evento como `INLABS_UNAVAILABLE / SOURCE_UNAVAILABLE / retryable=true`; não foi confundido com credencial inválida nem com ausência de publicação.

Na ativação produtiva de 21/09/2026, o serviço alternou entre tela oficial de manutenção, HTTP 502, login manual válido e `INLABS_SESSION_REDIRECT`. Como os scripts oficiais usam `requests.Session()`/`curl -L`, o cliente foi endurecido para seguir **apenas redirects autenticados same-origin**, com no máximo 3 hops e sem encaminhar cookie para outro domínio.
### Validação live Railway — DOU completo em 2026-09-18

Serviço temporário isolado `inlabs-validation`, branch `feat/dou-inlabs`, sem Scheduler e sem persistência PostgreSQL. Credenciais referenciadas a partir do Worker, sem exposição em logs. Login autenticado e índice diário foram aceitos; o índice retornou 12.418 bytes.

| Seção | ZIP bytes | XML | Mídias | Matérias | Falhas | Matérias com candidato textual a CNPJ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| DO1 | 2.409.302 | 358 | 6 | 351 | 0 | 125 |
| DO1E | 52.506 | 14 | 0 | 12 | 0 | 0 |
| DO2 | 975.740 | 760 | 0 | 760 | 0 | 5 |
| DO2E | 3.137 | 3 | 0 | 3 | 0 | 0 |
| DO3 | 2.819.018 | 2.143 | 2 | 2.139 | 0 | 999 |
| DO3E | 1.292 | 1 | 0 | 1 | 0 | 0 |

Total live: **3.266 matérias**, **0 falhas de parsing** e **1.129 matérias com candidato textual a CNPJ**. O contador de CNPJ nesta validação é apenas evidência exploratória do valor das Seções 2/3; ainda não é o Motor de Relevância nem um vínculo confirmado com tenant. A DO3 sozinha concentrou 999 candidatos, comprovando que limitar a ingestão à Seção 1 perderia grande parte das citações empresariais oficiais.

## Necessidade comprovada da migration 010

Os três XMLs `600_20260918_24382325`, `24382380` e `24382412` têm `idMateria` diferentes e apontam à mesma página 1 da edição 177-A. A unicidade antiga `(source_id, official_url)` rejeitaria matérias distintas. A edição normal também tem múltiplas matérias por página.

A 010 mantém unicidade de URL para origens de documento; referências explicitamente marcadas `officialUrlGranularity=PAGE` exigem external_id não vazio e usam a unicidade existente de `(source_id, external_id)`. Há índice não único para consulta por página. A persistência acompanha essa distinção e continua rejeitando um external_id ligado a outra identidade. Não há mudança nos hashes nem nas migrations antigas.

**Não aplicada em produção.** Implantação deve aplicar 010 antes de habilitar DOU. O runner usa transação, mas o rebuild de índice exige janela compatível com o volume real. Rollback após gravar várias origens na mesma página não pode simplesmente restaurar o índice único antigo: exige análise dos dados, sem apagar matérias para satisfazer o índice. Desativar o conector primeiro é a contenção reversível.

## Integração, incremental e recuperação

Registry registra `dou` somente com `DOU_CONNECTOR_ENABLED=true`; permanece desligado por padrão. `INLABS_EMAIL` e `INLABS_PASSWORD` vêm de secrets do Worker. Foi adicionado `db:ensure-dou-source`, que recusa ativação se a flag ou as credenciais não estiverem presentes e cria/atualiza a fonte `dou`. Após o gate operacional, a agenda aprovada passou a ser **4x/dia**: `0 8,12,16,20 * * *`, timezone `America/Sao_Paulo`. A fonte produtiva foi provisionada e o conector habilitado no Worker; a recorrência só é considerada liberada após uma coleta produtiva saudável.

Política de execução 4x/dia em America/Sao_Paulo: dia corrente e dois anteriores, mais uma data rotativa do mês corrente/anterior. Com cobertura integral do DOU, o teto passa a quatro datas e até 24 ZIPs por tentativa (seis seções/edições por data). A reconciliação é limitada e precisa de medição de cobertura; não é garantia de completude mensal. Intervalo desde último sucesso acima de 60 dias exige recuperação explícita (`DOU_BACKFILL_REQUIRED`). Nenhuma indisponibilidade dispara coleta de todo histórico.

SHA-256 do pacote permite evitar parsing de ZIP inalterado, mas o download ainda ocorre; validators HTTP não foram comprovados. Hash do ZIP fica só em metadata, não no content_hash de todas as matérias. Os hashes individuais XML também ficam preservados. Alteração de uma matéria não deve criar versões das outras.

Recibos das **seis variantes** ficam em `collection_attempts.metadata.douArchives`, retidos por 65 dias e aceitos somente de runs terminais SUCCESS/SUCCESS_NO_RESULTS com attempt SUCCESS. O reload aceita `DO[123]E?`; uma regressão PostgreSQL impede que DO2/DO3 sejam reprocessados por perda de checkpoint. Attempt SUCCESS sozinho ocorre antes da persistência e não é checkpoint. Falha parcial não avança recibos; próxima execução repete idempotentemente. Falha HTTP após outro pacote válido descarta o lote da tentativa e deixa retry com o Motor. A mudança no heartbeat mantém o timer durante persistência e fechamento do run; o comportamento preexistente de perda de ownership não foi redesenhado.

Nenhum pacote disponível gera erro explícito, retryable, `INLABS_EDITIONS_NOT_AVAILABLE`. Não é prova de dia vazio. Download 404 exige consulta do índice; validação estrutural positiva do índice autenticado ainda precisa ser conferida com HTML real. Parser inválido gera erro por matéria, com código e filename em metadata. Manutenção é distinguida de autenticação, WAF, rede, rate-limit, timeout e edição ausente. Um lote sem CONFAZ continua sendo sucesso de ingestão genérica, com contador CONFAZ zero.

BACKFILL produtivo é rejeitado sem lote explícito. A classe aceita até quatro datas injetadas para testes/validação controlada; o registry produtivo não expõe essa opção. Falta fechar interface de execução administrativa por run, sem alterar a configuração compartilhada da fonte. Antes de ampliá-la, medir duração, memória, crescimento do banco/storage e impacto Railway.

## Cobertura integral do DOU e citações empresariais

Decisão de escopo em 2026-09-21: a ingestão não ficará limitada à Seção 1. O Radar Fiscal deve poder detectar menções oficiais relacionadas a empresas/clientes, incluindo ocorrências por CNPJ, razão social e filiais. Por isso o conector passa a ingerir também Seções 2 e 3, normais e extras, preservando o conteúdo global uma única vez.

A classificação de uso fica separada da coleta: DO1/DO1E permanecem prioritários para legislação e atos normativos; DO3/DO3E são particularmente relevantes para contratos, editais, avisos, sanções e outras citações individualizadas; DO2/DO2E também são preservados para cobertura oficial completa. Nenhuma seção é descartada por parecer pouco tributária durante a ingestão.

O cruzamento por cliente será uma camada posterior, sem duplicar publicações: CNPJ completo, CNPJ normalizado, raiz quando aplicável, razão social e demais identificadores empresariais poderão gerar vínculos tenant-publication com o trecho comprobatório e uma classificação como benefício, credenciamento, multa/penalidade, sanção, contrato, licitação, decisão ou outra menção. A classificação não deve inventar vínculo quando o texto não o sustentar.

## Monitoramento

O snapshot existente expõe estado, última coleta, contagens de publicações/versões/falhas/retries e agora campos opcionais DOU: XMLs, matérias reunidas, edições, matérias CONFAZ e falhas de parsing. Estado de cada pacote (PARSED/UNCHANGED/NOT_AVAILABLE/PARTIAL), hashes, páginas e detalhes por falha ficam na tentativa. `UNCHANGED` indica que nenhuma matéria foi novamente processada; contador zero não significa edição vazia. Não há nova Central visual nesta frente.

## Validação e limite de aceitação

O head funcional final anterior à limpeza passou CI completo no GitHub Actions. A execução #108 registrou **83 testes unitários + 39 testes de integração/regressão = 122 execuções, 0 falhas**, cobrindo typecheck, build, parser, INLABS, collection engine, PostgreSQL, autenticação/RLS, deduplicação, versionamento, heartbeat e precedência de fontes. Commits posteriores adicionaram regressões para checkpoints das seis variantes, enriquecimento de vigência e provisionamento seguro; cada alteração é novamente validada pelo CI antes do merge.

Railway: `INLABS_EMAIL` e `INLABS_PASSWORD` estão ativos no `radar-fiscal-worker`. O Worker produtivo continua em `main` e o conector DOU segue desabilitado por padrão. O serviço temporário `inlabs-validation` foi usado apenas para testes live, sem Scheduler e sem persistência PostgreSQL; sua remoção foi staged após a conclusão do gate.

### Precedência DOU × portais

- DOU/INLABS: `sourceRole=PRIMARY`;
- portal CONFAZ: `sourceRole=ENRICHMENT`;
- enriquecimento com conteúdo diferente pode ser preservado como versão não corrente, mas não substitui a versão corrente nem `primary_official_url` do DOU;
- se o DOU chegar depois de uma origem de enriquecimento, o PRIMARY assume a versão corrente;
- um enriquecimento pode preencher `effective_on` somente quando a vigência canônica estiver ausente; não apaga nem substitui uma vigência explícita do PRIMARY;
- regressões PostgreSQL cobrem a regra.
## Decisões fechadas e follow-ups

1. **Originais — fechado para o MVP:** o conector não grava ZIP/PDF/binários no PostgreSQL. Conteúdo normalizado, URL oficial, identificadores e SHA-256 do pacote/XML são preservados. A tabela `publication_files` permanece como contrato para futura camada compartilhada de object storage.
2. **PRIMARY/ENRICHMENT — fechado:** DOU/INLABS é PRIMARY e portais dos órgãos são ENRICHMENT/VALIDATION. Conteúdo do portal não derruba a versão primária; vigência ausente pode ser enriquecida de forma conservadora.
3. **Recuperação — fechado para o MVP:** execução 4x/dia (08h, 12h, 16h, 20h) com dia corrente + dois anteriores + uma data antiga rotativa; no máximo quatro datas e seis variantes por data. A fonte DOU mantém uma única run ativa; falhas retryable de INLABS são repetidas a cada **10 segundos até sucesso**. O Scheduler não cria outra run DOU enquanto existir uma run `PENDING/RUNNING`. Erros não-retryable continuam encerrando a run para não mascarar credencial inválida ou defeito de processamento. Gaps acima de 60 dias exigem backfill administrativo explícito.
4. **Suplementos — follow-up de cobertura:** o serviço certificado do DOU admite edições suplementares, mas os scripts de automação oficiais do INLABS consultados documentam somente `DO1/DO1E`, `DO2/DO2E` e `DO3/DO3E`. Não foi encontrada convenção XML separada comprovada; portanto o conector **não inventa `DO1S`**. A cobertura desta frente é “todas as variantes XML documentadas pelo INLABS”, não uma promessa de captura de uma eventual variante suplementar não documentada.
5. **Gate CONFAZ — fechado:** Protocolo ICMS, Convênio ICMS, Ajuste SINIEF e Ato COTEPE/ICMS foram comprovados com XML real; atos agregados em Despachos são desmembrados sem perder o Despacho pai.
6. **Citações empresariais — base de ingestão fechada:** DO1/DO1E/DO2/DO2E/DO3/DO3E são preservados globalmente. O match CNPJ/razão social/classificação de benefício, multa, contrato, sanção etc. pertence ao Motor de Relevância e não é implementado neste conector.
7. **Ativação produtiva — controlada após merge:** aplicar migration 010, manter secrets no Worker, definir `DOU_CONNECTOR_ENABLED=true`, executar `db:ensure-dou-source` e observar a primeira coleta/monitoramento. Até isso ocorrer, merge do PR é seguro porque o registry não registra DOU por padrão.

### Critério de conclusão da frente

A frente DOU/INLABS é considerada tecnicamente concluída quando o PR final estiver com CI verde e mergeado. A ativação produtiva é um passo operacional separado e reversível, deliberadamente mantido fora do merge para evitar começar coletas antes da migration 010 e da decisão do Gerente Geral.

## Correção 2026-09-30: datas sem edição e matérias sem título

Governança: tribusca-control Issue #35.

**Datas sem edição (HTML 200).** Em produção, no domingo 2026-09-27, todos os seis pacotes da data responderam HTTP 200 com a mesma página `text/html` de 38.679 bytes, em vez de 404. Desde a PR #80 isso era isolado como `INLABS_INVALID_DOWNLOAD` (partial failure), o que deixava a run DOU `PARTIAL_SUCCESS` em todo fim de semana. Agora, diante de uma resposta HTML 200 no lugar de um pacote, o cliente consulta o **índice diário autenticado** (`index.php?p=<data>`, lido uma vez por data e tentativa):

- se o índice **não lista** o arquivo → `NOT_AVAILABLE` com `evidence: 'NOT_IN_DAILY_INDEX'`;
- se o índice **lista** o arquivo → continua `INLABS_INVALID_DOWNLOAD` (falha real de download, retentada);
- login/sessão expirada, manutenção e WAF, tanto no pacote quanto no índice, continuam falhando a tentativa.

Ausência nunca gera receipt: a próxima run pergunta de novo, então uma classificação errada se corrige sozinha dentro da janela de reconciliação. O `archives[]` registra `evidence`, a forma da resposta (`contentType`, `byteLength`, `magicHex`, `bodyKind`), `indexListsArchives` e `pageTitle` — o `<title>` da página, sem marcação, com e-mails mascarados e no máximo 120 caracteres. O corpo nunca é registrado. 404 continua revalidando a sessão pelo índice (`evidence: 'HTTP_404'`).

**Matéria sem título.** Uma matéria oficial com `<Identifica>` vazio era descartada (`DOU_MISSING_TITLE`). Agora recebe título descritivo formado pelos próprios atributos oficiais (`artType - unidade`), com `metadata.dou.titleFallback = 'ART_TYPE_AND_UNIT'`. O título de reserva não entra na classificação: nenhum número de ato ou identidade normativa é inferido; a identidade permanece a da matéria oficial (`SOURCE_SCOPED`).

**Agenda.** Pela D-056 a fonte `dou` passa a `0 6,10,14,18 * * *` (`America/Sao_Paulo`); ver `docs/collection-schedules.md`.

## Backfill administrativo (2026-10-05)

Governança: tribusca-control Issue #35. Fecha a pendência "interface de execução administrativa por run" (seção *Integração, incremental e recuperação*).

**Motivo.** O monitoramento consulta hoje, os dois dias anteriores e **uma** data antiga rotativa por run. Datas anteriores à ativação da fonte (~18/09/2026), e as perdidas enquanto a fonte ficou bloqueada antes da PR #80, só entravam quando a rotação as sorteava: milhares de atos de setembro chegando "hoje", em dias sem DOU.

**Execução.** `npm run db:dou-backfill -- [--from=AAAA-MM-DD] [--to=AAAA-MM-DD] [--apply]`
- Sem `--apply`: só imprime `DOU_BACKFILL_PLAN=` com as datas faltantes, da mais recente para a mais antiga, e os lotes.
- Padrão: do primeiro dia do mês anterior até hoje − 3 (horário de Brasília). Datas da janela de monitoramento (hoje, −1 e −2) nunca entram.
- **Datas faltantes**: as sem receipt no checkpoint do monitoramento e não consultadas por inteiro (6 pacotes) por um backfill bem-sucedido. Uma data sem edição fica coberta depois de checada uma vez.
- Com `--apply`: cada lote de até 4 datas é uma run `trigger_type = BACKFILL`, executada pelo **motor normal**, com a mesma persistência, `publication_origins` e regras de identidade. Logs `DOU_BACKFILL_RUN=` por lote e `DOU_BACKFILL_SUMMARY=` no fim.

**Garantias.**
- **Prioridade do monitoramento:**
  - não inicia lote se a fonte tem run aberta;
  - não inicia lote se um ciclo agendado do DOU cai nos próximos `--guard-minutes` (padrão 20). Nesse caso imprime `DOU_BACKFILL_PAUSED` e encerra; basta rodar de novo depois.
  - A criação da run usa o mesmo `LOCK TABLE collection_runs IN SHARE ROW EXCLUSIVE MODE` da pausa operacional, contra corrida com o Scheduler.
- **Posse da run:** a run nasce `RUNNING` e pertence ao script. Entre tentativas o script a retoma antes que o worker possa adquiri-la. Se o worker pegasse uma run BACKFILL, ela falharia fechada (`DOU_BACKFILL_DATE_BATCH_REQUIRED`).
- **Retries limitados:** falhas transitórias do INLABS são repetidas pelo motor, até 8 tentativas por lote. Atingido o limite, a run fecha como `SOURCE_UNAVAILABLE` (`DOU_BACKFILL_RETRY_LIMIT`) e o script para.
- **Lote sem edição:** um lote só de datas sem edição termina `SUCCESS_NO_RESULTS`. Isso vale só no backfill (`allowEmptyBatch`); o monitoramento continua tratando ausência total como disponibilidade pendente.
- **Checkpoint:** runs BACKFILL não alimentam o checkpoint do monitoramento (`readDouSourceState` as ignora).
- **Data das publicações:** recebem `published_on` = data oficial do DOU, não a data da coleta.

**Modo horário no Worker (D-056).** Com `DOU_BACKFILL_FROM=AAAA-MM-DD` no Worker, a mesma lógica roda sozinha. A cada intervalo (`DOU_BACKFILL_INTERVAL_MS`, padrão 1 h), uma run BACKFILL busca a próxima data faltante, recuando `DOU_BACKFILL_DATES_PER_RUN` dia(s) por consulta (padrão 1, máximo 4).
- Só roda com o Worker ocioso, sem run aberta do DOU e fora dos 20 min anteriores a um ciclo.
- O intervalo é verificado no banco, sob o lock da tabela, então várias réplicas do Worker não duplicam a consulta.
- Quando não resta data faltante em `[DOU_BACKFILL_FROM, hoje − 3]`, o Worker registra `DOU backfill complete; DOU_BACKFILL_FROM can be removed` e para de consultar. Basta então remover a variável.
- Logs: `DOU backfill batch completed` (runId, datas, status, métricas, `remainingDates`) e `DOU backfill tick failed`.

**Operação (R3).** Primeiro o dry-run, depois `--apply` logo após um ciclo do DOU (ex.: 06h20, 10h20 de Brasília), registrando as saídas na Issue. Para recuar além do mês anterior, `--from` explícito e decisão do responsável sobre o alcance (D-056: acervo oficial disponível).


## Correção 2026-10-05 — escopo DOU 1/3, cobertura e triagem de contratos

Governança: tribusca-control Issue #72.

Por decisão de produto, a política operacional do DOU passa a coletar somente `DO1`, `DO1E`, `DO3` e `DO3E`. `DO2` e `DO2E` permanecem apenas como evidência histórica em runs/receipts antigos; não são baixados, não são seções esperadas e não podem produzir falha, retry ou pendência nova.

A mesma constante `DOU_XML_SECTIONS` define download e cobertura do backfill. Receipt é apenas evidência de hash para evitar reparse; cobertura de data exige prova de consulta das quatro seções habilitadas em estado terminal `PARSED`, `UNCHANGED`, `NOT_AVAILABLE` ou `PARTIAL`. Um receipt isolado não torna a data completa. Metadados históricos com as seis seções continuam válidos quando as quatro atuais estão comprovadas; legado sem `dou.archives` suficiente é reconsultado conservadoramente, reaproveitando hashes existentes.

O teto operacional de um lote de quatro datas cai de 24 para 16 downloads de ZIP por tentativa. A string de cobertura passa a `DOU_SECTIONS_1_3_NORMAL_AND_EXTRA`.

`EXTRATO DE CONTRATO` não é descartado por rótulo. A regra determinística `dou-scope-v1` classifica a matéria completa após o parser. Sinais tributários, regulatórios/concessão ou eventos empresariais relevantes têm precedência; caso ambíguo permanece no acervo. Somente contratação administrativa rotineira comprovada por estrutura de contratação e allowlist estreita do objeto recebe `IGNORE`. CNPJ isolado, referência à Lei 14.133, órgão emissor ou boilerplate como “fiscal do contrato” não autorizam exclusão por si sós.

Ignorados não persistem conteúdo integral. A tentativa registra versão da regra, contagem por categoria e até 100 referências mínimas (externalId/URL/tipo/motivos) para auditoria. Mudanças futuras da regra exigem nova versão e estratégia explícita de replay; receipt `UNCHANGED` comprova bytes, não que uma nova política tenha sido aplicada.
