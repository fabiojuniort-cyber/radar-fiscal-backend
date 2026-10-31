# ANAT-STRUCT-01 — agrupamentos, considerandos e itens

Governança: tribusca-control#116. Primeiro lote técnico do fechamento integral da frente (Etapa C). O lote usa só fixtures sintéticas. A homologação com atos oficiais depende da liberação de rede (OFFICIAL-01 §2).

## O que muda no leitor (`src/modules/anatomy/readers.ts`)

O contrato v1 já previa os tipos `group`, `consideration` e `item`, mas o leitor não produzia nenhum deles. Agrupamentos, considerandos e itens saíam como `unidentified`, `preamble` ou ficavam presos ao dispositivo anterior.

| Bloco que começa por | Tipo | Motivo (`contextReasons[0]`) | Nível de aninhamento |
|---|---|---|---|
| `LIVRO` + número | `group` | `group_book` | 2.1 |
| `TÍTULO` / `TITULO` | `group` | `group_title` | 2.2 |
| `CAPÍTULO` / `CAPITULO` | `group` | `group_chapter` | 2.3 |
| `SEÇÃO` / `SECAO` | `group` | `group_section` | 2.4 |
| `SUBSEÇÃO` / `SUBSECAO` | `group` | `group_subsection` | 2.5 |
| `Considerando` (palavra inteira, qualquer caixa), num bloco já reconhecido como preâmbulo | `consideration` | `consideration_marker` | fora da hierarquia, como o preâmbulo |
| `1.`, `1)`, `1.1.` seguidos de texto | `item` | `item_marker` | 7, abaixo da alínea |

Regras e limites:
- **Grafias aceitas no cabeçalho:** maiúsculas, ou maiúscula inicial seguida de minúsculas (`Seção I`). A palavra precisa vir seguida de algarismo romano ou arábico, ou de `Único/Única`, e terminar o bloco ou vir acompanhada de separador (`-`, `–`, `—`, `:`, `.`). Uma menção em prosa ("conforme o Capítulo I") não abre agrupamento.
- **Hierarquia:** o agrupamento fica abaixo do anexo (nível 2) e acima de artigo e cláusula (nível 3). Um novo cabeçalho de mesmo nível ou superior fecha os anteriores.
- **Considerando:** o casamento do preâmbulo **não mudou**. Só o tipo de um bloco que já era preâmbulo e começa pela palavra inteira passa a `consideration`, e o contexto continua `prohibited`. As variantes coladas (`CONSIDERANDOé`, `CONSIDERANDO_`, `CONSIDERANDOS`) mantêm o resultado congelado.
- **Vigência:** nenhum tipo novo altera `legalStatus`. Estrutura nunca define vigência.
- **Fidelidade:** a cobertura continua completa (`accountedLength = canonicalText.length`), sem perda ou reordenação de texto.

## Correções da revisão R1 (#116 c.6543169799)

- **R1-A, anexo × agrupamentos:**
  - o leitor guarda o nível de agrupamento mais alto usado no corpo, fora de anexos;
  - um agrupamento desse nível ou superior, encontrado com um anexo aberto, **fecha o anexo** e volta para a raiz, e o contexto histórico do anexo deixa de valer;
  - níveis inferiores continuam dentro do anexo;
  - sem agrupamento no corpo, o anexo mantém os seus;
  - um novo anexo fecha o anterior.
- **R1-B, itens:** a profundidade (`1.`, `1.1.`, `1.1.1.`, até 6 níveis) define o aninhamento, com motivos `item_marker`, `item_level_2`, `item_level_3` e assim por diante. Um nível menor ou igual fecha os mais profundos. Valores (`1.000,00`), datas (`31.12.2026`), anos e células de tabela não viram item.
- **R1-C, fidelidade:** testes de texto canônico exato com caracteres fora do BMP e emoji, continuidade do `sourceMap` em UTF-16, spans que não partem pares substitutos, ponteiros de origem, hash determinístico e NFD preservado e sinalizado.
- **Delta:** nenhum documento sintético congelado mudou com as correções R1. A identidade do motor foi regenerada.

## Efeito em artefatos congelados

- `test/fixtures/anatomy/synthetic-equivalence.json`: regenerado. O único delta é o bloco CONSIDERANDO do documento sintético `preamble-variants`, que passa de `preamble` a `consideration` com o mesmo contexto. Conferido parte a parte antes de regravar.
- `test/anatomy.profile-engine.unit.test.ts` (#249 R2): uma única expectativa adversarial foi ajustada (`Considerando que` → `consideration`), com comentário. As demais seguem os valores do motor pré-integração.
- Identidade do motor: `engine-build.json` e `ANATOMY_ENGINE_BUILD_HASH` regenerados com `node ops/anatomy/build-identity.mjs --write`. Em produção a funcionalidade está desligada e não há análises registradas com o hash anterior.
- O gold e o corpus não são lidos nem afetados: os testes de gold não executam o motor.

## Testes

`test/anatomy.struct.unit.test.ts` (5 testes sintéticos) cobre:
- a hierarquia completa e o fechamento por novo capítulo;
- grafias sem acento e menções em prosa;
- considerandos;
- itens sob alínea;
- números em prosa e `legalStatus` sempre desconhecido.

Também incluído em `test:anatomy` e na lista sintética do `anatomy-ci.yml`.
