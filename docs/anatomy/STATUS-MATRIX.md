# ANAT — matriz de situação da frente (auditoria de 31/10/2026)

Governança: tribusca-control#116, com o direcionamento de 30/10 (comentário 6514510003): cobertura por fonte × tipo × layout × porte. Esta matriz foi preparada pelo EXEC e **não é revisão independente**.

Legenda de situação:
- **PROD-OFF:** implantado em produção, com a funcionalidade desligada;
- **MAIN:** integrado na main, sem uso produtivo;
- **PR:** em PR aberto;
- **LACUNA:** não implementado;
- **BLOQ:** depende de fonte oficial (bloqueio de rede).

## 1. Estado implantado (conferido em 31/10)

| Componente | Commit | Evidência |
|---|---|---|
| backend, worker, scheduler | `1a6419d0` | #116 c.6539976690 (deploys SUCCESS, migration 082) e c.6542468538 (pós-deploy PASS) |
| web (trifaros.com.br) | `b5cfb843` | idem; `/admin/anatomia` redireciona para `/` com a flag desligada |
| migrations ANAT | 077 base, 078 auditoria, 079 dupla aprovação (legada), 082 configuração direta | log do pré-deploy de 31/10 |
| flags | `ANAT_CONFIG_ENABLED` e `VITE_ENABLE_ANAT_CONFIG` inexistentes, portanto desligadas; antigas desligadas (404 em `anatomy-rules/drafts`) | pós-deploy de 31/10 |

## 2. Requisito → implementação → teste → evidência → situação

| # | Requisito (Etapa) | Implementação | Teste | Evidência | Situação |
|---|---|---|---|---|---|
| A1 | Contrato de resultado versionado | `contract.ts`, `contract-v1.schema.json` | `anatomy.contract` | CI anatomy | MAIN |
| A2 | Identidade verificável do motor | `build-identity.mjs`, `engine-build.json` | `anatomy:verify-build` | CI | MAIN |
| C1 | Epígrafe, ementa, preâmbulo | `readers.ts` (`epigraph`, `summary`, `preamble`) | `anatomy.readers`, `profile-engine` | CI | MAIN, só sintético |
| C2 | Considerandos | `readers.ts` → `consideration` | `anatomy.struct` | este PR | PR (STRUCT-01) |
| C3 | Livro, título, capítulo, seção, subseção | `readers.ts` → `group` com nível | `anatomy.struct` | este PR | PR (STRUCT-01) |
| C4 | Artigo, cláusula, parágrafo, inciso, alínea | `readers.ts` | `anatomy.readers` e `engine` | CI | MAIN, só sintético |
| C5 | Itens (1., 1.1.) | `readers.ts` → `item` | `anatomy.struct` | este PR | PR (STRUCT-01) |
| C6 | Parágrafo único distinto de § n | tipo `paragraph` comum; rótulo preservado no texto | — | — | LACUNA de apresentação (sem subtipo) |
| C7 | Caput separado do artigo | tipo `caput` no contrato, não produzido | — | — | LACUNA |
| C8 | Anexos e tabelas (linhas, células, geometria) | `readers.ts` (`annex`, `table/row/cell`) | `anatomy.readers` | CI | MAIN, só sintético |
| C9 | Assinatura e dados de publicação | `signature` produzido; `publication_header`/`footer` não produzidos | `anatomy.readers` | CI | PARCIAL / LACUNA |
| C10 | Referências e remissões | entidade `CITATION`/`LAW_NUMBER`, sem resolução de alvo | `anatomy.entities` | CI | PARCIAL (sem ligação ao ato citado) |
| C11 | Redações anteriores e notas editoriais | classes históricas → contexto `historical`; `editorial_note` | `profile-engine` | CI | MAIN (CONFAZ); demais fontes BLOQ |
| C12 | Retificação (Onde se lê / Leia-se) | `quoted_text` com contexto `prohibited` | `anatomy.readers` | CI | MAIN, só sintético |
| C13 | PDF | não existe leitor de PDF (só `pdfPage` como metadado DOU) | — | — | LACUNA |
| C14 | Documentos extensos e anexos separados | limites do leitor; manifesto de anexos, com anexo ausente → parcial | `anatomy.readers` | CI | PARCIAL; sem teste oficial extenso (BLOQ) |
| C15 | Rastreabilidade trecho → origem | `sourcePointers`, `sourceMap`, hashes de apresentação | `anatomy.readers` | CI | MAIN |
| C16 | Não inferir vigência por estilo ou nota | `legalStatus` sempre `unknown`; classes não definem status | `profile-engine`, `struct` | CI | MAIN |
| D1–D8 | Relações temporais (altera, revoga parcialmente, nova redação, prorroga, retifica, datas distintas, condição) | só contexto `historical` e `quoted_text`; não há modelo de relação entre atos | — | — | LACUNA (desenho necessário) |
| E1 | Tela `/admin/anatomia`: prévia, correção pontual, regra, histórico, restauração, nova análise | web `anatomy-config.tsx`; backend `config/*` e rota | vitest e e2e real (4 viewports) | `docs/evidence/anat-config-01` | PROD-OFF |
| E2 | Hierarquia navegável na tela | lista de trechos por tipo; sem árvore de navegação | vitest | capturas | PARCIAL |
| E3 | Origem de cada trecho e original × interpretação | resultado do motor e correção exibidos à parte | e2e | vídeo | PROD-OFF |
| B1 | Amostra oficial com procedência | gate em `official-provenance.ts` (#279); `OFFICIAL_SAMPLES` vazio | `anatomy.official-provenance` | #279 | PR + BLOQ |
| B2 | Cobertura fonte × tipo × layout × porte | manifesto inicial de 10 atos (#279) | — | — | BLOQ |
| F1 | Revisão independente por lote | — | — | ANAT-CONFIG-01 PASS 5/5 | ANAT-CONFIG-01 feito; demais lotes pendentes |
| G1 | Ativação e homologação com atos reais | — | — | — | PENDENTE (exige autorização) |

## 3. ANAT-03 (25 blocos) × direcionamento atual

- Os 25 blocos de tribusca-control#115 continuam **sem aprovação jurídica**: 0/25 marcados na issue. Esta matriz não os declara aprovados.
- O direcionamento de 30/10 transfere à IA a preparação e a revisão técnica. Ele não cria aceite jurídico. Os blocos ficam como **proposta documental**, que pode virar anotação de homologação quando houver fonte oficial e revisão independente.
- **Conflito com o corpus:** o Convênio ICMS 52/91 é a entrada `01` e o 100/97 é a entrada `02` do `corpus-manifest.json` (partição *development*). Pelo BLOCK_CORPUS_INPUTS_AND_GOLD, nenhum dos dois é usado como amostra de desenvolvimento ou teste até decisão. Conferido só o inventário (id, fonte, partição, rótulo), sem conteúdo.

## 4. Caminho crítico

1. **Liberar a rede** para as fontes oficiais (OFFICIAL-01 §2). Bloqueia B1, B2, C11 em outras fontes, C13 e C14 reais, e a homologação.
2. Decidir o uso do 52/91 frente ao corpus: liberar uma cópia oficial independente, ou manter fora.
3. Lotes offline em sequência: STRUCT-01 (este PR) → caput e parágrafo único → cabeçalho de publicação → modelo de relações D1–D8 (desenho para revisão).
4. Leitor de PDF (C13): depende de decidir a biblioteca e de amostras oficiais.
5. Revisão independente de cada lote → integração → autorização de ativação → homologação.
