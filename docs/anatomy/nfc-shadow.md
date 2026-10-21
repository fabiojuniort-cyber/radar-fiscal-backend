# ANAT-UNICODE-01b/B1 — sombra NFC e mapa de posições UTF-16 (componente isolado)

Origem: [decisão do COORD na issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-6282202378), sobre a [proposta](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-6282160251). Base: PR #250 em `dedcb22` (UNICODE-01a, PASS técnico).

**Escopo:** só um componente puro (`src/modules/anatomy/nfc-shadow.ts`) com seus dados e testes.
- **Nenhum** leitor, extrator, motor, adaptador ou consumidor o importa.
- A quarentena UNICODE-01a continua ativa.
- O `engineHash` do motor continua `bbcd7a7c…`, porque o componente não entra na identidade do motor enquanto o motor não o usa. A versão e os hashes do componente ficam no próprio manifesto (`docs/anatomy/nfc-shadow-manifest.json`).
- A integração (B2) depende de revisão e autorização próprias.

## Decisões do COORD aplicadas

1. Um documento processado pela sombra continuará `partial` (`nfc_shadow_matching`) no futuro B2, sem seleção positiva. O B1 não muda o status do motor.
2. Um span alargado é **só diagnóstico** (`widening`: intervalo pedido, intervalo mapeado e motivo). O componente não cria entidade nem classificação. No B2, alargamento que afete entidade, operador, condição ou proteção mantém a quarentena documental.
3. **Fronteiras forçadas** (limites de nó de texto): só são aceitas se forem fronteiras NFC. Caso contrário o componente emite o diagnóstico `forced_boundary_inside_segment` e marca o mapa como `usable: false`; o mapa recusa mapear. Isso cobre o caso Hangul L|V `<b>ᄀ</b>ᅡ` reproduzido pelo COORD, além de LV|T, acento e reordenação entre nós.
4. **Invariante final verificada em todo mapa:** `concat(NFC(segmento_i)) === original.normalize('NFC')`. Se falhar, o componente emite `nfc_concatenation_mismatch` e marca o mapa como inutilizável. A regra residual do "próximo nó com não-starter" foi abandonada.

## Algoritmo

- **Segmentação:** existe fronteira antes de um code point quando `ccc = 0` e `NFC_Quick_Check = Yes` (UAX #15 §9). O primeiro segmento começa em 0 (marca inicial). Um surrogate isolado é um starter (há fronteira antes dele) e nunca é substituído nem descartado. As marcas que vierem depois dele ficam no mesmo segmento: em `\ud800\u0301x`, o segmento inicial é [0,2) (ressalva B1-R1-01).
- **Sombra:** é a concatenação de `NFC(segmento)`. Quando já é NFC e não há fronteira inválida, `identity = true`. Isso indica **só igualdade textual** entre original e sombra, não exatidão automática de qualquer intervalo: os spans continuam mapeados por segmentos inteiros. Por exemplo, em `q\u0301x`, o intervalo [0,1) da sombra vira [0,2) no original, alargado. Todo consumidor deve conferir `MappedSpan.exact` (ressalva B1-R1-01). A política de alargamento do B2 vale também para documentos NFC.
- **Mapa:** dois `Uint32Array` com os inícios dos segmentos no original e na sombra (n+1 posições). Os segmentos são contíguos, não vazios e estritamente monótonos nos dois lados.
- **`shadowToOriginal` / `originalToShadow`:**
  - recebem intervalos semiabertos `[start, end)` em UTF-16, inteiros, com `0 ≤ start ≤ end ≤ length`;
  - recusam (`invalid_span`, sem nunca limitar o valor em silêncio) intervalos negativos, invertidos, fora do texto, não inteiros ou que cortem par substituto. A validação também vale no mapa identidade;
  - o resultado é a união dos segmentos tocados: `exact: true` quando o intervalo coincide com fronteiras, e `exact: false` com `widening` quando não coincide. Um intervalo exato vai e volta sem perda;
  - **intervalo vazio:** é definido só numa fronteira de segmento (devolve a fronteira correspondente); dentro de um segmento é recusado.
- **Garantia:** nunca corta par substituto nem segmento de normalização. **Não** promete respeitar grafemas estendidos nem sequências de emoji ZWJ: UAX #29 está fora do escopo.
- **Limites:** até 2 Mi unidades UTF-16 e até 1 Mi fronteiras forçadas (`input_too_large`).
- **Custo medido:**
  - a construção faz uma passada por code point, um `normalize` por segmento, um `normalize` do texto inteiro e aloca dois arrays de tamanho n+1;
  - medições: 1.048.572 unidades em ~258 ms e 2.097.144 unidades em ~469 ms (Node 24.22, aproximadamente linear);
  - o mapeamento é busca binária: 10.000 mapeamentos em menos de 1 s.

## Dados Unicode e runtime

- **Runtime suportado:** Node 24 (ICU 78.x, `process.versions.unicode === '17.0'`); `package.json` já exige `>=24 <25`. Medido no executor: Node v24.22.0, ICU 78.3, Unicode 17.0.
- **Falha fechada:** em qualquer outra versão Unicode o componente falha com `unsupported_runtime`. O Node 22 (Unicode 16.0), padrão deste container, é recusado.
- **Arquivos oficiais da UCD 17.0.0**, copiados em `ops/anatomy/ucd/17.0.0/`:
  - origem: tag `release-78.3` do repositório oficial `unicode-org/icu`, `icu4c/source/data/unidata/`. O acesso direto a unicode.org estava bloqueado neste ambiente;
  - os cabeçalhos confirmam a versão 17.0.0.

| Arquivo | SHA-256 |
|---|---|
| UnicodeData.txt | `2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c` |
| DerivedNormalizationProps.txt | `18f6857f9542dd942bc5b62e1547d156912e3fe9e9342d6bd2b544d5ece13c42` |
| NormalizationTest.txt | `437f84e715febc5bd8285020560768318045eb51d3e06cfa8c2a54fed2dddcc3` |

- **Tabela gerada:** `ops/anatomy/nfc-shadow-table.mjs` (`--write` para gerar; sem argumento, verifica) produz `src/modules/anatomy/nfc-shadow-table.ts`.
  - Lista 295 faixas, 2.177 code points sem fronteira antes: `ccc ≠ 0` ou `NFC_QC ∈ {N, M}`, lidos diretamente dos arquivos oficiais.
  - SHA-256 da tabela: `893e1507eef53e6a3b970995796fa3a6ae04cc84050623b293a095fe6da0d669`.
  - O manifesto registra os hashes de entrada, do gerador, da tabela e do módulo.
  - Não há download em runtime.

## Contrato e identidade

- **Nenhum campo novo no contrato.** `AnatomyResult` v1 **não** tem `operatorSpan`, `scopeSpan` ou span de condição na relação. Esses nomes pertencem ao gold e à `Prediction`. No B2, os intervalos de operador ou condição serão metadados internos do mapa, não campos do contrato.
- **Inalterados:** `canonicalText`, fonte, hashes de entrada, golds e aprovações.
- **IDs de entidades:** não há promessa de mantê-los quando o reconhecimento mudar em texto não NFC.
- **Integração futura (B2):** se trouxer a tabela para o motor, o `engineHash` muda. Então `analysisId` e `outputHash` mudam **para todos os documentos**, inclusive os NFC, e a equivalência exclui só as diferenças de identidade documentadas.

## Requisito → teste (`test/anatomy.nfc-shadow.unit.test.ts`, só sintéticos e dados oficiais)

| Requisito | Teste |
|---|---|
| Runtime Unicode 17.0, falha fechada em outra versão; hashes dos dados, tabela, gerador e módulo conferidos com o manifesto | `runtime and data identity` |
| Componente fora do caminho e da identidade do motor (`engineHash` inalterado) | `stays outside the engine path` |
| Conformidade oficial: `NormalizationTest-17.0.0`, todas as partes, coluna NFC (100.170 verificações) e complemento da Part 1 (1.094.978 code points inalterados) | `official conformance` |
| A tabela concorda com o runtime: todo code point com fronteira é estável sozinho e não compõe com o que vem antes, testado com **oito contextos à esquerda escolhidos**. Não é prova exaustiva de todo contexto; completam a evidência as propriedades oficiais, a conformidade e a invariante verificada por mapa. | `table agrees with the runtime` |
| Os 10 exemplos da proposta, com span na sombra, span original, fatia e alargamento | `map examples` |
| Fronteiras forçadas: L\|V, LV\|T, acento e reordenação entre nós recusados; fronteiras NFC aceitas; listas inválidas recusadas | `forced boundaries` |
| Validação de intervalos (negativo, invertido, fora do texto, não inteiro, NaN, nulo, par substituto), vazio, surrogate isolado e limites | `span validation` |
| Fuzz reproduzível | `reproducible fuzz` |
| Custo medido | `cost` |

**Fuzz:**
- PRNG mulberry32 com semente `0x5EED0B01`, 60.000 cadeias de 0 a 13 code points.
- **Conjunto de sorteio:** ASCII, Latin pré-composto, marcas de várias classes, Hangul L/V/T/LV/LVT, singletons e `NFC_QC = N`, emoji/ZWJ, astrais, surrogates isolados e **todos os code points da coluna de origem de `NormalizationTest-17.0.0`**. Isso cobre os contextos acrescentados até o Unicode 17, como Tulu-Tigalari, Kirat Rai e Gurung Khema.
- **Propriedades verificadas:**
  - sombra igual a NFC;
  - segmentos contíguos e monótonos;
  - um span sorteado na sombra mapeia para um original que volta exatamente e cobre o pedido;
  - com fronteiras forçadas aleatórias, o mapa ou é utilizável e respeita todas, ou é recusado com diagnóstico.
- **Resultado:** 7.089 alargamentos, 43.688 mapas com fronteiras utilizáveis e 8.683 recusados.

**Execução:** `npm run test:anatomy-nfc-shadow` no Node 24. Esse teste **não** foi incluído em `test:anatomy`, porque a suíte agregada lê corpus e golds reais.
