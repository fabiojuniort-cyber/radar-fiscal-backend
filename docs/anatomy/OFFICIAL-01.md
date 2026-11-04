# ANAT-OFFICIAL-01 — amostra oficial da configuração acessível

Governança: tribusca-control#116. Depende de radar-fiscal-backend#276 (ANAT-CONFIG-01). Estado: **preparação; fontes oficiais bloqueadas pela rede da sessão**. Nenhum ato oficial foi consultado ainda e nenhum texto oficial está neste repositório.

## 1. O que este lote entrega

- **Gate de procedência** (`src/modules/anatomy/config/official-provenance.ts`). Um ato só entra em `OFFICIAL_SAMPLES` com:
  - URL https num host oficial da sua fonte (CONFAZ, DOU, DOE-SP ou RFB);
  - data de consulta (AAAA-MM-DD, não futura);
  - versão consultada e motivo da escolha;
  - id `ofc-…`, sem colidir com ids reservados do corpus nem com os convênios 52/91 e 100/97, que são a base do ANAT-03.

  A checagem é fail-closed: procedência incompleta derruba o carregamento do serviço. Testes em `test/anatomy.official-provenance.unit.test.ts`.
- **Seleção de 10 atos** (`ops/anatomy/official-manifest.json`): só a identificação de cada ato e o motivo da escolha, cobrindo as quatro fontes e os fenômenos de estrutura, natureza e vigência. Nenhuma URL conta como confirmada antes de a página ser aberta.
- **Coletor** (`ops/anatomy/fetch-official.ts`):
  - consulta cada ato só no host oficial e recusa redirecionamento para fora dele;
  - grava o HTML exatamente como servido, com SHA-256, status HTTP, `Last-Modified` e a data de consulta;
  - reporta `BLOCKED` sem substituir o conteúdo por nada.
- **Bateria pós-deploy** (`ops/anatomy/config-postdeploy-check.sh` e `.ps1`), só com GET sem credenciais:
  - health 200 com `database` up;
  - `anatomy-config` 404;
  - `anatomy-rules/drafts` 404 (flag antiga desligada);
  - `admin/me` 401;
  - site 200;
  - conferência manual de que a tela e o menu estão ocultos.

## 2. Bloqueio de rede (30–31/10/2026)

| Ferramenta | Hosts | Erro |
|---|---|---|
| curl (proxy da sessão) | www.planalto.gov.br, normas.receita.fazenda.gov.br, www.confaz.fazenda.gov.br, legislacao.fazenda.sp.gov.br, www.in.gov.br, legis.senado.leg.br, www.lexml.gov.br | `CONNECT tunnel failed, response 403` / `connect_rejected` |
| WebFetch | www.confaz.fazenda.gov.br, www.planalto.gov.br | `getaddrinfo ENOTFOUND` |
| `fetch-official.ts` (Node fetch) | www.confaz.fazenda.gov.br | `getaddrinfo ENOTFOUND` |

**Liberação** (configuração do ambiente cloud, sem revisão de conteúdo):
1. Abrir o menu do ambiente na barra de título da sessão e clicar em **Edit**.
2. Em **Network access → Allowed domains**, adicionar os 7 hosts acima e manter marcada a caixa dos gerenciadores de pacotes.
3. Abrir uma sessão nova nesse ambiente.

Documentação: https://code.claude.com/docs/en/cloud-environments#network-access

## 3. Roteiro quando houver acesso (todo pela IA)

1. `npx tsx ops/anatomy/fetch-official.ts`: localizar as URLs marcadas `to-locate` na própria fonte oficial, confirmá-las no manifesto e guardar os snapshots com o hash.
2. Para cada ato:
   - recortar o trecho representativo do snapshot, sem editar o texto;
   - preencher `SampleInput` com `provenance.kind = 'official'`;
   - escrever as anotações em `SAMPLE_ANNOTATIONS`, separando estrutura, natureza e vigência, com o trecho como evidência;
   - marcar as ambiguidades sem concluir.
3. Segunda conferência pela mesma IA, **identificada como tal**. Não é revisão independente.
4. Testes do motor, prévia, correções e consumidor; evidências visuais da tela em ZIP.
5. Entregar para revisão independente, sem autoaprovação.

Mantidos: BLOCK_CORPUS_INPUTS_AND_GOLD e RESTRICT. O corpus, o gold e a reserva não são lidos.

## 4. Sobreposição com o corpus (direcionamento de 30/10)

`test/anatomy.official-overlap.unit.test.ts` compara a seleção com o **inventário** `corpus-manifest.json`. Usa só os campos id, fonte, rótulo e sourceId, nunca entradas, gold ou reserva. A chave de comparação é a espécie do ato com número e ano.

Resultado de 31/10:
- nenhuma sobreposição na seleção atual;
- o inventário lista o **Convênio ICMS 52/91 (entrada 01)** e o **100/97 (entrada 02)**, ambos na partição *development*, e a **IN RFB 2.342/2026 (entrada 11)**.

Esses atos ficam fora da amostra oficial até decisão do COORD. A prioridade do Product Owner pelo 52/91 é atendida por alternativas oficiais de mesma fonte e tipo, como outros convênios ICMS com anexos de NCM.

## 5. Correções da revisão R1 (#116 c.6543169799)

| Achado R1 | Correção | Arquivos | Teste de regressão |
|---|---|---|---|
| ALTO 1: sobreposição fora do gate | O gate exige a identidade do ato (`provenance.act`), calcula a chave espécie+número+ano (`act-key.ts`) e recusa as chaves do corpus. Também recusa título que indique outro ato e URL com um `sourceId` do corpus. Identidade ilegível é recusada (fail-closed). As chaves e ids saem só do inventário (`reserved-act-keys.ts`, gerado por `ops/anatomy/reserved-act-keys.ts`; o teste falha se houver deriva). | `official-provenance.ts`, `act-key.ts`, `reserved-act-keys.ts`, `sample-inputs.ts` | `official-provenance` (aliases: "Conv. ICMS 52/1991", "Nº 52, DE 26 DE SETEMBRO DE 1991", IN 2.342; idAto do corpus); `official-overlap` (deriva) |
| ALTO 2: `redirect: 'follow'` | Redirecionamento manual, com protocolo e host validados **antes** de cada requisição seguinte; https obrigatório; no máximo 5 saltos. | `fetch-official-core.ts`, `fetch-official.ts` | `official-fetch`: o host externo nunca é requisitado; downgrade para http; laço de redirecionamentos; redirecionamento relativo aceito |
| ALTO 3: snapshot de erro | Só uma resposta 2xx com HTML ou PDF vira snapshot. O resto vai para `failures.json`, sem corpo. | `fetch-official-core.ts`, `fetch-official.ts` | `official-fetch`: 404, 500, JSON, texto e tipo ausente |
| MÉDIO 4: vínculo com o snapshot | `provenance.snapshotSha256` é obrigatório. A promoção exige metadados com a mesma URL e o mesmo hash, bytes do arquivo íntegros e conteúdo como recorte exato. | `official-binding.ts` | `official-fetch`: recorte alterado, hash diferente, arquivo adulterado; as amostras publicadas passam |
| MÉDIO 5: URL candidata × confirmada | `urlStatus`: `candidate` / `verified` / `to-locate`. O coletor grava `verified=false` para candidata, e a promoção exige `verified`. | `official-manifest.json`, `fetch-official-core.ts`, `official-binding.ts` | `official-fetch`: candidata não promovível |

Execução real em 31/10: todas as URLs deram `FAIL network: getaddrinfo ENOTFOUND` e foram para `failures.json`. **Nenhum snapshot foi gravado.**

## R2 (correções do parecer R2 do COORD)

- **R2-03:** URL verificada não é o mesmo que representação válida. O corpo precisa corresponder ao formato declarado: um PDF tem a assinatura `%PDF-` no início e o marcador `%%EOF`; um HTML não é vazio, contém marcação e não é um PDF. Se não corresponder, a resposta vira a falha `invalid_representation`, sem corpo, e nunca um snapshot. Os metadados passam a separar `urlVerified` de `representation`. A proteção dos redirecionamentos não mudou.
- **R2-04:** o vínculo de amostra com snapshot em PDF usa o texto extraído de forma rastreável (`ops/anatomy/pdf-text.ts`, ferramenta `pdfjs-dist@6.3.289/lines-v2`), com o hash do texto registrado em `extraction.textSha256` no meta. O PDF nunca é decodificado como UTF-8. O hash binário continua sendo a identidade do original. O HTML continua com a conferência byte a byte.

## ANAT-D03 — JSON estruturado da Receita (aprovado pelo Fábio, via COORD)

- **Aceitação restrita:** `application/json` só é aceito em host oficial da RFB (`normasinternet2.receita.fazenda.gov.br`, adicionado a `OFFICIAL_HOSTS.RFB`) e no caminho `/api/consulta-externa/ato/<idAto>/visao/<visao>`, sem query string. Qualquer outro JSON continua sendo falha `content_type`.
- **Validação da representação** (`validateRfbJson`): o Content-Type sozinho não prova nada. O corpo precisa ser:
  - JSON UTF-8 com objeto raiz;
  - diferente de payload de erro (com `status`, `erro` ou `mensagem` e sem `idAto`);
  - com o `idAto` igual ao da URL;
  - estruturalmente compatível com `prepareRfbRepresentation`: segmentos ordenados, sem ordem duplicada, com pelo menos um texto legível.

  Caso contrário, a resposta vira `invalid_representation`, sem corpo.
- **Preservação:** o arquivo original fica intacto (`<id>.json`). O meta registra:
  - URL, `consultedAt`, SHA-256 e bytes;
  - a identificação do ato e da versão: `idAto`, epígrafe, número, data do ato, `dataPublicacao`, `dadosPublicacao`, `visao`, e o `vigente` **declarado pelo portal**, não inferido;
  - a preparação: versão, `preparationId`, `htmlSha256`, número de trechos, segmentos ausentes, anexos e campos excluídos.
- **Vínculo** (`bindingIssues`): o JSON é preparado de novo, o `htmlSha256` precisa conferir e a amostra precisa ser recorte exato do HTML preparado. A rastreabilidade ponteiro JSON ↔ texto preparado ↔ anatomia passa por `locateJsonHtmlSpan`, coberta por teste.
- **Perdas de estrutura declaradas:**
  - `epigrafeCompleta` fica excluída como metadado;
  - segmentos com `omitir` ou sem texto são listados como ausentes (ex.: IN 2.005/2021, `/outrosSegmentos/104`, `no_text`);
  - anexos binários são referenciados, sem conteúdo;
  - nesta branch o leitor é anterior ao STRUCT: agrupamentos e itens não são reconhecidos, e o texto correspondente fica `unidentified`, mas contabilizado (IN 2.237/2024: 12.271 de 31.389 caracteres). Os números por ato estão em `anatomyOnThisBranch` de cada meta.
- **`promoted: false`** nas 4 INs até o aceite independente da validação.

### ANAT-D03, conferência pré-revisão: visão multivigente e perdas por IN

**A visão `multivigente` MISTURA redações superadas.** O portal marca segmentos com `tachado: true` (riscados, redação superada) e os entrega no mesmo vetor dos vigentes. `prepareRfbRepresentation` os inclui como texto comum, e o leitor **não** os marca como históricos.

Tratamento nesta entrega, sem mudar o leitor nem a preparação:
- a validação registra `preparation.struckSegments` (ponteiro, ordem e tamanho);
- o vínculo **recusa** amostra que inclua segmento tachado;
- as 4 INs seguem `promoted: false`.

Marcar o tachado como contexto histórico na anatomia é mudança de leitor/preparação e **depende de decisão**.

| IN | Canônico (chars) | Contabilizado | Não identificado | causa: inciso sem travessão no texto do portal | outras | Segmentos tachados | Ausentes | Anexos |
|---|---|---|---|---|---|---|---|---|
| 2.005/2021 (115131) | 57.179 | 57.179 | 1.015 | 0 | 1.015 | **343 de 344** (o portal declara o ato não vigente) | 1 (`no_text`) | 0 |
| 2.237/2024 (141910) | 31.389 | 31.389 | **12.271** | **11.279** | 992 | 10 de 223 | 0 | 0 |
| 2.162/2023 (133898) | 4.540 | 4.540 | 511 | 0 | 511 | 19 de 28 | 0 | 0 |
| 1.932/2020 (108391) | 2.003 | 2.003 | 325 | 0 | 325 | 0 | 0 | 0 |

- **IN 2.237, os 12.271 caracteres:** 11.279 são incisos que o portal guarda **sem o travessão** ("I que ocorrerem…"); o travessão só aparece na exibição. A gramática de inciso exige o separador, então esses blocos ficam `unidentified`. Os 992 restantes são de outra natureza (preâmbulo e blocos de transição) e ficam para a revisão. O texto está todo **preservado e contabilizado**; o que se perde é a **estrutura**.
- **Coletar o arquivo com sucesso não comprova anatomia completa.** O status das 4 é `partial`.
- O detalhe por IN está em `anatomyOnThisBranch` de cada `<id>.meta.json`.
