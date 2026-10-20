# ANAT-UNICODE-01a — contenção de texto não NFC

Origem: decisão do COORD na [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-6281652547), sobre o diagnóstico [ANAT-UNICODE-01](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116#issuecomment-6281618662). Base: PR #249 em `8e1affb`, com R2 PASS técnico.

## Problema

Os literais do perfil e as regras fixas (citação, código de receita, `cl[áa]usula`, `at[eé]`) estão em NFC. Num texto decomposto (NFD), em que `á` vira `a` + U+0301, essas regras falham ou casam só a base sem acento. O efeito mais grave é perder a relação de exclusão: em `excluída a NCM 8471.30.12`, o código fica como NCM simples e o resultado sai `complete`. Nos testes não houve seleção jurídica positiva, mas a máscara de exclusão se perdeu. A correção desse reconhecimento (UNICODE-01b) **ainda está em desenho**. Este pacote apenas contém o problema.

## Comportamento (contenção temporária e conservadora)

- **Detecção:** o critério é `texto !== texto.normalize('NFC')`, não a presença de `\p{M}`. Ele é aplicado:
  - ao texto canônico;
  - à representação recebida (marcação e atributos, por exemplo uma classe CSS em NFD);
  - a cada nome e valor de **atributo decodificado pelo parser** (correção U01A-R1-01). Por exemplo, `class="Histo&#x301;rica"` está em NFC na marcação bruta, mas decodifica para NFD e determina contexto. A verificação cobre todos os atributos, um superconjunto das classes consumidas.

  Uma falha ao normalizar conta como não NFC. A cópia NFC serve só para detectar: texto, hashes, offsets UTF-16 e apresentação continuam sendo os da fonte.
- **Diagnóstico:**
  - o resultado recebe a limitação `non_nfc_text` e `status: partial`;
  - o span da limitação é o documento inteiro `[0, length)` quando o texto canônico não está em NFC, e `null` quando só a marcação ou um atributo decodificado está;
  - a mensagem informa que a extração não foi feita.

  A detecção é **documental**: não promete localizar cada caractere.
- **Quarentena de extração:** no documento inteiro, inclusive nos trechos que estão em NFC:
  - nenhuma entidade e nenhuma relação;
  - nenhuma entrada de elegibilidade NCM e nenhuma seleção positiva.

  O texto, a estrutura e os demais diagnósticos (recursos ausentes, conteúdo não identificado etc.) continuam disponíveis.
- **Contrato v1:** sem alteração. `limitations[].code` é um identificador livre, e o validador já exige `partial` quando há limitação, recusando um `complete` indevido.

## Responsabilidade de cada camada

| Camada | Responsabilidade |
|---|---|
| `readAnatomyInput` (leitor) | Detecta e registra `non_nfc_text` + `partial`, em todos os caminhos: HTML, texto puro e fallbacks. |
| `analyzeAnatomy` (motor) | Não chama o extrator quando o leitor registrou `non_nfc_text`; as entidades ficam vazias. |
| `extractAnatomyEntities` (exportado) | Recusa texto não NFC com `TypeError('non_nfc_text: …')`. Uma chamada direta não devolve códigos aparentemente normais. |
| Adaptador e avaliador | Levam `non_nfc_text` e `partial` em `pending` (por entrada, `nonCompleteEntries`, `entriesWithPending`). Um gold com códigos conta como **não encontrado**, nunca como completo. |

Nenhum helper normaliza texto. A configuração em NFD continua recusada pelo validador de perfis; essa é uma regra separada da detecção no documento.

## Casos cobertos (`test/anatomy.unicode.unit.test.ts`, só sintéticos)

- **Detectados como não NFC:** acento decomposto; emoji antes e depois de acento decomposto; singletons canônicos (U+212B Å, U+2126 Ω); Hangul em jamo decomposto; marcas combinantes em ordem não canônica.
- **Não detectados:** acentos NFC; Hangul NFC; caracteres fora do BMP (incluindo emoji com ZWJ); marca sem forma pré-composta (`q́`); marca inicial isolada; entrada vazia; surrogate isolado.
- **U01A-R1-01:**
  - classe `Histo&#x301;rica` e `Histo&#769;rica` (bruto e texto em NFC) e a forma NFD literal, no bloco, no ancestral e no descendente, com perfil válido que acrescenta `Histórica`: quarentena;
  - os equivalentes NFC codificados (`Hist&#xF3;rica`, `Hist&#243;rica`) são reconhecidos como históricos e não sinalizados;
  - outro atributo (`title`) também é coberto;
  - o teste falha no `a7db4be` e passa com a correção.
- Documento misto (artigo, citação, exceção, faixa e tabela em NFC, mais uma exceção em NFD): quarentena do documento inteiro.
- Preservação do texto canônico, `inputTextHash`, `inputPresentationHash`, spans e recursos ausentes; o validador aceita a limitação e recusa `complete`.

Teste existente ajustado: `anatomy.entities` usava `é` (não NFC) para testar spans UTF-16. Passou a usar `q́`, que está em NFC, e a exigir a recusa para `é`.

## Equivalência em texto NFC

- O snapshot dos 12 sintéticos e o oráculo estão inalterados.
- Nos 9 adversariais do #249, os 7 em NFC dão saída idêntica, sem `identity`/`analysisId`/`outputHash`; os 2 em NFD passam a ficar em quarentena.
- Os resultados inteiros não são iguais byte a byte, porque `engineHash`, `analysisId` e `outputHash` mudam.

## Inventário textual autorizado (sem motor, leitor ou avaliador)

O texto canônico congelado das 7 entradas de desenvolvimento foi remontado a partir dos trechos de `docs/anatomy/gold-review/<id>/canonical-*.json`. Os trechos são contíguos e a remontagem foi conferida contra o SHA-256 e o comprimento UTF-16 congelados em `test/fixtures/anatomy/canonical/development.json`.

| ID | Fonte | SHA-256 (UTF-8) | UTF-16 | Confere com o congelado | NFC |
|---|---|---|---|---|---|
| 01 | CONFAZ | `465186b9…4ddfbeb8` | 194470 | sim | sim |
| 02 | CONFAZ | `e8625c27…aa33e561` | 30591 | sim | sim |
| 03 | DOU | `c9af5e18…a31d800b9d41` | 433 | sim | sim |
| 05 | DOU | `7dc6c74f…4266b9276` | 1099 | sim | sim |
| 07 | DOU | `6f9fd606…a1bf48e2` | 1222 | sim | sim |
| 10 | DOU | `525a7604…3f94b1` | 23246 | sim | sim |
| 11 | DOU | `f34ce3ce…65a17ef` | 17021 | sim | sim |

As 7 entradas estão em NFC. É inventário de entrada, não medição de qualidade. **Esse inventário não prova** que a marcação bruta ou os atributos decodificados das sete publicações estejam em NFC; eles não foram inspecionados.

**Registro de escopo:**
- **Autorizado:** a inspeção textual acima, feita só sobre os artefatos congelados, sem leitor, motor nem avaliador.
- **Fora da autorização:** o executor rodou uma vez `ops/anatomy/dev-canonical.ts`. Esse script passa as 7 entradas pelo **leitor** (`readAnatomyInput`) para extrair o texto e comparar hash e comprimento. O COORD não concedeu autorização retroativa nem para repetir. A suíte agregada `test:anatomy` contém `anatomy.dev-canonical` e por isso não foi rodada na correção R1. Na correção foram executados só testes sintéticos selecionados.
- **Não realizado:** `analyzeAnatomy` e avaliador sobre as entradas, medição, reserva e recaptura.

## Fora deste pacote

- UNICODE-01b (sombra NFC com mapa de posições), que está em desenho;
- NFKC;
- corpus real, reserva, recaptura, medição, merge e deploy.
