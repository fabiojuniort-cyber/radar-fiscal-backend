# ANAT-04 — preparações DOE-SP e RFB (provisórias, só com dados sintéticos)

Origem: COORD → CLAUDE-EXEC, autorização do COORD em 18/10/2026, [issue #116](https://github.com/fabiojuniort-cyber/tribusca-control/issues/116), PR #244 (draft).

**Estado: PROVISÓRIO.** O código e os testes usam **exclusivamente fixtures sintéticas**, cujos identificadores começam com `synthetic://`. O formato foi modelado a partir dos conectores existentes, não de capturas originais. Nenhum texto real foi congelado com estas preparações. Elas precisam ser conferidas contra os 18 originais quando estes forem recuperados, e a recaptura continua dependendo de autorização expressa do Fábio. Não houve requisição a fonte oficial nem acesso à reserva.

## Módulo e versões

Arquivo: `src/modules/anatomy/json-preparation.ts`. As duas versões carregam o sufixo `-provisional`, e o resultado inclui `provisional: true`.

| Fonte | Função | Versão |
|---|---|---|
| DOE-SP | `prepareDoeSpRepresentation(resource, expectedId)` | `doe-sp-json/0.1.0-provisional` |
| RFB | `prepareRfbRepresentation(resource, expectedIdAto)` | `rfb-api-original/0.1.0-provisional` |

## Comportamento comum

- **Decodificação:** UTF-8 estrito. O BOM é removido e registrado em `bomPresent`. O JSON é interpretado sem nenhuma normalização de texto: escapes `\uXXXX` e caracteres literais produzem o mesmo texto, e a identidade do recurso (`sha256` dos bytes recebidos) continua distinguindo as duas formas.
- **Proveniência:** cada trecho do HTML preparado registra o *JSON pointer* do campo de origem, o SHA-256 do valor e o intervalo UTF-16 no HTML. `locateJsonHtmlSpan` converte um intervalo do HTML para `pointer` mais o deslocamento dentro do **valor decodificado** do campo. O deslocamento não é em bytes do arquivo, porque escapes JSON tornam essa relação não linear.
- **Metadados:** ficam em `metadata` ou, quando podem repetir texto, em `excluded`, registrados só por hash e comprimento. São eles o `title` do DOE-SP e o `epigrafeCompleta` da RFB.
- **Anexos:** entram num manifesto ordenado com `status: missing`. O conteúdo dos anexos não é buscado nem inventado.
- **Falha fechada:** qualquer erro gera `JsonPreparationError`, com código.

## DOE-SP

- Exige `id` em formato GUID e igual ao esperado (`invalid_id`, `id_mismatch`).
- Exige `title`, `slug`, `date` no formato `YYYY-MM-DD` e `journal` (`missing_fields`).
- Exige `content` como string (`missing_content`) e não vazia (`empty_content`).
- O HTML preparado é o `content` **sem alteração** (pointer `/content`).
- `attachments[]` exige `id` GUID e `name` (`invalid_attachment`) e é ordenado por `position` e depois por `id`.

## RFB

- Exige `idAto` inteiro positivo e igual ao esperado (`invalid_id`, `id_mismatch`).
- Os segmentos vêm de `ementas[]` e `outrosSegmentos[]` (`no_segments`, `invalid_segments`, `invalid_segment`).
- `ordemSegmentoAto` é obrigatório (`segment_order_missing`) e único (`segment_order_duplicate`). A ordem de leitura é a desse campo, não a posição no array.
- `textoIntegra` é copiado sem alteração, envolvido por um `<section data-rfb-segment>` neutro que não acrescenta caracteres. Se não for string, a preparação falha (`invalid_segment_text`).
- `omitir: true` gera `missingSegments` com `omitted_by_source`, e o texto não entra. Um segmento sem texto e sem anexo gera `no_text`.
- `arquivoBinario` exige `idArquivoBinario` inteiro (`invalid_attachment`) e entra no manifesto de anexos.
- Sem nenhum segmento legível, a preparação falha (`no_readable_segment`).

## Hipóteses de formato (`JSON_PREPARATION_HYPOTHESES`) e casos sem comprovação

**Derivadas dos conectores:**
- DOE-SP: o `content` é o corpo jurídico completo, o `title` é metadado e os anexos são recursos separados.
- RFB: os segmentos estão nesses dois arrays, `omitir` retém o texto e as tabelas podem vir só em anexo.

**Ainda sem comprovação, a conferir nos originais:**
1. Se o `content` do DOE-SP repete o título ou traz resíduos de editor (Word) e onde eles aparecem. Isso é esperado no ID 17.
2. Se algum campo do DOE-SP fora de `content` contém texto jurídico.
3. Se há segmentos RFB fora de `ementas` e `outrosSegmentos`, ou chaves de ordem ausentes ou repetidas nos atos reais.
4. Se algum segmento repete a `epigrafeCompleta`.
5. Comportamento de `omitir` nos oito atos RFB.
6. Atos de pessoal (IDs 19 e 22): a representação sanitizada fica num passo separado, com hash próprio, e **não** faz parte desta preparação.

Se um original contrariar alguma hipótese, a preparação recebe nova versão. A versão provisória não é ajustada em silêncio.

## Testes

Arquivo: `test/anatomy.json-preparation.unit.test.ts`, com fixtures sintéticas. Cobre:
- preservação de texto, incluindo acentos, marca combinante, emoji e entidade HTML;
- equivalência entre escapes JSON e caracteres literais, mantendo identidades de recurso distintas;
- proveniência por pointer e hash;
- BOM;
- ordem dos segmentos independente da posição no array;
- segmentos omitidos e segmentos que são só anexo;
- manifesto de anexos;
- campos ausentes e respostas inválidas: JSON, UTF-8, raiz, id, campos obrigatórios, tipos, ordem ausente ou duplicada;
- leitura do HTML preparado por `readAnatomyInput`.
