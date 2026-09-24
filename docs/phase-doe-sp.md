# Fase DOE-SP: conector do Diário Oficial do Estado de São Paulo

Esta fase inaugura a cobertura dos 27 Diários Oficiais estaduais. A arquitetura é a do Motor de Coleta, sem nenhum componente novo: `collection_runs`, `collection_attempts`, `collection_items`, `publication_versions`, `publication_origins` e `collection_checkpoints`, com retry, timeout, heartbeat, recuperação de worker stale, time budget e proteção de overlap.

## 1. Fonte oficial

| Item | Valor |
|---|---|
| Portal | https://doe.sp.gov.br (Prodesp, Next.js) |
| Conteúdo | `https://do-api-web-search.doe.sp.gov.br/` (JSON público, sem autenticação) |
| Edições e PDFs | `https://do-api-publication-pdf.doe.sp.gov.br/` (JSON e PDF) |
| Acervo coberto pela API | a partir de 10/07/2023. Antes disso, só no acervo legado da Imprensa Oficial (imprensaoficial.com.br), fora da API |
| Escopo desta fase | caderno **Executivo**, seção **Atos Normativos** |
| Condicionais HTTP | nenhum: as respostas não trazem ETag nem Last-Modified. O incremento é feito por checkpoint. |

A API é interna do portal (nível 3 da ordem de preferência: JSON oficial usado pelo próprio portal). Não existe API documentada, RSS nem sitemap útil. A estabilidade foi verificada assim:

- as respostas são byte-idênticas entre chamadas;
- os IDs são GUIDs estáveis;
- funciona a partir do Railway (probe de 24/09/2026: HTTP 200, entre 0,7 e 4 s).

### Endpoints usados

| Endpoint | Uso |
|---|---|
| `GET v2/journals` | descobre o GUID do caderno "Executivo" pelo nome |
| `GET v2/sections?JournalId=` | descobre o GUID de "Atos Normativos" pelo nome |
| `GET v2/summary/structured?Date&JournalId&SectionId` | árvore do dia (id, título, slug). Serve de sonda barata (cerca de 220 KB) para o fingerprint do dia |
| `GET v2/summary/list?Date&JournalId&SectionId` | todos os atos do dia, com `hierarchy`, `publicationTypeId` e `excerpt`. Usado na classificação |
| `GET v2/summary/filters?Date&…` | catálogo de tipos de publicação (id → nome) |
| `GET v2/publications/{id}` | ato completo: `content` (HTML com o texto integral), `publicationType`, `attachments[]`, `authCode` |
| `GET v2/authentication/download/{authCode}` | PDF autenticado do ato (`{name, content: base64, contentType}`) |
| `GET v2/publications/attachment/downloadattachment/{id}` | anexo (PDF) |
| `GET v1/editions/status/{date}` | edições do dia (`editionAuthCode`, volume/número). Devolve 404 quando não há edição |
| `GET v1/editions/url` e `v1/supplementary-editions/url` | PDF da edição e das edições suplementares (só a referência, sem download) |

Existe também a busca avançada (`v2/advanced-search/publications`, com `Terms[]`, datas e paginação), mas ela **não é usada**: o resumo por data é determinístico e cobre o dia inteiro.

## 2. Modelo: edição × publicação

Cada ato é uma publicação própria. O portal já entrega os atos individualizados (GUID, título, órgão e texto). Não há separação heurística de PDF. A edição fica como evidência nos metadados da versão:

- `editionAuthCode`, `editionNumber`, `editionVolume`;
- `editionPdfUrl`;
- `supplementaryEditionCount`.

**Suplementos e edições extras** entram no resumo da própria data:

- em 23/09/2026 a edição principal teve 788 atos e o resumo do dia, 791;
- houve edição extra em 24/09;
- houve edição de domingo em 13/09 (Decreto 70.858).

Por isso o conector percorre todos os dias do calendário. No resumo, os atos de suplemento aparecem com horário `T00:00:00`. Isso vira `editionHint = SUPPLEMENTARY_OR_EXTRA`, que é apenas indicativo.

## 3. Regras de captura (determinísticas)

Não há IA na decisão de captura. Cada ato recebe uma **categoria** (incluído) ou um **motivo** (excluído):

| Regra | Resultado |
|---|---|
| Leis, Leis Complementares, Emendas | `LEGISLATION` |
| Decretos numerados | incluídos somente quando título/ementa contém vocabulário tributário (`NUMBERED_DECREE`); os demais são `NUMBERED_DECREE_WITHOUT_TAX_TERMS` |
| Retificações/erratas da seção DECRETOS | `DECREES_SECTION` (captura conservadora, pois a ementa curta pode apenas referenciar o decreto corrigido) |
| Atos do Governador / vetos | incluídos só com vocabulário tributário (`GOVERNOR_ACT_TAX_TERMS`, `VETO_TAX_TERMS`) |
| Fazenda: Receita Estadual e Administração Tributária (Portaria SRE, Comunicados DICAR/DIGES/DEAT…) | `SEFAZ_TAX_ADMINISTRATION` |
| Fazenda: Gabinete do Secretário (Resolução SFP) | `SEFAZ_CABINET` |
| Fazenda: Delegacias Tributárias, Postos Fiscais, Núcleos | excluídos como `INDIVIDUAL_TAX_ADMINISTRATIVE_ACT`: são atos sobre contribuintes identificados (cassação de IE, PCN, AIIM, ITCMD) |
| Fazenda: Tesouro, Orçamento, Planejamento, CTA | incluídos só com vocabulário tributário (`SEFAZ_OTHER_TAX_TERMS`) |
| PGE: Contencioso Tributário-fiscal, Dívida Ativa ou vocabulário tributário | `PGE_TAX` |
| Outros órgãos: tipo normativo com vocabulário tributário no título ou na ementa | `OTHER_ORGAN_TAX_TERMS` |

O vocabulário tributário (`DOE_SP_TAX_TERMS`) inclui, entre outros:

- ICMS, IPVA, ITCMD, IBS, CBS, RICMS, CONFAZ;
- substituição tributária, DIFAL;
- tribut\*, imposto;
- NF-e, NFC-e, CT-e, MDF-e, EFD, SPED;
- documento fiscal, obrigação acessória;
- benefício e incentivo fiscal, crédito presumido e outorgado;
- dívida ativa;
- Reforma Tributária.

A lista não é filtro exclusivo: ela decide a inclusão fora dos órgãos tributários e também evita a captura indiscriminada de decretos numerados sem conteúdo tributário. Palavras ambíguas ficaram de fora de propósito, como "fiscal" sozinho ("fiscal do contrato") e "isenção" ("isenção de taxa de inscrição").

As métricas de cada tentativa registram:

- descobertos, incluídos e excluídos;
- `includedByCategory` e `excludedByReason`;
- amostras de excluídos apenas com id, órgão e motivo. O título fica de fora porque pode identificar contribuintes.

"Não publicado" (dia sem ato) é diferente de "descoberto e filtrado".

## 4. Identidade

| Caso | Identidade |
|---|---|
| Lei, LC, Emenda, Decreto numerado | **STRONG** `SP / GOVERNO-SP / <TIPO> / <n>/<ano>` (ex.: `DECRETO 70843/2026`) |
| Ato designado da SEFAZ ou da PGE | **STRONG** `SP / SEFAZ-SP/<SIGLA> / <TIPO> / <n>/<ano>` (ex.: `PORTARIA SRE 43/2026`, `RESOLUÇÃO SFP 25/2026`, `COMUNICADO DICAR 59/2026`, `PORTARIA CONJUNTA SRE/STE 5/2026`) |
| Ato sem numeração/sigla, ou de emissor sem série inequívoca | **SOURCE_SCOPED** pelo GUID do DOE (`externalId`) |
| Retificação/errata | **SOURCE_SCOPED** isolada (`DOE_SP\|RETIFICACAO\|<guid>`). Nunca vira versão do ato retificado |

Regras que valem para todos os casos:

- A data da identidade forte é a data do DOE (`publishedOn`). A data de assinatura fica em `metadata.signedOn`.
- O GUID do DOE é sempre o `externalId` da origem.
- A URL canônica é `https://doe.sp.gov.br/{slug}`.
- Não há fuzzy merge. Cross-source só acontece com identidade forte idêntica.

## 5. Versionamento

O `content_hash` é o do Motor: título, texto, vigência e SHA-256 dos arquivos. Metadados de captura (`capturedAt`) e URLs não entram no hash.

O texto é extraído do HTML oficial, descartando:

- o `<head>`, inclusive o `<title>` do SEI;
- CSS e scripts.

O PDF autenticado e os anexos têm SHA estável; isso foi verificado com downloads repetidos. Uma norma que altera outra é uma publicação nova. Retificações são publicações próprias.

## 6. Arquivos

Arquivos registrados em `source_metadata.files` (nunca como blob no Postgres):

| Arquivo | Campos |
|---|---|
| PDF autenticado do ato | URL da API, nome, `application/pdf`, tamanho, SHA-256 dos bytes do PDF (não do envelope JSON), `externalId = auth:<authCode>`, `capturedAt` |
| Anexos | URL `downloadattachment/{id}`, nome original, MIME detectado, tamanho, SHA-256, `externalId = <id do anexo>` |

O texto dos anexos em PDF **não é extraído** (`textExtraction = NOT_EXTRACTED`). O repositório não tem biblioteca de PDF, e adicionar uma está fora do escopo desta fase. O texto do ato vem do HTML oficial (`textExtraction = HTML_TEXT`), portanto não há OCR.

Se um arquivo falhar, o ato inteiro é adiado para o próximo run. Isso evita criar uma versão artificial quando o arquivo aparecer depois.

## 7. Incremento, checkpoint e bootstrap

- **Janela incremental**: `DOE_SP_LOOKBACK_DAYS` (padrão **3**, entre 1 e 30).
  - Suplementos saem na mesma data e há edições extras em fins de semana.
  - Três dias cobrem uma sexta → segunda e rechecam cada data.
- **Checkpoint** (`collection_checkpoints`, `connector_key = doe-sp`, `state_version = 1`, 3 gerações):
  - `coverageFrom`, `windowEnd`, `pendingRanges`;
  - `days[data] = { idsHash, total, included[], checkedAt }`, só para a janela.
- **Run horário**, para cada data da janela:
  1. `summary/structured` e fingerprint dos IDs.
  2. Se o fingerprint for igual ao do checkpoint, a data é **pulada** (0 lista, 0 detalhe, 0 download).
  3. Se mudou, `summary/list`, classificação e detalhe + arquivos **só dos incluídos ainda não conhecidos**.
- **Bootstrap/gaps**:
  - `DOE_SP_BOOTSTRAP_START_DATE` (a partir de 2023-07-01) enfileira o intervalo anterior à janela.
  - Queda maior que a janela vira gap enfileirado.
  - As datas são processadas uma única vez, depois da janela, com o time budget.
  - `TIME_BUDGET_REACHED` gera `PARTIAL_SUCCESS` sem retry. O run seguinte continua do checkpoint.
- **Falha de persistência**: itens `FAILED` no run que produziu o checkpoint são reabertos na leitura do estado (`reopenFailedItems`).
- **Replay forçado** (gate): `DOE_SP_FORCE_REPROCESS_UNTIL=<ISO>` ignora fingerprints e IDs conhecidos até o instante indicado e expira sozinho.

## 8. Status do Motor

| Situação | Status |
|---|---|
| Atos novos persistidos | `SUCCESS` |
| Consulta ok sem ato novo (dia vazio ou inalterado) | `SUCCESS_NO_RESULTS` |
| Algum ato, arquivo ou data falhou, ou houve parada pelo time budget | `PARTIAL_SUCCESS` |
| Portal ou API fora (catálogo ou todas as datas da janela) | `SOURCE_UNAVAILABLE` / `FETCH_FAILED`, nunca "0 publicações" |
| Contrato JSON mudou (caderno/seção não encontrados, payload inválido) | `PROCESSING_FAILED` |

Não há loop de retry próprio: vale o `decideRetry` do Motor (`max_attempts = 3`). Timeout e cancelamento usam o `AbortSignal` do executor, e cada request tem timeout de 30 s.

## 9. Scheduler e overlap

- `scheduler.service.ts` inclui `doe-sp` em `preventsOverlappingRuns`, com teste em `collection.scheduler.integration.test.ts`.
- Produção: `0 * * * *`, timezone `America/Sao_Paulo`.

## 10. Operação

```bash
npm run db:ensure-doe-sp-source            # provisiona a fonte (sem cron)
npm run db:ensure-doe-sp-source -- --hourly
npm run db:trigger-doe-sp-run              # run MANUAL (recusa se houver run ativo)
npm run db:inspect-doe-sp                  # inspeção somente leitura (gates)
```

## 11. Testes

| Arquivo | O que cobre |
|---|---|
| `test/doe-sp.parser.unit.test.ts` | catálogo, resumo, lista (com item malformado), detalhe, texto, edições |
| `test/doe-sp.rules.unit.test.ts` | inclusão/exclusão na edição real de 04/09/2026, datas, tipos, identidade |
| `test/doe-sp.client.unit.test.ts` | 503/429/400, HTML no lugar de JSON, JSON inválido, rede, timeout, cancelamento, origem, 404 permitido, PDF autenticado, anexos |
| `test/doe-sp.connector.unit.test.ts` | primeiro run, replay pelo checkpoint, replay forçado com hashes idênticos, suplemento, dia vazio, indisponibilidade, item falhando e cura, malformado, bootstrap, extensão do bootstrap, time budget, gap, cancelamento, reabertura de falhas |
| `test/doe-sp.collection.integration.test.ts` | pelo Motor com Postgres: persistência, identidade STRONG/SOURCE_SCOPED, arquivos, replay `SUCCESS_NO_RESULTS` sem refetch, replay forçado com 0 publicações e 0 versões novas |

As fixtures (`test/doe-sp.fixtures.ts`) são payloads reais de 24/09/2026. O CSS inline foi removido, os dados pessoais da amostra de retificação foram anonimizados e os PDFs são sintéticos. Não foi usado nenhum payload inventado.

## 12. Limitações

- A API é interna do portal e não documentada. Uma mudança de contrato gera `PROCESSING_FAILED`, nunca falha silenciosa.
- O suplemento não é marcado por ato; `editionHint` é heurístico.
- O texto dos anexos em PDF não é extraído.
- Os cadernos Legislativo, Municípios, Empresarial e Jucesp e as seções Atos de Pessoal e Gestão ficam fora do escopo. Leis sancionadas saem no Executivo › LEIS.
- O acervo anterior a 07/2023 fica fora da API.
- Republicação de ato numerado em outra data gera uma publicação distinta, porque a identidade usa a data do DOE.
- Decretos numerados não tributários não entram no canal tributário apenas por estarem na seção DECRETOS; a inclusão exige evidência determinística no título/ementa.

## 13. Fechamento produtivo

Esta seção será preenchida com:

- run IDs;
- contagens;
- replay;
- run `SCHEDULED`;
- serviços temporários.
