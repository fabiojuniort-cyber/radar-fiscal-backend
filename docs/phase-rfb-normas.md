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
