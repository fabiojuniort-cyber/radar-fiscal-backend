# Fase Receita Federal — Sistema Normas

## Decisão arquitetural aprovada

O Sistema Normas da Receita Federal é a fonte oficial desta frente para:

- descoberta de atos da Receita;
- texto oficial;
- vigência;
- representação consolidada;
- histórico e relações normativas quando expostos pela fonte.

O DOU permanece a origem oficial primária do evento jurídico de publicação
quando o ato for publicado no Diário Oficial. Quando DOU e Sistema Normas
expõem o mesmo ato sob identidade normativa forte, ambos devem apontar para
uma única `publication` por meio de múltiplas `publication_origins`.

Não há fuzzy merge.

Nenhuma migration específica é necessária para o MVP.

## Fonte oficial

Pesquisa:

`https://normas.receita.fazenda.gov.br/sijut2consulta/consulta.action`

A coleta utiliza exclusivamente HTTPS.

O `idAto` fornecido pelo Sistema Normas é preservado como
`publication_origin.externalId`, nunca como identidade normativa global.

## Escopo do MVP

### NORMATIVE

Captura determinística:

- Instrução Normativa;
- Instrução Normativa Conjunta;
- Ato Declaratório Interpretativo;
- Ato Declaratório Normativo;
- Parecer Normativo;
- equivalentes centrais explicitamente suportados.

### INTERPRETATIVE

- Solução de Consulta COSIT;
- Solução de Divergência COSIT.

Classificação pura de mercadorias/NCM fica fora do canal principal.

### OPERATIONAL

- Nota Técnica;
- Nota Técnica Conjunta;
- Ato Técnico Conjunto;
- Norma de Execução;
- Norma de Execução Conjunta;
- ADE central quando passar regras determinísticas.

### PORTARIAS

Portarias centrais tributárias/operacionais podem ser capturadas.
São excluídos objetivamente pessoal, designações, gestão interna,
funcionamento de agência/unidade e outros conteúdos puramente
administrativos.

## Filtro determinístico e auditabilidade

Nenhuma IA participa da decisão de captura.

Cada execução registra:

- `discoveredCount`;
- `includedCount`;
- `excludedCount`;
- `includedByCategory`;
- `excludedByReason`;
- itens excluídos com `idAto`, tipo, número, órgão, data e razão.

Quando o ato pertence a uma família central suportada e não há regra
negativa forte, a estratégia tende à captura, não ao descarte silencioso.

## Identidade

A identidade forte canônica é derivada de:

- órgão emissor normalizado;
- tipo do ato normalizado;
- número sem formatação/zeros irrelevantes;
- ano;
- data oficial de publicação, conforme a identidade forte comum do Motor.

Exemplos conceituais:

- `RFB | INSTRUÇÃO NORMATIVA | 2344/2026`;
- `COSIT | SOLUÇÃO DE CONSULTA | 180/2026`.

Aliases históricos/estruturais da Receita são normalizados
deterministicamente.

O parser DOU reutiliza a mesma canonização somente nas famílias em que
isso não altera a taxonomia histórica já estabilizada. Famílias unitárias
como ADE COANA preservam a taxonomia existente do DOU.

## Cross-source DOU × Sistema Normas

Gate obrigatório:

```text
DOU encontra ato X
+
Sistema Normas encontra o mesmo ato X
=
1 publication
2 publication_origins
0 duplicidade
0 versão artificial quando o original normalizado é equivalente
```

A origem Sistema Normas é PRIMARY para a representação mantida pela
Receita, mas entra no mecanismo de autoridade de versões como
`sourceRole = ENRICHMENT` quando há DOU, de modo que um consolidado ou
espelho diferente não substitua silenciosamente a versão jurídica
primária do DOU.

## Representações

São consultadas, quando disponíveis:

- `original`;
- `vigente`;
- `multivigente`;
- `relacional`.

Metadata esperada:

```text
metadata.rfbNormas.representations.<kind>:
  url
  legacyUrl
  available
  normalizedHash
  lastCheckedAt
  status (quando identificável)
```

Somente o texto original é conteúdo canônico da publicação.

Mudanças em `vigente`, `multivigente` ou `relacional` alteram o
`normalizedHash` informativo em metadata, mas não alteram o
`content_hash` e não criam `publication_version`.

## Arquivos

Anexos oficiais `anexoOutros.action?idArquivoBinario=...` preservam:

- URL oficial;
- idArquivoBinario como externalId do arquivo;
- nome;
- MIME;
- tamanho;
- SHA-256;
- ETag / Last-Modified quando fornecidos;
- horário do último check em checkpoint.

Replay imediato reutiliza o arquivo conhecido; rechecks posteriores usam
validators condicionais quando disponíveis.

## Checkpoint e bootstrap

Checkpoint: `collection_checkpoints`.

Primeiro bootstrap:

- início em janeiro de 2025;
- processamento mensal;
- paginação preservada no cursor;
- time budget respeitado;
- execução pode terminar voluntariamente com
  `TIME_BUDGET_REACHED` e continuar no run seguinte.

Depois do bootstrap:

- janela incremental definida por `RFB_LOOKBACK_DAYS`;
- default inicial: **7 dias**;
- faixa válida: 1–60 dias;
- todas as páginas da janela são percorridas.

A janela só deve ser reduzida depois de evidência produtiva sobre volume,
duração e inclusões tardias.

## Scheduler

Frequência-alvo:

`0 * * * *`

Timezone:

`America/Sao_Paulo`

O conector `rfb-normas` participa da proteção explícita contra overlap
do Scheduler.

O cron permanece nulo até todos os gates produtivos serem concluídos.

## Gates antes da ativação horária

1. CI verde;
2. validação live dos endpoints oficiais;
3. bootstrap 2025 → hoje concluído;
4. inventário e regras de exclusão inspecionados;
5. amostras confrontadas com a Receita;
6. URLs/anexos/SHA-256 validados;
7. gate real DOU × Sistema Normas;
8. replay idempotente;
9. zero publicações e versões artificiais;
10. checkpoint validado;
11. timeout medido;
12. overlap protection validada;
13. somente então ativar `0 * * * *`.


## Evidência live — 23/09/2026

Validação isolada no Railway executada contra o head
`bc6e36a17bc9b9de3d9ac31c4dbe2683350277da`.

Janela incremental real de 7 dias:

- 106 atos descobertos;
- 20 atos incluídos;
- 86 atos excluídos por regra determinística;
- 6 INTERPRETATIVE;
- 9 OPERATIONAL;
- 3 NORMATIVE;
- 2 PORTARIA;
- 0 falhas parciais.

Principais motivos de exclusão observados:

- `ADE_NONCENTRAL`: 57;
- `ADE_LOW_VALUE_CERTIFICATION`: 14;
- `INTERPRETATIVE_NON_COSIT`: 8;
- `PORTARIA_NONCENTRAL`: 6;
- `PORTARIA_ADMINISTRATIVE`: 1.

A SC Cosit nº 180/2026 foi validada diretamente:

- `idAto = 153667`;
- publicação em 23/09/2026;
- PDF oficial `idArquivoBinario = 86539`;
- SHA-256 válido:
  `2d192678c077746ce3b55c5340c82fd8cc80236f71037d86558b8f1cdee276d3`.

A API moderna oficial foi confirmada em:

`https://normasinternet2.receita.fazenda.gov.br/api/consulta-externa/ato/{idAto}/visao/{kind}`

A visão `original` é obrigatória. Algumas famílias não disponibilizam
`vigente`, `multivigente` ou `relacional`. A API sinaliza isso com
HTTP 403/406; nesses casos o conector registra `available=false` e o
status HTTP em metadata, sem transformar ausência oficial esperada em
falha parcial.

Exemplo confirmado: Edital de Transação PGFN/RFB nº 5/2026
(`idAto=153623`) possui apenas visão original; vigente e multivigente
retornam 406 com mensagem oficial de visão indisponível, e relacional
retorna 403.

Marcador final da validação:

`RFB_NORMAS_LIVE_OK=1`.


## Checkpoint operacional — 24/09/2026

Checkpoint salvo durante a validação produtiva final da frente Receita Federal / Sistema Normas.

### Estado já concluído

- implementação principal mergeada na `main` pelo PR #48;
- correções produtivas adicionais mergeadas até o PR #57;
- fonte produtiva `rfb-normas` ativa;
- `RFB_LOOKBACK_DAYS = 7`;
- bootstrap 2025-01 → 2026-09 concluído;
- último replay incremental limpo:
  - 22 encontradas;
  - 22 existentes;
  - 0 novas publicações;
  - 0 novas versões;
  - 0 erros;
  - 0 falhas parciais;
- checkpoint final:
  - bootstrap completo;
  - 752 arquivos conhecidos;
- estado final auditado:
  - 959 publications;
  - 959 publication_origins;
  - 959 publication_versions;
  - 959 versões correntes;
  - 0 versões históricas artificiais;
  - 752 anexos;
  - 752/752 SHA-256 válidos;
  - 0 publication_origins duplicadas;
- validação live de 7 dias aprovada;
- API moderna oficial confirmada;
- filtro determinístico e auditável funcionando;
- overlap protection já implementada para `rfb-normas`.

### Fonte produtiva

- source id: `4e9a40f1-9a12-4786-a816-5104cb252e3f`;
- connector_key: `rfb-normas`;
- schedule timezone: `America/Sao_Paulo`;
- cron ainda está `NULL`;
- max_attempts: 3.

### Runs produtivos relevantes

Bootstrap avançou em múltiplos runs respeitando time budget:

- `8795f7eb-e10f-4ab8-93ea-d329bdf9e90c` — PARTIAL_SUCCESS;
- `98413d3f-d78b-462d-bfbc-f1ed3b4a0c00` — PARTIAL_SUCCESS;
- `5f8d38e4-2089-4d78-986e-cfe3ebfb35aa` — PARTIAL_SUCCESS;
- `50c452c4-c439-414e-9e7c-397bb212dfc6` — SUCCESS, bootstrap completo.

Replay incremental:

- `44048c1b-2512-469d-9586-97acaa4ce153` — SUCCESS;
- 22 encontradas / 22 existentes / 0 novas / 0 versões / 0 erros;
- duração aproximada: 30 s.

### Gate ainda aberto

O único gate produtivo importante ainda não encerrado é:

`DOU × Sistema Normas → 1 publication + múltiplas publication_origins`.

A auditoria atual mostrou:

- `publications_with_multiple_sources = 0`;
- porém existem pares fortes já persistidos separadamente por legado do DOU.

Pares reais confirmados que deveriam convergir incluem:

- IN RFB nº 2.344/2026;
- IN RFB nº 2.340/2026;
- SC COSIT nº 180/2026;
- SC COSIT nº 177/2026;
- SC COSIT nº 164/2026;
- SC COSIT nº 154/2026;
- ADE COCAD nº 74/2026;
- ADE CORAT nº 66/2026;
- ADE CORAT nº 67/2026.

Não fazer merge por número/data isolados. O probe de potenciais matches também retornou falsos positivos de outros órgãos.

### Diagnóstico atual do cross-source

O algoritmo novo está correto para ingestões futuras e o teste de integração DOU × Sistema Normas já comprova:

- 1 publication;
- 2 origins;
- 0 duplicidade;
- 0 versão artificial para conteúdo equivalente.

O problema produtivo é legado: atos DOU antigos já haviam sido persistidos antes da canonização comum de RFB/COSIT.

### Próximo passo exato

1. concluir o probe `rfb-normas-cross-source-detail.ts`;
2. comparar conteúdo/metadata dos pares fortes reais;
3. criar reparo transacional somente para matches fortes:
   - mesmo órgão Receita normalizado;
   - mesmo tipo canônico;
   - mesmo número/ano;
   - mesma data de publicação;
4. preservar ambas as origins;
5. preservar DOU como PRIMARY do evento jurídico;
6. preservar Sistema Normas como PRIMARY da representação Receita / ENRICHMENT no mecanismo de versão;
7. não criar `publication_version` artificial por anexos/representação consolidada;
8. rodar novamente o probe cross-source e exigir pelo menos um caso real com:
   - 1 publication;
   - 2 publication_origins;
   - identidade normativa forte;
9. executar replay incremental novamente;
10. exigir:
   - 0 novas publicações;
   - 0 novas versões;
   - 0 erros;
11. medir timeout operacional;
12. somente então ativar:
   - `schedule_cron = 0 * * * *`;
   - timezone `America/Sao_Paulo`;
13. observar run real `SCHEDULED`;
14. neutralizar os serviços temporários:
   - `rfb-normas-validation`;
   - `rfb-normas-repair`;
15. atualizar esta documentação com o fechamento final.

### Infra temporária atual

- `rfb-normas-validation`: serviço auxiliar de validação;
- `rfb-normas-repair`: serviço auxiliar usado em reparos produtivos anteriores;
- ambos devem ser neutralizados/removidos após o fechamento.

### Observação importante

Não declarar a frente concluída ainda.

Critérios faltantes para encerramento:

- cross-source real DOU × Sistema Normas corrigido e comprovado;
- replay pós-reparo limpo;
- timeout operacional definido;
- cron horário ativado;
- run real do Scheduler observado;
- limpeza da infra temporária.
