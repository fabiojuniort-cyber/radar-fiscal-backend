# Fase 4 — Conector oficial CONFAZ

Data de implementação: 2026-09-19.

## Objetivo

Primeiro conector governamental real do Radar Fiscal, adaptado ao contrato genérico do Motor de Coleta da Fase 3. A coleta é global e não possui vínculo com tenant/empresa.

## Fonte oficial

Origem primária: `https://www.confaz.fazenda.gov.br`.

O portal oficial organiza os principais atos em índices anuais HTML e páginas individuais. Não foi identificado, para estas famílias normativas, feed/API pública oficial estruturada e estável superior aos índices HTML.

Famílias cobertas no MVP:

- Convênios ICMS: `/legislacao/convenios/{ano}/{ano}`;
- Ajustes SINIEF: `/legislacao/ajustes/{ano}/{ano}`;
- Atos COTEPE/ICMS: `/legislacao/atos/{ano}/{ano}`;
- Protocolos ICMS: `/legislacao/protocolos/{ano}/{ano}`.

Retificações, republicações e versões explicitamente separadas pelo CONFAZ são tratadas como documentos de origem distintos, sem colapsá-las silenciosamente no ato original.

## Contrato e persistência

O conector implementa `CollectionConnector` e retorna `ConnectorPublication`. Ele não grava publicações diretamente.

Fluxo:

CONFAZ -> ConfazConnector -> ConnectorPublication -> CollectionEngine -> normalização -> deduplicação/versionamento -> publicação global.

O Motor de Coleta continua responsável por:

- `identity_hash`;
- `content_hash`;
- origins;
- versões;
- arquivos;
- collection runs/attempts/items;
- retry/backoff/timeout;
- métricas operacionais.

Nenhuma migration foi criada ou alterada. As migrations 001–009 permanecem intactas.

## Identidade

Para atos com identidade normativa completa, o normalizador existente produz identidade forte a partir do escopo, órgão, tipo de ato, número e data de publicação.

O conector normaliza o número para `numero/ano-completo` (por exemplo, `45/2026`).

Retificação/republicação recebe tipo de ato distinto, preservando a semântica da publicação oficial.

Quando a página oficial não expõe todos os elementos exigidos pela identidade forte, o fallback conservador do Motor usa `externalId`/URL oficial source-scoped.

## Parsing

Campos coletados quando presentes:

- órgão = CONFAZ;
- esfera = FEDERAL;
- tipo de ato;
- número/ano;
- ementa/título;
- data do ato em metadata;
- data de publicação no DOU;
- data de vigência/efeitos quando explicitamente interpretável;
- texto integral da página normativa;
- URL oficial;
- externalId baseado no path oficial;
- referência ao DOU/Despacho;
- ratificação nacional;
- menções explícitas de UFs;
- links oficiais relacionados;
- anexos/arquivos oficiais.

O parser não inventa datas/UFs/impactos ausentes.

## Incremental

Por padrão:

- durante janeiro/fevereiro, consulta ano corrente e anterior;
- nos demais meses, consulta ano corrente;
- busca os índices das quatro famílias;
- usa `publication_origins` já persistidos como estado observado;
- no bootstrap, limita atos normais recentes por família, mantendo variantes especiais;
- após o bootstrap, usa o maior número oficial já observado como high-water mark;
- mantém pequena janela recente para capturar publicação fora de ordem;
- revisita atos conhecidos de forma limitada para detectar alteração de conteúdo.

Opcionalmente, `sources.connector_config.confaz.incrementalBaselines` pode definir baseline explícito por família/ano e `incrementalYears` pode restringir anos em operações controladas.

## Backfill

Backfill é operacionalmente separado da rotina incremental.

Estratégia recomendada:

1. executar por ano/faixa controlada;
2. usar `trigger_type=BACKFILL`;
3. configurar temporariamente `incrementalYears` e baselines adequados;
4. limitar concorrência e respeitar o rate limit;
5. observar runs/attempts/métricas antes de avançar ao próximo lote;
6. restaurar a configuração incremental ao final.

Não executar varredura histórica total de uma só vez em produção.

## Respeito à fonte

- User-Agent identificável do Radar Fiscal;
- requisições sequenciais com espaçamento padrão de 250 ms;
- timeout/cancelamento herdados do executor;
- retry moderado herdado do Motor;
- suporte a Retry-After;
- 429, 5xx e indisponibilidade classificados adequadamente;
- encoding UTF-8, ISO-8859-1/Windows-1252 tratado;
- apenas links do host oficial são aceitos para documentos/anexos.

## Provisionamento da fonte

`npm run db:ensure-confaz-source` cria/atualiza idempotentemente o registro global CONFAZ em `sources`, sem migration e sem alterar `connector_config` já customizado.

Configuração operacional inicial:

- connector_key: `confaz`;
- jurisdição: FEDERAL;
- timezone: America/Sao_Paulo;
- max_attempts: 3;
- agenda: minuto 35 de cada hora.

## Limitações conhecidas

- HTML do portal é a interface oficial disponível usada pelo MVP e pode sofrer mudanças de layout;
- datas de vigência com regras jurídicas complexas não são inferidas além de padrões textuais explícitos;
- menções de UF representam menções textuais explícitas, não análise jurídica de aplicabilidade;
- arquivos são descobertos e entregues ao mecanismo existente; download/storage continua sob a infraestrutura genérica já prevista;
- o backfill histórico completo não é executado automaticamente pela rotina incremental.


## Validação real de produção — 2026-09-19

A implementação e o contrato foram validados em CI e no runtime Railway, porém a captura real em produção ficou bloqueada por conectividade de saída entre o Railway e o host oficial do CONFAZ.

Evidências observadas:

- Scheduler cria runs reais para a fonte `confaz`;
- Worker adquire as runs e inicia attempts normalmente;
- retry/backoff e limite de 3 attempts funcionam;
- as falhas são persistidas como `SOURCE_UNAVAILABLE`;
- a causa de baixo nível foi preservada nos logs: `UND_ERR_CONNECT_TIMEOUT` ao conectar em `www.confaz.fazenda.gov.br:443`, antes de qualquer resposta HTTP;
- o mesmo comportamento foi reproduzido em três regiões Railway: SFO (US West), IAD (US East) e AMS (EU West);
- o portal oficial estava acessível externamente durante a mesma janela de validação;
- por responsabilidade com a fonte, os testes de agenda acelerada foram temporários; a agenda operacional deve permanecer em `35 * * * *`.

Portanto, esta frente não deve ser declarada integralmente concluída enquanto não houver uma execução real bem-sucedida a partir da infraestrutura de produção, persistência dos registros e validação amostral dos registros persistidos.

### Validação manual do parser

A página oficial do Protocolo ICMS 88/26 foi comparada com o parser e os campos esperados coincidem:

- tipo: `PROTOCOLO ICMS`;
- número normalizado: `88/2026`;
- data do ato: `2026-07-27`;
- publicação no DOU: `2026-07-29`;
- efeitos explícitos: `2026-08-01`;
- UFs explicitamente mencionadas no corpo normativo: RS e SP;
- ementa e texto normativo preservados;
- URL oficial preservada.

### Observação sobre identidade global

O normalizador global atual inclui `publishedOn` na identidade forte, além de esfera, órgão, tipo e número do ato. Para o CONFAZ isso funciona nos casos validados, mas existe um risco arquitetural: se a própria fonte corrigir apenas a data de publicação mantendo o mesmo ato e a mesma origem, o novo `identity_hash` poderá conflitar com o origin já vinculado, em vez de gerar uma nova versão.

Nenhuma alteração foi feita no algoritmo global nesta frente. Esse ponto deve ser avaliado pelo Gerente Geral com evidência adicional de outras fontes antes de qualquer `identity_version` nova.

## Decisões pendentes para o Gerente Geral

1. Definir a estratégia de egress para fontes oficiais que não aceitem a rota padrão do Railway. Railway oferece Static Outbound IPs para planos compatíveis, mas habilitar isso não garante por si só que o CONFAZ aceite o endereço; eventual allowlisting dependeria da fonte.
2. Se Static Outbound IP não resolver, decidir se será permitido um egress proxy/gateway com IP estável ou um worker de coleta em outro provedor. Isso altera a infraestrutura e não deve ser introduzido silenciosamente nesta frente.
3. Manter o algoritmo global de identidade como está até haver evidência concreta suficiente para decidir se `publishedOn` deve permanecer na identidade forte ou migrar para outra `identity_version`.

## ADRs

Nenhum novo ADR foi criado. A implementação reutiliza a arquitetura existente. Os dois pontos acima são decisões pendentes, não decisões arquiteturais já aprovadas.


## Análise específica de identity_hash — evidência oficial

Em 2026-09-19 foi analisado o comportamento editorial real do CONFAZ para atos corrigidos.

Caso oficial: Convênio ICMS 73/25.

A página oficial do ato registra simultaneamente:

- ato: Convênio ICMS nº 73, de 4 de julho de 2025;
- publicação original no DOU: 08.07.2025;
- ratificação nacional: 25.07.2025;
- retificação publicada no DOU: 11.07.2025;
- seção própria de RETIFICAÇÃO com a correção textual do mesmo ato.

Conclusão operacional para o modelo atual:

- o CONFAZ preserva a data original de publicação do ato;
- a retificação possui sua própria data de publicação/evento;
- o ato original não teve o campo de publicação original substituído pela data da retificação;
- o conector já distingue retificação como documento de origem/actType próprio quando ela aparece como item separado no índice;
- no caso validado, `publishedOn` mostrou-se estável para a identidade do ato original.

Também foram observados no índice oficial de 2025 múltiplos atos com entradas de retificação separadas, incluindo Convênios 73/25, 92/25, 135/25, 143/25, 176/25 e 172/25, e no índice de 2026 o Convênio 96/26 possui entrada específica de retificação.

Não foi encontrada, na amostra oficial pesquisada, evidência de que o CONFAZ substitua silenciosamente a data original de publicação do mesmo ato por uma nova data mantendo exatamente a mesma representação documental.

Decisão nesta frente:

- manter o algoritmo global de identidade inalterado;
- não criar nova `identity_version` agora;
- manter o ponto sob observação durante backfill/amostras futuras;
- se surgir caso oficial em que a própria data original seja corrigida sem nova identidade editorial de retificação/republicação, retornar ao Gerente Geral antes de qualquer mudança estrutural.


## Static Outbound IP — resultado controlado em produção

Em 2026-09-20/21 o workspace Railway foi atualizado de Hobby para Pro e o recurso Static Outbound IP foi habilitado exclusivamente no serviço `radar-fiscal-worker`.

Validação executada com deployment diagnóstico temporário e reversível:

- egress observado pelo Worker: `152.55.176.226`;
- requisição de controle para serviço de identificação de IP: sucesso;
- requisição HTTPS única para `https://www.confaz.fazenda.gov.br/`: falha antes de HTTP;
- causa preservada: `UND_ERR_CONNECT_TIMEOUT`;
- detalhe: `Connect Timeout Error (attempted address: www.confaz.fazenda.gov.br:443, timeout: 10000ms)`.

Conclusão: alterar o egress Railway para Static Outbound IP não resolveu a conectividade com o host oficial. O ponto exato de filtragem continua não comprovado; a evidência demonstra apenas que a rota Railway -> CONFAZ permanece indisponível mesmo com o egress estático.

Após o teste, o start command do Worker foi restaurado para `npm run start:worker`; backend e scheduler não foram alterados. O Static Outbound IP permanece habilitado no Worker.

A próxima prova autorizada é um relay/proxy source-specific. Nenhum relay está ativo em produção neste momento.


## Fixie — resultado da POC source-specific

Em 2026-09-21 foi executada uma POC real com Fixie HTTP/HTTPS, plano gratuito Tricycle, região US East, configurado somente no `radar-fiscal-worker` por `CONFAZ_PROXY_URL`.

Diagnóstico isolado:

- `Railway -> Fixie -> api.ipify.org`: sucesso;
- resposta HTTP: `200 OK`;
- latência observada: 348 ms;
- IP de saída observado: `52.5.155.132`, correspondente a um dos IPs do proxy provisionado;
- `Railway -> Fixie -> www.confaz.fazenda.gov.br:443`: timeout após 15.002 ms, sem resposta HTTP.

Também foi executada uma collection run real pelo Motor de Coleta usando o proxy source-specific. O attempt expirou no timeout global de 90 s e foi classificado como `CONNECTOR_TIMEOUT`, confirmando que o relay Fixie não libera a rota até o CONFAZ.

Conclusão:

- credencial e transporte Fixie estão funcionais;
- o bloqueio não é causado por configuração incorreta do proxy no Radar Fiscal;
- um egress US East via Fixie/AWS também não alcança o CONFAZ;
- repetir outro relay US/EU tem baixo valor técnico;
- próxima prova deve usar egress em região brasileira, preferencialmente São Paulo.

Após a POC, o Worker foi restaurado para `main` e `npm run start:worker`. O PR de proxy permanece draft e não foi consolidado em produção.
