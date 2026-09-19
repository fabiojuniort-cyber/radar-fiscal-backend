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
