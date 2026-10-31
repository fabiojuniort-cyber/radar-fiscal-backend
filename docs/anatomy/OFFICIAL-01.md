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
