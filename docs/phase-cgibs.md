# Fase CGIBS — Conector oficial do Comitê Gestor do IBS

## Decisão arquitetural

O portal oficial do CGIBS é uma fonte federal independente do Tribusca.

- Base oficial: `https://www.cgibs.gov.br/`
- Conector: `cgibs`
- Esfera: `FEDERAL`
- Órgão: `CGIBS`
- Scheduler durante implantação: desligado (`schedule_cron = NULL`)
- Frequência-alvo após gates produtivos: `0 * * * *`
- Timezone: `America/Sao_Paulo`
- Migration específica: **não necessária**

O conector reutiliza `publications`, `publication_versions`,
`publication_origins`, `collection_runs`, `collection_attempts`,
`collection_items` e `collection_checkpoints`.

## Inspeção da fonte oficial

O site público do CGIBS expõe conteúdo em HTML e artefatos oficiais
diretos em caminhos como `/upload/arquivos/YYYYMM/...`.

Não foi identificada API pública, RSS ou feed oficial que substitua as
páginas HTML para o escopo monitorado. O mapa do site oficial é a
referência estrutural para descoberta das áreas públicas.

Áreas cobertas:

| Área | Papel |
|---|---|
| Resoluções | PRIMARY |
| Portarias | PRIMARY |
| Atos Conjuntos | PRIMARY |
| Atos Técnicos Conjuntos | PRIMARY |
| Comunicados Oficiais | PRIMARY |
| Documentos Técnicos | PRIMARY |
| Regulamentos | ENRICHMENT |
| Guias | ENRICHMENT |
| Cartilhas | ENRICHMENT |
| Notícias operacionais selecionadas | ENRICHMENT |

Documentos técnicos incluem, entre outros, DeRE e Split Payment.
Notícias só entram quando o título indica alteração tributária,
regulamentar ou técnica operacional; notícias institucionais genéricas
não são publicações do conector.

## Containers x documentos

Páginas de categoria são containers e nunca viram publicação por si só.

Uma página individual pode ser publicação quando:
- é um comunicado/orientação oficial sem arquivo; ou
- é notícia operacional relevante sem artefato independente.

Quando uma página contém anexos oficiais, os artefatos são as
publicações documentais capturadas.

## Identidade

Atos formais priorizam:
- órgão;
- tipo;
- número;
- ano;
- data oficial quando disponível.

Documentos técnicos usam chave determinística com:
- família;
- família documental;
- versão oficial;
- ambiente operacional quando aplicável.

`Versão Atual` e `Versões Anteriores` são status/containers e não
fazem parte da família lógica; mover um documento para histórico não
pode criar outra publicação artificialmente.

Não há fuzzy merge.

Se o mesmo ato também aparecer no DOU, a correlação cross-source só
pode ocorrer quando o modelo produzir identidade normativa forte.
Caso contrário as origens permanecem separadas até correlação segura.

## Versionamento

Versões documentais formais distintas permanecem publicações distintas,
por exemplo DeRE v1.1.0 e DeRE v1.2.0.

Se os bytes do arquivo da mesma publicação formal mudarem sem mudar sua
identidade, o SHA-256 altera o `content_hash` e gera uma nova
`publication_version`.

Metadados de crawl, URL de listagem e outras informações voláteis não
entram no `content_hash`.

## Checkpoint

O checkpoint do conector é armazenado exclusivamente em
`collection_checkpoints`.

Para arquivos conhecidos são preservados:
- SHA-256;
- tamanho;
- MIME;
- filename;
- ETag;
- Last-Modified;
- checkedAt.

Replay imediato reutiliza os arquivos conhecidos. Rechecks periódicos
usam `If-None-Match` e `If-Modified-Since` quando disponíveis.

## Gates oficiais para validação live

A validação produtiva deve procurar, sem depender de contagem fixa:

1. Resolução CGIBS nº 6/2026 — Regulamento do IBS;
2. Resolução CGIBS nº 18/2026;
3. pelo menos uma Portaria CGIBS;
4. Ato Conjunto RFB/CGIBS nº 6/2026;
5. Ato Técnico Conjunto RFB/CGIBS de 2026;
6. DeRE v1.2.0 — leiautes e XSD;
7. Nota Orientativa DeRE 2026.001;
8. Split Payment — Manual/integração atual;
9. Split Payment — OpenAPI v1.1.0;
10. pelo menos um artefato com SHA-256 válido.

A contagem absoluta não é gate permanente porque a fonte é viva.

## Gates para ativação horária

A agenda `0 * * * *` só pode ser ativada depois de:

1. CI determinística verde;
2. validação live da fonte oficial;
3. bootstrap controlado no PostgreSQL produtivo;
4. inspeção de publicações, origens, arquivos e hashes;
5. replay produtivo com zero novas publicações e zero versões artificiais;
6. checkpoint confirmado;
7. timeout operacional medido;
8. uma execução real do Scheduler validada;
9. overlap protection confirmada.


## Validação live isolada

O gate externo é executado fora da CI determinística para evitar que
instabilidade da rede pública torne o pipeline flakey.

Comando do serviço de validação isolado no Railway:

`node dist/validation/cgibs-live-validation.js`

O serviço deve apontar para a branch/commit em validação, usar
`restartPolicyType = NEVER` e não precisa de acesso ao PostgreSQL.
Somente logs de um deployment cujo commit corresponda ao head do PR
podem ser usados como evidência do gate live.


## Evidência live — 23/09/2026

Validação isolada no Railway executada contra o commit
`e2aeccd454fad909a58c19169c7fb8bd6a0d62c0`.

Resultado da primeira coleta:

- 12/12 seeds oficiais consultados com sucesso;
- 77 publicações documentais;
- 77 arquivos oficiais baixados;
- 77/77 arquivos com SHA-256 válido;
- 0 falhas parciais;
- famílias emitidas: 18 Resoluções, 10 Portarias, 7 Atos Conjuntos,
  4 Atos Técnicos Conjuntos e 38 Documentos Técnicos;
- Resolução CGIBS nº 6/2026 validada com data de publicação 30/04/2026;
- Resolução CGIBS nº 18/2026 validada com data de publicação 15/09/2026;
- Atos Técnicos Conjuntos 1–4/2026 validados como publicados, sem herdar
  status de nomes internos de arquivos;
- DeRE v1.2.0, XSD v1.2.0, Nota Orientativa 2026.001,
  Split Payment e OpenAPI v1.1.0 validados.

Replay imediato com o checkpoint da primeira coleta:

- 77 publicações reconhecidas;
- `downloadedCount = 0`;
- `newFileDownloadCount = 0`;
- `reusedCheckpointCount = 77`;
- 0 falhas parciais;
- marcador final `CGIBS_LIVE_OK=1`.

O gate também revelou e permitiu corrigir antes do merge dois problemas de
parsing: vazamento de data/status entre atos adjacentes e navegação por
links institucionais/mídia global. Ambos ficaram cobertos por testes de
regressão.


## Fechamento produtivo — 23/09/2026

Após o merge inicial, a validação produtiva revelou duas particularidades
do HTML oficial que foram corrigidas antes do encerramento da frente:

1. a Resolução CGIBS nº 3/2026 aparecia sob o heading ainda ativo da
   Resolução nº 2/2026. O parser passou a preferir o título formal do
   próprio link quando ele representa ato normativo semanticamente
   diferente;
2. Portarias usam, em alguns casos, heading com zero à esquerda
   (`01/2026`) e link sem zero (`1/2026`). A comparação passou a
   considerar os números semanticamente equivalentes, preservando a
   identidade já persistida.

O vínculo incorreto da Resolução nº 3 criado no primeiro bootstrap foi
reparado de forma cirúrgica com dry-run e precondições transacionais.
Após o reparo, a Resolução nº 2 voltou a possuir uma origem e uma versão
correntes corretas, e a Resolução nº 3 foi recriada sob identidade
própria no replay subsequente.

Estado final do banco:

- 77 publicações CGIBS;
- 77 `publication_versions`;
- 77 versões correntes;
- 0 versões históricas artificiais;
- 77 arquivos;
- 77/77 SHA-256 válidos;
- 0 origens duplicadas;
- 0 publicações CGIBS com múltiplas origens internas inesperadas;
- 18 Resoluções;
- 10 Portarias;
- 7 Atos Conjuntos;
- 4 Atos Técnicos Conjuntos;
- 38 Documentos Técnicos.

Replay produtivo limpo:

- 77 encontradas;
- 77 processadas;
- 77 existentes;
- 0 novas publicações;
- 0 novas versões;
- 0 erros de item;
- 0 falhas parciais;
- 77 checkpoints reutilizados;
- 0 downloads novos;
- duração observada: aproximadamente 16,2 s.

Execução real do Scheduler:

- run: `b90513c9-dad1-4b2f-9499-20239914d704`;
- `trigger_type = SCHEDULED`;
- `scheduled_for = 2026-09-23T23:00:00Z`;
- status: `SUCCESS`;
- 77 encontradas / 77 processadas / 77 existentes;
- 0 novas publicações;
- 0 novas versões;
- 0 erros;
- 0 falhas parciais;
- duração da tentativa: aproximadamente 13,8 s.

Configuração operacional final:

- `schedule_cron = 0 * * * *`;
- timezone: `America/Sao_Paulo`;
- Worker `COLLECTION_TIMEOUT_MS = 180000` (3 minutos);
- timeout confirmado no log de inicialização do Worker;
- proteção contra overlap habilitada explicitamente para `cgibs` no
  Scheduler e coberta pelo teste de integração existente.

Com esses gates, o conector CGIBS está apto para operação horária.
